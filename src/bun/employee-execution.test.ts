import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveQuota } from "../shared/accounts/resolve.ts";
import { EMPTY_MODEL_EVIDENCE } from "../shared/model-router/route.ts";
import type { OwnerRoutingConstraints, RoutingSnapshot } from "../shared/model-router/types.ts";
import { AGENT_OPTIONS, supportedEfforts } from "../shared/types.ts";

/**
 * FO-010E1 employee execution preflight. One isolated data dir and HOME for the
 * whole file, a real API server on its own port, and spies that fail the test
 * if anything spawns a process or reaches the network.
 */
const isolated = mkdtempSync(path.join(tmpdir(), "fo010e1-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4698";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/fo010e1";

let backend: typeof import("./server.ts");
let store: typeof import("./db.ts");
let server: ReturnType<(typeof import("./server.ts"))["startApiServer"]>;
let exec: typeof import("./employee-execution.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AccountCore: typeof import("./account-core.ts").AccountCore;
let spawn: ReturnType<typeof spyOn>;
let spawnSync: ReturnType<typeof spyOn>;
let fetchGuard: ReturnType<typeof spyOn>;
let externalCalls = 0;
const base = "http://127.0.0.1:4698";
let counter = 0;

beforeAll(async () => {
  spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected process");
  });
  spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Unexpected process");
  });
  const realFetch = globalThis.fetch;
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base + "/")) {
      externalCalls++;
      throw new Error("External calls forbidden");
    }
    return realFetch(input, init);
  }) as typeof fetch);
  store = await import("./db.ts");
  backend = await import("./server.ts");
  exec = await import("./employee-execution.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ AccountCore } = await import("./account-core.ts"));
  server = backend.startApiServer();
  store.db.run("UPDATE harnesses SET enabled = 1 WHERE id = 'claude-code'");
  store.db.run("UPDATE harnesses SET enabled = 0 WHERE id = 'codex'");
});
afterAll(() => {
  server?.stop(true);
  spawn?.mockRestore();
  spawnSync?.mockRestore();
  fetchGuard?.mockRestore();
});

function project(name: string): string {
  const dir = mkdtempSync(path.join(isolated, `${name}-`));
  store.projects.upsert(dir, name);
  return dir;
}
function addTask(workdir: string, extra: { column?: string; agent?: string; title?: string } = {}): string {
  const id = crypto.randomUUID();
  store.db.run(
    'INSERT INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
    [id, extra.title ?? `Task ${++counter}`, "SECRET_PROMPT_MARKER", extra.column ?? "ready", extra.agent ?? "claude-code", workdir],
  );
  return id;
}
function worker(projectPath: string, name = `Worker ${++counter}`) {
  return new EmployeeCore(store.db).createWorker({ name, jobTitle: "QA Engineer", projectPath });
}
function assign(taskId: string, employeeId: string) {
  return new AssignmentCore(store.db).assign(taskId, employeeId).assignment;
}
/** A project, an assigned active worker, and an assigned task. */
function scenario() {
  const dir = project("proj");
  const person = worker(dir);
  const taskId = addTask(dir);
  const assignment = assign(taskId, person.id);
  return { dir, person, taskId, assignment };
}
const prepare = (body: Record<string, unknown>, deps: Parameters<typeof exec.prepareEmployeeExecution>[1] = {}) =>
  exec.prepareEmployeeExecution(body, deps);
const codes = (result: { blockingErrors: { code: string }[] }) => result.blockingErrors.map((e) => e.code);
async function call(body: unknown, route = "/employee-execution/preflight", auth: string | null = "Bearer " + backend.API_TOKEN, method = "POST") {
  const response = await fetch(base + route, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any, cache: response.headers.get("cache-control") };
}

// ----- router evidence fixtures --------------------------------------------------------------

const NOW = 1_000_000;
const fact = <T,>(value: T) => ({ value, verification: "verified" as const, source: "fake-driver", observedAt: NOW - 1, expiresAt: NOW + 1000 });
function fixtureSnapshot(conflict = false): RoutingSnapshot {
  const definition = { id: "q1", accountId: "acct", subscriptionId: null, scope: "account", unit: { kind: "concurrency" as const }, window: "instant", createdAt: 1, archivedAt: null };
  const observation = (id: string, source: string, remaining: number) => ({
    id, quotaId: "q1", source, verification: "verified" as const, provenance: "verified" as const, observedAt: NOW - 1, expiresAt: NOW + 1000,
    resetAt: null, limit: 3, used: 3 - remaining, remaining, indicator: null, confidence: "high" as const,
  });
  return {
    capturedAt: NOW,
    candidates: [{
      id: "c", accountId: "acct", harnessId: "claude-code", modelId: "opus-5.5", enabled: true, profileIds: [],
      authorization: fact(true), availability: fact(true), billing: fact({ paidApi: "no", overage: "none", reasons: ["fixture"] }),
      support: { accountId: "acct", harnessId: "claude-code", modelId: "opus-5.5", support: "supported", source: "fake-driver", provenance: "verified", verification: "verified", observedAt: NOW - 1, expiresAt: NOW + 1000 },
      evidence: { ...EMPTY_MODEL_EVIDENCE, efforts: fact(["low", "high"]) },
    }],
    accounts: [{ id: "acct", provider: "fake", displayName: "Fake account", externalIdentity: "person@example.com", availability: "available", provenance: "user-provided", verification: "unverified", source: "manual", createdAt: 1, updatedAt: 1, archivedAt: null }],
    bindings: [{ accountId: "acct", harnessId: "claude-code", createdAt: 1, provenance: "user-provided", verification: "unverified", source: "manual" }],
    subscriptions: [], subscriptionLinks: [],
    quotas: [resolveQuota(definition as never, conflict ? [observation("o1", "a", 2), observation("o2", "b", 1)] : [observation("o1", "a", 2)], NOW)],
    limits: [
      { id: "global", scope: { kind: "global" }, limit: fact(4), occupied: fact(0) },
      { id: "account:acct", scope: { kind: "account", id: "acct" }, limit: fact(1 as number | "unbounded"), occupied: fact(0) },
    ],
    occupancyComplete: true,
  } as unknown as RoutingSnapshot;
}
const allowPaid = (saved: OwnerRoutingConstraints): OwnerRoutingConstraints => ({ ...saved, spending: "allow-paid" });
const fixed = { now: () => NOW };

// ----- scope and assignment -------------------------------------------------------------------

test("valid worker and task: describes the future run without starting or granting anything", () => {
  const s = scenario();
  const r = prepare({ taskId: s.taskId });
  expect(r).toMatchObject({
    readOnly: true,
    executionAvailable: false,
    banner: "Preflight only — no agent started.",
    outcome: "selection-needed",
    taskId: s.taskId,
    canonicalProject: { path: s.dir, via: "exact" },
    employee: { id: s.person.id, kind: "worker", status: "active" },
    assignment: { id: s.assignment.id, revision: 1 },
    requested: { harnessId: null, model: null, effort: null, complexity: null },
    proposedNextAction: { code: "select-harness" },
  });
  expect(r.blockingErrors).toEqual([]);
  expect(r.selection).toBeNull();
  expect(r.validUntil - r.capturedAt).toBe(30_000);
  expect(r.stateKey).toMatch(/^[0-9a-f]{16}$/);
  // The result explains the start contract and that earlier approvals do not allow a run.
  expect(r.startContract.approvals["assignment-approval"]).toContain("does not allow a run");
  expect(r.startContract.approvals["knowledge-grant"]).toContain("does not allow a run");
  expect(r.startContract.clientTimestampIsNotProof).toBe(true);
  expect(r.startContract.recheckAtStart.join(" ")).toContain("verifyLaunchScope");
});

test("a missing assignment is shown and never created", () => {
  const dir = project("noassign");
  const taskId = addTask(dir);
  const before = store.db.query("SELECT COUNT(*) AS n FROM employee_task_assignments").get();
  const r = prepare({ taskId });
  expect(codes(r)).toContain("no-assignment");
  expect(r.outcome).toBe("blocked");
  expect(r.assignment).toBeNull();
  expect(r.employee).toBeNull();
  expect(r.proposedNextAction.code).toBe("assign-worker");
  expect(store.db.query("SELECT COUNT(*) AS n FROM employee_task_assignments").get()).toEqual(before);
});

test("archived, inactive, non-worker and foreign-project employees are blocked", () => {
  const archived = scenario();
  store.db.run("UPDATE ai_employees SET status='archived', archived_at=5 WHERE id=?", [archived.person.id]);
  expect(codes(prepare({ taskId: archived.taskId }))).toContain("employee-archived");

  const inactive = scenario();
  store.db.run("UPDATE ai_employees SET status='inactive' WHERE id=?", [inactive.person.id]);
  expect(codes(prepare({ taskId: inactive.taskId }))).toContain("employee-inactive");

  const other = scenario();
  const elsewhere = project("elsewhere");
  store.db.run("UPDATE ai_employees SET project_path=? WHERE id=?", [elsewhere, other.person.id]);
  expect(codes(prepare({ taskId: other.taskId }))).toContain("employee-other-project");

  const notWorker = scenario();
  store.db.run("UPDATE ai_employees SET kind='project-manager' WHERE id=?", [notWorker.person.id]);
  expect(codes(prepare({ taskId: notWorker.taskId }))).toContain("employee-not-worker");
});

test("a stale assignment revision is blocked, and a reassigned worker is shown as current", () => {
  const s = scenario();
  const bea = worker(s.dir, "Bea Reassigned");
  const first = prepare({ taskId: s.taskId });
  expect(first.assignment?.revision).toBe(1);
  new AssignmentCore(store.db).reassign(s.taskId, bea.id, 1);
  const stale = prepare({ taskId: s.taskId, expectedAssignmentRevision: 1 });
  expect(codes(stale)).toContain("stale-assignment");
  expect(stale.outcome).toBe("blocked");
  expect(stale.proposedNextAction.code).toBe("refresh");
  // The fresh data is in the same answer, so the next click needs no guess.
  expect(stale.assignment?.revision).toBe(2);
  expect(stale.employee?.name).toBe("Bea Reassigned");
  const fresh = prepare({ taskId: s.taskId, expectedAssignmentRevision: 2 });
  expect(codes(fresh)).not.toContain("stale-assignment");
  expect(fresh.stateKey).not.toBe(first.stateKey);
  // An unassigned task: the assignment the owner reviewed no longer exists.
  new AssignmentCore(store.db).unassign(s.taskId, 2);
  expect(codes(prepare({ taskId: s.taskId, expectedAssignmentRevision: 2 }))).toEqual(expect.arrayContaining(["no-assignment", "stale-assignment"]));
});

test("an unregistered project, a moved task and an archived or done task are blocked", () => {
  const gone = scenario();
  store.projects.delete(gone.dir);
  expect(codes(prepare({ taskId: gone.taskId }))).toContain("task-outside-project");

  const moved = scenario();
  const beta = project("beta");
  store.db.run("UPDATE tasks SET workdir=? WHERE id=?", [beta, moved.taskId]);
  const m = prepare({ taskId: moved.taskId });
  expect(m.canonicalProject?.path).toBe(beta);
  expect(codes(m)).toEqual(expect.arrayContaining(["assignment-project-diverged", "employee-other-project"]));

  const archivedTask = scenario();
  store.db.run("UPDATE tasks SET archived_at=9 WHERE id=?", [archivedTask.taskId]);
  expect(codes(prepare({ taskId: archivedTask.taskId }))).toContain("task-archived");

  const done = scenario();
  store.db.run('UPDATE tasks SET "column"=\'done\' WHERE id=?', [done.taskId]);
  expect(codes(prepare({ taskId: done.taskId }))).toContain("task-column");

  const step = scenario();
  const parent = addTask(step.dir);
  store.db.run("UPDATE tasks SET pipeline_parent_id=? WHERE id=?", [parent, step.taskId]);
  expect(codes(prepare({ taskId: step.taskId }))).toContain("task-pipeline-step");
});

test("nested projects resolve to the deepest one; a git worktree resolves to its main project", () => {
  const outer = project("outer");
  const inner = path.join(outer, "inner");
  mkdirSync(inner);
  store.projects.upsert(inner, "inner");
  const taskId = addTask(path.join(inner));
  const outerWorker = worker(outer);
  // The task belongs to the inner project, so an outer-project worker cannot be assigned.
  expect(() => assign(taskId, outerWorker.id)).toThrow();
  const innerWorker = worker(inner);
  assign(taskId, innerWorker.id);
  expect(prepare({ taskId }).canonicalProject).toMatchObject({ path: inner, via: "exact" });

  const main = project("wt-main");
  mkdirSync(path.join(main, ".git", "worktrees", "wt1"), { recursive: true });
  const wt = mkdtempSync(path.join(isolated, "wt-folder-"));
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt1")}\n`);
  writeFileSync(path.join(main, ".git", "worktrees", "wt1", "gitdir"), path.join(wt, ".git") + "\n");
  const wtTask = addTask(wt);
  assign(wtTask, worker(main).id);
  const r = prepare({ taskId: wtTask });
  expect(r.canonicalProject).toMatchObject({ path: main, via: "worktree" });
  expect(r.blockingErrors).toEqual([]);
});

test("a live run, a starting proposal and a running column are conflicts", () => {
  const s = scenario();
  expect(codes(prepare({ taskId: s.taskId }, { isLive: () => true }))).toContain("task-running");
  expect(codes(prepare({ taskId: s.taskId }, { isStarting: () => true }))).toContain("execution-starting");
  store.db.run('UPDATE tasks SET "column"=\'running\' WHERE id=?', [s.taskId]);
  expect(codes(prepare({ taskId: s.taskId }))).toContain("task-column");
});

// ----- resources ------------------------------------------------------------------------------

test("manual harness selection offers every registered harness, not only verified ones", () => {
  const s = scenario();
  const r = prepare({ taskId: s.taskId, harnessId: "claude-code" });
  const registered = store.harnesses.list().map((h) => h.id).sort();
  expect(r.harnessOptions.map((o) => o.harnessId).sort()).toEqual(registered);
  // Nothing is verified here; unregistered evidence is Unknown, never Ready or Available.
  expect(r.harnessOptions.find((o) => o.harnessId === "claude-code")!.evidence).toBe("unknown");
  expect(r.harnessOptions.find((o) => o.harnessId === "codex")!.evidence).toBe("blocked");
  expect(r.selection).toMatchObject({ harnessId: "claude-code", evidence: "unknown", enabled: true });
  expect(r.outcome).toBe("prepared");
  expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["evidence-unknown", "account-unverified", "quota-unverified", "model-unverified"]));
  expect(JSON.stringify(r)).not.toMatch(/\bReady\b|\bAvailable\b/);
  // A disabled harness stays selectable to inspect, but is explicitly blocked.
  const disabled = prepare({ taskId: s.taskId, harnessId: "codex" });
  expect(codes(disabled)).toContain("harness-disabled");
  expect(disabled.selection?.evidence).toBe("blocked");
  expect(codes(prepare({ taskId: s.taskId, harnessId: "not-a-harness" }))).toContain("unknown-harness");
  // FO-DEEPSEEK01 detection metadata is never execution authority.
  const deepseek = prepare({ taskId: s.taskId, harnessId: "deepseek-dsh" });
  expect(deepseek.outcome).toBe("blocked");
  expect(codes(deepseek)).toContain("unknown-harness");
  expect(codes(deepseek)).toContain("deepseek-policy-unsupported");
  expect(deepseek.blockingErrors.find((e) => e.code === "deepseek-policy-unsupported")?.message).toContain("reads unconfined");
  expect(deepseek.harnessOptions.some((h) => h.harnessId === "deepseek-dsh")).toBe(false);
  // The task is configured for another harness: shown as a warning, never changed.
  const other = prepare({ taskId: s.taskId, harnessId: "antigravity" });
  expect(other.warnings.map((w) => w.code)).toContain("harness-differs-from-task");
  expect(store.tasks.get(s.taskId)!.agent).toBe("claude-code");
});

test("explicit model and effort are accepted only when the harness offers them", () => {
  const s = scenario();
  const model = AGENT_OPTIONS["claude-code"].models[0]!.id;
  const effort = supportedEfforts("claude-code", model)[0]?.id;
  const ok = prepare({ taskId: s.taskId, harnessId: "claude-code", model, ...(effort ? { effort } : {}) });
  expect(ok.requested).toMatchObject({ harnessId: "claude-code", model });
  expect(codes(ok)).toEqual([]);
  expect(codes(prepare({ taskId: s.taskId, harnessId: "claude-code", model: "no-such-model" }))).toContain("unknown-model");
  expect(codes(prepare({ taskId: s.taskId, harnessId: "claude-code", effort: "turbo-9000" }))).toContain("unsupported-effort");
  // The request is never written back onto the task or the employee.
  expect(store.tasks.get(s.taskId)!.model).toBe(null);
});

test("account and quota stay Unknown when nothing identifies them, and bound accounts are only listed", () => {
  const s = scenario();
  const accounts = new AccountCore(store.db);
  const one = accounts.createAccount({ provider: "anthropic", displayName: "Work login", externalIdentity: "owner@example.com" });
  const two = accounts.createAccount({ provider: "anthropic", displayName: "Personal login" });
  accounts.bindHarness(one.id, "claude-code");
  accounts.bindHarness(two.id, "claude-code");
  const before = store.db.query("SELECT COUNT(*) AS n FROM account_harness_bindings").get();
  const r = prepare({ taskId: s.taskId, harnessId: "claude-code" });
  expect(r.selection!.account.state).toBe("unknown");
  expect(r.selection!.account.label).toContain("Account Unknown");
  expect(r.selection!.account.label).toContain("2 registry accounts");
  expect(r.selection!.account.accounts.map((a) => a.displayName).sort()).toEqual(["Personal login", "Work login"]);
  expect(r.selection!.quota.state).toBe("unknown");
  expect(r.selection!.model.state).toBe("unknown");
  // No identity field, no secret, no switch.
  expect(JSON.stringify(r)).not.toContain("owner@example.com");
  expect(store.db.query("SELECT COUNT(*) AS n FROM account_harness_bindings").get()).toEqual(before);
  accounts.unbindHarness(one.id, "claude-code");
  accounts.unbindHarness(two.id, "claude-code");
});

test("verified evidence is reported only when every current fact is verified", () => {
  const s = scenario();
  const r = prepare({ taskId: s.taskId, harnessId: "claude-code", complexity: "medium" }, { ...fixed, snapshot: () => fixtureSnapshot(), owner: allowPaid });
  expect(r.selection).toMatchObject({ evidence: "verified", quota: { state: "verified" }, model: { state: "supported" } });
  expect(r.routerRecommendation).toMatchObject({ status: "recommended", harnessId: "claude-code", modelId: "opus-5.5" });
  expect(r.routerRecommendation.note).toContain("not permission");
  // Verified resources still do not identify the execution account without a profile association.
  expect(r.selection!.account.state).toBe("unknown");
  expect(JSON.stringify(r)).not.toContain("person@example.com");
  // Unknown task complexity keeps the same resources Conditional; nothing is invented.
  const unknownComplexity = prepare({ taskId: s.taskId, harnessId: "claude-code" }, { ...fixed, snapshot: () => fixtureSnapshot(), owner: allowPaid });
  expect(unknownComplexity.selection!.evidence).toBe("conditional");
  expect(unknownComplexity.missingEvidence).toContain("Task complexity is unknown.");
});

test("conflicting quota evidence is reported as conflicting, not as a verified or blocked resource", () => {
  const s = scenario();
  const r = prepare({ taskId: s.taskId, harnessId: "claude-code", complexity: "medium" }, { ...fixed, snapshot: () => fixtureSnapshot(true), owner: allowPaid });
  expect(r.selection).toMatchObject({ evidence: "conflicting", quota: { state: "conflicting" } });
  expect(r.selection!.conflicts.join(" ")).toContain("Quota sources conflict");
  expect(r.warnings.map((w) => w.code)).toContain("evidence-conflicting");
  expect(r.harnessOptions.find((o) => o.harnessId === "claude-code")!.evidence).toBe("conflicting");
});

test("unknown, stale and percent-only quota stay manual warnings and are not an automatic recommendation", () => {
  const s = scenario();
  const noQuota = fixtureSnapshot();
  noQuota.quotas = [];
  const open = prepare({ taskId: s.taskId, harnessId: "claude-code" }, { ...fixed, snapshot: () => noQuota, owner: allowPaid });
  expect(open.outcome).toBe("prepared");
  expect(open.routerRecommendation.status).toBe("no-verified-candidate");
  expect(open.selection?.quota.state).toBe("unknown");
  expect(open.selection?.quota.label).toContain("Quota Unknown");
  expect(open.warnings.map((w) => w.code)).toContain("quota-unverified");
  expect(JSON.stringify(open.selection)).not.toMatch(/\bAvailable\b/);

  const stale = fixtureSnapshot();
  for (const quota of stale.quotas) for (const observation of quota.observations) observation.expiresAt = NOW;
  const staleResult = prepare({ taskId: s.taskId, harnessId: "claude-code" }, { ...fixed, snapshot: () => stale, owner: allowPaid });
  expect(staleResult.outcome).toBe("prepared");
  expect(staleResult.routerRecommendation).toMatchObject({ status: "no-verified-candidate", harnessId: null });
  expect(staleResult.selection?.quota.state).toBe("stale");
  // Direction 11: a past reading is named as the past, not as "no reading", and nothing was refreshed.
  expect(staleResult.selection?.quota.facts).toContain("historical");
  expect(noQuota.quotas).toEqual([]);
  expect(open.selection?.quota.facts).toEqual([]);
  expect(codes(staleResult)).not.toContain("resource-excluded");

  const percent = fixtureSnapshot();
  for (const quota of percent.quotas) for (const observation of quota.observations) {
    observation.remaining = null;
    observation.limit = null;
    observation.used = null;
    observation.indicator = { kind: "percent-used", value: 40 };
  }
  const percentResult = prepare({ taskId: s.taskId, harnessId: "claude-code" }, { ...fixed, snapshot: () => percent, owner: allowPaid });
  expect(percentResult.outcome).toBe("prepared");
  expect(percentResult.routerRecommendation.status).toBe("no-verified-candidate");
  expect(percentResult.selection?.quota.state).not.toBe("verified");
});

test("an exhausted or forbidden launch model cannot be waived by choosing it, and an unprohibited model stays an Owner choice", () => {
  const s = scenario();
  const snap = fixtureSnapshot();
  for (const quota of snap.quotas) {
    quota.definition.scope = "model:opus-5.5";
    for (const observation of quota.observations) {
      observation.remaining = 0;
      observation.used = observation.limit;
    }
  }
  const sibling = structuredClone(snap.candidates[0]!);
  sibling.id = "c-sonnet";
  sibling.modelId = "sonnet-5.5";
  sibling.authorization = null;
  sibling.availability = null;
  sibling.billing = null;
  sibling.support = null;
  sibling.evidence = { ...EMPTY_MODEL_EVIDENCE };
  snap.candidates.push(sibling);
  const deps = { ...fixed, snapshot: () => snap, owner: allowPaid };

  const blank = prepare({ taskId: s.taskId, harnessId: "claude-code" }, deps);
  expect(blank.outcome).toBe("blocked");
  expect(blank.selection?.evidence).toBe("blocked");
  expect(codes(blank)).toContain("resource-excluded");
  expect(blank.blockingErrors.map((e) => e.message).join(" ")).toContain("exhausted");
  expect(blank.routerRecommendation.status).toBe("no-verified-candidate");

  const named = prepare({ taskId: s.taskId, harnessId: "claude-code", model: "opus-5.5" }, deps);
  expect(named.outcome).toBe("blocked");
  expect(codes(named)).toContain("resource-excluded");

  const other = prepare({ taskId: s.taskId, harnessId: "claude-code", model: "sonnet-5.5" }, deps);
  expect(other.outcome).toBe("prepared");
  expect(codes(other)).not.toContain("resource-excluded");
  expect(other.selection?.quota.state).toBe("unknown");
  expect(other.selection?.evidence).not.toBe("verified");
  expect(other.routerRecommendation.status).toBe("no-verified-candidate");
  expect(JSON.stringify(other)).not.toMatch(/\bAvailable\b/);
});

test("managers and assignment records cannot invoke the owner manual exception", () => {
  for (const file of ["project-manager.ts", "portfolio-manager.ts", "assignment-core.ts", "assignment-proposals.ts"]) {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    expect(source).not.toMatch(/startEmployeeExecution|reviewEmployeeExecution|prepareEmployeeExecution/);
  }
});

test("an Owner restriction cannot be bypassed by choosing the harness manually", () => {
  const s = scenario();
  const deny = (saved: OwnerRoutingConstraints): OwnerRoutingConstraints => ({ ...saved, allowedHarnesses: ["antigravity"] });
  const r = prepare({ taskId: s.taskId, harnessId: "claude-code" }, { owner: deny });
  expect(codes(r)).toContain("owner-policy");
  expect(r.outcome).toBe("blocked");
  expect(r.selection!.evidence).toBe("blocked");
  expect(r.ownerRestrictions.allowedHarnesses).toEqual(["antigravity"]);
  expect(r.harnessOptions.find((o) => o.harnessId === "claude-code")!.notRecommendedBecause.join(" ")).toContain("Owner disallows");
  // The harness the Owner allows is not blocked by policy.
  expect(codes(prepare({ taskId: s.taskId, harnessId: "antigravity" }, { owner: deny }))).not.toContain("owner-policy");
});

test("harness options explain why a resource cannot be recommended automatically", () => {
  const s = scenario();
  const r = prepare({ taskId: s.taskId });
  expect(r.routerRecommendation).toMatchObject({ status: "no-verified-candidate", harnessId: null });
  const option = r.harnessOptions.find((o) => o.harnessId === "claude-code")!;
  expect(option.notRecommendedBecause.length).toBeGreaterThan(0);
  expect(r.harnessOptions.find((o) => o.harnessId === "codex")!.notRecommendedBecause).toContain("Harness is disabled.");
});

// ----- compatibility with neighbouring stages --------------------------------------------------

test("model router preview stays independent and agrees with the preflight recommendation", async () => {
  const s = scenario();
  const before = await call({ path: s.dir, taskId: s.taskId }, "/model-router/preview");
  const r = prepare({ taskId: s.taskId });
  const after = await call({ path: s.dir, taskId: s.taskId }, "/model-router/preview");
  expect(before.status).toBe(200);
  expect(after.body.preview.status).toBe(r.routerRecommendation.status);
  expect(after.body.preview.recommendedCandidate).toBe(null);
  // Running a preflight does not change what the preview says.
  expect({ ...after.body.preview, capturedAt: 0 }).toEqual({ ...before.body.preview, capturedAt: 0 });
  expect(r.missingEvidence.every((m) => after.body.preview.unknownInformation.includes(m))).toBe(true);
});

test("an assignment proposal is not an assignment until approved; approval alone does not allow a run", async () => {
  const dir = project("proposals");
  const person = worker(dir, "Proposed Pat");
  const taskId = addTask(dir);
  const created = await fetch(base + "/assignment-proposals", {
    method: "POST",
    headers: { authorization: "Bearer " + backend.API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ taskId, employeeId: person.id, rationale: "Fits the task" }),
  });
  expect(created.status).toBe(201);
  const proposal = ((await created.json()) as any).proposal;
  expect(codes(prepare({ taskId }))).toContain("no-assignment");
  const approved = await fetch(base + `/assignment-proposals/${proposal.id}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer " + backend.API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: proposal.revision, expectedAssignmentRevision: null, allowReassign: false }),
  });
  expect(approved.status).toBe(200);
  const r = prepare({ taskId });
  expect(r.employee?.id).toBe(person.id);
  expect(r.assignment?.revision).toBe(1);
  expect(r.executionAvailable).toBe(false);
  expect(store.db.query("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId)).toEqual({ n: 0 });
});

test("a knowledge grant has no effect on a preflight", () => {
  const s = scenario();
  const before = prepare({ taskId: s.taskId });
  store.db.run(
    `INSERT INTO knowledge_context_grants (id, manager_kind, project_path, status, preview_key, items_json, total_bytes, created_at, expires_at)
     VALUES (?, 'project', ?, 'approved', 'k', '[]', 0, 1, 99999999999999)`,
    ["a".repeat(64), s.dir],
  );
  const after = prepare({ taskId: s.taskId });
  expect(after.stateKey).toBe(before.stateKey);
  expect({ ...after, capturedAt: 0, validUntil: 0 }).toEqual({ ...before, capturedAt: 0, validUntil: 0 });
  expect(readFileSync(path.join(import.meta.dir, "employee-execution.ts"), "utf8")).not.toMatch(/knowledge/i);
});

// ----- isolation, consistency and safety -------------------------------------------------------

test("concurrent preflights from two tabs read the same state and write nothing", async () => {
  const s = scenario();
  const before = store.db.serialize();
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => Promise.resolve().then(() => prepare({ taskId: s.taskId, harnessId: "claude-code" }))),
    call({ taskId: s.taskId, harnessId: "claude-code" }),
    call({ taskId: s.taskId, harnessId: "claude-code" }),
  ]);
  const keys = results.map((r) => ("stateKey" in r ? r.stateKey : r.body.preflight.stateKey));
  expect(new Set(keys).size).toBe(1);
  expect(store.db.serialize()).toEqual(before);
});

test("a preflight never mutates state or starts AI; permission probes are read-only Git only", () => {
  const s = scenario();
  const snapshot = () => ({
    task: store.db.query("SELECT * FROM tasks WHERE id = ?").get(s.taskId),
    employee: store.db.query("SELECT * FROM ai_employees WHERE id = ?").get(s.person.id),
    assignments: store.db.query("SELECT * FROM employee_task_assignments").all(),
    runs: store.db.query("SELECT COUNT(*) AS n FROM runs").get(),
    events: store.db.query("SELECT COUNT(*) AS n FROM run_events").get(),
    accounts: store.db.query("SELECT COUNT(*) AS n FROM resource_accounts").get(),
    bindings: store.db.query("SELECT * FROM account_harness_bindings").all(),
    quotas: store.db.query("SELECT COUNT(*) AS n FROM quota_observations").get(),
  });
  const before = snapshot();
  const spawned = spawn.mock.calls.length;
  const syncSpawned = spawnSync.mock.calls.length;
  prepare({ taskId: s.taskId, harnessId: "claude-code", model: AGENT_OPTIONS["claude-code"].models[0]!.id });
  prepare({ taskId: s.taskId, harnessId: "codex" });
  prepare({ taskId: s.taskId });
  expect(snapshot()).toEqual(before);
  for (const call of [...spawn.mock.calls.slice(spawned), ...spawnSync.mock.calls.slice(syncSpawned)]) {
    const input = call[0];
    const argv = Array.isArray(input) ? input : input.cmd;
    expect(argv[0]).toBe("git");
    expect(argv[1]).toBe("rev-parse");
  }
  expect(externalCalls).toBe(0);
});

test("the result carries no secret, prompt, path-to-credentials or harness configuration", () => {
  const s = scenario();
  const text = JSON.stringify(prepare({ taskId: s.taskId, harnessId: "claude-code" }));
  expect(text).not.toContain("SECRET_PROMPT_MARKER");
  expect(text).not.toMatch(/"(env|bin|home|token|password|apiKey|externalIdentity)"/i);
  expect(text).not.toMatch(/Bearer|\bsk-[A-Za-z0-9]{8}/);
  expect(text).not.toContain(isolated + "/.");
  const source = readFileSync(path.join(import.meta.dir, "employee-execution.ts"), "utf8");
  expect(source).not.toMatch(/Bun\.spawn|child_process|readFile|checkHarness|bindHarness|createAccount|recordObservation|\.insert\(|INSERT INTO|UPDATE |DELETE FROM/);
});

test("HTTP: bearer-only, strict schema, read-only POST, no client paths", async () => {
  const s = scenario();
  for (const auth of [null, "Bearer wrong", "bearer " + backend.API_TOKEN, "Bearer " + backend.API_TOKEN + "x"]) {
    expect((await call({ taskId: s.taskId }, undefined, auth)).status).toBe(401);
  }
  expect((await call({ taskId: s.taskId }, "/employee-execution/preflight?token=" + backend.API_TOKEN, null)).status).toBe(401);
  expect((await call({ taskId: s.taskId }, "/employee-execution/preflight?x=1")).status).toBe(400);
  expect((await call({}, "/employee-execution/preflight", undefined, "GET")).status).toBe(405);
  expect((await call({}, "/employee-execution/other")).status).toBe(404);
  for (const bad of [{}, { taskId: "" }, { taskId: s.taskId, path: s.dir }, { taskId: s.taskId, command: "ls" }, { taskId: s.taskId, accountId: "x" },
    { taskId: s.taskId, policy: "yolo" }, { taskId: s.taskId, complexity: "enormous" }, { taskId: s.taskId, expectedAssignmentRevision: 0 },
    { taskId: s.taskId, harnessId: "a\u0000b" }, [s.taskId]]) {
    expect((await call(bad)).status).toBe(400);
  }
  expect((await call("{not json")).status).toBe(400);
  expect((await call({ taskId: s.taskId, harnessId: "x".repeat(5000) })).status).toBe(413);
  expect((await call({ taskId: crypto.randomUUID() })).status).toBe(404);
  const ok = await call({ taskId: s.taskId });
  expect(ok.status).toBe(200);
  expect(ok.cache).toBe("no-store");
  expect(ok.body.preflight.executionAvailable).toBe(false);
});

test("HTTP snapshot: verified exhaustion blocks the launch model, a neighbor stays an Owner choice, and nothing is reserved", async () => {
  const s = scenario();
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "anthropic", displayName: "Synthetic exhaustion" });
  core.bindHarness(account.id, "claude-code");
  const expiresAt = Date.now() + 60_000;
  core.setModelCapability(account.id, "claude-code", "opus-5.5", { support: "supported", expiresAt });
  core.setModelCapability(account.id, "claude-code", "sonnet-5.5", { support: "supported", expiresAt });
  const quota = core.createDefinition({
    accountId: account.id, subscriptionId: null, scope: "model:opus-5.5", unit: { kind: "requests" }, window: "week",
  });
  core.recordTrustedObservations("anthropic-admin", [{
    quotaId: quota.id,
    values: { remaining: 0, limit: 1, used: 1, expiresAt },
    evidence: {
      provider: "anthropic", accountId: account.id, subject: "synthetic-subject", method: "provider-account",
      sourceId: "anthropic-admin", officialUrl: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api",
      checkedAt: "2026-10-28", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic acceptance evidence",
    },
  }]);
  const observations = () => store.db.query("SELECT COUNT(*) AS n FROM quota_observations").get() as { n: number };
  const runCount = () => store.db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
  const assignmentCount = () => store.db.query("SELECT COUNT(*) AS n FROM employee_task_assignments").get() as { n: number };
  const beforeObservations = observations();
  const beforeRuns = runCount();
  const beforeAssignments = assignmentCount();

  const catalog = await call(undefined, "/account-core/quota-sources", "Bearer " + backend.API_TOKEN, "GET");
  expect(catalog.status).toBe(200);
  expect(catalog.body.find((source: { id: string }) => source.id === "anthropic-admin")).toMatchObject({ implemented: false, refreshAvailable: false });

  const blocked = await call({ taskId: s.taskId, harnessId: "claude-code", model: "opus-5.5" });
  expect(blocked.status).toBe(200);
  expect(blocked.body.preflight.outcome).toBe("blocked");
  expect(blocked.body.preflight.blockingErrors.map((error: { code: string }) => error.code)).toContain("resource-excluded");
  expect(blocked.body.preflight.blockingErrors.map((error: { message: string }) => error.message).join(" ")).toContain("exhausted");
  expect(blocked.body.preflight.routerRecommendation.status).toBe("no-verified-candidate");
  expect(blocked.body.preflight.executionAvailable).toBe(false);

  // The task has no model, so a blank choice launches the harness default, which is the exhausted model.
  const blank = await call({ taskId: s.taskId, harnessId: "claude-code" });
  expect(blank.body.preflight.outcome).toBe("blocked");
  expect(blank.body.preflight.blockingErrors.map((error: { code: string }) => error.code)).toContain("resource-excluded");

  const neighbor = await call({ taskId: s.taskId, harnessId: "claude-code", model: "sonnet-5.5" });
  expect(neighbor.body.preflight.outcome).toBe("prepared");
  expect(neighbor.body.preflight.blockingErrors).toEqual([]);
  expect(neighbor.body.preflight.selection.quota.state).toBe("unknown");
  expect(JSON.stringify(neighbor.body.preflight.selection)).not.toMatch(/\bAvailable\b/);
  expect(neighbor.body.preflight.routerRecommendation).toMatchObject({
    status: "no-verified-candidate", harnessId: null, modelId: null, accountId: null,
  });

  const review = await call({ taskId: s.taskId, harnessId: "claude-code", model: "opus-5.5" }, "/employee-execution/reviews");
  expect(review.status).toBe(200);
  expect(review.body.attempt).toBeNull();
  expect(review.body.blockingErrors.map((error: { code: string }) => error.code)).toContain("resource-excluded");

  const preview = await call({ path: s.dir, taskId: s.taskId }, "/model-router/preview");
  expect(preview.status).toBe(200);
  expect(preview.body.preview.status).toBe("no-verified-candidate");
  expect(preview.body.preview.recommendedCandidate).toBeNull();
  expect(observations()).toEqual(beforeObservations);
  expect(runCount()).toEqual(beforeRuns);
  expect(assignmentCount()).toEqual(beforeAssignments);
});

test("a provider usage-limit refusal is a warning on exactly its account: no block, no auto-retry, readiness stays unconfirmed", async () => {
  const s = scenario();
  const { recordProviderRefusal, supersedeProviderRefusals } = await import("./provider-refusals.ts");
  const runs = () => (store.db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  const beforeRuns = runs();
  const baseline = await call({ taskId: s.taskId, harnessId: "claude-code", model: "sonnet-5.5" });
  expect(baseline.body.preflight.warnings.map((w: { code: string }) => w.code)).not.toContain("provider-usage-limit-refused");

  const scope = { harnessId: "claude-code", accountId: null, modelId: "sonnet-5.5" };
  recordProviderRefusal({
    kind: "usage-limit", provider: "claude-code", scope, surface: "test", evidenceId: "preflight-refusal",
    proof: "usage_limit_exceeded", retryHint: "9:31 PM", diagnostics: "synthetic",
  });
  const refused = await call({ taskId: s.taskId, harnessId: "claude-code", model: "sonnet-5.5" });
  const warning = refused.body.preflight.warnings.find((w: { code: string }) => w.code === "provider-usage-limit-refused");
  expect(warning.message).toContain("readiness to run is unconfirmed");
  // The sentence states no time, balance or reset.
  expect(warning.message).not.toMatch(/\d:\d\d|balance|reset|remaining/i);
  expect(refused.body.preflight.selection.evidence).not.toBe("verified");
  // It is advice, not a block: the Owner's manual choice and authorization behaviour are unchanged.
  expect(refused.body.preflight.outcome).toBe(baseline.body.preflight.outcome);
  expect(refused.body.preflight.blockingErrors).toEqual(baseline.body.preflight.blockingErrors);
  expect(refused.body.preflight.routerRecommendation.accountId).toBeNull();
  expect(runs()).toBe(beforeRuns);

  // A different harness is unaffected.
  const neighbour = await call({ taskId: s.taskId, harnessId: "codex", model: "gpt-6.1-sol" });
  expect(neighbour.body.preflight.warnings.map((w: { code: string }) => w.code)).not.toContain("provider-usage-limit-refused");

  // The same harness with another model is not covered by an observation made on this model.
  const otherModel = await call({ taskId: s.taskId, harnessId: "claude-code", model: "opus-5.5" });
  expect(otherModel.body.preflight.warnings.map((w: { code: string }) => w.code)).not.toContain("provider-usage-limit-refused");

  // Only a later successful answer on this exact scope ends it.
  supersedeProviderRefusals(scope, "later-success");
  const cleared = await call({ taskId: s.taskId, harnessId: "claude-code", model: "sonnet-5.5" });
  expect(cleared.body.preflight.warnings.map((w: { code: string }) => w.code)).not.toContain("provider-usage-limit-refused");
});
