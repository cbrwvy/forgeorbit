import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore } from "./account-core.ts";
import { accountHttp } from "./account-http.ts";
import { LegacyUsageBridge } from "./account-usage-bridge.ts";
import { CODEX_EVIDENCE_METHODS, CodexEvidenceCollector, normalizeCodexEvidence, type EvidenceConnect } from "./codex-evidence.ts";
import { resolveQuota } from "../shared/accounts/resolve.ts";
import { autoSelectionBlockers, evidenceFreshness } from "../shared/accounts/provider-evidence.ts";
import { EMPTY_MODEL_EVIDENCE, UNKNOWN_OWNER_CONSTRAINTS, routeTask } from "../shared/model-router/route.ts";
import { analyzeTaskRequirements } from "../shared/model-router/requirements.ts";
import type { Account, QuotaDefinition, QuotaObservation } from "../shared/accounts/types.ts";
import type { ResourceCandidate, RoutingSnapshot, VerifiedFact } from "../shared/model-router/types.ts";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Must precede the dynamic import: importing the production DB module never opens the real data directory.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-orch03-"));
process.env.AGETOR_USAGE_OFFLINE = "1";
const { buildRoutingSnapshot } = await import("./model-router.ts");

const EMAIL = "secret.person@example.invalid", PROVIDER_ID = "acct-SECRET-123";
let db: Database, core: AccountCore, now: number, account: Account, log: string[], closed: number;
let script: Record<string, unknown>;
const resetSec = () => Math.floor(now / 1000) + 3600;
const bucket = (limitId: string, extra: Record<string, unknown> = {}) => ({ limitId, limitName: null, normalModelSlug: null,
  primary: { usedPercent: 86, windowDurationMins: 300, resetsAt: resetSec() },
  secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: resetSec() + 86400 },
  credits: { hasCredits: false, unlimited: false, balance: "0" }, individualLimit: null, spendControlReached: false, planType: "plus", rateLimitReachedType: null, ...extra });
const rateLimits = (extra: Record<string, unknown> = {}, buckets: Record<string, unknown> = { codex: bucket("codex") }) => ({
  ordinaryUsageAllowed: true, rateLimits: bucket("codex"), rateLimitsByLimitId: buckets, rateLimitResetCredits: { availableCount: 0, credits: [] },
  accountId: PROVIDER_ID, rateLimitUpsell: null, ...extra });
const accountRead = (extra: Record<string, unknown> = {}) => ({ account: { type: "chatgpt", email: EMAIL, planType: "plus" }, requiresOpenaiAuth: true,
  workspaceRouting: { chatgptAccountId: PROVIDER_ID, backendOrigin: "https://chatgpt.com" }, ...extra });
beforeEach(() => {
  now = 1_800_000_000_000; log = []; closed = 0;
  db = new Database(":memory:"); db.run("PRAGMA foreign_keys=ON"); migrate(db, migrations);
  core = new AccountCore(db, () => now);
  account = core.createAccount({ provider: "openai", displayName: "Declared codex" });
  core.bindHarness(account.id, "codex");
  script = { initialize: { userAgent: "codex_cli_rs/0.162.1 (Mac OS)" }, "account/read": accountRead(),
    "model/list": { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }], nextCursor: null }, "account/rateLimits/read": rateLimits() };
});
afterEach(() => db.close());
const connect = (hang = false): EvidenceConnect => () => ({
  timedOut: false, close: () => { closed++; }, notify: (m: string) => { log.push(`notify:${m}`); },
  call: async (method: string) => {
    log.push(method);
    const r = script[method];
    if (hang) return new Promise(() => {});
    if (r === undefined || r === "error") return { id: 1, error: { message: `boom ${EMAIL}` } };
    return { id: 1, result: r };
  },
});
const collector = (opts: { hang?: boolean; timeoutMs?: number } = {}) => new CodexEvidenceCollector(core, {
  harness: id => id === "codex" ? { id, kind: "codex", env: {} } : null, connect: connect(opts.hang), now: () => now, timeoutMs: opts.timeoutMs ?? 500 });
const consent = { consent: true };

test("valid observation: percent-used per window, raw values kept, stored observed + unverified with evidence", async () => {
  const view = await collector().refresh(account.id, consent);
  expect(view.items).toHaveLength(2);
  const primary = view.items.find(i => i.evidence.slot === "primary")!;
  expect(primary.evidence).toMatchObject({ provider: "openai", harnessKind: "codex", harnessId: "codex", bucketId: "codex", metric: "percent-used", rawValue: 86,
    windowMins: 300, authMode: "chatgpt", planType: "plus", quality: "observed-correlated", unit: "percent of the reporting window",
    association: { basis: "owner-declared-harness-binding", identityVerified: false } });
  expect(primary.freshness).toBe("fresh");
  expect(primary.resetAt).toBe(resetSec() * 1000);
  expect(primary.expiresAt).toBe(now + 300_000);
  const stored = core.observedReadings(account.id, "codex-app-server");
  expect(stored.every(o => o.provenance === "observed" && o.verification === "unverified" && o.source === "observed:codex-app-server")).toBe(true);
  expect(stored.every(o => o.limit === null && o.used === null && o.remaining === null && o.acquisition === undefined)).toBe(true);
  expect(view.session).toMatchObject({ authMode: "chatgpt", cliVersion: "0.162.1", catalog: { count: 2 }, ordinaryUsageAllowed: true, freshness: "fresh" });
});

test("missing account association: no Codex harness binding, wrong provider, archived, ambiguity and bad input are refused before any process", async () => {
  const lone = core.createAccount({ provider: "openai", displayName: "No binding" });
  await expect(collector().refresh(lone.id, consent)).rejects.toMatchObject({ status: 409 });
  const other = core.createAccount({ provider: "anthropic", displayName: "Other" }); core.bindHarness(other.id, "codex");
  await expect(collector().refresh(other.id, consent)).rejects.toMatchObject({ status: 400 });
  await expect(collector().refresh(account.id, { consent: false })).rejects.toMatchObject({ status: 400 });
  await expect(collector().refresh(account.id, { consent: true, extra: 1 })).rejects.toMatchObject({ status: 400 });
  await expect(collector().refresh(account.id, { consent: true, harnessId: "cursor" })).rejects.toMatchObject({ status: 400 });
  core.archiveAccount(account.id);
  await expect(collector().refresh(account.id, consent)).rejects.toMatchObject({ status: 409 });
  expect(log).toEqual([]);
});

test("multiple quota buckets stay separate; a confirmed model slug scopes only its own bucket", async () => {
  script["account/rateLimits/read"] = rateLimits({}, { codex: bucket("codex"), codex_spark: bucket("codex_spark", { limitName: "Spark", normalModelSlug: "gpt-6-luna", secondary: null }) });
  const view = await collector().refresh(account.id, consent);
  expect(view.items.map(i => `${i.evidence.bucketId}:${i.evidence.slot}`)).toEqual(["codex:primary", "codex:secondary", "codex_spark:primary"]);
  expect(view.items.find(i => i.evidence.bucketId === "codex_spark")!.evidence.modelScope).toEqual({ kind: "confirmed", slug: "gpt-6-luna" });
  expect(view.items.find(i => i.evidence.bucketId === "codex")!.evidence.modelScope).toEqual({ kind: "unconfirmed" });
  expect(new Set(view.items.map(i => i.quotaId)).size).toBe(3);
});

test("model/bucket mismatch: an unconfirmed bucket is never extrapolated to the catalog models", async () => {
  const view = await collector().refresh(account.id, consent);
  expect(view.session!.catalog!.modelIds).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
  for (const item of view.items) {
    expect(item.evidence.modelScope.kind).toBe("unconfirmed");
    expect(item.autoSelectionBlockers.join(" ")).toContain("did not tie this bucket to a specific model");
  }
  expect(view.session!.catalog!.note).toContain("does not show quota");
});

test("used percent only: remaining/limit/used stay null and are never derived", async () => {
  const view = await collector().refresh(account.id, consent);
  for (const o of core.observedReadings(account.id, "codex-app-server")) {
    expect(o.indicator).toEqual({ kind: "percent-used", value: expect.any(Number) });
    expect([o.limit, o.used, o.remaining]).toEqual([null, null, null]);
  }
  expect(view.items[0]!.autoSelectionBlockers.join(" ")).toContain("remaining requests or tokens are unknown");
});

test("provider-reported exhaustion is recorded as reported, not as verified eligibility or a future guarantee", async () => {
  script["account/rateLimits/read"] = rateLimits({ ordinaryUsageAllowed: false }, { codex: bucket("codex", { rateLimitReachedType: "rate_limit_reached", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetSec() } }) });
  const view = await collector().refresh(account.id, consent);
  const primary = view.items.find(i => i.evidence.slot === "primary")!;
  expect(primary.evidence).toMatchObject({ exhausted: "reported", reachedType: "rate_limit_reached", rawValue: 100, ordinaryUsageAllowed: false });
  expect(view.items.find(i => i.evidence.slot === "secondary")!.evidence.exhausted).toBe("reported"); // the marker belongs to the bucket
  expect(core.observedReadings(account.id, "codex-app-server")[0]!.verification).toBe("unverified");
});

test("unknown: API-key sign-in, signed-out and unreadable limits produce no quota and an explicit reason", async () => {
  script["account/read"] = accountRead({ account: { type: "apiKey" } });
  let view = await collector().refresh(account.id, consent);
  expect(view.items).toEqual([]);
  expect(view.session!.authMode).toBe("apiKey");
  expect(view.session!.unknownReasons.join(" ")).toContain("Only a ChatGPT sign-in has subscription rate limits");
  expect(log).not.toContain("account/rateLimits/read");
  script["account/read"] = accountRead({ account: null });
  view = await collector().refresh(account.id, consent);
  expect(view.session!.authMode).toBe("none");
  script["account/read"] = accountRead(); script["account/rateLimits/read"] = "error";
  view = await collector().refresh(account.id, consent);
  expect(view.items).toEqual([]);
  expect(view.session!.unknownReasons).toContain("Rate limits could not be read.");
  script["account/rateLimits/read"] = { rateLimits: { nonsense: true }, rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 400 } } } };
  view = await collector().refresh(account.id, consent);
  expect(view.items).toEqual([]);
  expect(view.session!.unknownReasons).toContain("Rate-limit response is malformed.");
});

test("stale and expired evidence: freshness degrades after the local TTL and after reset, and resolveQuota stops treating it as current", async () => {
  const c = collector();
  await c.refresh(account.id, consent);
  now += 301_000;
  const view = c.view(account.id);
  expect(view.items.every(i => i.freshness === "stale")).toBe(true);
  expect(view.session!.freshness).toBe("stale");
  expect(view.items[0]!.autoSelectionBlockers).toContain("Evidence is stale.");
  const states = core.currentQuotas(account.id);
  expect(states.every(s => s.status === "stale" && s.current === null)).toBe(true);
  expect(evidenceFreshness({ observedAt: 1, expiresAt: null, resetAt: null }, 2)).toBe("unknown");
  expect(evidenceFreshness({ observedAt: 1, expiresAt: 100, resetAt: 5 }, 10)).toBe("stale");
  // A reset that already passed at collection time is ignored instead of being stored.
  script["account/rateLimits/read"] = rateLimits({}, { codex: bucket("codex", { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) - 5 }, secondary: null }) });
  const stale = await collector().refresh(account.id, consent);
  expect(stale.session!.unknownReasons.join(" ")).toContain("reset time already passed");
});

test("identity: matching reads are correlated; a mismatch records nothing; a changed provider account is refused", async () => {
  script["account/rateLimits/read"] = rateLimits({ accountId: "acct-OTHER" });
  const bad = await collector().refresh(account.id, consent);
  expect(bad.items).toEqual([]);
  expect(bad.session!.identity.correlation).toBe("mismatch");
  script["account/rateLimits/read"] = rateLimits({ accountId: null });
  const absent = await collector().refresh(account.id, consent);
  expect(absent.items[0]!.evidence.quality).toBe("observed");
  expect(absent.items[0]!.evidence.identity.correlation).toBe("absent");
  now += 1000; script["account/rateLimits/read"] = rateLimits();
  const ok = await collector().refresh(account.id, consent);
  expect(ok.items[0]!.evidence.quality).toBe("observed-correlated");
  const fp = ok.items[0]!.evidence.identity.fingerprint!;
  expect(fp).toMatch(/^[0-9a-f]{12}$/);
  now += 1000;
  script["account/read"] = accountRead({ workspaceRouting: { chatgptAccountId: "acct-NEW" } }); script["account/rateLimits/read"] = rateLimits({ accountId: "acct-NEW" });
  await expect(collector().refresh(account.id, consent)).rejects.toMatchObject({ status: 409 });
  expect(core.observedReadings(account.id, "codex-app-server")[0]!.evidence!.identity.fingerprint).toBe(fp);
});

test("provider timeout and errors are controlled: bounded, process closed, previous observations retained, no provider text leaks", async () => {
  const c = collector();
  await c.refresh(account.id, consent);
  const before = JSON.stringify(c.view(account.id).items);
  closed = 0;
  await expect(collector({ hang: true, timeoutMs: 40 }).refresh(account.id, consent)).rejects.toMatchObject({ status: 504 });
  expect(closed).toBe(1);
  script["account/read"] = "error";
  let error: unknown;
  try { await c.refresh(account.id, consent); } catch (e) { error = e; }
  expect(error).toMatchObject({ status: 502 });
  expect(String((error as Error).message)).not.toContain(EMAIL);
  expect(JSON.stringify(c.view(account.id).items)).toBe(before);
  // The in-flight guard is released after a failure, so Refresh can run again.
  script["account/read"] = accountRead(); now += 1000;
  expect((await c.refresh(account.id, consent)).items).toHaveLength(2);
});

test("a second collection while one is running is refused, and a login change mid-collection discards the evidence", async () => {
  const c = new CodexEvidenceCollector(core, { harness: id => ({ id, kind: "codex", env: {} }), now: () => now, timeoutMs: 500,
    connect: ({ onNotification }) => ({ timedOut: false, close() {}, notify() {}, call: async (method: string) => {
      if (method === "initialize") return { id: 1, result: { userAgent: "codex_cli_rs/0.162.1" } };
      if (method === "account/read") return { id: 1, result: accountRead() };
      onNotification("account/updated"); return new Promise(() => {}); } }) });
  const first = c.refresh(account.id, consent);
  await expect(c.refresh(account.id, consent)).rejects.toMatchObject({ status: 409 });
  await expect(first).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Authentication changed") });
  expect(core.observedReadings(account.id, "codex-app-server")).toEqual([]);
});

test("the startup account/updated announcement of the real app-server does not abort collection", async () => {
  const c = new CodexEvidenceCollector(core, { harness: id => ({ id, kind: "codex", env: {} }), now: () => now, timeoutMs: 500,
    connect: ({ onNotification }) => ({ timedOut: false, close() {}, notify() {}, call: async (method: string) => {
      if (method === "initialize") { onNotification("remoteControl/status/changed"); onNotification("account/updated"); }
      return { id: 1, result: script[method] }; } }) });
  expect((await c.refresh(account.id, consent)).items).toHaveLength(2);
});

test("no credentials leak: neither stored rows nor the API view contain email, provider account id, balance or raw payloads", async () => {
  const view = await collector().refresh(account.id, consent);
  const everything = JSON.stringify([view, db.query("SELECT data FROM quota_observations").all(), db.query("SELECT data FROM quota_definitions").all(), db.query("SELECT data FROM resource_accounts").all()]);
  for (const secret of [EMAIL, PROVIDER_ID, "SECRET", "\"balance\"", "chatgptAccountId", "access_token", "refresh"]) expect(everything).not.toContain(secret);
});

test("no inference: only the four read-only methods are called, never a thread, turn, login, logout or reset-credit method", async () => {
  await collector().refresh(account.id, consent);
  const methods = log.filter(m => !m.startsWith("notify:"));
  expect(methods).toEqual(["initialize", "account/read", "model/list", "account/rateLimits/read"]);
  expect(methods.every(m => (CODEX_EVIDENCE_METHODS as readonly string[]).includes(m))).toBe(true);
  expect(log.filter(m => m.startsWith("notify:"))).toEqual(["notify:initialized"]);
  expect(closed).toBe(1);
  // Reading the view never starts a process.
  log.length = 0; collector().view(account.id); expect(log).toEqual([]);
});

test("a failed model catalog read is non-fatal and stays Unknown", async () => {
  script["model/list"] = "error";
  const view = await collector().refresh(account.id, consent);
  expect(view.items).toHaveLength(2);
  expect(view.session!.catalog).toBeNull();
  expect(view.session!.unknownReasons).toContain("Model catalog could not be read.");
});

test("normalizeCodexEvidence is pure and tolerant of garbage", () => {
  expect(normalizeCodexEvidence({ account: 5, models: null, rateLimits: null }, 1).unknownReasons.length).toBeGreaterThan(0);
  expect(normalizeCodexEvidence({ account: accountRead(), models: [{ id: "a b" }, { id: "ok" }, 7], rateLimits: null }, 1).catalog!.modelIds).toEqual(["ok"]);
});

// Routing: new evidence must not raise anything above Unknown.
const NOW = 1_000_000;
const fact = <T>(value: T): VerifiedFact<T> => ({ value, verification: "verified", source: "fake-driver", observedAt: NOW - 1, expiresAt: NOW + 1000 });
const acct = (): Account => ({ id: "a", provider: "openai", displayName: "a", externalIdentity: null, availability: "available", provenance: "user-provided", verification: "unverified", source: "manual", createdAt: 1, updatedAt: 1, archivedAt: null });
function routable(observed: boolean): RoutingSnapshot {
  const c: ResourceCandidate = { id: "c", accountId: "a", harnessId: "codex", modelId: "m", enabled: true, profileIds: ["p"],
    authorization: fact(true), availability: fact(true), billing: fact({ paidApi: "no", overage: "none", reasons: ["fixture"] }),
    support: { accountId: "a", harnessId: "codex", modelId: "m", support: "supported", source: "fake-driver", provenance: "verified", verification: "verified", observedAt: NOW - 1, expiresAt: NOW + 1000 },
    evidence: { ...EMPTY_MODEL_EVIDENCE, efforts: fact(["small", "standard", "deep"]), quality: fact({ benchmark: "b", score: 80 }),
      expectedCost: fact({ taskId: "t", basis: "x", money: { currency: "USD", minor: 10 } }), durationMs: fact({ taskId: "t", basis: "x", ms: 100 }) } };
  const d: QuotaDefinition = { id: "q", accountId: "a", subscriptionId: null, scope: "account", unit: { kind: "provider-specific", name: "codex-window-percent" }, window: "primary:300m", createdAt: 1, archivedAt: null };
  const base = { id: "o", quotaId: "q", observedAt: NOW - 1, expiresAt: NOW + 1000, resetAt: null, confidence: "medium" as const };
  const o: QuotaObservation = observed
    ? { ...base, source: "observed:codex-app-server", provenance: "observed", verification: "unverified", limit: null, used: null, remaining: null, indicator: { kind: "percent-used", value: 10 } }
    : { ...base, source: "fake-driver", provenance: "verified", verification: "verified", limit: 10, used: 0, remaining: 10, indicator: null };
  return { capturedAt: NOW, candidates: [c], accounts: [acct()], bindings: [{ accountId: "a", harnessId: "codex", createdAt: 1, provenance: "user-provided", verification: "unverified", source: "manual" }], subscriptions: [], subscriptionLinks: [], quotas: [resolveQuota(d, [o], NOW)], occupancyComplete: true,
    limits: [{ id: "global", scope: { kind: "global" }, limit: fact(4), occupied: fact(0) }, { id: "account:a", scope: { kind: "account", id: "a" }, limit: fact<number | "unbounded">(1), occupied: fact(0) }] };
}
const requirements = () => analyzeTaskRequirements({ taskId: "t", projectId: "p", complexity: "medium", quotaDemands: [{ quotaId: "q", amount: 1 }] });
const owner = { ...UNKNOWN_OWNER_CONSTRAINTS, spending: "allow-paid" as const, projectPriority: "normal" as const };

test("no automatic selection without verified evidence: an otherwise verified candidate stays Unknown on an observed percent reading", () => {
  const verified = routeTask(requirements(), routable(false), "balanced", owner);
  expect(verified.status).toBe("recommended"); // control: the fixture itself is routable
  const preview = routeTask(requirements(), routable(true), "balanced", owner);
  expect(preview.status).toBe("no-verified-candidate");
  expect(preview.recommendedCandidate).toBeNull();
  expect(JSON.stringify(preview)).toContain("unverified");
});

test("the real snapshot builder never lifts an observed Codex reading above Unknown", async () => {
  await collector().refresh(account.id, consent);
  const snapshot = buildRoutingSnapshot(db, now);
  const states = snapshot.quotas.filter(q => q.definition.accountId === account.id);
  expect(states.length).toBe(2);
  expect(states.every(q => q.current?.verification === "unverified")).toBe(true);
  expect(snapshot.limits.find(l => l.id === "account:" + account.id)?.limit).toBeNull();
  const preview = routeTask(requirements(), snapshot, "balanced", owner);
  expect(preview.status).toBe("no-verified-candidate");
});

test("HTTP: bearer required, consent required, GET never collects, unknown account is 404", async () => {
  const c = collector();
  const call = (method: string, route: string, value?: unknown, auth = true) => accountHttp(
    new Request(`http://localhost/account-core${route}`, { method, body: value === undefined ? undefined : JSON.stringify(value) }), core, new LegacyUsageBridge(db), auth, undefined, undefined, c);
  expect((await call("GET", `/accounts/${account.id}/provider-evidence`, undefined, false)).status).toBe(401);
  expect((await call("POST", `/accounts/${account.id}/provider-evidence`, consent, false)).status).toBe(401);
  expect((await call("POST", `/accounts/${account.id}/provider-evidence`, {})).status).toBe(400);
  expect((await call("POST", "/accounts/nope/provider-evidence", consent)).status).toBe(404);
  const empty = await call("GET", `/accounts/${account.id}/provider-evidence`);
  expect(empty.status).toBe(200); expect((await empty.json() as any).items).toEqual([]); expect(log).toEqual([]);
  const done = await call("POST", `/accounts/${account.id}/provider-evidence`, consent);
  expect(done.status).toBe(200); expect((await done.json() as any).items).toHaveLength(2);
  expect((await call("GET", `/accounts/${account.id}/provider-evidence?x=1`)).status).toBe(400);
});

test("blockers always explain why evidence cannot select an executor", async () => {
  const view = await collector().refresh(account.id, consent);
  const text = autoSelectionBlockers(view.items[0]!.evidence, "fresh").join("\n");
  expect(text).toContain("not verified");
  expect(text).toContain("does not prove the next request");
  expect(view.disclaimer).toContain("not a guaranteed number of future requests");
});
