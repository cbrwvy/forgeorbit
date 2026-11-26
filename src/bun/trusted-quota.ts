import { AccountCore, AccountCoreError } from "./account-core.ts";
import { QUOTA_SOURCES, type QuotaSourceCapability, type QuotaRefreshAvailability, type QuotaPoolEvidence, type TrustedQuotaEvidence } from "../shared/accounts/quota-sources.ts";
import type { Account, QuotaDefinition, QuotaObservation } from "../shared/accounts/types.ts";

/** This proof comes from an approved server-side authorization flow, NEVER from HTTP input or a harness binding. */
export interface VerifiedQuotaBinding {
  accountId: string;
  provider: string;
  subject: string;
  verification: "verified";
  method: TrustedQuotaEvidence["method"];
}
export interface TrustedQuotaSample {
  quotaId: string;
  scope: string;
  unit: QuotaDefinition["unit"];
  window: string;
  observedAt: number;
  expiresAt: number | null;
  resetAt: number | null;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  indicator: QuotaObservation["indicator"];
  sharedPool: QuotaPoolEvidence | null;
  period?: TrustedQuotaEvidence["period"];
}
export interface TrustedQuotaResult {
  provider: string;
  sourceId: string;
  attribution: VerifiedQuotaBinding;
  samples: TrustedQuotaSample[];
}
/** No credentials, arbitrary URLs, paths or process runners in the acquisition context. */
export interface TrustedQuotaAdapter {
  sourceId: string;
  /** Local configuration only: MUST NOT perform IO or discover credentials. */
  binding(accountId: string): VerifiedQuotaBinding | null;
  acquire(context: { account: Readonly<Account>; definitions: readonly QuotaDefinition[]; signal: AbortSignal }): Promise<TrustedQuotaResult>;
}
class RefreshError extends AccountCoreError {}
/** Convert transport status to fixed public messages. Never expose response bodies or headers. */
export function quotaSourceHttpError(status: number): Error {
  if (status === 401 || status === 403) return new RefreshError("Quota source authorization was rejected. Previous observations were retained.", 403);
  if (status === 429) return new RefreshError("Quota source is rate limited. Try again later. Previous observations were retained.", 429);
  return new RefreshError("Quota source request failed. Previous observations were retained.", 502);
}
function invalid(): never { throw new RefreshError("Quota source evidence is invalid.", 422); }
const safeId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 160
  && /^[a-zA-Z0-9@._:+/-]+$/.test(s) && !/(?:sk-|eyJ|token|secret|cookie|Bearer)/i.test(s);
function validBinding(b: VerifiedQuotaBinding | null, account: Account): b is VerifiedQuotaBinding {
  return !!b && b.verification === "verified" && b.accountId === account.id && b.provider === account.provider
    && safeId(b.subject) && ["provider-account", "organization-member", "provider-organization"].includes(b.method);
}

/** Explicit refresh coordinator. Construction and reads never acquire. Production has zero approved adapters. */
export class TrustedQuotaRefresh {
  private adapters = new Map<string, TrustedQuotaAdapter>();
  private inFlight = new Set<string>();
  constructor(private core: AccountCore, adapters: readonly TrustedQuotaAdapter[] = [],
    private now: () => number = Date.now, private timeoutMs = 10_000,
    private sources: readonly QuotaSourceCapability[] = QUOTA_SOURCES) {
    for (const adapter of adapters) {
      const source = sources.find(s => s.id === adapter.sourceId);
      if (!source || source.documentation !== "documented" || source.acquisition !== "eligible-interface" || !source.officialUrl || this.adapters.has(adapter.sourceId))
        throw new Error("Only documented quota adapters may be registered.");
      this.adapters.set(adapter.sourceId, adapter);
    }
  }
  catalog(): QuotaRefreshAvailability[] {
    return this.sources.map(source => ({ ...source, implemented: this.adapters.has(source.id), adapterAvailableInCode: source.id === "cursor-org-pool" || this.adapters.has(source.id), refreshAvailable: false,
      reason: this.adapters.has(source.id) ? "Select an account to check source authorization." : source.limitations }));
  }
  private binding(adapter: TrustedQuotaAdapter | undefined, accountId: string): VerifiedQuotaBinding | null {
    try { return structuredClone(adapter?.binding(accountId) ?? null); } catch { return null; }
  }
  availability(accountId: string): QuotaRefreshAvailability[] {
    const account = this.core.getAccount(accountId);
    return this.sources.filter(s => s.provider === "*" || s.provider === account.provider).map(source => {
      const adapter = this.adapters.get(source.id);
      const binding = this.binding(adapter, accountId);
      const reason = account.archivedAt !== null ? "Account is archived." : !adapter ? source.limitations
        : !validBinding(binding, account) ? "Verified source authorization and account attribution are required."
        : this.inFlight.has(accountId) ? "Refresh already in progress." : "Ready for explicit manual refresh.";
      return { ...source, implemented: !!adapter, adapterAvailableInCode: source.id === "cursor-org-pool" || !!adapter, refreshAvailable: account.archivedAt === null && !!adapter && validBinding(binding, account) && !this.inFlight.has(accountId), reason };
    });
  }
  async refresh(accountId: string, sourceId: string) {
    const capability = this.availability(accountId).find(s => s.id === sourceId);
    if (!capability) throw new AccountCoreError("Unknown quota source for this provider.", 400);
    if (this.inFlight.has(accountId)) throw new AccountCoreError("Quota refresh already in progress.", 409);
    if (!capability.refreshAvailable) throw new AccountCoreError(`Quota refresh unavailable. ${capability.reason}`, 409);
    const adapter = this.adapters.get(sourceId)!;
    const account = this.core.getAccount(accountId);
    const binding = this.binding(adapter, accountId);
    if (!validBinding(binding, account)) invalid();
    const definitions = this.core.definitions(accountId);
    this.inFlight.add(accountId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const acquisition = Promise.resolve().then(() => adapter.acquire({ account: structuredClone(account), definitions: structuredClone(definitions), signal: controller.signal }))
      .finally(() => { settled = true; if (controller.signal.aborted) this.inFlight.delete(accountId); });
    try {
      const result = await Promise.race([
        acquisition,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RefreshError("Quota refresh timed out.", 504)); }, this.timeoutMs); }),
      ]);
      if (result.provider !== account.provider || result.sourceId !== sourceId || !validBinding(result.attribution, account)
        || result.attribution.subject !== binding.subject || result.attribution.method !== binding.method) invalid();
      const currentBinding = this.binding(adapter, accountId);
      const currentAccount = this.core.getAccount(accountId);
      if (!validBinding(currentBinding, currentAccount) || currentBinding.subject !== binding.subject || currentBinding.method !== binding.method
        || currentAccount.archivedAt !== null || JSON.stringify(currentAccount) !== JSON.stringify(account)) invalid();
      if (!Array.isArray(result.samples) || !result.samples.length || result.samples.length > 100) invalid();
      const receivedAt = this.now();
      const seen = new Set<string>();
      const rows = result.samples.map(sample => {
        const d = definitions.find(d => d.id === sample.quotaId);
        if (!d || seen.has(d.id) || sample.scope !== d.scope || sample.window !== d.window
          || !sample.unit || Object.keys(sample.unit).length !== Object.keys(d.unit).length
          || Object.entries(d.unit).some(([key, value]) => (sample.unit as unknown as Record<string, unknown>)[key] !== value)) invalid();
        seen.add(d.id);
        if (!Number.isSafeInteger(sample.observedAt) || sample.observedAt > receivedAt || sample.observedAt < 0) invalid();
        const pool = sample.sharedPool;
        if (pool !== null && (capability.poolIdentity !== "documented" || !pool || pool.verified !== true || !safeId(pool.id) || pool.scope !== d.scope || pool.window !== d.window)) invalid();
        const period = sample.period;
        if (period && ([period.startAt, period.endAt].some(t => t !== null && (!Number.isSafeInteger(t) || t < 0))
          || period.startAt !== null && period.startAt > sample.observedAt
          || period.endAt !== null && period.endAt <= sample.observedAt)) invalid();
        // Reconstruct an allowlisted payload; never persist arbitrary provider objects or errors.
        return { quotaId: d.id, values: { observedAt: sample.observedAt, expiresAt: sample.expiresAt, resetAt: sample.resetAt,
          limit: sample.limit, used: sample.used, remaining: sample.remaining, indicator: sample.indicator, confidence: "high" },
          evidence: { provider: account.provider, accountId, subject: binding.subject, method: binding.method, sourceId,
            officialUrl: capability.officialUrl!, checkedAt: capability.checkedAt, receivedAt,
            ...(period ? { period: { startAt: period.startAt, endAt: period.endAt } } : {}),
            sharedPool: pool === null ? null : { id: pool.id, scope: d.scope, window: d.window, verified: true as const }, limitations: capability.limitations } };
      });
      return { observations: this.core.recordTrustedObservations(sourceId, rows), refreshedAt: receivedAt };
    } catch (error) {
      // Provider exceptions, body text, auth errors and SQL diagnostics never cross this boundary.
      if (error instanceof RefreshError) throw error;
      throw new AccountCoreError("Quota refresh failed. Previous observations were retained.", 502);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (settled) this.inFlight.delete(accountId);
    }
  }
}
