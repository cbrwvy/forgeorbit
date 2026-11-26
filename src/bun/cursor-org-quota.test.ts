import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AccountCore } from "./account-core.ts";
import { cursorOrganizationQuota } from "./cursor-org-quota.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { TrustedQuotaRefresh, type VerifiedQuotaBinding } from "./trusted-quota.ts";

test("documented Cursor organization pool is read explicitly, account-bound and never treated as a personal reset", async () => {
  using db = new Database(":memory:");
  migrate(db, migrations);
  let now = Date.parse("2026-11-10T00:00:00Z");
  const core = new AccountCore(db, () => now);
  const account = core.createAccount({ provider: "cursor", displayName: "Example organization" });
  const other = core.createAccount({ provider: "cursor", displayName: "Unrelated" });
  const pool = core.createDefinition({ accountId: account.id, category: "organization-budget", scope: "account",
    unit: { kind: "provider-specific", name: "Cursor cents" }, window: "Contract" });
  const binding: VerifiedQuotaBinding = { accountId: account.id, provider: "cursor", subject: "org_demo",
    method: "provider-organization", verification: "verified" };
  let access = 0, requests = 0, status = 200;
  const adapter = cursorOrganizationQuota({
    binding: id => id === account.id ? binding : null,
    authorization: async () => { access++; return "Basic synthetic"; },
  }, (async (url: string, init: RequestInit) => {
    requests++;
    expect(url).toBe("https://api.cursor.com/organizations/pooled-usage");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: '{"organizationId":"org_demo"}' });
    if (status !== 200) return new Response("private diagnostic must not escape", { status });
    return Response.json({ pool: { limitCents: 5000000, usedCents: 1862340, remainingCents: 3137660,
      contractStartDate: "2026-01-01T00:00:00Z", contractEndDate: "2026-12-31T23:59:59Z" },
      teams: [{ teamId: 7 }], ignored: "private diagnostic must not persist" });
  }) as typeof fetch, () => now);
  const refresh = new TrustedQuotaRefresh(core, [adapter], () => now);
  expect(refresh.availability(account.id).find(s => s.id === adapter.sourceId)?.refreshAvailable).toBeTrue();
  expect(refresh.availability(other.id).find(s => s.id === adapter.sourceId)?.refreshAvailable).toBeFalse();
  expect([access, requests]).toEqual([0, 0]);
  const result = await refresh.refresh(account.id, adapter.sourceId);
  expect(result.observations[0]).toMatchObject({ used: 1862340, remaining: 3137660, resetAt: null, verification: "verified",
    acquisition: { sourceId: "cursor-org-pool", accountId: account.id, method: "provider-organization",
      period: { startAt: Date.parse("2026-01-01T00:00:00Z"), endAt: Date.parse("2026-12-31T23:59:59Z") }, sharedPool: { verified: true } } });
  expect(JSON.stringify(core.history(pool.id))).not.toContain("private diagnostic");
  for (const response of [401, 429]) {
    status = response; now++;
    expect(await refresh.refresh(account.id, adapter.sourceId).catch(e => ({ status: e.status, message: e.message })))
      .toMatchObject({ status: response === 401 ? 403 : 429, message: expect.stringContaining("Previous observations were retained") });
  }
  expect(core.history(pool.id)).toHaveLength(1);
  expect([access, requests]).toEqual([3, 3]);
});
