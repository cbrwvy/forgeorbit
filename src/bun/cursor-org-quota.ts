import { quotaSourceHttpError, type TrustedQuotaAdapter, type VerifiedQuotaBinding } from "./trusted-quota.ts";

const endpoint = "https://api.cursor.com/organizations/pooled-usage";
const maxBytes = 1_048_576;

/** Provided only by a future separately authorized server-side credential/binding service.
 * The API itself requires the supplied organizationId to match the organization key. */
export interface CursorOrganizationAccess {
  binding(accountId: string): VerifiedQuotaBinding | null;
  authorization(binding: Readonly<VerifiedQuotaBinding>, signal: AbortSignal): Promise<string | null>;
}

async function readPool(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response.");
  const decoder = new TextDecoder();
  let json = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("Oversized response."); }
      json += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const pool = JSON.parse(json + decoder.decode())?.pool;
  if (!pool || !Number.isSafeInteger(pool.limitCents) || pool.limitCents < 0 ||
    !Number.isSafeInteger(pool.usedCents) || pool.usedCents < 0 ||
    !Number.isSafeInteger(pool.remainingCents) || pool.remainingCents !== pool.limitCents - pool.usedCents)
    throw new Error("Invalid pool response.");
  const date = (value: unknown) => {
    if (value === null) return null;
    const result = typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(result)) throw new Error("Invalid contract date.");
    return result;
  };
  return { limit: pool.limitCents as number, used: pool.usedCents as number, remaining: pool.remainingCents as number,
    startAt: date(pool.contractStartDate), endAt: date(pool.contractEndDate) };
}

/** Documented read-only POST. Construction performs no I/O. Intentionally not registered in production. */
export function cursorOrganizationQuota(access: CursorOrganizationAccess, request = globalThis.fetch, now = Date.now): TrustedQuotaAdapter {
  const binding = (accountId: string) => {
    const b = access.binding(accountId);
    return b?.method === "provider-organization" && b.provider === "cursor" && b.accountId === accountId &&
      /^org_[a-zA-Z0-9_-]+$/.test(b.subject) ? b : null;
  };
  return {
    sourceId: "cursor-org-pool",
    binding,
    async acquire({ account, definitions, signal }) {
      const attribution = binding(account.id);
      const matches = definitions.filter(d => d.category === "organization-budget" && d.scope === "account" &&
        d.unit.kind === "provider-specific" && d.unit.name === "Cursor cents" && d.window === "Contract");
      if (!attribution || matches.length !== 1) throw new Error("Organization pool binding required.");
      const d = matches[0]!;
      const authorization = await access.authorization(attribution, signal);
      if (!authorization) throw quotaSourceHttpError(403);
      signal.throwIfAborted();
      const response = await request(endpoint, { method: "POST", redirect: "error", signal,
        headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ organizationId: attribution.subject }) });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw quotaSourceHttpError(response.status);
      }
      const pool = await readPool(response);
      const observedAt = now();
      return { sourceId: "cursor-org-pool", provider: "cursor", attribution,
        samples: [{
          quotaId: d.id, scope: d.scope, window: d.window, unit: d.unit, observedAt,
          expiresAt: Math.min(observedAt + 60 * 60_000, pool.endAt ?? Infinity),
          resetAt: null, limit: pool.limit, used: pool.used, remaining: pool.remaining < 0 ? null : pool.remaining, indicator: null,
          period: { startAt: pool.startAt, endAt: pool.endAt },
          sharedPool: pool.startAt !== null && pool.endAt !== null
            ? { id: `${attribution.subject}:${pool.startAt}:${pool.endAt}`, scope: d.scope, window: d.window, verified: true } : null,
        }] };
    },
  };
}
