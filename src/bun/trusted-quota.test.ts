import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore, AccountCoreError } from "./account-core.ts";
import { TrustedQuotaRefresh, type TrustedQuotaAdapter, type TrustedQuotaResult, type TrustedQuotaSample, type VerifiedQuotaBinding } from "./trusted-quota.ts";
import { QUOTA_SOURCES } from "../shared/accounts/quota-sources.ts";
import { accountHttp } from "./account-http.ts";
import { LegacyUsageBridge, journalLegacyUsage } from "./account-usage-bridge.ts";
import { accountPortfolioView, portfolioQuota } from "./account-portfolio.ts";
import type { Account, QuotaDefinition } from "../shared/accounts/types.ts";

let db: Database, core: AccountCore, now: number, a: Account, d: QuotaDefinition;
let acquire: () => Promise<TrustedQuotaResult>, binding: VerifiedQuotaBinding | null, calls: number;
const sourceId = "codex-app-server";
let adapter: TrustedQuotaAdapter;
beforeEach(() => {
  now = 1_000_000; calls = 0;
  db = new Database(":memory:"); db.run("PRAGMA foreign_keys=ON"); migrate(db, migrations);
  core = new AccountCore(db, () => now);
  a = core.createAccount({ provider: "openai", displayName: "Declared", externalIdentity: "declared@example.invalid" });
  d = definition("primary");
  binding = { accountId: a.id, provider: "openai", subject: "subject-1", verification: "verified", method: "provider-account" };
  acquire = async () => result();
  adapter = { sourceId, binding: () => binding, acquire: async () => { calls++; return acquire(); } };
});
afterEach(() => db.close());
function definition(window: string, accountId = a.id) {
  return core.createDefinition({ accountId, scope: "account", unit: { kind: "tokens" }, window });
}
function sample(def = d, extra: Partial<TrustedQuotaSample> = {}): TrustedQuotaSample {
  return { quotaId: def.id, scope: def.scope, unit: def.unit, window: def.window, observedAt: now, expiresAt: now + 1000,
    resetAt: null, limit: null, used: null, remaining: null, indicator: null, sharedPool: null, ...extra };
}
function result(samples = [sample()]): TrustedQuotaResult { return { sourceId, provider: "openai", attribution: binding!, samples }; }
const service = (timeout = 100) => new TrustedQuotaRefresh(core, [adapter], () => now, timeout);
const http = (refresh: TrustedQuotaRefresh, method: string, route: string, value?: unknown, auth = true) => accountHttp(
  new Request(`http://localhost/account-core${route}`, { method, body: value === undefined ? undefined : JSON.stringify(value) }), core, new LegacyUsageBridge(db), auth, refresh);

test("documentation is distinct from implementation and unsupported sources cannot register", async () => {
  const production = new TrustedQuotaRefresh(core);
  expect(production.availability(a.id).find(s => s.id === sourceId)).toMatchObject({ documentation: "documented", implemented: false, refreshAvailable: false });
  expect(QUOTA_SOURCES.find(s => s.id === "gemini-cli")?.documentation).toBe("unsupported");
  expect(QUOTA_SOURCES.find(s => s.id === "manual")?.documentation).toBe("user-provided-only");
  for (const id of ["gemini-cli", "manual", "fx", "unknown"]) expect(() => new TrustedQuotaRefresh(core, [{ ...adapter, sourceId: id }])).toThrow();
  await expect(production.refresh(a.id, sourceId)).rejects.toMatchObject({ status: 409 });
  await expect(production.refresh(a.id, "https://127.0.0.1")).rejects.toMatchObject({ status: 400 });
  expect(calls).toBe(0);
});
test("reads, construction and a single declared harness binding perform zero acquisition or IO", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("Unexpected paid request"); }, { preconnect: globalThis.fetch.preconnect }));
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected CLI"); });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("Unexpected CLI"); });
  try {
    binding = null; core.bindHarness(a.id, "codex"); const s = service();
    expect(s.availability(a.id).every(s => !s.refreshAvailable)).toBe(true);
    expect(core.resolveIdentity("codex").accountId).toBeNull();
    for (const route of ["/quota-sources", "/capabilities", `/accounts/${a.id}/quota-sources`, `/accounts/${a.id}/quotas`]) expect((await http(s,"GET",route)).status).toBe(200);
    await expect(s.refresh(a.id, sourceId)).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(0); expect(fetch).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore(); }
});
test("explicit refresh persists verified attribution without upgrading declared identity or CLI auth", async () => {
  const before = core.getAccount(a.id);
  acquire = async () => result([sample(d, { remaining: 0 })]);
  const response = await http(service(), "POST", `/accounts/${a.id}/quota-refresh`, { sourceId });
  expect(response.status).toBe(200); expect(calls).toBe(1);
  expect(core.currentQuotas(a.id)[0]!.current).toMatchObject({ source: `trusted:${sourceId}`, remaining: 0, provenance: "verified", acquisition: { accountId: a.id, subject: "subject-1", sourceId, receivedAt: now } });
  expect(core.getAccount(a.id)).toEqual(before); expect(core.resolveIdentity("codex").accountId).toBeNull();
  expect(accountPortfolioView(core).accounts[0]!.quotas[0]!.current?.remaining).toBe(0);
});
for (const kind of ["percent-used", "percent-remaining"] as const) test(`${kind} stays typed, multiple windows never produce a balance`, async () => {
  const secondary = definition("secondary");
  acquire = async () => result([sample(d, { indicator: { kind, value: 73 } }), sample(secondary, { indicator: { kind, value: 21 } })]);
  await service().refresh(a.id, sourceId);
  expect(core.currentQuotas(a.id)).toHaveLength(2);
  expect(core.currentQuotas(a.id).every(q => q.current?.remaining === null && q.current?.indicator?.kind === kind)).toBe(true);
  expect(portfolioQuota(core.currentQuotas(a.id)).quota.kind).toBe("unknown");
});
test("expiry, missing TTL and passed reset never imply replenishment; stale refresh is historical", async () => {
  const s = service(); await s.refresh(a.id, sourceId); now += 1001;
  expect(core.currentQuotas(a.id)[0]!.status).toBe("stale");
  acquire = async () => result([sample(d, { expiresAt: null, remaining: 10 })]); await s.refresh(a.id, sourceId);
  expect(core.currentQuotas(a.id)[0]!.current).toBeNull();
  now++; acquire = async () => result([sample(d, { resetAt: now + 2, remaining: 10 })]); await s.refresh(a.id, sourceId); now += 3;
  expect(core.currentQuotas(a.id)[0]!.status).toBe("stale"); expect(core.history(d.id)).toHaveLength(3);
});
test("superseded responses and timestamp ties cannot overwrite newer source evidence", async () => {
  const s = service(); await s.refresh(a.id, sourceId);
  const saved = core.history(d.id); now++;
  for (const observedAt of [now - 1, now - 2]) {
    acquire = async () => result([sample(d, { observedAt, remaining: 99 })]);
    await expect(s.refresh(a.id, sourceId)).rejects.toMatchObject({ status: 502 });
    expect(core.history(d.id)).toEqual(saved);
  }
});
test("verified source conflicts with manual facts instead of silently replacing them", async () => {
  core.recordObservation(d.id, { remaining: 1, expiresAt: now + 1000 });
  acquire = async () => result([sample(d, { remaining: 2 })]); await service().refresh(a.id, sourceId);
  expect(core.currentQuotas(a.id)[0]!.status).toBe("conflict"); expect(core.currentQuotas(a.id)[0]!.current).toBeNull();
});
test("pool identity is explicit and namespaced evidence; no subscription-based pooling or portfolio summation", async () => {
  const pool = { id: "org-pool-1", scope: d.scope, window: d.window, verified: true as const };
  acquire = async () => result([sample(d, { sharedPool: pool, remaining: 5 })]); await new TrustedQuotaRefresh(core, [adapter], () => now, 100,
    QUOTA_SOURCES.map(s => s.id === sourceId ? { ...s, poolIdentity: "documented" } : s)).refresh(a.id, sourceId);
  expect(core.history(d.id)[0]!.acquisition?.sharedPool).toEqual(pool);
  expect(portfolioQuota(core.currentQuotas(a.id)).quota.kind).toBe("unknown");
  const second = core.createAccount({ provider: "openai", displayName: "Declared" }); const secondQuota = definition("primary", second.id);
  expect(core.currentQuotas(second.id)[0]!.current).toBeNull();
  binding = { ...binding!, accountId: second.id, subject: "subject-2" };
  acquire = async () => result([sample(secondQuota, { sharedPool: pool, remaining: 5 })]);
  await new TrustedQuotaRefresh(core, [adapter], () => now, 100,
    QUOTA_SOURCES.map(s => s.id === sourceId ? { ...s, poolIdentity: "documented" } : s)).refresh(second.id, sourceId);
  expect(core.currentQuotas(second.id)[0]!.current?.acquisition?.sharedPool?.id).toBe(pool.id);
  expect(portfolioQuota(core.currentQuotas(second.id)).quota.kind).toBe("unknown");
  expect(accountPortfolioView(core).accounts).toHaveLength(2);
});
test("duplicate refresh rejects while a single acquisition is pending", async () => {
  let finish!: (r: TrustedQuotaResult) => void; acquire = () => new Promise(resolve => { finish = resolve; });
  const s = service(); const pending = s.refresh(a.id, sourceId); await Promise.resolve(); await Promise.resolve();
  await expect(s.refresh(a.id, sourceId)).rejects.toMatchObject({ status: 409 }); expect(calls).toBe(1);
  finish(result()); await pending; expect(s.availability(a.id).find(s => s.id === sourceId)?.refreshAvailable).toBe(true);
});
test("timeout aborts, keeps the duplicate guard until settlement and late result never writes", async () => {
  let finish!: (r: TrustedQuotaResult) => void, signal!: AbortSignal;
  adapter.acquire = async ctx => { calls++; signal = ctx.signal; return new Promise(resolve => { finish = resolve; }); };
  const s = service(5); await expect(s.refresh(a.id, sourceId)).rejects.toMatchObject({ status: 504 });
  expect(signal.aborted).toBe(true); await expect(s.refresh(a.id, sourceId)).rejects.toMatchObject({ status: 409 });
  finish(result()); await Bun.sleep(1); expect(core.history(d.id)).toEqual([]);
  expect(s.availability(a.id).find(s => s.id === sourceId)?.refreshAvailable).toBe(true);
});
test("provider errors including forged core errors do not expose body, credentials, URLs or paths", async () => {
  for (const err of [new Error("Bearer SECRET /home/auth.json https://internal"), new AccountCoreError("Bearer SECRET", 422)]) {
    acquire = async () => { throw err; }; const response = await http(service(),"POST",`/accounts/${a.id}/quota-refresh`,{ sourceId });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("SECRET"); expect(core.history(d.id)).toEqual([]);
  }
});
test("source/provider/identity/definition mismatch and invalid data reject the entire batch", async () => {
  const secondary = definition("secondary"); const other = core.createAccount({ provider: "openai", displayName: "Other" }); const foreign = definition("primary",other.id);
  const cases: TrustedQuotaResult[] = [
    { ...result(), provider: "other" }, { ...result(), sourceId: "manual" },
    { ...result(), attribution: { ...binding!, subject: "other" } }, { ...result(), attribution: { ...binding!, accountId: other.id } },
    result([sample(foreign)]), result([sample(d), sample(d)]), result([sample(d),sample(secondary,{ window: "primary" })]),
    result([sample(d),sample(secondary,{ unit: { kind: "requests" } })]), result([sample(d),sample(secondary,{ remaining: -1 })]),
    result([sample(d,{ observedAt: now+1 })]), result([sample(d,{ sharedPool: { id:"Bearer-SECRET",scope:d.scope,window:d.window,verified:true } })]),
    result([sample(d,{ indicator:{kind:"percent-used",value:101} })]), result([sample(d,{ resetAt: now-1 })]),
  ];
  for (const r of cases) { acquire = async () => r; await expect(service().refresh(a.id,sourceId)).rejects.toBeInstanceOf(AccountCoreError); expect(core.history(d.id)).toEqual([]); expect(core.history(secondary.id)).toEqual([]); }
});
test("identity revocation or account/archive changes during acquisition fail closed", async () => {
  for (const mutate of [() => { binding = null; }, () => { core.updateAccount(a.id,{ externalIdentity:"changed@example.invalid" }); }, () => core.archiveDefinition(d.id), () => core.archiveAccount(a.id)]) {
    binding = { accountId:a.id,provider:a.provider,subject:"subject-1",verification:"verified",method:"provider-account" };
    acquire = async () => { const r = result(); mutate(); return r; };
    await expect(service().refresh(a.id,sourceId)).rejects.toBeInstanceOf(AccountCoreError); expect(core.history(d.id)).toEqual([]);
  }
});
test("bearer permission precedes parsing; refresh accepts only exact sourceId and rejects URL/path inputs", async () => {
  const s = service();
  for (const route of ["/quota-sources", `/accounts/${a.id}/quota-sources`, `/accounts/${a.id}/quota-refresh`]) expect((await http(s,"POST",route,{ sourceId },false)).status).toBe(401);
  for (const body of [{ sourceId,url:"http://169.254.169.254" }, { sourceId,tokenPath:"../../auth.json" }, { sourceId,credentials:"SECRET" }, { sourceId:"../../auth.json" }, { provider:"openai" }]) {
    const response = await http(s,"POST",`/accounts/${a.id}/quota-refresh`,body); expect(response.status).toBe(400); expect(await response.text()).not.toContain("SECRET");
  }
  expect((await http(s,"POST",`/accounts/${a.id}/quota-refresh?url=http://localhost`,{sourceId})).status).toBe(400); expect(calls).toBe(0);
});
test("legacy history remains unassigned after trusted refresh and metadata bindings", async () => {
  journalLegacyUsage(db,{harnessId:"codex",kind:"codex",planType:null,source:"api",status:"ok",reason:null,fetchedAtMs:now,meters:[{id:"weekly",label:"Weekly",usedPercent:10,resetsAtMs:null}]});
  const before = new LegacyUsageBridge(db).history(); core.bindHarness(a.id,"codex"); await service().refresh(a.id,sourceId);
  expect(new LegacyUsageBridge(db).history()).toEqual(before); expect(before.observations[0]!.accountId).toBeNull();
});

test("undeclared pools, unverified attribution and credential-bearing payloads fail closed", async () => {
  const s = service();
  acquire = async () => result([sample(d,{sharedPool:{id:"pool-1",scope:d.scope,window:d.window,verified:true}})]);
  await expect(s.refresh(a.id,sourceId)).rejects.toMatchObject({status:422});
  binding = {...binding!, verification:"unverified" as "verified"};
  expect(s.availability(a.id).find(s => s.id === sourceId)?.refreshAvailable).toBe(false);
  await expect(s.refresh(a.id,sourceId)).rejects.toMatchObject({status:409});
  binding = {...binding!,verification:"verified"};
  acquire = async () => ({...result(), credentials:"SECRET", samples:[{...sample(),rawResponse:{secret:"SECRET"}}]});
  await s.refresh(a.id,sourceId);
  expect(JSON.stringify(core.history(d.id))).not.toContain("SECRET");
  expect(() => core.recordObservation(d.id,{source:"trusted:fake",acquisition:{subject:"SECRET"}})).toThrow();
});
