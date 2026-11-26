import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { makeTask } from "../cli/test-fixtures.ts";

/**
 * Developer and Reviewer outcomes of the account that actually ran. Offline: the fake Codex driver
 * ends a run the way a Codex process ends on a provider usage-limit refusal, with two synthetic
 * Codex profiles. Nothing contacts a provider; no credential, Keychain or real profile exists.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "provider-run-outcome-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4684";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);

const SOL = "gpt-6.1-sol";
const LUNA = "gpt-6-luna";
const NOV = "Nov 16th, 2026 9:31 PM";
let base = "";
let token = "";
let server: { stop: () => void };
let store: typeof import("./db.ts");
let refusals: typeof import("./provider-refusals.ts");
let outcome: typeof import("./provider-run-outcome.ts");
let orchestrator: typeof import("./orchestrator.ts");
let assertCanMoveTaskToDone: typeof import("./task-quality-control.ts").assertCanMoveTaskToDone;
let profiles: import("./codex-profiles.ts").CodexProfiles;
let A: { accountId: string; harnessId: string };
let B: { accountId: string; harnessId: string };
let seq = 0;

const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const count = (table: string) => (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const scope = (h: { accountId: string; harnessId: string }, modelId = SOL) => ({ harnessId: h.harnessId, accountId: h.accountId, modelId });
const active = (h: { accountId: string; harnessId: string }, modelId = SOL) => refusals.activeProviderRefusal(scope(h, modelId));

function addProfile(name: string) {
  const directory = path.join(ownerHome, `profile-${++seq}`);
  writeSyntheticCodexProfile(directory, `subject-${seq}`);
  return profiles.register({ displayName: name, directory });
}

let projectDir = "";
function newTask(harness: string, prompt: string, model = SOL, column: "ready" | "review" = "ready") {
  const now = Date.now();
  return store.tasks.insert(makeTask({ id: randomUUID(), title: `Task ${++seq}`, prompt, column, workdir: projectDir, agent: harness, model, effort: "low", mode: "auto", createdAt: now, updatedAt: now }));
}

async function waitFor<T>(read: () => T | null | undefined | false, what: string, ms = 12_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as T;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Start a task run and wait until it has settled. Returns the run row. */
async function run(harness: string, prompt: string, model = SOL) {
  const task = newTask(harness, prompt, model);
  const started = await orchestrator.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const settled = await waitFor(() => {
    const row = store.runs.get(started.runId);
    return row && row.status !== "running" ? row : null;
  }, `run ${started.runId}`);
  // The settle hook runs right after the status write; wait for the task column to move as well.
  await waitFor(() => store.tasks.get(task.id)?.column !== "running", "task column");
  return { task, run: settled };
}

beforeAll(async () => {
  store = await import("./db.ts");
  refusals = await import("./provider-refusals.ts");
  outcome = await import("./provider-run-outcome.ts");
  orchestrator = await import("./orchestrator.ts");
  ({ assertCanMoveTaskToDone } = await import("./task-quality-control.ts"));
  const { AccountCore } = await import("./account-core.ts");
  const { CodexProfiles } = await import("./codex-profiles.ts");
  profiles = new CodexProfiles(new AccountCore(store.db));
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  A = addProfile("Account A");
  B = addProfile("Account B");
  for (const h of [A, B]) {
    await profiles.check(h.accountId);
    store.harnesses.setEnabled(h.harnessId, true);
  }
  projectDir = realpathSync(mkdtempSync(path.join(root, "project-")));
  store.projects.upsert(projectDir, "Outcome project");
});
afterAll(() => { server?.stop?.(); });

describe("Developer run: the account that actually ran", () => {
  test("a recognized usage-limit refusal is recorded for that launch identity only", async () => {
    const before = count("runs");
    const { task, run: row } = await run(A.harnessId, "Implement it __fake_provider__:usage-limit");
    expect(row.status).toBe("failed");
    const refusal = active(A)!;
    expect(refusal).toMatchObject({ surface: "developer-run", accountId: A.accountId, harnessId: A.harnessId, modelId: SOL, proof: "codex-cli-usage-limit", retryHint: NOV, supersededAt: null });
    // It came from this run's own process evidence.
    expect(store.db.query("SELECT evidence_id FROM provider_refusal_observations WHERE id = ?").get(refusal.id)).toEqual({ evidence_id: row.id });
    // The other account, the other model and the plain Codex harness are untouched.
    expect(active(B)).toBeNull();
    expect(active(A, LUNA)).toBeNull();
    expect(refusals.activeProviderRefusal({ harnessId: "codex", accountId: null, modelId: SOL })).toBeNull();
    // Nothing retried, switched or launched: exactly one run, same harness and model on the task.
    await Bun.sleep(250);
    expect(count("runs")).toBe(before + 1);
    expect(store.tasks.get(task.id)).toMatchObject({ agent: A.harnessId, model: SOL });
    // The task's run list carries the same observation, read-only.
    const runs = (await api("GET", `/tasks/${task.id}/runs`)).json;
    expect(runs[0].providerRefusal).toMatchObject({ id: refusal.id, surface: "developer-run" });
  });

  test("a duplicate settle returns the same observation and records nothing new", () => {
    const row = store.db.query<{ id: string }, []>("SELECT evidence_id AS id FROM provider_refusal_observations WHERE surface = 'developer-run' ORDER BY rowid LIMIT 1").get()!;
    const before = count("provider_refusal_observations");
    const again = outcome.noteRunProviderOutcome(row.id);
    expect(again).toMatchObject({ action: "refusal-recorded" });
    expect(count("provider_refusal_observations")).toBe(before);
  });

  test("the Router holds the refused operation and keeps other accounts and models eligible", async () => {
    const { RouterV2Service } = await import("./router-v2/router-v2-service.ts");
    const { evaluateCandidates } = await import("../shared/router-v2/evaluator.ts");
    const { DEFAULT_ROUTER_POLICY } = await import("../shared/router-v2/types.ts");
    const service = new RouterV2Service(store.db);
    const candidates = service.gatherCandidatesSync("developer");
    const mine = candidates.find((c) => c.harnessId === A.harnessId && c.modelId === SOL)!;
    const neighbour = candidates.find((c) => c.harnessId === B.harnessId && c.modelId === SOL)!;
    const otherModel = candidates.find((c) => c.harnessId === A.harnessId && c.modelId === LUNA)!;
    expect(mine.providerRefusal).toMatchObject({ accountId: A.accountId, modelId: SOL });
    expect(neighbour.providerRefusal ?? null).toBeNull();
    expect(otherModel.providerRefusal ?? null).toBeNull();
    const req = { taskId: "t", projectId: "p", role: "developer" as const };
    const withRefusal = evaluateCandidates(candidates, req, DEFAULT_ROUTER_POLICY);
    const without = evaluateCandidates(candidates.map((c) => ({ ...c, providerRefusal: null })), req, DEFAULT_ROUTER_POLICY);
    expect(withRefusal.eligible).toEqual(without.eligible.filter(candidate => candidate.candidateId !== mine.id));
    expect(withRefusal.ineligible.find(c => c.candidateId === mine.id)?.eliminationReasons.join(" ")).toContain("provider-usage-limit:");
    expect(withRefusal.eligible.find(c => c.candidateId === neighbour.id)?.scores.quota.capacityClass).toBe("unknown");
    expect(withRefusal.authorizesExecution).toBe(false);
  });
});

describe("what is not a provider refusal", () => {
  for (const variant of ["text", "unmarked", "rate-limit", "auth", "unsupported-model", "permission", "network"]) {
    test(`${variant}: a failed run with that evidence records nothing`, async () => {
      // Use the neighbour so a leftover observation on A cannot hide a false positive.
      const before = count("provider_refusal_observations");
      const { run: row } = await run(B.harnessId, `Do it __fake_provider__:${variant}`);
      expect(row.status).toBe("failed");
      expect(count("provider_refusal_observations")).toBe(before);
      expect(active(B)).toBeNull();
    });
  }

  test("assistant text that looks like the provider error on a successful run is an ordinary answer", async () => {
    const before = count("provider_refusal_observations");
    const { run: row } = await run(B.harnessId, "Say it __fake_provider__:ok-text");
    expect(row.status).toBe("succeeded");
    expect(count("provider_refusal_observations")).toBe(before);
  });

  test("the task prompt and tool-like text never count: only the process stderr does", () => {
    const row = store.runs.insert({
      id: randomUUID(), taskId: store.tasks.list()[0]!.id, agent: B.harnessId, status: "failed", startedAt: 1, endedAt: 2, exitCode: 1,
      tmuxSession: null, claudeSessionId: null, codexSessionId: "0194f6a2-8b1c-7d3e-9f40-1a2b3c4d5e6f", cursorSessionId: null, geminiSessionId: null,
    } as never);
    const sentence = `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${NOV}.`;
    for (const stream of ["assistant", "user", "tool_result", "status"]) store.runs.appendEvent(row.id, stream as never, sentence, "error:1");
    store.runs.appendEvent(row.id, "status" as never, JSON.stringify({ kind: "execution-identity", executionType: "real-provider", provider: "codex", model: SOL, mode: "auto", accountProfile: { id: B.accountId, displayName: "B", harnessId: B.harnessId } }));
    expect(outcome.noteRunProviderOutcome(row.id)).toEqual({ action: "skipped", reason: "no-provider-evidence" });
    expect(active(B)).toBeNull();
  });
});

describe("the launch identity is never guessed", () => {
  const sentence = `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${NOV}.`;
  function failedRun(agent: string, identity: object | null, taskId = store.tasks.list()[0]!.id) {
    const id = randomUUID();
    store.runs.insert({
      id, taskId, agent, status: "failed", startedAt: 1, endedAt: Date.now(), exitCode: 1,
      tmuxSession: null, claudeSessionId: null, codexSessionId: "0194f6a2-8b1c-7d3e-9f40-1a2b3c4d5e6f", cursorSessionId: null, geminiSessionId: null,
    } as never);
    store.runs.appendEvent(id, "stderr", sentence, "error:1");
    if (identity) store.runs.appendEvent(id, "status" as never, JSON.stringify({ kind: "execution-identity", provider: "codex", mode: "auto", ...identity }));
    return id;
  }
  const real = { executionType: "real-provider", model: SOL };

  test("no identity event: skipped, attributed to nobody", () => {
    expect(outcome.noteRunProviderOutcome(failedRun(A.harnessId, null))).toEqual({ action: "skipped", reason: "no-launch-identity" });
  });
  test("a profile that names a different harness than the run: skipped", () => {
    const id = failedRun(A.harnessId, { ...real, accountProfile: { id: B.accountId, displayName: "B", harnessId: B.harnessId } });
    expect(outcome.noteRunProviderOutcome(id)).toEqual({ action: "skipped", reason: "launch-identity-mismatch" });
  });
  test("an unknown model, a fixture run and a non-Codex run are skipped", () => {
    expect(outcome.noteRunProviderOutcome(failedRun(A.harnessId, { executionType: "real-provider", model: null, accountProfile: { id: A.accountId, displayName: "A", harnessId: A.harnessId } }))).toEqual({ action: "skipped", reason: "model-unknown" });
    expect(outcome.noteRunProviderOutcome(failedRun(A.harnessId, { executionType: "fixture", model: SOL, accountProfile: { id: A.accountId, displayName: "A", harnessId: A.harnessId } }))).toEqual({ action: "skipped", reason: "not-provider-origin" });
    expect(outcome.noteRunProviderOutcome(failedRun("claude-code", { ...real, provider: "claude-code" }))).toEqual({ action: "skipped", reason: "not-a-codex-run" });
  });
  test("the plain Codex harness with no profile is recorded in the unidentified scope, never on a named account", () => {
    const id = failedRun("codex", { ...real, accountProfile: null });
    const result = outcome.noteRunProviderOutcome(id);
    expect(result).toMatchObject({ action: "refusal-recorded", refusal: { accountId: null, harnessId: "codex", modelId: SOL } });
    expect(active(A)).not.toBeNull(); // A's own earlier refusal is untouched
    expect(refusals.activeProviderRefusal({ harnessId: "codex", accountId: null, modelId: SOL })).not.toBeNull();
    refusals.supersedeProviderRefusals({ harnessId: "codex", accountId: null, modelId: SOL }, "cleanup");
  });
  test("the identity is the launch's, not whatever the task or the selected account says now", () => {
    const developerTask = newTask(A.harnessId, "Developer task");
    const id = failedRun(B.harnessId, { ...real, accountProfile: { id: B.accountId, displayName: "B", harnessId: B.harnessId } }, developerTask.id);
    // The task row still names A (the Developer). The run launched on B.
    expect(store.tasks.get(developerTask.id)!.agent).toBe(A.harnessId);
    const result = outcome.noteRunProviderOutcome(id);
    expect(result).toMatchObject({ action: "refusal-recorded", refusal: { accountId: B.accountId } });
    expect(active(B)).not.toBeNull();
    refusals.supersedeProviderRefusals(scope(B), "cleanup");
  });
});

describe("which successful answers clear a refusal", () => {
  test("only a success on the same account AND model; another model or account never does", async () => {
    // (A, SOL) is refused from the first test. A refusal on (A, LUNA) too.
    await run(A.harnessId, "Implement luna __fake_provider__:usage-limit-token", LUNA);
    expect(active(A, SOL)).not.toBeNull();
    expect(active(A, LUNA)).not.toBeNull();
    // A success on the other account, same model: nothing clears.
    await run(B.harnessId, "Fine", SOL);
    expect(active(A, SOL)).not.toBeNull();
    // A success on A with the other model clears only that model's refusal.
    const solOk = await run(A.harnessId, "Fine", SOL);
    expect(solOk.run.status).toBe("succeeded");
    expect(active(A, SOL)).toBeNull();
    expect(active(A, LUNA)).not.toBeNull();
    // The refusal row is kept as history, marked superseded by that run.
    const row = store.db.query("SELECT superseded_by FROM provider_refusal_observations WHERE account_id = ? AND model_id = ? AND superseded_at IS NOT NULL").get(A.accountId, SOL) as { superseded_by: string };
    expect(row.superseded_by).toBe(solOk.run.id);
    await run(A.harnessId, "Fine", LUNA);
    expect(active(A, LUNA)).toBeNull();
  });

  test("an account-wide observation is never cleared by a success on one model", () => {
    const wide = { harnessId: A.harnessId, accountId: A.accountId, modelId: null };
    refusals.recordProviderRefusal({ kind: "usage-limit", provider: "codex", scope: wide, surface: "test", evidenceId: "wide", proof: "usage_limit_exceeded", retryHint: null, diagnostics: "x" });
    refusals.supersedeProviderRefusals(scope(A, SOL), "success-on-one-model", Date.now() + 10);
    expect(refusals.activeProviderRefusal({ ...scope(A, SOL) })).not.toBeNull();
    expect(refusals.activeProviderRefusal({ ...scope(A, LUNA) })).not.toBeNull();
    store.db.run("UPDATE provider_refusal_observations SET superseded_at = 1 WHERE evidence_id = 'wide'");
  });

  test("a login check and a passed retry hint do not clear it", async () => {
    refusals.recordProviderRefusal({ kind: "usage-limit", provider: "codex", scope: scope(B), surface: "test", evidenceId: "hint", proof: "codex-cli-usage-limit", retryHint: "9:31 PM", diagnostics: "x", now: Date.now() + 1 });
    expect((await api("POST", `/account-core/codex-profiles/${B.accountId}/check`)).json).toMatchObject({ authentication: "authenticated" });
    expect(active(B)).not.toBeNull();
    refusals.supersedeProviderRefusals(scope(B), "cleanup");
  });
});

describe("late, duplicate and out-of-order evidence", () => {
  const sc = () => ({ harnessId: A.harnessId, accountId: A.accountId, modelId: "ordering-model" });
  const input = (evidenceId: string, now: number) => ({ kind: "usage-limit" as const, provider: "codex", scope: sc(), surface: "test", evidenceId, proof: "codex-cli-usage-limit" as const, retryHint: null, diagnostics: "x", now });

  test("a refusal that settles late, after a newer success, is recorded as already answered", () => {
    refusals.supersedeProviderRefusals(sc(), "newer-success", 5000);
    const late = refusals.recordProviderRefusal(input("older-refusal", 4000));
    expect(late.supersededAt).toBe(5000);
    expect(refusals.activeProviderRefusal(sc())).toBeNull();
  });
  test("a refusal newer than the last success stays; a late older success cannot clear or rewind", () => {
    refusals.recordProviderRefusal(input("newer-refusal", 9000));
    refusals.supersedeProviderRefusals(sc(), "late-old-success", 7000);
    expect(refusals.activeProviderRefusal(sc())).not.toBeNull();
    expect(refusals.lastAnswer({ ...sc(), modelId: "ordering-model" })!.observedAt).toBe(7000 > 5000 ? 7000 : 5000);
    // A duplicate of the newest success at its own time changes nothing.
    refusals.supersedeProviderRefusals(sc(), "newer-success", 5000);
    expect(refusals.lastAnswer(sc())!.evidenceId).toBe("late-old-success");
    expect(refusals.activeProviderRefusal(sc())).not.toBeNull();
    // A genuinely newer success clears it.
    refusals.supersedeProviderRefusals(sc(), "real-success", 9500);
    expect(refusals.activeProviderRefusal(sc())).toBeNull();
  });
  test("the same evidence recorded twice is one observation", () => {
    const first = refusals.recordProviderRefusal(input("dup", 20000));
    const second = refusals.recordProviderRefusal(input("dup", 30000));
    expect(second.id).toBe(first.id);
    expect(second.observedAt).toBe(20000);
  });
});

describe("Reviewer run: its own account, not the Developer's", () => {
  test("a Reviewer refused on account B while the Developer ran on A: B is recorded, A is not", async () => {
    // Clear everything so the scopes are unambiguous.
    store.db.run("UPDATE provider_refusal_observations SET superseded_at = 1 WHERE superseded_at IS NULL");
    const dev = await run(A.harnessId, "Implement the feature", SOL);
    expect(dev.run.status).toBe("succeeded");
    await waitFor(() => store.tasks.get(dev.task.id)?.column === "review", "review column");
    expect(active(A)).toBeNull();

    process.env.AGETOR_FAKE_QC_VERDICT = "USAGE_LIMIT";
    const before = count("runs");
    const prep = await api("POST", `/tasks/${dev.task.id}/qc/reviews`, { reviewerHarness: B.harnessId, reviewerModel: SOL });
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    const start = await api("POST", `/tasks/${dev.task.id}/qc/reviews/${prep.json.review.id}/start`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const review = await waitFor(() => {
      const r = store.taskQualityReviews.get(prep.json.review.id);
      return r && r.status === "complete" ? r : null;
    }, "review to settle");
    await waitFor(() => active(B), "reviewer refusal");

    expect(active(B)).toMatchObject({ surface: "reviewer-run", accountId: B.accountId, modelId: SOL, retryHint: NOV });
    expect(active(A)).toBeNull();
    // The existing QC rules are untouched: no verdict, no Done, no second review or run.
    expect(review.verdict).toBeNull();
    const task = store.tasks.get(dev.task.id)!;
    expect(task.qcState?.latestVerdict ?? null).toBeNull();
    expect(task.agent).toBe(A.harnessId); // the Developer's settings are restored, not inherited the other way
    expect(count("runs")).toBe(before + 1);
    // Control: a Reviewer that fails for an unrelated reason leaves the identical QC state, column and Done gate.
    const gate = (id: string) => { const t = store.tasks.get(id)!; return { column: t.column, qc: t.qcState, review: store.taskQualityReviews.listForTask(id).map((r) => [r.status, r.verdict, r.round]), done: assertCanMoveTaskToDone(t) }; };
    const control = await run(A.harnessId, "Implement the control", SOL);
    await waitFor(() => store.tasks.get(control.task.id)?.column === "review", "control review column");
    process.env.AGETOR_FAKE_QC_VERDICT = "MODEL_NOT_FOUND";
    const cprep = await api("POST", `/tasks/${control.task.id}/qc/reviews`, { reviewerHarness: B.harnessId, reviewerModel: SOL });
    await api("POST", `/tasks/${control.task.id}/qc/reviews/${cprep.json.review.id}/start`);
    await waitFor(() => store.taskQualityReviews.get(cprep.json.review.id)?.status === "complete", "control review");
    const strip = (g: ReturnType<typeof gate>) => ({ ...g, qc: { ...g.qc, activeReviewId: null } });
    expect(strip(gate(dev.task.id))).toEqual(strip(gate(control.task.id)));
    // The task and QC views carry the Reviewer's observation, labelled as the Reviewer's.
    const qc = (await api("GET", `/tasks/${dev.task.id}/qc`)).json;
    expect(qc.reviews[0].providerRefusal).toMatchObject({ surface: "reviewer-run", accountId: B.accountId });
    // The Developer's own successful run cleared nothing of the Reviewer's.
    expect(store.db.query("SELECT COUNT(*) AS n FROM provider_refusal_observations WHERE surface = 'developer-run'").get()).toBeTruthy();
    process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  });
});
