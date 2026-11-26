import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";

/**
 * Direction 11 (quota and availability), offline. Two synthetic Codex profiles, recorded quota readings and one
 * recorded provider refusal. Nothing here calls a provider: no model, no quota source, no network. The point is that
 * registration, sign-in, entitlement, a verified reading, an Owner-reported one, a past one and an observed
 * refusal stay separate facts on every read path, and that unknown never becomes a number.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "direction11-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4719";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);

const M1 = "gpt-6.1-sol";
const M2 = "gpt-6-luna";
const HOUR = 3_600_000;
let base = "";
let token = "";
let server: { stop: () => void };
let store: typeof import("./db.ts");
let refusals: typeof import("./provider-refusals.ts");
let core: import("./account-core.ts").AccountCore;
let profiles: import("./codex-profiles.ts").CodexProfiles;
let A: { accountId: string; harnessId: string };
let B: { accountId: string; harnessId: string };
let seq = 0;

async function get(route: string): Promise<any> {
  const res = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status, route).toBe(200);
  return res.json();
}
const count = (table: string) => (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () => ({
  refusals: count("provider_refusal_observations"), answers: count("provider_last_answer"), observations: count("quota_observations"),
  definitions: count("quota_definitions"), runs: count("runs"), tasks: count("tasks"), journal: count("activity_events"),
  superseded: (store.db.query("SELECT COUNT(*) AS n FROM provider_refusal_observations WHERE superseded_at IS NOT NULL").get() as { n: number }).n,
});

function addProfile(name: string) {
  const directory = path.join(ownerHome, `profile-${++seq}`);
  writeSyntheticCodexProfile(directory, `subject-${seq}`);
  return profiles.register({ displayName: name, directory });
}

// Account A fixtures (every reading is Owner-reported unless stated; nothing is verified by a provider).
let freshPool: string, stalePool: string, emptyPool: string, exhaustedPool: string;

beforeAll(async () => {
  store = await import("./db.ts");
  refusals = await import("./provider-refusals.ts");
  const { AccountCore } = await import("./account-core.ts");
  const { CodexProfiles } = await import("./codex-profiles.ts");
  core = new AccountCore(store.db);
  profiles = new CodexProfiles(core);
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  store.harnesses.setEnabled("codex", true);
  A = addProfile("Account A");
  B = addProfile("Account B");
  await profiles.check(A.accountId);
  await profiles.check(B.accountId);
  store.harnesses.setEnabled(A.harnessId, true);
  store.harnesses.setEnabled(B.harnessId, true);

  const now = Date.now();
  const pool = (scope: string, window: string, unit: unknown = { kind: "percentage" }) =>
    core.createDefinition({ accountId: A.accountId, scope, unit, window, windowMs: 5 * HOUR }).id;
  freshPool = pool("account", "5h window");
  stalePool = pool("group:g1", "weekly window");
  emptyPool = pool(`model:${M2}`, "weekly model window", { kind: "tokens" });
  exhaustedPool = pool(`model:${M1}`, "daily window");
  core.recordObservation(freshPool, { observedAt: now - HOUR, expiresAt: now + 4 * HOUR, resetAt: now + 3 * HOUR, indicator: { kind: "percent-used", value: 40 } });
  // Owner-reported 100% used: still not a verified exhaustion, and not a balance of zero.
  core.recordObservation(exhaustedPool, { observedAt: now - HOUR, expiresAt: now + 4 * HOUR, indicator: { kind: "percent-used", value: 100 } });
  core.recordObservation(stalePool, { observedAt: now - 30 * HOUR, expiresAt: now - 6 * HOUR, indicator: { kind: "percent-used", value: 10 } });
  // `emptyPool` has no reading at all.
});

afterAll(() => { server?.stop?.(); });

describe("reading kinds stay separate", () => {
  test("quotaFact names a reading you reported, a past reading and no reading differently", async () => {
    const { quotaFact } = await import("../shared/accounts/availability.ts");
    const states = new Map(core.currentQuotas(A.accountId).map((s) => [s.definition.id, s]));
    const now = Date.now();
    expect(quotaFact(states.get(freshPool)!, now).kind).toBe("owner-reported");
    expect(quotaFact(states.get(stalePool)!, now).kind).toBe("historical");
    expect(quotaFact(states.get(stalePool)!, now).reading?.observedAt).toBeLessThan(now - 24 * HOUR);
    expect(quotaFact(states.get(emptyPool)!, now).kind).toBe("unknown");
    // The same fresh reading, judged after its expiry at display time, is the past.
    expect(quotaFact(states.get(freshPool)!, now + 6 * HOUR).kind).toBe("historical");
  });

  test("the Router context row keeps the time and source of a past reading and states capacity as Unknown", async () => {
    const context = await get("/model-router/resource-context");
    const rows = new Map<string, any>(context.accounts.find((a: any) => a.id === A.accountId).quotas.map((q: any) => [q.quotaId, q]));
    expect(rows.get(freshPool)).toMatchObject({ evidence: "owner-reported", verification: "unverified", capacityLabel: "Owner-reported — not verified capacity", lastSource: "manual" });
    expect(rows.get(stalePool)).toMatchObject({ evidence: "historical", capacityLabel: "Unknown", verification: "unknown" });
    expect(rows.get(stalePool).lastObservedAt).not.toBeNull();
    expect(rows.get(emptyPool)).toMatchObject({ evidence: "unknown", capacityLabel: "Unknown", lastObservedAt: null, lastSource: null });
    // Nothing anywhere states a balance for these.
    for (const row of rows.values()) expect(row.capacityLabel).not.toMatch(/^Verified|remaining: 0|unlimited|\bfree\b/i);
  });

  test("Router 2.0 never turns an Owner-reported, past or missing reading into verified capacity, zero or unlimited", async () => {
    const { routingQuota } = await import("./router-v2/router-v2-quota-adapters.ts");
    const now = Date.now();
    const route = (model: string) => routingQuota(core.currentQuotas(A.accountId), A.accountId, "openai", A.harnessId, model, now);
    // M1: only an Owner-reported 100% used reading applies. Not verified exhausted, not verified headroom.
    expect(route(M1)).toMatchObject({ isUnknown: true, isExhausted: false, remainingPercent: null, remainingUnits: null, capacityEvidence: "owner-reported" });
    // M2: a pool with no reading is Unknown: not zero, not exhausted.
    const m2 = route(M2);
    expect(m2).toMatchObject({ isUnknown: true, isExhausted: false, remainingPercent: null, remainingUnits: null });
    expect(m2.capacityEvidence).not.toBe("verified-headroom");
    // The same states after the fresh reading has expired: historical, never headroom.
    const later = routingQuota(core.currentQuotas(A.accountId), A.accountId, "openai", A.harnessId, M1, now + 6 * HOUR);
    expect(later.isUnknown).toBe(true);
    expect(later.capacityEvidence).not.toBe("verified-headroom");
  });

  test("a reading attributed to another account never counts for this one", async () => {
    const { routingQuota } = await import("./router-v2/router-v2-quota-adapters.ts");
    const now = Date.now();
    const d = core.createDefinition({ accountId: A.accountId, scope: "harness:" + A.harnessId, unit: { kind: "tokens" }, window: "mismatch window", windowMs: 5 * HOUR });
    core.recordTrustedObservations("fixture-source", [{
      quotaId: d.id,
      values: { observedAt: now - 1000, expiresAt: now + HOUR, remaining: 500, limit: 1000 },
      evidence: { sourceId: "fixture-source", provider: "openai", accountId: B.accountId, subject: "other", method: "provider-account", receivedAt: now, sharedPool: null } as never,
    }]);
    const result = routingQuota(core.currentQuotas(A.accountId), A.accountId, "openai", A.harnessId, M1, now);
    expect(result.capacityEvidence).not.toBe("verified-headroom");
    expect(result.remainingUnits).toBeNull();
    core.archiveDefinition(d.id);
  });

  test("Analytics lists the Owner-reported and the past reading as such and shows no verified capacity", async () => {
    const resources = await get("/api/usage-analytics/resources");
    const account = resources.accounts.find((a: any) => a.id === A.accountId);
    const fresh = account.quota.find((q: any) => q.id === freshPool);
    const stale = account.quota.find((q: any) => q.id === stalePool);
    const empty = account.quota.find((q: any) => q.id === emptyPool);
    expect(fresh.current).toBeNull();
    expect(fresh.ownerReported).toMatchObject({ provenance: "user-provided", verification: "unverified", freshness: "fresh" });
    expect(stale.current).toBeNull();
    expect(stale.ownerReported).toMatchObject({ provenance: "user-provided", freshness: "stale" });
    expect(empty).toMatchObject({ current: null, ownerReported: null, status: "unknown" });
    expect(empty.observations).toEqual([]);
  });
});

describe("a provider refusal is its own observation", () => {
  test("it stays on the recorded account and model, keeps the provider's words verbatim and is not a quota reading", async () => {
    const before = snapshot();
    const refusal = refusals.recordProviderRefusal({
      kind: "usage-limit", provider: "openai", scope: { harnessId: A.harnessId, accountId: A.accountId, modelId: M1 },
      surface: "developer-run", evidenceId: "d11-run-1", proof: "codex-cli-usage-limit",
      retryHint: "Nov 16th, 2026 9:31 PM", diagnostics: "You've hit your usage limit. Try again at Nov 16th, 2026 9:31 PM.",
      now: Date.now() - 400 * 24 * HOUR,
    });
    expect(refusal.retryHint).toBe("Nov 16th, 2026 9:31 PM");
    expect(snapshot()).toEqual({ ...before, refusals: before.refusals + 1 });
    // Another model on the same account, another account on the same model, and the plain harness are not affected.
    expect(refusals.activeProviderRefusal({ harnessId: A.harnessId, accountId: A.accountId, modelId: M2 })).toBeNull();
    expect(refusals.activeProviderRefusal({ harnessId: B.harnessId, accountId: B.accountId, modelId: M1 })).toBeNull();
    expect(refusals.activeProviderRefusal({ harnessId: "codex", accountId: null, modelId: M1 })).toBeNull();
    // A year of elapsed time does not end it.
    expect(refusals.activeProviderRefusal({ harnessId: A.harnessId, accountId: A.accountId, modelId: M1 })?.id).toBe(refusal.id);
  });

  test("a refusal does not change any quota reading, and a quota reading does not hide the refusal", async () => {
    const { routingQuota } = await import("./router-v2/router-v2-quota-adapters.ts");
    const route = () => routingQuota(core.currentQuotas(A.accountId), A.accountId, "openai", A.harnessId, M1, Date.now());
    const withRefusal = route();
    expect(withRefusal).toMatchObject({ isUnknown: true, isExhausted: false, capacityEvidence: "owner-reported" });
    const view = (await get("/account-core/codex-profiles")) as any[];
    expect(view.find((p) => p.accountId === A.accountId).providerRefusal).toMatchObject({ accountId: A.accountId, modelId: M1, retryHint: "Nov 16th, 2026 9:31 PM" });
    expect(view.find((p) => p.accountId === B.accountId).providerRefusal).toBeNull();
    // Account A is still signed in and its Owner-reported reading is still there.
    // The list is a passive read: it does not check sign-in, so it states no readiness either way.
    expect(view.find((p) => p.accountId === A.accountId).availability).not.toBe("unavailable");
    const fresh = (await get("/api/usage-analytics/resources")).accounts.find((a: any) => a.id === A.accountId).quota.find((q: any) => q.id === freshPool);
    expect(fresh.ownerReported.indicator).toEqual({ kind: "percent-used", value: 40 });
  });

  test("Router 2.0 carries the refusal for its own scope only", async () => {
    const { routerV2Service } = await import("./router-v2/router-v2-service.ts");
    const candidates = routerV2Service.gatherCandidatesSync();
    const mine = candidates.filter((c) => c.harnessId === A.harnessId && c.modelId === M1);
    const others = candidates.filter((c) => !(c.harnessId === A.harnessId && c.modelId === M1));
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect((c as any).providerRefusal?.accountId).toBe(A.accountId);
    for (const c of others) expect((c as any).providerRefusal ?? null).toBeNull();
  });
});

describe("reading is read-only", () => {
  test("opening the same screens starts no process and requests nothing, clears nothing, selects nothing and records nothing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    const invocations = path.join(root, "synthetic-invocations.jsonl");
    const logged = () => (Bun.file(invocations).size);
    const before = snapshot();
    const callsBefore = { spawn: spawn.mock.calls.length, sync: spawnSync.mock.calls.length };
    const invocationBytes = logged();
    // `fetch` is the test's own loopback client; only calls to a non-loopback host would be a provider request.
    fetchSpy.mockClear();
    for (const route of ["/model-router/resource-context", "/api/usage-analytics/resources", "/account-core/codex-profiles", `/account-core/accounts/${A.accountId}/quotas`]) await get(route);
    const outbound = fetchSpy.mock.calls.filter(([input]) => !String(typeof input === "string" ? input : (input as Request).url ?? input).startsWith("http://127.0.0.1"));
    expect(outbound).toEqual([]);
    expect(snapshot()).toEqual(before);
    // No new Codex invocation was logged by the fixture executable: reading a screen never started the CLI.
    expect(logged()).toBe(invocationBytes);
    // Nothing selected another account: both profiles and the plain harness keep their registration.
    expect(core.bindings(A.accountId).map((b) => b.harnessId)).toContain(A.harnessId);
    expect(spawn.mock.calls.length - callsBefore.spawn).toBe(0);
    expect(spawnSync.mock.calls.length - callsBefore.sync).toBe(0);
    // Settings' harness list is the one screen that runs a local `--version` for non-Codex CLIs (existing, no model,
    // no provider). It is reported separately and never touches Codex or any profile.
    const spawnedBefore = spawn.mock.calls.length + spawnSync.mock.calls.length;
    await get("/harnesses");
    const launched = [...spawn.mock.calls, ...spawnSync.mock.calls].slice(spawnedBefore).map((c) => JSON.stringify(c[0]));
    for (const argv of launched) { expect(argv).toContain("--version"); expect(argv).not.toMatch(/codex/); }
    expect(snapshot()).toEqual(before);
    fetchSpy.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore();
  });
});
