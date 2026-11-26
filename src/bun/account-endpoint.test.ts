import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = mkdtempSync(path.join(tmpdir(), "fo009a-api-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_API_PORT = "4697";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo009a-cli";
let server: ReturnType<typeof import("./server.ts")["startApiServer"]>;
let token: string;
let db: typeof import("./db.ts");
let spawn: ReturnType<typeof spyOn>, spawnSync: ReturnType<typeof spyOn>, fetchGuard: ReturnType<typeof spyOn>;
let externalCalls = 0;
const base = "http://127.0.0.1:4697";
beforeAll(async () => {
  spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected process"); });
  spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("Unexpected process"); });
  const fetchOriginal = globalThis.fetch;
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/`)) { externalCalls++; throw new Error("Unexpected external request"); }
    return fetchOriginal(input, init);
  }) as typeof fetch);
  db = await import("./db.ts");
  const backend = await import("./server.ts"); token = backend.API_TOKEN; server = backend.startApiServer();
});
afterAll(() => { server?.stop(true); spawn?.mockRestore(); spawnSync?.mockRestore(); fetchGuard?.mockRestore(); });
async function call(method: string, route: string, value?: unknown, authorization: string | null = `Bearer ${token}`) {
  const res = await fetch(`${base}/account-core${route}`, { method,
    headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: res.status, json: await res.json() as any };
}
test("every account endpoint requires an exact bearer token; query token cannot authorize mutations", async () => {
  for (const [method, route] of [["GET", "/accounts"], ["POST", "/accounts"], ["GET", "/accounts/id"], ["PATCH", "/accounts/id"], ["DELETE", "/accounts/id"],
    ["POST", "/accounts/id/harnesses"], ["DELETE", "/accounts/id/harnesses/codex"], ["POST", "/accounts/id/profiles"], ["DELETE", "/accounts/id/profiles/p"],
    ["GET", "/subscriptions"], ["POST", "/subscriptions"], ["PATCH", "/subscriptions/id"], ["DELETE", "/subscriptions/id"],
    ["POST", "/accounts/id/subscriptions"], ["DELETE", "/accounts/id/subscriptions/s"], ["POST", "/quotas"], ["GET", "/accounts/id/quotas"],
    ["GET", "/quotas/id/observations"], ["POST", "/quotas/id/observations"], ["DELETE", "/quotas/id"], ["GET", "/capabilities"], ["GET", "/legacy-usage"], ["GET", "/legacy-tokens"], ["GET", "/identity"], ["GET", "/quota-sources"], ["GET", "/accounts/id/quota-sources"], ["POST", "/accounts/id/quota-refresh"]]) {
    for (const auth of [null, "Bearer wrong", `bearer ${token}`]) expect((await call(method!, route!, undefined, auth)).status).toBe(401);
    expect((await call(method!, `${route}?token=${token}`, undefined, null)).status).toBe(401);
  }
});
test("CRUD, bindings, subscription, quotas, history and archive work through the existing server", async () => {
  expect((await call("GET", "/accounts")).json).toEqual([]);
  const created = await call("POST", "/accounts", { provider: "openai", displayName: "Fixture", externalIdentity: "fixture@example.invalid" });
  expect(created.status).toBe(201); const a = created.json.id;
  expect(created.json.verification).toBe("unverified");
  expect((await call("PATCH", `/accounts/${a}`, { displayName: "Renamed" })).json.displayName).toBe("Renamed");
  expect((await call("POST", `/accounts/${a}/harnesses`, { harnessId: "codex" })).status).toBe(201);
  const profile = db.agentProfiles.insert({ name: "FO009 fixture", harness: "codex", model: "fake-model" });
  const profileBefore = db.agentProfiles.get(profile.id);
  expect((await call("POST", `/accounts/${a}/profiles`, { profileId: profile.id })).status).toBe(201);
  expect((await call("GET", `/identity?harnessId=codex&profileId=${profile.id}`)).json.accountId).toBe(a);
  expect(db.agentProfiles.get(profile.id)).toEqual(profileBefore);
  const sub = (await call("POST", "/subscriptions", { provider: "openai", planLabel: "Test", currency: "USD", recurringCostMinor: 2000, billingPeriod: "month" })).json;
  expect((await call("POST", `/accounts/${a}/subscriptions`, { subscriptionId: sub.id })).status).toBe(201);
  const quota = (await call("POST", "/quotas", { accountId: a, subscriptionId: sub.id, scope: "account", unit: { kind: "requests" }, window: "unknown" })).json;
  expect((await call("POST", `/quotas/${quota.id}/observations`, { remaining: 0, expiresAt: Date.now() + 10_000 })).status).toBe(201);
  expect((await call("GET", `/accounts/${a}/quotas`)).json[0].current.remaining).toBe(0);
  expect((await call("GET", `/quotas/${quota.id}/observations`)).json.observations).toHaveLength(1);
  expect((await call("GET", `/accounts/${a}/definitions`)).json).toHaveLength(1);
  expect((await call("GET", `/subscriptions/${sub.id}`)).json.id).toBe(sub.id);
  const res = await fetch(`${base}/portfolio/analysis`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const portfolio = await res.json() as any;
  expect(portfolio.accountResources.accounts.find((row: any) => row.account.id === a).quotas[0].current.remaining).toBe(0);
  expect(portfolio.snapshot.resources.some((row: any) => row.accountId === a && row.subscriptionId === sub.id)).toBe(true);
  expect((await call("DELETE", `/accounts/${a}/harnesses/codex`)).status).toBe(200);
  expect((await call("GET", `/accounts/${a}/profiles`)).json).toEqual([]);
  expect((await call("DELETE", `/accounts/${a}`)).status).toBe(200);
  expect((await call("GET", `/quotas/${quota.id}/observations`)).json.observations).toHaveLength(1);
  expect((await call("GET", "/accounts")).json).toEqual([]);
  expect((await call("GET", "/accounts?archived=true")).json).toHaveLength(1);
});
test("secret/config fields and forged provenance are rejected without echoing request content", async () => {
  for (const extra of [{ credentials: "SECRET" }, { home: "/SECRET/path" }, { token: "SECRET" }, { provenance: "verified" }, { verification: "verified" }, { displayName: "Bearer SECRET" }]) {
    const res = await call("POST", "/accounts", { provider: "fixture", displayName: "Test", ...extra });
    expect(res.status).toBe(400); expect(JSON.stringify(res.json)).not.toContain("SECRET");
  }
  expect((await call("POST", "/accounts", { provider: "x", displayName: "x".repeat(17000) })).status).toBe(413);
  expect((await call("GET", "/legacy-usage?before=bad")).status).toBe(400);
  expect((await call("POST", "/shell", { command: "ignored" })).status).toBe(404);
});
test("legacy upserts atomically journal history and survive cache deletion without assigning identity", async () => {
  const quota = { harnessId: "codex", kind: "codex" as const, planType: "SECRET", source: "cache" as const, status: "ok" as const, reason: "SECRET", fetchedAtMs: Date.now(), meters: [{ id: "session", label: "SECRET", usedPercent: 80, resetsAtMs: null }] };
  db.harnessUsage.upsert(quota); db.harnessUsage.upsert(quota);
  expect(db.harnessUsage.get("codex")).toEqual(quota);
  const response = await call("GET", "/legacy-usage");
  expect(response.json.observations).toHaveLength(1); expect(response.json.observations[0].accountId).toBeNull();
  expect(response.json.observations[0].source).toBe("cache");
  expect(JSON.stringify(response.json)).not.toContain("SECRET");
  db.harnessUsage.delete("codex");
  expect((await call("GET", "/legacy-usage")).json.observations).toHaveLength(1);
});
test("usage history and compatibility cache roll back together on write failure", () => {
  const before = db.db.query("SELECT * FROM harness_usage_history").all();
  db.db.run("CREATE TEMP TRIGGER reject_usage BEFORE INSERT ON harness_usage BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  try {
    expect(() => db.harnessUsage.upsert({ harnessId: "codex", kind: "codex", planType: null, source: "api", status: "ok", reason: null, fetchedAtMs: Date.now()+1, meters: [] })).toThrow();
    expect(db.db.query("SELECT * FROM harness_usage_history").all()).toEqual(before);
    expect(db.harnessUsage.get("codex")).toBeNull();
  } finally { db.db.run("DROP TRIGGER reject_usage"); }
});
test("account operations never spawn a process, probe a real CLI or make a paid/external request", () => {
  expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled(); expect(externalCalls).toBe(0);
});

test("real backend publishes audited sources and fails closed for unimplemented refresh", async () => {
  const a = (await call("POST", "/accounts", { provider: "openai", displayName: "Quota sources" })).json;
  const sources = await call("GET", `/accounts/${a.id}/quota-sources`);
  expect(sources.status).toBe(200);
  expect(sources.json.find((s: any) => s.id === "codex-app-server")).toMatchObject({ documentation: "documented", implemented: false, refreshAvailable: false });
  expect((await call("POST", `/accounts/${a.id}/quota-refresh`,{sourceId:"codex-app-server"})).status).toBe(409);
  expect((await call("POST", `/accounts/${a.id}/quota-refresh`,{sourceId:"cursor-admin"})).status).toBe(400);
  expect((await call("POST", `/accounts/${a.id}/quota-refresh`,{sourceId:"codex-app-server",url:"http://169.254.169.254"})).status).toBe(400);
  expect((await call("GET","/quota-sources")).json.map((row: { id: string }) => row.id)).toContain("deepseek-api-balance");
  expect(externalCalls).toBe(0); expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled();
});
