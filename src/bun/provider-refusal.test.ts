import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";

/**
 * One provider usage-limit refusal, end to end and offline. The Head turn runs through the fake Codex
 * driver (`AGETOR_CODEX_DRIVER=fake`) with a synthetic Codex profile; no CLI, model or network is
 * contacted and no credential exists. The refusal is an observation about ONE account and model: the
 * account stays signed in, nothing is retried or re-routed, and only a later successful answer ends it.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "provider-refusal-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4683";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);

const MODEL = "gpt-6.1-sol";
let base = "";
let token = "";
let server: { stop: () => void };
let store: typeof import("./db.ts");
let fake: typeof import("./portfolio-manager-fake.ts");
let refusals: typeof import("./provider-refusals.ts");
let profiles: import("./codex-profiles.ts").CodexProfiles;
let accountA: { accountId: string; harnessId: string };
let accountB: { accountId: string; harnessId: string };
let seq = 0;

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function addProfile(name: string) {
  const directory = path.join(ownerHome, `profile-${++seq}`);
  writeSyntheticCodexProfile(directory, `subject-${seq}`);
  return profiles.register({ displayName: name, directory });
}

async function useHead(harness: string): Promise<void> {
  const preflight = await call("POST", "/project-interviews/preflight", { harness, model: MODEL });
  expect(preflight.status, JSON.stringify(preflight.json)).toBe(200);
  const res = await call("PUT", "/portfolio-manager/config", {
    config: { harness, model: MODEL, effort: "low", consentKey: preflight.json.isolation.consentKey },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function ask(text: string): Promise<{ turn: any; state: any; owner: any }> {
  const sent = await call("POST", "/portfolio-manager/messages", { text });
  expect(sent.status, JSON.stringify(sent.json)).toBe(202);
  let turn: any = null;
  for (let i = 0; i < 400; i++) {
    turn = (await call("GET", `/portfolio-manager/turns/${sent.json.turn.id}`)).json;
    if (turn?.status && turn.status !== "running") break;
    await Bun.sleep(20);
  }
  const state = (await call("GET", "/portfolio-manager")).json;
  const owner = [...state.messages].reverse().find((m: any) => m.role === "owner");
  return { turn, state, owner };
}

const count = (table: string) => (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const downstream = () => ({ tasks: count("tasks"), runs: count("runs"), plans: count("portfolio_manager_plans"), delegations: count("portfolio_manager_delegations") });

beforeAll(async () => {
  store = await import("./db.ts");
  fake = await import("./portfolio-manager-fake.ts");
  refusals = await import("./provider-refusals.ts");
  const { AccountCore } = await import("./account-core.ts");
  const { CodexProfiles } = await import("./codex-profiles.ts");
  profiles = new CodexProfiles(new AccountCore(store.db));
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  store.harnesses.setEnabled("codex", true);
  accountA = addProfile("Account A");
  accountB = addProfile("Account B");
  await profiles.check(accountA.accountId);
  await profiles.check(accountB.accountId);
  store.harnesses.setEnabled(accountA.harnessId, true);
  store.harnesses.setEnabled(accountB.harnessId, true);
});

afterAll(() => { server?.stop?.(); });

const scopeA = () => ({ harnessId: accountA.harnessId, accountId: accountA.accountId, modelId: MODEL });

describe("the Head path records one observation from provider evidence", () => {
  test("a dated usage-limit refusal fails the turn, keeps the account signed in and creates nothing downstream", async () => {
    await useHead(accountA.harnessId);
    const before = downstream();
    const turnsBefore = fake.fakeTurnLog.portfolio;
    const { turn, owner, state } = await ask("what is going on __fake_portfolio_usage_limit__");
    expect(turn.status).toBe("failed");
    expect(fake.fakeTurnLog.portfolio).toBe(turnsBefore + 1);
    expect(owner.status).toBe("failed");
    expect(owner.providerRefusal).toMatchObject({
      kind: "usage-limit", harnessId: accountA.harnessId, accountId: accountA.accountId, modelId: MODEL,
      proof: "codex-cli-usage-limit", retryHint: "Nov 16th, 2026 9:31 PM", supersededAt: null,
    });
    // No plan, task, run, delegation or assistant answer exists because of the failed turn.
    expect(downstream()).toEqual(before);
    expect(state.messages.filter((m: any) => m.role === "manager" && m.createdAt >= owner.createdAt)).toEqual([]);
    expect(JSON.stringify(owner.providerRefusal)).not.toMatch(/sk-|Bearer|token=/i);
  });

  test("the account view shows sign-in valid and the refusal; a login check does not erase it", async () => {
    // The sign-in check runs through the same route the account view uses.
    const signedIn = await call("POST", `/account-core/codex-profiles/${accountA.accountId}/check`);
    expect(signedIn.json).toMatchObject({ authentication: "authenticated", availability: "ready" });
    expect(signedIn.json.providerRefusal).toMatchObject({ kind: "usage-limit", accountId: accountA.accountId });
    // The list is deliberately unchecked (it probes nothing) but carries the same observation.
    const view = (await call("GET", "/account-core/codex-profiles")).json;
    const a = view.find((p: any) => p.accountId === accountA.accountId);
    expect(a.providerRefusal).toMatchObject({ kind: "usage-limit", accountId: accountA.accountId, retryHint: "Nov 16th, 2026 9:31 PM" });
    const checked = await profiles.check(accountA.accountId);
    expect(checked).toMatchObject({ authentication: "authenticated" });
    expect(checked.providerRefusal).toMatchObject({ kind: "usage-limit" });
    // A later read returns the same observation: it is persisted, not held in memory.
    const again = (await call("GET", "/account-core/codex-profiles")).json.find((p: any) => p.accountId === accountA.accountId);
    expect(again.providerRefusal.id).toBe(a.providerRefusal.id);
  });

  test("a neighbouring account and the plain Codex harness are unaffected", async () => {
    const view = (await call("GET", "/account-core/codex-profiles")).json;
    expect(view.find((p: any) => p.accountId === accountB.accountId).providerRefusal ?? null).toBeNull();
    expect(refusals.activeProviderRefusal({ harnessId: accountB.harnessId, accountId: accountB.accountId, modelId: MODEL })).toBeNull();
    expect(refusals.activeProviderRefusal({ harnessId: "codex", accountId: null, modelId: MODEL })).toBeNull();
    // Another model on the refused account is not covered by an observation made on this model.
    expect(refusals.activeProviderRefusal({ ...scopeA(), modelId: "gpt-6-luna" })).toBeNull();
  });

  test("the Router reads the same observation as Unknown, and a hint passing or a login check changes nothing", async () => {
    const { accountResourceEvidence } = await import("./account-resource-evidence.ts");
    const { evaluateAccountEligibility } = await import("../shared/model-router/account-eligibility.ts");
    const harness = store.harnesses.get(accountA.harnessId)!;
    const eligibility = (now: number) => evaluateAccountEligibility({
      evidence: accountResourceEvidence(harness, { agent: harness.id, agentProfileId: null }, MODEL, "ask", "head", [], now),
      role: "head", kind: "codex", enabled: true, installed: true, modeSupported: true, policyBlocked: false, permissionBlocked: false,
    });
    const now = Date.now();
    const first = eligibility(now);
    expect(first.state).toBe("unknown");
    expect(first.reasons.map((r) => r.code)).toContain("provider-usage-limit-refused");
    // Two days later, long past the hinted time: still not ready.
    expect(eligibility(now + 2 * 24 * 3600_000).state).toBe("unknown");
    // The neighbour is eligible on its own evidence.
    const other = store.harnesses.get(accountB.harnessId)!;
    const neighbour = evaluateAccountEligibility({
      evidence: accountResourceEvidence(other, { agent: other.id, agentProfileId: null }, MODEL, "ask", "head", [], now),
      role: "head", kind: "codex", enabled: true, installed: true, modeSupported: true, policyBlocked: false, permissionBlocked: false,
    });
    expect(neighbour.reasons.map((r) => r.code)).not.toContain("provider-usage-limit-refused");
  });

  test("no automatic retry, account switch or extra model call happens", async () => {
    const turns = fake.fakeTurnLog.portfolio;
    const spawn = spyOn(Bun, "spawn");
    try {
      // Reading state, the account list, a login check and the Router never start a turn.
      await call("GET", "/portfolio-manager");
      await call("GET", "/account-core/codex-profiles");
      await profiles.check(accountA.accountId);
      await Bun.sleep(150);
    } finally { spawn.mockRestore(); }
    expect(fake.fakeTurnLog.portfolio).toBe(turns);
    const config = (await call("GET", "/portfolio-manager")).json.config;
    expect(config.harness).toBe(accountA.harnessId);
    expect(config.model).toBe(MODEL);
  });

  test("the observation survives a reload of the stores", async () => {
    const stored = store.db.query("SELECT COUNT(*) AS n FROM provider_refusal_observations WHERE superseded_at IS NULL").get() as { n: number };
    expect(stored.n).toBe(1);
    const reread = refusals.activeProviderRefusal(scopeA());
    expect(reread?.retryHint).toBe("Nov 16th, 2026 9:31 PM");
  });

  test("only a later successful provider answer for the same scope supersedes it", async () => {
    // A success on the OTHER account does not touch it.
    await useHead(accountB.harnessId);
    const other = await ask("hello");
    expect(other.turn.status).toBe("succeeded");
    expect(refusals.activeProviderRefusal(scopeA())).not.toBeNull();
    // A success on the refused account and model ends it.
    await useHead(accountA.harnessId);
    const ok = await ask("hello again");
    expect(ok.turn.status).toBe("succeeded");
    expect(refusals.activeProviderRefusal(scopeA())).toBeNull();
    const view = (await call("GET", "/account-core/codex-profiles")).json.find((p: any) => p.accountId === accountA.accountId);
    expect(view.providerRefusal ?? null).toBeNull();
    // The history of the failed owner message keeps its snapshot as evidence.
    const failed = (await call("GET", "/portfolio-manager")).json.messages.find((m: any) => m.providerRefusal);
    expect(failed.providerRefusal.retryHint).toBe("Nov 16th, 2026 9:31 PM");
  });
});

describe("what is and is not a provider refusal", () => {
  async function attempt(marker: string) {
    await useHead(accountA.harnessId);
    const before = store.db.query("SELECT COUNT(*) AS n FROM provider_refusal_observations").get() as { n: number };
    const result = await ask(`question ${marker}`);
    const after = store.db.query("SELECT COUNT(*) AS n FROM provider_refusal_observations").get() as { n: number };
    return { ...result, recorded: after.n - before.n };
  }

  test("a clock-only hint is kept as written and never turned into a local time", async () => {
    const r = await attempt("__fake_portfolio_usage_limit_clock__");
    expect(r.turn.status).toBe("failed");
    expect(r.recorded).toBe(1);
    expect(r.owner.providerRefusal.retryHint).toBe("9:31 PM");
    refusals.supersedeProviderRefusals(scopeA(), "test-cleanup");
  });

  test("the machine token proves the refusal with no hint", async () => {
    const r = await attempt("__fake_portfolio_usage_limit_token__");
    expect(r.recorded).toBe(1);
    expect(r.owner.providerRefusal).toMatchObject({ proof: "usage_limit_exceeded", retryHint: null });
    refusals.supersedeProviderRefusals(scopeA(), "test-cleanup");
  });

  test("a quota-looking sentence in model text is an ordinary answer, not a refusal", async () => {
    const r = await attempt("__fake_portfolio_usage_limit_text__");
    expect(r.recorded).toBe(0);
    expect(r.owner.providerRefusal).toBeUndefined();
  });

  test("a sentence with no provider line id is not proof", async () => {
    const r = await attempt("__fake_portfolio_usage_limit_unmarked__");
    expect(r.recorded).toBe(0);
    expect(r.owner.providerRefusal).toBeUndefined();
  });

  test("temporary rate limiting and an unrelated failure are kept apart from a usage limit", async () => {
    const rate = await attempt("__fake_portfolio_rate_limit__");
    expect(rate.recorded).toBe(0);
    const unrelated = await attempt("__fake_portfolio_fail__");
    expect(unrelated.recorded).toBe(0);
    expect(refusals.activeProviderRefusal(scopeA())).toBeNull();
  });

  test("recording the same evidence twice keeps one observation", () => {
    const input = {
      kind: "usage-limit" as const, provider: "codex", scope: scopeA(), surface: "test", evidenceId: "same",
      proof: "codex-cli-usage-limit" as const, retryHint: null, diagnostics: "x",
    };
    const first = refusals.recordProviderRefusal(input);
    const second = refusals.recordProviderRefusal(input);
    expect(second.id).toBe(first.id);
    refusals.supersedeProviderRefusals(scopeA(), "test-cleanup");
  });

  test("diagnostics are redacted and capped, and a hint cannot carry control characters", () => {
    const row = refusals.recordProviderRefusal({
      kind: "usage-limit", provider: "codex", scope: scopeA(), surface: "test", evidenceId: "redact",
      proof: "usage_limit_exceeded", retryHint: `9:31\u0007 PM${"x".repeat(300)}`,
      diagnostics: `Authorization: Bearer sk-proj-REALSECRETREALSECRET1234 ${"y".repeat(2000)}`,
    });
    expect(row.diagnostics).not.toContain("REALSECRET");
    expect(row.diagnostics.length).toBeLessThanOrEqual(700);
    expect(row.retryHint!.length).toBeLessThanOrEqual(120);
    expect(row.retryHint).not.toMatch(/[\u0000-\u001f]/);
    refusals.supersedeProviderRefusals(scopeA(), "test-cleanup");
  });
});
