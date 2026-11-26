import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AccountCore } from "./account-core.ts";
import { LegacyUsageBridge, journalLegacyUsage } from "./account-usage-bridge.ts";
import { accountPortfolioView, extendPortfolioResources, portfolioQuota } from "./account-portfolio.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { resolveQuota, resourceRelationship, subscriptionCommitments, assessQuotaDemand } from "../shared/accounts/resolve.ts";
import { accountSourceCapabilities } from "../shared/accounts/capabilities.ts";
import type { QuotaObservation } from "../shared/accounts/types.ts";
import type { ResourceSnapshotInput } from "../shared/portfolio/types.ts";
import type { HarnessQuota } from "../shared/types.ts";

let db: Database, core: AccountCore, now: number;
beforeEach(() => {
  now = 1_000_000;
  db = new Database(":memory:"); db.run("PRAGMA foreign_keys = ON"); migrate(db, migrations);
  core = new AccountCore(db, () => now);
});
afterEach(() => db.close());
const account = (extra = {}) => core.createAccount({ provider: "openai", displayName: "Same name", ...extra });
const subscription = (extra = {}) => core.createSubscription({ provider: "openai", planLabel: "Pro", ...extra });
function definition(extra: Record<string, unknown> = {}) { return core.createDefinition({ accountId: extra.accountId ?? account().id, scope: "account", unit: { kind: "tokens" }, window: "unknown", ...extra }); }
const observe = (id: string, extra = {}) => core.recordObservation(id, { expiresAt: now + 1000, ...extra });
function profile(id = "profile", harness = "codex") {
  db.run(`INSERT INTO agent_profiles(id,name,name_key,harness_id,model,created_at,updated_at) VALUES (?, ?, ?, ?, 'fake-model', 1, 1)`, [id, id, id, harness]);
  return id;
}
const legacy = (extra = {}): HarnessQuota => ({ harnessId: "codex", kind: "codex", planType: "Pro", source: "api", status: "ok", reason: null,
  fetchedAtMs: now, meters: [{ id: "weekly", label: "Weekly", usedPercent: 100, resetsAtMs: null }], ...extra });
function base(harnessId = "codex"): ResourceSnapshotInput {
  const unknown = { value: null, origin: "unknown" as const, observedAtMs: null };
  return { id: `harness:${harnessId}`, harnessId, harnessKind: "codex", accountId: null, agentProfileIds: [],
    supportedModels: unknown, availability: unknown, concurrencyLimit: unknown, occupiedSlots: { value: 0, origin: "observed", observedAtMs: now },
    exclusive: false, quota: { kind: "unknown", reason: "unknown" }, quotaOrigin: "unknown", extraSpending: unknown, permissions: unknown, subscriptionId: null };
}

test("empty registry has no seeded identities or capacity", () => {
  expect(core.listAccounts()).toEqual([]); expect(core.commitments().totals).toEqual([]);
  expect(core.resolveIdentity("codex").accountId).toBeNull();
});
test("multiple distinct UUID accounts may have identical names and one harness", () => {
  const a = account(), b = account(); core.bindHarness(a.id, "codex"); core.bindHarness(b.id, "codex");
  expect(a.id).not.toBe(b.id); expect(core.bindings()).toHaveLength(2);
  expect(core.resolveIdentity("codex").accountId).toBeNull();
  expect(core.listAccounts()).toHaveLength(2);
});
test("one account across harnesses is explicit and idempotent, never inferred", () => {
  const a = account(); core.bindHarness(a.id, "codex");
  expect(core.bindings(a.id)).toHaveLength(1);
  core.bindHarness(a.id, "cursor"); core.bindHarness(a.id, "cursor");
  expect(core.bindings(a.id)).toHaveLength(2);
  expect(core.bindings(a.id).every(b => b.provenance === "user-provided")).toBe(true);
});
test("email, provider and profile do not verify identity; unknown is explicit", () => {
  const a = account({ externalIdentity: "test@example.invalid" });
  expect(a.verification).toBe("unverified");
  expect(() => account({ provenance: "verified" })).toThrow();
  expect(() => account({ verification: "verified" })).toThrow();
  expect(() => account({ provenance: "observed" })).toThrow();
  const u = account({ provenance: "unknown", externalIdentity: "not evidence" });
  expect(u.externalIdentity).toBeNull(); expect(u.verification).toBe("unknown");
  core.bindHarness(u.id, "codex"); core.bindProfile(u.id, profile());
  expect(core.resolveIdentity("codex", "profile").accountId).toBeNull();
});
test("account update preserves UUID and forbids provider or verification escalation", () => {
  const a = account(); now += 1;
  expect(core.updateAccount(a.id, { displayName: "Changed" })).toMatchObject({ id: a.id, displayName: "Changed", updatedAt: now });
  expect(() => core.updateAccount(a.id, { provider: "anthropic" })).toThrow();
  expect(() => core.updateAccount(a.id, { provenance: "verified" })).toThrow();
});
test("profile binding is explicit, unique, removable and does not alter the profile", () => {
  const a = account(), b = account(); profile();
  const before = db.query("SELECT * FROM agent_profiles").all();
  expect(() => core.bindProfile(a.id, "profile")).toThrow();
  core.bindHarness(a.id, "codex"); core.bindProfile(a.id, "profile");
  core.bindHarness(b.id, "codex"); expect(() => core.bindProfile(b.id, "profile")).toThrow();
  expect(core.resolveIdentity("codex", "profile")).toMatchObject({ accountId: a.id, provenance: "user-provided", verification: "unverified" });
  expect(db.query("SELECT * FROM agent_profiles").all()).toEqual(before);
  core.unbindProfile(a.id, "profile"); expect(core.resolveIdentity("codex", "profile").accountId).toBeNull();
});
test("profile harness drift fails closed", () => {
  const a = account(); core.bindHarness(a.id, "codex"); core.bindProfile(a.id, profile());
  db.run("UPDATE agent_profiles SET harness_id='cursor' WHERE id='profile'");
  expect(core.resolveIdentity("codex", "profile").accountId).toBeNull();
  expect(core.resolveIdentity("cursor", "profile").accountId).toBeNull();
});
test("shared subscription counts once by ID; equal plan labels do not merge", () => {
  const a = account(), b = account(), shared = subscription({ currency: "USD", recurringCostMinor: 2000, billingPeriod: "month" });
  core.linkSubscription(a.id, shared.id); core.linkSubscription(b.id, shared.id);
  const commitments = subscriptionCommitments([...core.subscriptionsFor(a.id), ...core.subscriptionsFor(b.id)]);
  expect(commitments.totals).toEqual([{ currency: "USD", billingPeriod: "month", minor: 2000 }]);
  const independent = subscription({ currency: "USD", recurringCostMinor: 2000, billingPeriod: "month" });
  core.linkSubscription(b.id, independent.id);
  expect(core.commitments().totals[0]!.minor).toBe(4000);
});
test("currencies and billing periods remain separate; unknown cost is not zero", () => {
  subscription(); subscription({ currency: "USD", recurringCostMinor: 0, billingPeriod: "month" });
  subscription({ currency: "EUR", recurringCostMinor: 100, billingPeriod: "month" });
  subscription({ currency: "USD", recurringCostMinor: 100, billingPeriod: "year" });
  expect(core.commitments().totals).toHaveLength(3); expect(core.commitments().unknownIds).toHaveLength(1);
  expect(() => subscription({ recurringCostMinor: 100 })).toThrow();
});
test("subscriptions require matching provider and explicit account membership", () => {
  const a = account(), s = subscription({ provider: "other" });
  expect(() => core.linkSubscription(a.id, s.id)).toThrow();
  expect(() => definition({ accountId: a.id, subscriptionId: s.id })).toThrow();
  expect(core.subscriptionsFor(a.id)).toEqual([]);
});
test("subscription update and archive preserve quota history and remove current capacity", () => {
  const a = account(), s = subscription(); core.linkSubscription(a.id, s.id);
  const d = definition({ accountId: a.id, subscriptionId: s.id }); observe(d.id, { remaining: 3 });
  expect(core.updateSubscription(s.id, { currency: "USD", recurringCostMinor: 100, billingPeriod: "month" }).recurringCostMinor).toBe(100);
  expect(() => core.unlinkSubscription(a.id, s.id)).toThrow();
  core.archiveSubscription(s.id);
  expect(core.currentQuotas(a.id)[0]!.current).toBeNull(); expect(core.history(d.id)).toHaveLength(1);
});
test("unknown quota is neither zero nor unlimited; limit-used does not manufacture remaining", () => {
  const d = definition(); expect(core.currentQuotas(d.accountId)[0]!.status).toBe("unknown");
  const o = observe(d.id, { limit: 10, used: 10 });
  expect(o.remaining).toBeNull(); expect(portfolioQuota(core.currentQuotas(d.accountId)).quota.kind).toBe("unknown");
});
test("confirmed zero and known remaining are retained exactly", () => {
  const d = definition(); observe(d.id, { remaining: 0, limit: 20 });
  expect(portfolioQuota(core.currentQuotas(d.accountId)).quota).toMatchObject({ kind: "remaining", remaining: 0, limit: 20 });
  now++; observe(d.id, { remaining: 8 }); expect(core.currentQuotas(d.accountId)[0]!.current?.remaining).toBe(8);
});
for (const kind of ["percent-used", "percent-remaining"] as const) test(`${kind} never becomes tokens or exhaustion`, () => {
  const d = definition(); const o = observe(d.id, { indicator: { kind, value: 100 } });
  expect(o.remaining).toBeNull(); expect(o.limit).toBeNull(); expect(o.used).toBeNull();
  expect(o.indicator).toEqual({ kind, value: 100 });
  expect(portfolioQuota(core.currentQuotas(d.accountId)).quota.kind).toBe(kind === "percent-used" ? "percent-used" : "unknown");
});
test("expiry and reset invalidate capacity without deleting history or assuming replenishment", () => {
  const d = definition(); observe(d.id, { remaining: 0, resetAt: now + 500 }); now += 500;
  expect(core.currentQuotas(d.accountId)[0]!.status).toBe("stale");
  expect(core.currentQuotas(d.accountId)[0]!.current).toBeNull(); expect(core.history(d.id)[0]!.remaining).toBe(0);
  now++; observe(d.id, { remaining: 2 }); now += 1000;
  expect(core.currentQuotas(d.accountId)[0]!.status).toBe("stale");
});
test("missing reset stays null; missing freshness cannot supply current quota", () => {
  const d = definition(); expect(observe(d.id).resetAt).toBeNull();
  now++; core.recordObservation(d.id, { remaining: 5 });
  expect(core.currentQuotas(d.accountId)[0]!.status).toBe("stale");
});
test("conflicting sources or timestamp ties return unknown current capacity", () => {
  const d = definition(), a = observe(d.id, { remaining: 5 });
  const b: QuotaObservation = { ...a, id: "other", source: "supported-future-fixture", remaining: 4, provenance: "observed" };
  expect(resolveQuota(d, [a, b], now).status).toBe("conflict");
  observe(d.id, { remaining: 3 });
  expect(core.currentQuotas(d.accountId)[0]!.status).toBe("conflict");
  now++; observe(d.id, { remaining: 2 }); expect(core.currentQuotas(d.accountId)[0]!.status).toBe("current");
});
test("a stale latest observation does not resurrect an older fresh one", () => {
  const d = definition(), a = observe(d.id, { remaining: 5 });
  const b = { ...a, id: "new", observedAt: now + 1, expiresAt: now + 2, remaining: 0 };
  expect(resolveQuota(d, [a, b], now + 3).status).toBe("stale");
});
test("different quota units, windows and currencies are independent", () => {
  const a = account();
  for (const unit of [{ kind: "requests" }, { kind: "tokens" }, { kind: "compute-time", name: "seconds" }, { kind: "money", currency: "USD" }, { kind: "money", currency: "EUR" }, { kind: "provider-specific", name: "credits" }, { kind: "concurrency" }]) {
    const d = definition({ accountId: a.id, unit }); observe(d.id, { remaining: 1 });
  }
  expect(core.currentQuotas(a.id)).toHaveLength(7);
  expect(portfolioQuota(core.currentQuotas(a.id)).quota.kind).toBe("unknown");
});
test("invalid quantities, time ranges, currencies and credential fields fail before writes", () => {
  const d = definition();
  for (const v of [{ remaining: -1 }, { used: Infinity }, { remaining: 2, limit: 1 }, { observedAt: now + 1 }, { expiresAt: now }, { indicator: { kind: "percent-used", value: 101 } }, { source: "verified-api" }]) expect(() => observe(d.id, v)).toThrow();
  for (const v of [{ home: "/secret" }, { accessToken: "secret" }, { displayName: "Bearer secret" }]) expect(() => account(v)).toThrow();
  expect(() => definition({ unit: { kind: "tokens", currency: "USD" } })).toThrow();
  expect(() => subscription({ currency: "usd" })).toThrow();
  expect(core.history(d.id)).toEqual([]);
});
test("provider capabilities do not advertise legacy undocumented APIs as supported live connectors", () => {
  for (const kind of ["codex", "cursor", "claude-code"]) {
    expect(accountSourceCapabilities(kind).storedUsage).toBe("supported-safe");
    expect(accountSourceCapabilities(kind).liveQuota).toBe("user-provided-only");
    expect(accountSourceCapabilities(kind).identityVerification).toBe("unsupported");
  }
  expect(accountSourceCapabilities("fx").storedUsage).toBe("unsupported");
  expect(accountSourceCapabilities("new").liveQuota).toBe("unknown");
});
test("legacy history is idempotent, unassigned, percent-only, and does not include reason or plan text", () => {
  journalLegacyUsage(db, legacy({ reason: "Bearer SECRET", planType: "SECRET" })); journalLegacyUsage(db, legacy());
  const a = account(); core.bindHarness(a.id, "codex");
  const data = new LegacyUsageBridge(db, () => now).history();
  expect(data.observations).toHaveLength(1); expect(data.observations[0]!.accountId).toBeNull();
  expect(data.observations[0]!.meters[0]).toMatchObject({ remaining: null, indicator: { kind: "percent-used", value: 100 } });
  expect(JSON.stringify(data)).not.toContain("SECRET");
  now += 300_000; expect(new LegacyUsageBridge(db, () => now).history().observations[0]!.current).toBe(false);
});
test("stored transcript bridge reads existing rows without scanning homes or treating tokens as quota", () => {
  db.run("INSERT INTO usage_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["/private/fake-config", "2026-10-24", "fake-model", 12, 3, 0, 0, 1]);
  const data = new LegacyUsageBridge(db).tokenHistory();
  expect(data.observations[0]).toMatchObject({ accountId: null, inputTokens: 12, quota: null });
  expect(JSON.stringify(data)).not.toContain("fake-config");
});
test("portfolio projects account identity and concurrency without assigning legacy usage or historical runs", () => {
  const a = account(); core.bindHarness(a.id, "codex"); core.bindProfile(a.id, profile());
  const d = definition({ accountId: a.id, unit: { kind: "concurrency" }, window: "instant" }); observe(d.id, { limit: 2 });
  const s = subscription(); core.linkSubscription(a.id, s.id);
  const warnings: string[] = []; const resources = extendPortfolioResources(core, [base()], now, warnings);
  expect(resources).toHaveLength(2); expect(resources[0]!.accountId).toBeNull();
  expect(resources[1]).toMatchObject({ accountId: a.id, subscriptionId: s.id, concurrencyLimit: { value: 2 }, occupiedSlots: { value: 0 } });
  expect(resources[1]!.supportedModels.value).toBeNull();
  const running = base(); running.occupiedSlots.value = 1;
  expect(extendPortfolioResources(core, [running], now, [])[1]!.occupiedSlots.value).toBeNull();
  expect(accountPortfolioView(core).accounts[0]!.quotas).toHaveLength(1);
  expect(warnings.length).toBeGreaterThan(0);
});
test("declarations of model support are not confirmed discovery", () => {
  const a = account(); core.bindHarness(a.id, "codex");
  expect(core.setModelCapability(a.id, "codex", "fake-model", { support: "supported" }).verification).toBe("unverified");
  expect(extendPortfolioResources(core, [base()], now, [])[1]!.supportedModels.value).toBeNull();
  expect(() => core.setModelCapability(a.id, "codex", "fake-model", { support: "supported", verification: "verified" })).toThrow();
});
test("unbind and account archival preserve profiles, definitions and observations", () => {
  const a = account(); core.bindHarness(a.id, "codex"); core.bindProfile(a.id, profile());
  const d = definition({ accountId: a.id }); observe(d.id, { remaining: 2 });
  core.unbindHarness(a.id, "codex"); expect(core.associations(a.id)).toEqual([]);
  expect(db.query("SELECT id FROM agent_profiles").all()).toHaveLength(1);
  expect(core.history(d.id)).toHaveLength(1);
  core.archiveAccount(a.id); expect(core.listAccounts()).toEqual([]); expect(core.getAccount(a.id).archivedAt).toBe(now);
  expect(core.currentQuotas(a.id)[0]!.current).toBeNull(); expect(core.history(d.id)).toHaveLength(1);
  expect(() => core.bindHarness(a.id, "codex")).toThrow();
});
test("FKs reject orphan observations; definitions are immutable and archived, never erased", () => {
  expect(() => db.run("INSERT INTO quota_observations VALUES ('id','missing',1,'{}')")).toThrow();
  const d = definition(); observe(d.id); core.archiveDefinition(d.id);
  expect(core.definitions(d.accountId)).toEqual([]); expect(core.history(d.id)).toHaveLength(1);
  expect(() => observe(d.id)).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("history pagination preserves equal timestamps and current lookup is not page-limited", () => {
  const d = definition(); for (let i = 0; i < 205; i++) observe(d.id, { remaining: 2 });
  const first = core.historyPage(d.id), second = core.historyPage(d.id, first.nextCursor);
  expect(first.observations).toHaveLength(200); expect(second.observations).toHaveLength(5);
  expect(new Set([...first.observations, ...second.observations].map(o => o.id)).size).toBe(205);
  expect(core.currentQuotas(d.accountId)[0]!.status).toBe("current");
});
test("pure resource identity comparison distinguishes unknown, same, shared and independent", () => {
  const identity = (accountId: string | null, subscriptionIds: string[] = []) => ({ accountId, subscriptionIds, provenance: "user-provided" as const, verification: "unverified" as const, warnings: [] });
  expect(resourceRelationship(identity(null), identity("b"))).toBe("unknown");
  expect(resourceRelationship(identity("a"), identity("a"))).toBe("same-account");
  expect(resourceRelationship(identity("a", ["s"]), identity("b", ["s"]))).toBe("shared-subscription");
  expect(resourceRelationship(identity("a"), identity("b"))).toBe("unknown");
});

test("pure demand checks require the exact quota and explicit remaining count", () => {
  const d = definition(); observe(d.id, { remaining: 0 });
  const state = core.currentQuotas(d.accountId)[0]!;
  expect(assessQuotaDemand(state, { quotaId: d.id, amount: 1 })).toBe("exceeds");
  expect(assessQuotaDemand(state, { quotaId: d.id, amount: 0 })).toBe("fits");
  expect(assessQuotaDemand(state, { quotaId: "independent", amount: 1 })).toBe("unknown");
  now += 1000;
  expect(assessQuotaDemand(core.currentQuotas(d.accountId)[0]!, { quotaId: d.id, amount: 1 })).toBe("unknown");
});

test("one account concurrency cap is never duplicated into independent harness capacity", () => {
  const a = account(); core.bindHarness(a.id, "codex"); core.bindHarness(a.id, "cursor");
  const d = definition({ accountId: a.id, unit: { kind: "concurrency" }, window: "instant" }); observe(d.id, { limit: 2 });
  const rows = extendPortfolioResources(core, [base(), base("cursor")], now, []).filter(r => r.accountId === a.id);
  expect(rows).toHaveLength(2);
  expect(rows.every(r => r.concurrencyLimit.value === null)).toBe(true);
  expect(accountPortfolioView(core).accounts[0]!.quotas[0]!.current?.limit).toBe(2);
});
