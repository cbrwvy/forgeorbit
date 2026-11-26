import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccountCore } from "./account-core.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { LegacyUsageBridge } from "./account-usage-bridge.ts";
import { TrustedQuotaRefresh } from "./trusted-quota.ts";
import { CodexSource, type CodexConnectionFactory } from "./codex-source.ts";
import { openCodexStdio, type CodexConnection } from "./codex-stdio.ts";
import { accountHttp } from "./account-http.ts";
import { normalizeCodexQuotas } from "./codex-quota.ts";
import { assessQuotaDemand, resolveQuota } from "../shared/accounts/resolve.ts";

let db: Database, core: AccountCore, now: number;
let dir: string;
beforeEach(() => {
  now = 2_000_000;
  dir = mkdtempSync(path.join(tmpdir(), "fo009f-"));
  db = new Database(path.join(dir, "test.sqlite")); db.run("PRAGMA foreign_keys=ON"); migrate(db, migrations);
  core = new AccountCore(db, () => now);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function fixture(account: unknown = { type: "chatgpt", email: "PRIVATE@example.invalid", planType: "PRIVATE" }, extra: { hang?: boolean; badInit?: boolean; notify?: boolean; error?: boolean } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  let starts = 0, closes = 0;
  const connect: CodexConnectionFactory = options => {
    starts++;
    return { timedOut: false, close: () => { closes++; },
      notify(method, params) { calls.push({ method, params }); },
      async call(method, params) {
        calls.push({ method, params });
        if (extra.hang) return new Promise(() => {});
        if (extra.error) return { error: { message: "Bearer PRIVATE sk-PRIVATE" } };
        if (method === "initialize") return { result: extra.badInit ? {} : { userAgent: "fixture" } };
        if (extra.notify) options.onNotification("account/updated");
        return { result: { account, requiresOpenaiAuth: true, accessToken: "PRIVATE" } };
      },
    };
  };
  return { connect, calls, get starts() { return starts; }, get closes() { return closes; } };
}
const http = (source: CodexSource, method: string, route = "", value?: unknown, authorized = true) => accountHttp(
  new Request(`http://local/account-core/codex-source${route}`, { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }),
  core, new LegacyUsageBridge(db), authorized, new TrustedQuotaRefresh(core), source);

test("construction, status, dashboard reads and missing consent never spawn or fetch", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("No process"); });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("No network"); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    const source = new CodexSource();
    expect(source.snapshot().status).toBe("disconnected");
    expect((await http(source, "GET")).status).toBe(200);
    expect((await http(source, "DELETE")).status).toBe(200);
    expect((await http(source, "POST", "/inspect", { consent: false })).status).toBe(400);
    expect(spawn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); fetch.mockRestore(); }
});
test("valid handshake then non-refreshing account read, redaction, teardown and memory expiry", async () => {
  const f = fixture(); const source = new CodexSource(f.connect, () => now);
  const before = [...db.serialize()];
  const response = await http(source, "POST", "/inspect", { consent: true });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const state = await response.json() as any;
  expect(state).toMatchObject({ status: "unassigned", authentication: "chatgpt", linkedAccountId: null, binding: "unverified", refreshAvailable: false });
  expect(JSON.stringify(state)).not.toContain("PRIVATE");
  expect(f.calls.map(c => c.method)).toEqual(["initialize", "initialized", "account/read"]);
  expect(f.calls[2]!.params).toEqual({ refreshToken: false });
  expect(f.closes).toBeGreaterThan(0);
  expect([...db.serialize()]).toEqual(before);
  now += 60_000; expect(source.snapshot().status).toBe("stale");
  source.disconnect(); expect(source.snapshot()).toMatchObject({ authentication: "unknown", observedAt: null, status: "disconnected" });
});
for (const [account, authentication] of [[null, "none"], [{ type: "apiKey", apiKey: "PRIVATE" }, "apiKey"], [{ type: "amazonBedrock", credentialSource: "awsManaged" }, "amazonBedrock"]] as const) {
  test(`auth mode ${authentication} never authorizes quotas`, async () => {
    const f = fixture(account); const source = new CodexSource(f.connect, () => now);
    expect(await source.inspect(true)).toMatchObject({ authentication, binding: "unverified", refreshAvailable: false });
    expect(f.calls.some(c => c.method === "account/rateLimits/read")).toBe(false);
  });
}
test("multiple accounts, forged subjects, display names and single harness never create verified mapping", async () => {
  const a = core.createAccount({ provider: "openai", displayName: "PRIVATE", externalIdentity: "PRIVATE@example.invalid" });
  const b = core.createAccount({ provider: "openai", displayName: "PRIVATE" });
  core.bindHarness(a.id, "codex"); core.bindHarness(b.id, "codex");
  const f = fixture({ type: "chatgpt", email: a.externalIdentity, planType: "pro", workspaceName: "PRIVATE", subject: "forged-subject", id: a.id, chatgptAccountId: b.id, userId: "user-1" });
  const source = new CodexSource(f.connect, () => now);
  expect(await source.inspect(true)).toMatchObject({ linkedAccountId: null, binding: "unverified" });
  for (const account of [a,b]) {
    const coordinator = new TrustedQuotaRefresh(core);
    expect(coordinator.availability(account.id).find(s => s.id === "codex-app-server")?.refreshAvailable).toBe(false);
    await expect(coordinator.refresh(account.id, "codex-app-server")).rejects.toThrow("unavailable");
  }
  expect((await http(source, "POST", "/confirm-link", { accountId: a.id, subject: "forged" })).status).toBe(409);
  expect(core.getAccount(a.id).verification).toBe("unverified");
  expect(core.modelCapabilities(a.id)).toEqual([]);
});
test("bearer check precedes body parsing and transport; arbitrary connector configuration rejected", async () => {
  const f = fixture(); const source = new CodexSource(f.connect);
  for (const method of ["GET", "POST", "DELETE"]) expect((await http(source, method, method === "POST" ? "/inspect" : "", { token: "PRIVATE" }, false)).status).toBe(401);
  for (const extra of [{ url: "http://169.254.169.254" }, { bin: "/PRIVATE" }, { CODEX_HOME: "/PRIVATE" }, { accountId: "PRIVATE" }, { subject: "PRIVATE" }, { token: "PRIVATE" }]) {
    const res = await http(source, "POST", "/inspect", { consent: true, ...extra });
    expect(res.status).toBe(400); expect(await res.text()).not.toContain("PRIVATE");
  }
  expect((await http(source, "POST", "/inspect?consent=true", { consent: true })).status).toBe(400);
  expect((await http(source, "POST", "/inspect", { consent: true, excess: "x".repeat(17_000) })).status).toBe(413);
  expect(f.starts).toBe(0);
});
for (const extra of [{ badInit: true }, { error: true }, { notify: true }]) {
  test(`invalid protocol or auth drift discards evidence ${JSON.stringify(extra)}`, async () => {
    const f = fixture(undefined, extra); const source = new CodexSource(f.connect);
    const res = await http(source, "POST", "/inspect", { consent: true });
    expect(res.ok).toBe(false); expect(await res.text()).not.toContain("PRIVATE");
    expect(source.snapshot()).toMatchObject({ status: "error", authentication: "unknown", observedAt: null });
    expect(f.closes).toBeGreaterThan(0);
  });
}
for (const account of [{ type: "invented" }, [], "PRIVATE"]) {
  test(`unsupported account response fails closed ${JSON.stringify(account)}`, async () => {
    const source = new CodexSource(fixture(account).connect);
    await expect(source.inspect(true)).rejects.toThrow("Unable to inspect");
    expect(source.snapshot().observedAt).toBeNull();
  });
}
test("timeout, cancellation, disconnect and duplicate requests close even an uncooperative fake", async () => {
  const f = fixture(undefined, { hang: true }); const source = new CodexSource(f.connect, () => now, 10);
  const work = source.inspect(true);
  await expect(source.inspect(true)).rejects.toThrow("already in progress");
  await expect(work).rejects.toMatchObject({ status: 504 });
  expect(f.closes).toBeGreaterThan(0);
  const controller = new AbortController();
  const cancelled = source.inspect(true, controller.signal); controller.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  const disconnected = source.inspect(true); source.disconnect();
  await expect(disconnected).rejects.toThrow("cancelled");
  expect(source.snapshot().status).toBe("disconnected");
  expect(f.calls.every(c => c.method === "initialize")).toBe(true);
});
test("late handshake after cancellation cannot cause an account request or resurrect evidence", async () => {
  let finish!: (v: unknown) => void;
  const methods: string[] = [];
  const source = new CodexSource(() => ({ timedOut: false, close() {}, notify() {}, call(method) {
    methods.push(method); return new Promise(resolve => { finish = resolve; });
  } }), () => now, 5);
  await expect(source.inspect(true)).rejects.toMatchObject({ status: 504 });
  finish({ result: { userAgent: "late" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(methods).toEqual(["initialize"]); expect(source.snapshot().observedAt).toBeNull();
});

test("shared stdio transport uses JSONL, no jsonrpc header, drains interleaved messages and tears down", async () => {
  const log = path.join(dir, "wire.jsonl"), bin = path.join(dir, "fake-codex");
  writeFileSync(bin, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nfor await (const line of console) { const m = JSON.parse(line); appendFileSync(${JSON.stringify(log)}, line + '\\n'); if (m.id) { console.log(JSON.stringify({method:'ignored',params:{token:'PRIVATE'}})); console.log(JSON.stringify({id:m.id,result:m.method === 'initialize' ? {userAgent:'fake'} : {account:{type:'chatgpt',email:'PRIVATE'},requiresOpenaiAuth:true}})); } }`);
  chmodSync(bin, 0o700);
  let connection!: CodexConnection;
  const source = new CodexSource(options => connection = openCodexStdio({ ...options, bin, env: { HOME: dir }, timeoutMs: 2000 }));
  const result = await source.inspect(true);
  expect(result.authentication).toBe("chatgpt");
  const wire = readFileSync(log, "utf8").trim().split("\n").map(s => JSON.parse(s));
  expect(wire.map(m => m.method)).toEqual(["initialize", "initialized", "account/read"]);
  expect(wire.every(m => !("jsonrpc" in m))).toBe(true);
  expect(await connection.call("account/read", {})).toBeUndefined();
});

const bucket = (primary: unknown = { usedPercent: 25, windowDurationMins: 300, resetsAt: 3000 }, secondary: unknown = { usedPercent: 0, windowDurationMins: 10080, resetsAt: 9000 }) => ({ limitId: "codex", primary, secondary, rateLimitReachedType: null });
test("independent buckets and windows preserve percentages, null counts, reset seconds and unknown pools", () => {
  const windows = normalizeCodexQuotas({ rateLimits: bucket(), rateLimitsByLimitId: { codex: bucket(), other: { ...bucket(), limitId: "other" } } }, now);
  expect(windows).toHaveLength(4);
  expect(windows.map(w => [w.limitId, w.slot])).toEqual([["codex","primary"],["codex","secondary"],["other","primary"],["other","secondary"]]);
  expect(windows[0]!.sample).toMatchObject({ indicator: { kind: "percent-used", value: 25 }, resetAt: 3_000_000, expiresAt: now + 300_000, remaining: null, used: null, limit: null, sharedPool: null });
  expect(windows[1]!.sample.indicator?.value).toBe(0);
  expect(windows[0]!.sample.unit.kind).toBe("provider-specific");
});
test("legacy fallback, nullable metrics, missing data and authoritative empty multi-bucket view", () => {
  expect(normalizeCodexQuotas({ rateLimits: bucket(undefined, null) }, now)).toHaveLength(1);
  const unknown = normalizeCodexQuotas({ rateLimits: bucket({ usedPercent: null, windowDurationMins: null, resetsAt: null }, null) }, now)[0]!;
  expect(unknown.sample).toMatchObject({ indicator: null, resetAt: null, window: "primary:unknownm" });
  expect(normalizeCodexQuotas({ rateLimits: bucket(), rateLimitsByLimitId: {} }, now)).toEqual([]);
  expect(normalizeCodexQuotas({ rateLimits: { primary: {}, limitId: null } }, now)).toEqual([]);
  expect(normalizeCodexQuotas({ rateLimits: null }, now)).toEqual([]);
});
test("rate-limit accountId and ordinaryUsageAllowed do not attribute, pool or prove remaining capacity", () => {
  const payload = { accountId: "acct_backend", ordinaryUsageAllowed: true, rateLimitUpsell: { banner: "PRIVATE" }, rateLimits: bucket(), rateLimitsByLimitId: { codex: bucket() } };
  const windows = normalizeCodexQuotas(payload, now);
  expect(windows.map(w => [w.limitId, w.slot])).toEqual([["codex", "primary"], ["codex", "secondary"]]);
  expect(JSON.stringify(windows)).not.toContain("acct_backend");
  expect(JSON.stringify(windows)).not.toContain("PRIVATE");
  for (const window of windows) expect(window.sample).toMatchObject({ remaining: null, used: null, limit: null, sharedPool: null });
  expect(normalizeCodexQuotas({ accountId: null, ordinaryUsageAllowed: null, rateLimits: bucket(undefined, null) }, now)).toHaveLength(1);
  const a = core.createAccount({ provider: "openai", displayName: "fixture" });
  const d = core.createDefinition({ accountId: a.id, scope: "codex:codex", window: "primary:300m", unit: { kind: "provider-specific", name: "codex-window-percent" } });
  const observation = { ...windows[0]!.sample, id: "o", quotaId: d.id, provenance: "observed" as const, source: "fixture", verification: "unverified" as const, confidence: "unknown" as const };
  expect(assessQuotaDemand(resolveQuota(d, [observation], now), { quotaId: d.id, amount: 1 })).toBe("unknown");
  expect(new TrustedQuotaRefresh(core).availability(a.id).find(s => s.id === "codex-app-server")?.refreshAvailable).toBe(false);
});
test("expired reset is stale, conflicting evidence stays Conflict and percentages never authorize exact demand", () => {
  const a = core.createAccount({ provider: "openai", displayName: "fixture" });
  const d = core.createDefinition({ accountId: a.id, scope: "codex:codex", window: "primary:300m", unit: { kind: "provider-specific", name: "codex-window-percent" } });
  const sample = normalizeCodexQuotas({ rateLimits: bucket({ usedPercent: 99, windowDurationMins: 300, resetsAt: 1 }, null) }, now)[0]!.sample;
  const observation = { ...sample, id: "o", quotaId: d.id, provenance: "observed" as const, source: "fixture", verification: "unverified" as const, confidence: "unknown" as const };
  expect(resolveQuota(d, [observation], now).status).toBe("stale");
  const current = { ...observation, expiresAt: now + 1000, resetAt: null };
  expect(resolveQuota(d, [current, { ...current, id: "other", source: "other", indicator: { kind: "percent-used", value: 1 } }], now).status).toBe("conflict");
});
for (const response of [null, [], { rateLimitsByLimitId: [] }, { rateLimits: bucket({ usedPercent: 101 }, null) }, { rateLimits: bucket({ usedPercent: "25" }, null) }, { rateLimits: bucket({ resetsAt: 1e20 }, null) }, { rateLimits: bucket({ windowDurationMins: -5 }, null) }, { rateLimitsByLimitId: { wrong: bucket() } }, { rateLimits: { ...bucket(), limitId: "Bearer-PRIVATE" } }]) {
  test(`malformed quotas rejected without payload disclosure ${JSON.stringify(response)}`, () => {
    expect(() => normalizeCodexQuotas(response, now)).toThrow("Invalid Codex rate-limit response.");
  });
}


test("timeout reaps a fake app-server that ignores SIGTERM", async () => {
  const pidFile = path.join(dir, "fake.pid"), bin = path.join(dir, "stubborn-codex");
  // Keep startup independent of a second Bun process loading on a cold host.
  // The shell writes its own PID and blocks on builtins, with no descendants.
  writeFileSync(bin, `#!/bin/sh
trap '' TERM
printf '%s\\n' "$$" > "$FO_QUOTA_TEST_PID_FILE"
IFS= read -r first || exit
printf '%s\\n' '{"id":1,"result":{"userAgent":"fake"}}'
while IFS= read -r line; do :; done
`, { mode: 0o700 });
  const source = new CodexSource(options => openCodexStdio({
    ...options, bin, env: { HOME: dir, FO_QUOTA_TEST_PID_FILE: pidFile }, timeoutMs: 300,
  }), () => now, 500);
  await expect(source.inspect(true)).rejects.toMatchObject({ status: 504 });
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  const deadline = Date.now() + 1000;
  while (alive && Date.now() < deadline) {
    try { process.kill(pid, 0); await Bun.sleep(5); } catch { alive = false; }
  }
  expect(alive).toBe(false);
  expect(source.snapshot().authentication).toBe("unknown");
});
