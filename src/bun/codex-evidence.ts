import { createHash } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import { AccountCore, AccountCoreError } from "./account-core.ts";
import { openCodexStdio, type CodexConnection } from "./codex-stdio.ts";
import { normalizeCodexQuotas, type CodexQuotaWindow } from "./codex-quota.ts";
import {
  PROVIDER_EVIDENCE_DISCLAIMER, autoSelectionBlockers, evidenceFreshness,
  type EvidenceAuthMode, type IdentityCorrelation, type ModelScope, type ProviderEvidenceSession, type ProviderEvidenceView, type ProviderQuotaEvidence,
} from "../shared/accounts/provider-evidence.ts";

/** FO-ORCH03 Codex collector. Explicit, one-shot, read-only: `initialize`, `account/read`
 * (refreshToken=false), `model/list`, `account/rateLimits/read`. No thread, turn, login, logout,
 * token refresh or reset-credit method is ever sent, so no inference can happen. Nothing is
 * polled; the Owner presses Refresh. The result is stored as unverified observations. */
export const CODEX_EVIDENCE_METHODS = ["initialize", "account/read", "model/list", "account/rateLimits/read"] as const;
const SOURCE_ID = "codex-app-server";
const SESSION_TTL_MS = 5 * 60_000;
const MAX_MODEL_PAGES = 5, MAX_MODELS = 200;
const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;

export interface EvidenceHarness { id: string; kind: string; env: Record<string, string> }
export type EvidenceConnect = (options: { signal: AbortSignal; env: Record<string, string>; onNotification: (method: string) => void }) => CodexConnection;
export interface CodexEvidenceDeps {
  harness(id: string): EvidenceHarness | null;
  connect?: EvidenceConnect;
  now?: () => number;
  timeoutMs?: number;
}
const defaultConnect: EvidenceConnect = options => {
  // Same executable resolution as Harness discovery; the bound harness decides the CODEX_HOME.
  const fallback = process.env.AGETOR_CODEX_BIN ?? "codex";
  return openCodexStdio({ ...options, bin: Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback, timeoutMs: 12_000 });
};
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeText = (v: unknown, max = 64): string | null => typeof v === "string" && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v) ? v : null;
const fingerprint = (providerId: string) => createHash("sha256").update(`codex-account:${providerId}`).digest("hex").slice(0, 12);

export interface CodexRawReads { account: unknown; models: unknown[] | null; rateLimits: unknown | null }
export interface NormalizedCodexEvidence {
  authMode: EvidenceAuthMode; planType: string | null;
  identity: { fingerprint: string | null; correlation: IdentityCorrelation };
  catalog: ProviderEvidenceSession["catalog"];
  ordinaryUsageAllowed: boolean | null; credits: ProviderEvidenceSession["credits"];
  windows: { window: CodexQuotaWindow; bucketName: string | null; modelScope: ModelScope; reachedType: string | null }[];
  unknownReasons: string[];
}
/** Pure normalization of the three reads. Anything malformed becomes an Unknown reason, never a guess. */
export function normalizeCodexEvidence(raw: CodexRawReads, observedAt: number): NormalizedCodexEvidence {
  const unknownReasons: string[] = [];
  const out: NormalizedCodexEvidence = { authMode: "unknown", planType: null, identity: { fingerprint: null, correlation: "absent" },
    catalog: null, ordinaryUsageAllowed: null, credits: null, windows: [], unknownReasons };
  let accountProviderId: string | null = null;
  if (!obj(raw.account) || typeof raw.account.requiresOpenaiAuth !== "boolean") unknownReasons.push("Authentication state could not be read.");
  else {
    const account = raw.account.account;
    if (account === null) out.authMode = "none";
    else if (obj(account) && ["chatgpt", "apiKey", "amazonBedrock"].includes(String(account.type))) {
      out.authMode = account.type as EvidenceAuthMode;
      if (account.type === "chatgpt") out.planType = safeText(account.planType);
    } else unknownReasons.push("Authentication type is not recognised.");
    const routing = raw.account.workspaceRouting;
    if (obj(routing)) accountProviderId = safeText(routing.chatgptAccountId, 200);
  }
  if (raw.models === null) unknownReasons.push("Model catalog could not be read.");
  else {
    const ids = [...new Set(raw.models.flatMap(m => obj(m) && typeof m.id === "string" && ID.test(m.id) ? [m.id] : []))].slice(0, MAX_MODELS);
    out.catalog = { count: ids.length, modelIds: ids, note: "Catalog membership says the CLI lists the model for this login. It does not show quota or that a request will be accepted." };
  }
  if (out.authMode !== "chatgpt") {
    if (out.authMode !== "unknown") unknownReasons.push(out.authMode === "none" ? "Codex is not signed in." : "Only a ChatGPT sign-in has subscription rate limits; this authentication mode reports none.");
    return out;
  }
  if (raw.rateLimits === null) { unknownReasons.push("Rate limits could not be read."); return out; }
  const rl = raw.rateLimits;
  if (!obj(rl)) { unknownReasons.push("Rate-limit response is malformed."); return out; }
  let windows: CodexQuotaWindow[];
  try { windows = normalizeCodexQuotas(rl, observedAt); }
  catch { unknownReasons.push("Rate-limit response is malformed."); return out; }
  out.ordinaryUsageAllowed = typeof rl.ordinaryUsageAllowed === "boolean" ? rl.ordinaryUsageAllowed : null;
  const rateAccountId = safeText(rl.accountId, 200);
  if (accountProviderId && rateAccountId) {
    if (accountProviderId === rateAccountId) out.identity = { fingerprint: fingerprint(rateAccountId), correlation: "matched" };
    else { out.identity = { fingerprint: null, correlation: "mismatch" }; unknownReasons.push("Account identity differs between the account and rate-limit reads; no quota was recorded."); return out; }
  } else if (rateAccountId || accountProviderId) out.identity = { fingerprint: fingerprint((rateAccountId ?? accountProviderId)!), correlation: "absent" };
  const single = obj(rl.rateLimits) ? rl.rateLimits : null;
  if (single && obj(single.credits)) out.credits = { hasCredits: single.credits.hasCredits === true, unlimited: single.credits.unlimited === true };
  const byId = obj(rl.rateLimitsByLimitId) ? rl.rateLimitsByLimitId : null;
  const bucket = (limitId: string) => {
    const b = byId ? byId[limitId] : single && single.limitId === limitId ? single : null;
    return obj(b) ? b : {};
  };
  for (const window of windows) {
    const b = bucket(window.limitId);
    const slug = safeText(b.normalModelSlug, 128);
    if (window.sample.resetAt !== null && window.sample.resetAt <= observedAt) { unknownReasons.push(`Bucket ${window.limitId} ${window.slot} window: reported reset time already passed; ignored.`); continue; }
    out.windows.push({ window, bucketName: safeText(b.limitName, 128),
      modelScope: slug ? { kind: "confirmed", slug } : { kind: "unconfirmed" }, reachedType: typeof b.rateLimitReachedType === "string" ? safeText(b.rateLimitReachedType) : null });
  }
  if (!windows.length) unknownReasons.push("The provider reported no rate-limit window.");
  return out;
}

export class CodexEvidenceCollector {
  private sessions = new Map<string, ProviderEvidenceSession>();
  private active = false;
  private now: () => number;
  private timeoutMs: number;
  private connect: EvidenceConnect;
  constructor(private core: AccountCore, private deps: CodexEvidenceDeps) {
    this.now = deps.now ?? Date.now; this.timeoutMs = deps.timeoutMs ?? 15_000; this.connect = deps.connect ?? defaultConnect;
  }
  /** Stored observations plus the in-memory session. Reads never start a process. */
  view(accountId: string): ProviderEvidenceView {
    const account = this.core.getAccount(accountId);
    const now = this.now();
    const items = this.core.observedReadings(accountId, SOURCE_ID).flatMap(o => {
      if (!o.evidence) return [];
      const freshness = evidenceFreshness(o, now);
      return [{ quotaId: o.quotaId, evidence: o.evidence, observedAt: o.observedAt, expiresAt: o.expiresAt, resetAt: o.resetAt,
        freshness, autoSelectionBlockers: autoSelectionBlockers(o.evidence, freshness) }];
    }).sort((a, b) => a.evidence.bucketId.localeCompare(b.evidence.bucketId) || a.evidence.slot.localeCompare(b.evidence.slot));
    const session = this.sessions.get(accountId) ?? null;
    return { accountId, provider: "openai", items,
      session: session ? { ...session, freshness: session.expiresAt > now ? "fresh" : "stale" } : null,
      limitations: ["Claude Code: no read-only interface for subscription limits exists (the CLI shows them only in the interactive /usage panel), so quota stays Unknown.",
        "Antigravity: no documented machine-readable usage interface exists (only the interactive /usage panel), so quota stays Unknown.",
        ...(account.archivedAt !== null ? ["This account is archived."] : [])],
      disclaimer: PROVIDER_EVIDENCE_DISCLAIMER };
  }
  async refresh(accountId: string, input: unknown, signal?: AbortSignal): Promise<ProviderEvidenceView> {
    if (!obj(input) || input.consent !== true || Object.keys(input).some(k => k !== "consent" && k !== "harnessId")
      || input.harnessId !== undefined && typeof input.harnessId !== "string") throw new AccountCoreError("Explicit consent to start a local Codex app-server is required; only consent and harnessId are accepted.");
    const account = this.core.getAccount(accountId);
    if (account.archivedAt !== null) throw new AccountCoreError("Account is archived.", 409);
    if (account.provider !== "openai") throw new AccountCoreError("Codex evidence applies to OpenAI accounts only.");
    const bound = this.core.bindings(accountId).flatMap(b => { const h = this.deps.harness(b.harnessId); return h?.kind === "codex" ? [h] : []; });
    if (!bound.length) throw new AccountCoreError("Bind a Codex harness to this account first; that declaration is the account association.", 409);
    const harness = input.harnessId ? bound.find(h => h.id === input.harnessId) : bound.length === 1 ? bound[0] : undefined;
    if (!harness) throw new AccountCoreError(input.harnessId ? "That harness is not bound to this account." : "Several Codex harnesses are bound; choose one.");
    if (signal?.aborted) throw new AccountCoreError("Evidence collection cancelled.", 409);
    if (this.active) throw new AccountCoreError("An evidence collection is already in progress.", 409);
    this.active = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let connection: CodexConnection | null = null, authChanged = false, armed = false, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      connection = this.connect({ signal: controller.signal, env: harness.env, onNotification: method => {
        // The real app-server announces the current auth state with `account/updated` right after startup
        // (verified on 0.162.1). Only an update after `account/read` answered means the login changed mid-read.
        if (method === "account/updated" && armed) { authChanged = true; controller.abort(); }
      } });
      const conn = connection;
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => reject(new AccountCoreError(authChanged ? "Authentication changed during collection. Evidence discarded." : "Evidence collection cancelled.", 409));
        controller.signal.addEventListener("abort", stop, { once: true }); if (controller.signal.aborted) stop();
        timer = setTimeout(() => reject(new AccountCoreError("Codex evidence collection timed out.", 504)), this.timeoutMs);
      });
      aborted.catch(() => {});
      const call = async (method: (typeof CODEX_EVIDENCE_METHODS)[number], params: unknown): Promise<Record<string, unknown>> => {
        const response = await Promise.race([conn.call(method, params), aborted]) as unknown;
        if (controller.signal.aborted) throw new Error("Cancelled.");
        if (!obj(response) || "error" in response || !obj(response.result)) throw new Error("Invalid protocol response.");
        return response.result;
      };
      const work = async (): Promise<{ raw: CodexRawReads; cliVersion: string | null }> => {
        const init = await call("initialize", { clientInfo: { name: "forgeorbit", title: "ForgeOrbit", version: pkg.version } });
        if (typeof init.userAgent !== "string") throw new Error("Invalid handshake.");
        conn.notify("initialized", {});
        const cliVersion = /\/(\d+\.\d+\.\d+[\w.-]*)/.exec(init.userAgent)?.[1] ?? null;
        const account = await call("account/read", { refreshToken: false });
        armed = true;
        let models: unknown[] | null = [];
        try {
          let cursor: string | null = null;
          for (let page = 0; page < MAX_MODEL_PAGES; page++) {
            const r: Record<string, unknown> = await call("model/list", cursor ? { cursor, includeHidden: false } : { includeHidden: false });
            if (!Array.isArray(r.data)) throw new Error("Invalid model list.");
            models.push(...r.data);
            cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
            if (!cursor) break;
          }
        } catch (error) { if (error instanceof AccountCoreError || controller.signal.aborted) throw error; models = null; }
        let rateLimits: unknown | null = null;
        if (obj(account.account) && account.account.type === "chatgpt") {
          try { rateLimits = await call("account/rateLimits/read", undefined); }
          catch (error) { if (error instanceof AccountCoreError || controller.signal.aborted) throw error; }
        }
        return { raw: { account, models, rateLimits }, cliVersion };
      };
      const { raw, cliVersion } = await work();
      if (controller.signal.aborted || authChanged) throw new AccountCoreError("Authentication changed during collection. Evidence discarded.", 409);
      const observedAt = this.now();
      const normalized = normalizeCodexEvidence(raw, observedAt);
      const previous = this.core.observedReadings(accountId, SOURCE_ID).map(o => o.evidence?.identity.fingerprint).find((f): f is string => !!f);
      if (previous && normalized.identity.fingerprint && previous !== normalized.identity.fingerprint) {
        throw new AccountCoreError("The provider account behind this harness changed since the previous observation. Nothing was recorded; use a separate Account for the new login.", 409);
      }
      const quality = normalized.identity.correlation === "matched" ? "observed-correlated" as const : "observed" as const;
      this.persist(accountId, harness.id, normalized, quality, observedAt);
      this.sessions.set(accountId, { collectedAt: observedAt, expiresAt: observedAt + SESSION_TTL_MS, harnessId: harness.id, cliVersion,
        authMode: normalized.authMode, planType: normalized.planType, catalog: normalized.catalog, ordinaryUsageAllowed: normalized.ordinaryUsageAllowed,
        credits: normalized.credits, identity: normalized.identity, unknownReasons: normalized.unknownReasons });
      return this.view(accountId);
    } catch (error) {
      if (error instanceof AccountCoreError) throw error;
      if (connection?.timedOut) throw new AccountCoreError("Codex evidence collection timed out.", 504);
      if (controller.signal.aborted) throw new AccountCoreError("Evidence collection cancelled.", 409);
      // Provider text, paths and SQLite diagnostics never cross this boundary.
      throw new AccountCoreError("Codex evidence collection failed. Previous observations were retained.", 502);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      controller.abort(); connection?.close(); this.active = false;
    }
  }
  private persist(accountId: string, harnessId: string, n: NormalizedCodexEvidence, quality: "observed-correlated" | "observed", observedAt: number): void {
    if (!n.windows.length) return;
    const definitions = this.core.definitions(accountId);
    const rows = n.windows.map(({ window, bucketName, modelScope, reachedType }) => {
      const s = window.sample;
      const same = definitions.find(d => d.scope === s.scope && d.window === s.window && JSON.stringify(d.unit) === JSON.stringify(s.unit));
      const definition = same ?? this.core.createDefinition({ accountId, subscriptionId: null, scope: s.scope, unit: s.unit, window: s.window });
      if (!same) definitions.push(definition);
      const percent = s.indicator?.kind === "percent-used" ? s.indicator.value : null;
      const evidence: ProviderQuotaEvidence = { schema: 1, provider: "openai", harnessKind: "codex", harnessId,
        source: "codex app-server account/rateLimits/read", association: { basis: "owner-declared-harness-binding", identityVerified: false },
        identity: n.identity, authMode: n.authMode, planType: n.planType, bucketId: window.limitId, bucketName, modelScope, slot: window.slot,
        metric: "percent-used", rawValue: percent, unit: "percent of the reporting window", windowMins: window.durationMins, reachedType,
        exhausted: reachedType !== null ? "reported" : "not-reported", ordinaryUsageAllowed: n.ordinaryUsageAllowed, quality,
        unknownReason: percent === null ? "The provider reported no usage percentage." : null, receivedAt: observedAt };
      return { quotaId: definition.id, evidence, values: { observedAt: s.observedAt, expiresAt: s.expiresAt, resetAt: s.resetAt,
        limit: null, used: null, remaining: null, indicator: s.indicator, confidence: "medium" } };
    });
    this.core.recordObservedObservations(SOURCE_ID, rows);
  }
}
