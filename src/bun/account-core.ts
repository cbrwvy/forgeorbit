import type { TrustedQuotaEvidence } from "../shared/accounts/quota-sources.ts";
import type { ProviderQuotaEvidence } from "../shared/accounts/provider-evidence.ts";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Account, Binding, ModelCapability, ProfileAssociation, QuotaDefinition, QuotaObservation, QuotaUnit, ResourceIdentity, Subscription } from "../shared/accounts/types.ts";
import { remainingPercent, resolveQuota, subscriptionCommitments, verifiedQuotaWindows } from "../shared/accounts/resolve.ts";

export class AccountCoreError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const fail = (message: string): never => { throw new AccountCoreError(message); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Expected an object.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(k => !keys.includes(k))) fail("Unsupported metadata field.");
  return result;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)
    || /(?:Bearer\s|sk-[a-zA-Z0-9]{12}|eyJ[a-zA-Z0-9_-]+\.|access_token|session_cookie|-----BEGIN)/i.test(value)) return fail(`Invalid ${field}.`);
  return value.trim();
}
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fail(`Invalid ${field}.`);
}
function number(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : fail(`Invalid ${field}.`);
}
function timestamp(value: unknown, field: string): number | null {
  const n = number(value, field);
  if (n !== null && (!Number.isSafeInteger(n) || n > 8_640_000_000_000_000)) fail(`Invalid ${field}.`);
  return n;
}
function currency(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : fail("Invalid currency.");
}
const manual = { provenance: "user-provided", verification: "unverified", source: "manual" } as const;
const accountKeys = ["provider", "displayName", "externalIdentity", "provenance", "availability"];
const subscriptionKeys = ["provider", "planLabel", "currency", "recurringCostMinor", "billingPeriod", "renewsAt", "resetsAt"];

/** Injected SQLite only. No filesystem, credentials, network, CLI or runner dependency. */
export class AccountCore {
  constructor(readonly db: Database, private now: () => number = Date.now) {}
  private all<T>(sql: string, ...params: string[]): T[] { return this.db.query<{ data: string }, string[]>(sql).all(...params).map(r => JSON.parse(r.data) as T); }
  private account(id: string, active = true): Account {
    const a = this.all<Account>("SELECT data FROM resource_accounts WHERE id = ?", id)[0];
    if (!a || active && a.archivedAt !== null) throw new AccountCoreError("Account not found.", 404);
    return a;
  }
  listAccounts(includeArchived = false): Account[] {
    return this.all<Account>("SELECT data FROM resource_accounts ORDER BY id").filter(a => includeArchived || a.archivedAt === null);
  }
  getAccount(id: string): Account { return this.account(id, false); }
  createAccount(input: unknown): Account {
    const v = object(input, accountKeys);
    const now = this.now();
    const a: Account = { id: randomUUID(), provider: text(v.provider, "provider"), displayName: text(v.displayName, "displayName"),
      externalIdentity: v.externalIdentity == null ? null : text(v.externalIdentity, "externalIdentity"),
      ...manual, provenance: choice(v.provenance ?? "user-provided", ["unknown", "user-provided"], "identity provenance"),
      availability: choice(v.availability ?? "unknown", ["unknown", "available", "unavailable"], "availability"),
      createdAt: now, updatedAt: now, archivedAt: null };
    if (a.provenance === "unknown") { a.verification = "unknown"; a.externalIdentity = null; }
    this.db.run("INSERT INTO resource_accounts(id, provider, data) VALUES (?, ?, ?)", [a.id, a.provider, JSON.stringify(a)]);
    return a;
  }
  updateAccount(id: string, input: unknown): Account {
    const a = this.account(id);
    // Provider is immutable: changing it would silently move subscriptions and evidence.
    const v = object(input, accountKeys.filter(k => k !== "provider"));
    const next: Account = { ...a, updatedAt: this.now() };
    if (v.displayName !== undefined) next.displayName = text(v.displayName, "displayName");
    if (v.externalIdentity !== undefined) next.externalIdentity = v.externalIdentity === null ? null : text(v.externalIdentity, "externalIdentity");
    if (v.availability !== undefined) next.availability = choice(v.availability, ["unknown", "available", "unavailable"], "availability");
    if (v.provenance !== undefined) next.provenance = choice(v.provenance, ["unknown", "user-provided"], "provenance");
    next.verification = next.provenance === "unknown" ? "unknown" : "unverified";
    if (next.provenance === "unknown") next.externalIdentity = null;
    this.db.run("UPDATE resource_accounts SET data = ? WHERE id = ?", [JSON.stringify(next), id]);
    if (next.codexProfile) this.db.run("UPDATE harnesses SET label = ? WHERE id = ?", [`Codex · ${next.displayName}`, next.codexProfile.harnessId]);
    if (next.claudeProfile) this.db.run("UPDATE harnesses SET label = ? WHERE id = ?", [`Claude · ${next.displayName}`, next.claudeProfile.harnessId]);
    return next;
  }
  archiveAccount(id: string): void {
    const a = this.account(id, false);
    this.db.transaction(() => {
      if (a.codexProfile) this.db.run("UPDATE harnesses SET enabled = 0 WHERE id = ?", [a.codexProfile.harnessId]);
      if (a.claudeProfile) this.db.run("UPDATE harnesses SET enabled = 0 WHERE id = ?", [a.claudeProfile.harnessId]);
      this.db.run("DELETE FROM account_harness_bindings WHERE account_id = ?", [id]);
      this.db.run("UPDATE resource_accounts SET data = ? WHERE id = ?", [JSON.stringify({ ...a, availability: "unavailable", archivedAt: a.archivedAt ?? this.now(), updatedAt: this.now() }), id]);
    })();
  }
  /** Internal validated writer, never accepted by generic account metadata HTTP. */
  configureCodex(id: string, profile: import("../shared/accounts/codex-profile.ts").CodexProfile): Account {
    const account = this.account(id);
    if (account.provider !== "openai") fail("Codex requires the OpenAI provider.");
    const next = { ...account, codexProfile: profile, updatedAt: this.now() };
    this.db.run("UPDATE resource_accounts SET data = ? WHERE id = ?", [JSON.stringify(next), id]);
    return next;
  }
  /** Internal validated writer. The HTTP account editor cannot set this field. */
  configureClaude(id: string, profile: import("../shared/accounts/claude-profile.ts").ClaudeProfile): Account {
    const account = this.account(id);
    if (account.provider !== "anthropic") fail("Claude requires the Anthropic provider.");
    if (typeof profile.homeAccessAccepted !== "boolean") fail("Claude HOME-access acceptance must be explicit.");
    const next = { ...account, claudeProfile: profile, updatedAt: this.now() };
    this.db.run("UPDATE resource_accounts SET data = ? WHERE id = ?", [JSON.stringify(next), id]);
    return next;
  }
  bindings(accountId?: string): Binding[] {
    const rows = this.db.query<{ account_id: string; harness_id: string; created_at: number }, string[]>(
      `SELECT * FROM account_harness_bindings ${accountId ? "WHERE account_id = ?" : ""} ORDER BY account_id, harness_id`).all(...accountId ? [accountId] : []);
    return rows.map(r => ({ accountId: r.account_id, harnessId: r.harness_id, createdAt: r.created_at, ...manual }));
  }
  bindHarness(accountId: string, harnessId: string): Binding {
    this.account(accountId);
    const owner = this.listAccounts(true).find(a => a.codexProfile?.harnessId === harnessId || a.claudeProfile?.harnessId === harnessId);
    if (owner && owner.id !== accountId) fail("This execution resource belongs to another account profile.");
    if (!this.db.query("SELECT id FROM harnesses WHERE id = ?").get(harnessId)) throw new AccountCoreError("Harness not found.", 404);
    this.db.run("INSERT OR IGNORE INTO account_harness_bindings VALUES (?, ?, ?)", [accountId, harnessId, this.now()]);
    return this.bindings(accountId).find(b => b.harnessId === harnessId)!;
  }
  unbindHarness(accountId: string, harnessId: string): void {
    this.db.run("DELETE FROM account_harness_bindings WHERE account_id = ? AND harness_id = ?", [accountId, harnessId]);
  }
  associations(accountId?: string): ProfileAssociation[] {
    return this.db.query<ProfileAssociation, string[]>(`SELECT account_id AS accountId, harness_id AS harnessId, profile_id AS profileId, created_at AS createdAt FROM account_profile_associations ${accountId ? "WHERE account_id = ?" : ""}`).all(...accountId ? [accountId] : []);
  }
  bindProfile(accountId: string, profileId: string): ProfileAssociation {
    this.account(accountId);
    const profile = this.db.query<{ harness_id: string }, [string]>("SELECT harness_id FROM agent_profiles WHERE id = ?").get(profileId);
    if (!profile) throw new AccountCoreError("Profile not found.", 404);
    if (!this.bindings(accountId).some(b => b.harnessId === profile.harness_id)) fail("Bind the profile's harness explicitly first.");
    const existing = this.associations().find(a => a.profileId === profileId);
    if (existing && (existing.accountId !== accountId || existing.harnessId !== profile.harness_id)) throw new AccountCoreError("Unbind the existing profile association first.", 409);
    this.db.run("INSERT OR IGNORE INTO account_profile_associations VALUES (?, ?, ?, ?)", [profileId, accountId, profile.harness_id, this.now()]);
    return this.associations(accountId).find(a => a.profileId === profileId)!;
  }
  unbindProfile(accountId: string, profileId: string): void {
    this.db.run("DELETE FROM account_profile_associations WHERE account_id = ? AND profile_id = ?", [accountId, profileId]);
  }
  resolveIdentity(harnessId: string, profileId: string | null = null): ResourceIdentity {
    const unknown = (warning: string): ResourceIdentity => ({ accountId: null, provenance: "unknown", verification: "unknown", subscriptionIds: [], warnings: [warning] });
    // A managed Codex resource selects exactly one AccountCore identity.
    const selected = this.listAccounts().find(a => a.codexProfile?.harnessId === harnessId || a.claudeProfile?.harnessId === harnessId);
    if (selected && this.bindings(selected.id).some(b => b.harnessId === harnessId)) {
      return { accountId: selected.id, provenance: selected.provenance, verification: selected.verification,
        subscriptionIds: this.subscriptionsFor(selected.id).map(s => s.id), warnings: ["Configured CLI profile; provider subject and quota remain unverified."] };
    }
    // A registry binding lists possible accounts; it does not select an execution account.
    if (!profileId) return unknown("Execution account is unknown without an explicit profile association.");
    const association = this.associations().find(a => a.profileId === profileId && a.harnessId === harnessId);
    const profile = this.db.query<{ harness_id: string }, [string]>("SELECT harness_id FROM agent_profiles WHERE id = ?").get(profileId);
    if (!association || profile?.harness_id !== harnessId) return unknown("Profile association is missing or its harness has changed.");
    const a = this.account(association.accountId, false);
    if (a.archivedAt !== null || a.provenance === "unknown") return unknown("Account identity is unknown or archived.");
    return { accountId: a.id, provenance: a.provenance, verification: a.verification,
      subscriptionIds: this.subscriptionsFor(a.id).map(s => s.id), warnings: a.verification === "verified" ? [] : ["Account identity is user-declared, not provider-verified."] };
  }
  listSubscriptions(includeArchived = false): Subscription[] {
    return this.all<Subscription>("SELECT data FROM resource_subscriptions ORDER BY id").filter(s => includeArchived || s.archivedAt === null);
  }
  private subscription(id: string): Subscription {
    const s = this.listSubscriptions().find(s => s.id === id);
    if (!s) throw new AccountCoreError("Subscription not found.", 404);
    return s;
  }
  private subscriptionData(v: Record<string, unknown>) {
    const cost = number(v.recurringCostMinor, "recurringCostMinor");
    const cur = currency(v.currency);
    if (cost !== null && (!Number.isSafeInteger(cost) || !cur)) fail("Cost requires integer minor units and currency.");
    return { provider: text(v.provider, "provider"), planLabel: text(v.planLabel, "planLabel"), currency: cur,
      recurringCostMinor: cost, billingPeriod: choice(v.billingPeriod ?? "unknown", ["unknown", "month", "year", "week", "day"], "billingPeriod"),
      renewsAt: timestamp(v.renewsAt, "renewsAt"), resetsAt: timestamp(v.resetsAt, "resetsAt") };
  }
  createSubscription(input: unknown): Subscription {
    const v = object(input, subscriptionKeys);
    const s: Subscription = { ...this.subscriptionData(v), ...manual, id: randomUUID(), createdAt: this.now(), updatedAt: this.now(), archivedAt: null };
    this.db.run("INSERT INTO resource_subscriptions VALUES (?, ?, ?)", [s.id, s.provider, JSON.stringify(s)]);
    return s;
  }
  updateSubscription(id: string, input: unknown): Subscription {
    const old = this.subscription(id);
    const v = object(input, subscriptionKeys.filter(k => k !== "provider"));
    const s = { ...old, ...this.subscriptionData({ ...old, ...v }), updatedAt: this.now() };
    this.db.run("UPDATE resource_subscriptions SET data = ? WHERE id = ?", [JSON.stringify(s), id]);
    return s;
  }
  archiveSubscription(id: string): void {
    const s = this.subscription(id);
    this.db.run("UPDATE resource_subscriptions SET data = ? WHERE id = ?", [JSON.stringify({ ...s, archivedAt: this.now(), updatedAt: this.now() }), id]);
  }
  linkSubscription(accountId: string, subscriptionId: string): void {
    const a = this.account(accountId), s = this.subscription(subscriptionId);
    if (a.provider !== s.provider) fail("Subscription and account providers must match.");
    this.db.run("INSERT OR IGNORE INTO account_subscriptions VALUES (?, ?)", [accountId, subscriptionId]);
  }
  unlinkSubscription(accountId: string, subscriptionId: string): void {
    if (this.definitions(accountId, true).some(d => d.subscriptionId === subscriptionId)) throw new AccountCoreError("Historical quota definitions retain this subscription relationship.", 409);
    this.db.run("DELETE FROM account_subscriptions WHERE account_id = ? AND subscription_id = ?", [accountId, subscriptionId]);
  }
  subscriptionsFor(accountId: string): Subscription[] {
    return this.all<Subscription>("SELECT s.data FROM resource_subscriptions s JOIN account_subscriptions a ON a.subscription_id = s.id WHERE a.account_id = ? ORDER BY s.id", accountId).filter(s => s.archivedAt === null);
  }
  commitments() { return subscriptionCommitments(this.listSubscriptions()); }
  definitions(accountId: string, includeArchived = false): QuotaDefinition[] {
    return this.all<QuotaDefinition>("SELECT data FROM quota_definitions WHERE account_id = ? ORDER BY id", accountId).filter(d => includeArchived || d.archivedAt === null);
  }
  getDefinition(id: string): QuotaDefinition {
    const d = this.all<QuotaDefinition>("SELECT data FROM quota_definitions WHERE id = ?", id)[0];
    if (!d) throw new AccountCoreError("Quota not found.", 404);
    return d;
  }
  createDefinition(input: unknown): QuotaDefinition {
    const v = object(input, ["accountId", "subscriptionId", "scope", "unit", "window", "windowMs", "category", "modelIds", "warnAtRemainingPercent"]);
    const accountId = text(v.accountId, "accountId");
    this.account(accountId);
    const subscriptionId = v.subscriptionId == null ? null : text(v.subscriptionId, "subscriptionId");
    if (subscriptionId && !this.subscriptionsFor(accountId).some(s => s.id === subscriptionId)) fail("Subscription must be explicitly linked first.");
    const u = object(v.unit, ["kind", "name", "currency"]);
    const kind = choice(u.kind, ["requests", "tokens", "concurrency", "compute-time", "money", "provider-specific", "percentage"], "unit");
    let unit: QuotaUnit;
    if (kind === "money") { const cur = currency(u.currency); if (!cur) fail("Money quota needs currency."); unit = { kind, currency: cur! }; }
    else if (kind === "compute-time") unit = { kind, name: choice(u.name, ["milliseconds", "seconds"], "time unit") };
    else if (kind === "provider-specific") unit = { kind, name: text(u.name, "provider unit") };
    else unit = { kind };
    if (Object.keys(u).some(k => !(k in unit))) fail("Incompatible quota unit fields.");
    const scope = text(v.scope, "scope");
    const windowMs = timestamp(v.windowMs, "window duration");
    if (windowMs === 0) fail("Window duration must be positive.");
    const category = choice(v.category ?? "other", ["subscription", "api-rate", "api-credit", "organization-budget", "other"], "quota category");
    if (category === "api-credit" && unit.kind !== "money") fail("This category requires a monetary unit.");
    if (v.modelIds !== undefined && (!Array.isArray(v.modelIds) || v.modelIds.length > 100)) fail("Invalid model group.");
    const modelIds = [...new Set((v.modelIds as unknown[] | undefined ?? []).map(id => text(id, "model ID")))];
    if (modelIds.length && !scope.startsWith("group:")) fail("Model membership requires a group scope.");
    const d: QuotaDefinition = { category, windowMs, modelIds, warnAtRemainingPercent: this.threshold(v.warnAtRemainingPercent), id: randomUUID(), accountId, subscriptionId, scope, unit,
      window: text(v.window, "window"), createdAt: this.now(), archivedAt: null };
    // No uniqueness on labels/scopes: two independently defined quotas are not assumed identical.
    this.db.run("INSERT INTO quota_definitions VALUES (?, ?, ?, ?)", [d.id, accountId, subscriptionId, JSON.stringify(d)]);
    return d;
  }
  private threshold(value: unknown): number | null {
    const threshold = number(value, "remaining warning threshold");
    if (threshold !== null && threshold > 100) fail("Remaining warning threshold must be between 0 and 100.");
    return threshold;
  }
  updateQuotaThreshold(id: string, input: unknown): QuotaDefinition {
    const d = this.getDefinition(id);
    this.account(d.accountId);
    if (d.archivedAt !== null) fail("Quota definition is archived.");
    const v = object(input, ["warnAtRemainingPercent"]);
    if (!("warnAtRemainingPercent" in v)) fail("Warning threshold required.");
    const next = { ...d, warnAtRemainingPercent: this.threshold(v.warnAtRemainingPercent) };
    this.db.run("UPDATE quota_definitions SET data = ? WHERE id = ?", [JSON.stringify(next), id]);
    return next;
  }
  recordOwnerPool(accountId: string, input: unknown) {
    const v = object(input, ["definition", "observation"]);
    const definition = object(v.definition, ["subscriptionId", "scope", "unit", "window", "windowMs", "category", "modelIds", "warnAtRemainingPercent"]);
    return this.db.transaction(() => {
      const d = this.createDefinition({ ...definition, accountId });
      const observation = this.recordObservation(d.id, v.observation);
      return { definition: d, observation };
    })();
  }
  archiveDefinition(id: string): void {
    const d = this.getDefinition(id);
    this.db.run("UPDATE quota_definitions SET data = ? WHERE id = ?", [JSON.stringify({ ...d, archivedAt: d.archivedAt ?? this.now() }), id]);
  }
  recordObservation(quotaId: string, input: unknown): QuotaObservation {
    return this.writeObservation(quotaId, input, true);
  }
  private writeObservation(quotaId: string, input: unknown, owner: boolean): QuotaObservation {
    const d = this.getDefinition(quotaId);
    this.account(d.accountId);
    if (d.archivedAt !== null) fail("Quota definition is archived.");
    if (d.subscriptionId) this.subscription(d.subscriptionId);
    const v = object(input, ["observedAt", "expiresAt", "resetAt", "limit", "used", "remaining", "indicator", "confidence",
      ...(owner ? ["sourceNote", "evidenceReference", "revises"] : [])]);
    const revises = v.revises == null ? null : text(v.revises, "observation revision");
    if (revises) {
      const target = this.all<QuotaObservation>("SELECT data FROM quota_observations WHERE id = ? AND quota_id = ?", revises, quotaId)[0];
      if (!target || target.source !== "manual" || target.provenance !== "user-provided" || target.verification !== "unverified")
        throw new AccountCoreError("Only an Owner-reported observation in this quota pool can be corrected.", 409);
      if (this.db.query("SELECT 1 FROM quota_observations WHERE quota_id = ? AND json_extract(data, '$.revises') = ?").get(quotaId, revises))
        throw new AccountCoreError("This observation already has a correction.", 409);
    }
    const observedAt = timestamp(v.observedAt, "observedAt") ?? this.now();
    const expiresAt = timestamp(v.expiresAt, "expiresAt");
    const resetAt = timestamp(v.resetAt, "resetAt");
    if (observedAt > this.now() || expiresAt !== null && expiresAt <= observedAt || resetAt !== null && resetAt <= observedAt) fail("Invalid observation time range.");
    let indicator: QuotaObservation["indicator"] = null;
    if (v.indicator != null) {
      const i = object(v.indicator, ["kind", "value"]);
      const value = number(i.value, "indicator");
      if (value === null || value > 100) fail("Invalid percent indicator.");
      indicator = { kind: choice(i.kind, ["percent-used", "percent-remaining"], "indicator kind"), value: value! };
    }
    const o: QuotaObservation = { id: randomUUID(), quotaId, ...manual, observedAt, expiresAt, resetAt,
      limit: number(v.limit, "limit"), used: number(v.used, "used"), remaining: number(v.remaining, "remaining"), indicator,
      confidence: choice(v.confidence ?? "unknown", ["unknown", "low", "medium", "high"], "confidence") };
    if (owner) {
      if (revises) o.revises = revises;
      o.recordedAt = this.now();
      if (v.sourceNote != null) o.sourceNote = text(v.sourceNote, "source note");
      if (v.evidenceReference != null) o.evidenceReference = text(v.evidenceReference, "evidence reference");
    }
    if (d.unit.kind === "percentage" && [o.limit, o.used, o.remaining].some(n => n !== null)) fail("Enter percentage in the indicator field.");
    if (["concurrency", "money"].includes(d.unit.kind) && [o.limit, o.used, o.remaining].some(n => n !== null && !Number.isInteger(n))) fail("Concurrency and monetary minor units require integer counts.");
    if (o.limit !== null && o.remaining !== null && o.remaining > o.limit) fail("Remaining exceeds limit.");
    this.db.run("INSERT INTO quota_observations VALUES (?, ?, ?, ?)", [o.id, quotaId, observedAt, JSON.stringify(o)]);
    return o;
  }
  /** Internal approved-adapter writer; never exposed through the manual observation HTTP route.
   * Reuses the manual numeric/time validator and the same append-only journal atomically. */
  recordTrustedObservations(sourceId: string, rows: { quotaId: string; values: unknown; evidence: TrustedQuotaEvidence }[]): QuotaObservation[] {
    return this.db.transaction(() => rows.map(row => {
      const source = `trusted:${sourceId}`;
      const o = this.writeObservation(row.quotaId, row.values, false);
      const newest = this.db.query<{ latest: number | null }, [string, string]>(
        "SELECT MAX(observed_at) AS latest FROM quota_observations WHERE quota_id = ? AND json_extract(data, '$.source') = ?"
      ).get(row.quotaId, source)?.latest;
      if (newest != null && o.observedAt <= newest) throw new AccountCoreError("Quota source returned superseded evidence.", 422);
      const observation: QuotaObservation = { ...o, source, provenance: "verified", verification: "verified", acquisition: row.evidence };
      this.db.run("UPDATE quota_observations SET data = ? WHERE id = ?", [JSON.stringify(observation), o.id]);
      return observation;
    }))();
  }
  /** FO-ORCH03 writer for read-only provider readings the Owner requested. Same validator and append-only
   * journal as manual/trusted rows, but the row is permanently `observed` + `unverified`: it carries no
   * VerifiedQuotaBinding, so the router keeps it Unknown. */
  recordObservedObservations(sourceId: string, rows: { quotaId: string; values: unknown; evidence: ProviderQuotaEvidence }[]): QuotaObservation[] {
    return this.db.transaction(() => rows.map(row => {
      const source = `observed:${sourceId}`;
      const o = this.writeObservation(row.quotaId, row.values, false);
      const newest = this.db.query<{ latest: number | null }, [string, string, string]>(
        "SELECT MAX(observed_at) AS latest FROM quota_observations WHERE quota_id = ? AND json_extract(data, '$.source') = ? AND id != ?"
      ).get(row.quotaId, source, o.id)?.latest;
      if (newest != null && o.observedAt <= newest) throw new AccountCoreError("Provider reading is older than the stored one.", 422);
      const observation: QuotaObservation = { ...o, source, provenance: "observed", verification: "unverified", evidence: row.evidence };
      this.db.run("UPDATE quota_observations SET data = ? WHERE id = ?", [JSON.stringify(observation), o.id]);
      return observation;
    }))();
  }
  /** Newest stored reading from one observed source across the account's quotas (for identity pinning and views). */
  observedReadings(accountId: string, sourceId: string): QuotaObservation[] {
    const source = `observed:${sourceId}`;
    return this.definitions(accountId, true).flatMap(d => this.all<QuotaObservation>(
      `SELECT o.data FROM quota_observations o WHERE o.quota_id = ? AND json_extract(o.data, '$.source') = ? AND o.observed_at = (
        SELECT MAX(n.observed_at) FROM quota_observations n WHERE n.quota_id = o.quota_id AND json_extract(n.data, '$.source') = ?)`, d.id, source, source));
  }
  history(quotaId: string, before: number | null = null, limit = 200): QuotaObservation[] {
    this.getDefinition(quotaId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("Invalid history limit.");
    return this.db.query<{ data: string }, [string, number | null, number | null, number]>(
      "SELECT data FROM quota_observations WHERE quota_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?"
    ).all(quotaId, before, before, limit).map(r => JSON.parse(r.data) as QuotaObservation);
  }
  // Rowid pagination is exposed separately so equal timestamps cannot lose observations.
  historyPage(quotaId: string, before: number | null = null) {
    this.getDefinition(quotaId);
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) fail("Invalid history cursor.");
    const rows = this.db.query<{ cursor: number; data: string }, [string, number | null, number | null]>(
      "SELECT rowid AS cursor, data FROM quota_observations WHERE quota_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT 201"
    ).all(quotaId, before, before);
    return { observations: rows.slice(0, 200).map(r => JSON.parse(r.data) as QuotaObservation), nextCursor: rows.length > 200 ? rows[199]!.cursor : null };
  }
  currentQuotas(accountId: string, includeArchived = false) {
    const a = this.account(accountId, false);
    return this.definitions(accountId, includeArchived).map(d => {
      // Fetch every source's newest timestamp (ties retained). Never use a truncated history page for decisions.
      const rows = this.all<QuotaObservation>(`WITH active AS (
        SELECT o.* FROM quota_observations o WHERE o.quota_id = ? AND NOT EXISTS (
          SELECT 1 FROM quota_observations r WHERE r.quota_id = o.quota_id AND json_extract(r.data, '$.revises') = o.id
        )
      ), latest AS (
        SELECT json_extract(data, '$.source') AS source, MAX(observed_at) AS observed_at FROM active GROUP BY source
      )
      SELECT o.data FROM active o JOIN latest l ON l.source = json_extract(o.data, '$.source') AND l.observed_at = o.observed_at`, d.id);
      const state = resolveQuota(d, rows, this.now());
      if (a.archivedAt !== null || d.subscriptionId && !this.listSubscriptions().some(s => s.id === d.subscriptionId)) {
        state.status = "unknown"; state.current = null; state.warnings.push("Account or subscription is archived.");
      }
      return state;
    });
  }
  /** Positive headroom in each applicable verified window. No estimated task demand is used. */
  hasVerifiedHeadroom(accountId: string, harnessId: string, modelId: string): boolean {
    const account = this.account(accountId);
    if (!this.bindings(accountId).some(binding => binding.harnessId === harnessId)) return false;
    const windows = verifiedQuotaWindows(this.currentQuotas(accountId), account.id, account.provider, harnessId, modelId, this.now());
    return windows.length > 0 && windows.every(quota => {
      const o = quota.current;
      return !!o && (o.remaining ?? remainingPercent(o) ?? 0) > 0 && remainingPercent(o) !== 0;
    });
  }

  /** Time-bounded observation from a provider rejection. Scoped to one account, harness and model. */
  observeProviderModelRejection(accountId: string, harnessId: string, modelId: string, input: { source: string; expiresAt: number }): ModelCapability {
    this.account(accountId);
    if (!this.bindings(accountId).some(b => b.harnessId === harnessId)) fail("Harness binding required.");
    const expiresAt = timestamp(input.expiresAt, "expiresAt");
    if (expiresAt === null || expiresAt <= this.now()) fail("Capability expiry must be in the future.");
    const c: ModelCapability = {
      accountId, harnessId, modelId: text(modelId, "modelId"),
      provenance: "observed", source: text(input.source, "source"), verification: "verified",
      support: "unsupported", observedAt: this.now(), expiresAt,
    };
    this.db.run("INSERT INTO account_model_capabilities VALUES (?, ?, ?, ?) ON CONFLICT(account_id,harness_id,model_id) DO UPDATE SET data=excluded.data", [accountId, harnessId, c.modelId, JSON.stringify(c)]);
    return c;
  }
  setModelCapability(accountId: string, harnessId: string, modelId: string, input: unknown): ModelCapability {
    this.account(accountId);
    if (!this.bindings(accountId).some(b => b.harnessId === harnessId)) fail("Harness binding required.");
    const v = object(input, ["support", "expiresAt"]);
    const expiresAt = timestamp(v.expiresAt, "expiresAt");
    if (expiresAt !== null && expiresAt <= this.now()) fail("Capability expiry must be in the future.");
    const c: ModelCapability = { accountId, harnessId, modelId: text(modelId, "modelId"), ...manual,
      support: choice(v.support, ["unknown", "supported", "unsupported"], "support"), observedAt: this.now(), expiresAt };
    this.db.run("INSERT INTO account_model_capabilities VALUES (?, ?, ?, ?) ON CONFLICT(account_id,harness_id,model_id) DO UPDATE SET data=excluded.data", [accountId, harnessId, c.modelId, JSON.stringify(c)]);
    return c;
  }
  modelCapabilities(accountId: string): ModelCapability[] {
    return this.all<ModelCapability>("SELECT data FROM account_model_capabilities WHERE account_id = ?", accountId);
  }
}
