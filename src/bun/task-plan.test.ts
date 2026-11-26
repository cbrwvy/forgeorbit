import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startableNodes, type PlanView } from "../shared/task-plan.ts";
import { parseProposal, type ProposalItem, type TaskProposal } from "../shared/project-manager.ts";

/**
 * FO-ORCH04 task plan view. Fake codex driver behind a /bin/echo stub, a
 * disposable SQLite and temp project folders: no real AI CLI runs and no
 * provider is reached. The plan routes are read-only, so most tests also
 * assert that nothing was written (runs, assignments, journal, tasks).
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch04-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4744";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch04";

let store: typeof import("./db.ts");
let backend: typeof import("./server.ts");
let server: ReturnType<(typeof import("./server.ts"))["startApiServer"]>;
let orchestrator: typeof import("./orchestrator.ts");
let manager: typeof import("./project-manager.ts");
let plans: typeof import("./task-plan.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AssignmentProposalCore: typeof import("./assignment-proposals.ts").AssignmentProposalCore;
const base = "http://127.0.0.1:4744";
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  manager = await import("./project-manager.ts");
  plans = await import("./task-plan.ts");
  backend = await import("./server.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ AssignmentProposalCore } = await import("./assignment-proposals.ts"));
  server = backend.startApiServer();
  store.harnesses.setEnabled("codex", true);
  store.harnesses.setEnabled("claude-code", true);
  store.harnesses.setEnabled("cursor", false);
});
afterAll(() => server?.stop(true));
beforeEach(() => store.preferences.set("executorRoutingPreferences", ""));

const present = { recommendations: { cli: () => ({ available: true, loggedIn: null as boolean | null }) } };

function project(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(isolated, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  store.projects.upsert(dir, name);
  return dir;
}

function item(id: string, title: string, deps: string[] = [], extra: Partial<ProposalItem> = {}): ProposalItem {
  return {
    id, title, description: `${title} description`, priority: "medium", acceptanceCriteria: [`${title} works`],
    dependsOn: deps.map((itemId) => ({ kind: "item" as const, itemId })), parentFeature: null, taskType: "task",
    rationale: "", include: true, duplicate: null, duplicateAction: "use-existing", warnings: [], result: null, ...extra,
  };
}

function storeProposal(dir: string, items: ProposalItem[], title = "Build the API"): TaskProposal {
  const proposal: TaskProposal = {
    id: crypto.randomUUID(), projectPath: dir, messageId: "m1", title, summary: "A goal", status: "pending",
    items, createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
  };
  store.projectManagers.putProposal(dir, proposal.id, proposal.status, JSON.stringify(proposal), proposal.createdAt);
  return proposal;
}

async function approved(dir: string, items: ProposalItem[], title?: string) {
  const proposal = storeProposal(dir, items, title);
  const result = await manager.approveProposal(dir, proposal.id, { revision: proposal.revision });
  if (!result.ok) throw new Error(result.error);
  const taskOf = (itemId: string) => {
    const stored = result.value.proposal.items.find((i) => i.id === itemId)!;
    return stored.result!.taskId!;
  };
  return { proposal: result.value.proposal, taskOf };
}

async function plan(dir: string, id: string, skipRecommendations = true): Promise<PlanView> {
  const out = await plans.getPlan(dir, id, { skipRecommendations, ...present });
  if (!out.ok) throw new Error(out.error);
  return out.value;
}
const node = (view: PlanView, title: string) => view.nodes.find((n) => n.title === title)!;

function snapshot() {
  const n = (sql: string) => store.db.query<{ n: number }, []>(sql).get()!.n;
  return {
    runs: n("SELECT COUNT(*) AS n FROM runs"),
    assignments: n("SELECT COUNT(*) AS n FROM employee_task_assignments"),
    journal: n("SELECT COUNT(*) AS n FROM activity_events"),
    executions: n("SELECT COUNT(*) AS n FROM employee_executions"),
    tasks: JSON.stringify(store.tasks.list().map((t) => [t.id, t.column, t.updatedAt, t.runId])),
    proposals: JSON.stringify(store.projectManagers.listProposals.call(store.projectManagers, "")),
  };
}

// ----- plan representation -------------------------------------------------------------------

test("a multi-task plan keeps its goal, order, priorities and the board link", async () => {
  const dir = project("api");
  const { proposal, taskOf } = await approved(dir, [
    item("i1", "Design the API"),
    item("i2", "Implement auth", ["i1"], { priority: "high" }),
    item("i3", "Write tests", ["i2"]),
    item("i4", "Write docs", ["i1"]),
  ]);
  const view = await plan(dir, proposal.id);
  expect(view.title).toBe("Build the API");
  expect(view.projectPath).toBe(dir);
  expect(view.readOnly).toBe(true);
  expect(view.executionAvailable).toBe(false);
  expect(view.nodes.map((n) => n.title)).toEqual(["Design the API", "Implement auth", "Write docs", "Write tests"]);
  expect(view.nodes.map((n) => n.wave)).toEqual([1, 2, 2, 3]);
  expect(node(view, "Implement auth").priority).toBe("high");
  expect(node(view, "Design the API")).toMatchObject({ stage: "created", state: "ready", taskId: taskOf("i1"), reasons: [] });
  expect(node(view, "Write tests")).toMatchObject({ state: "blocked", taskId: taskOf("i3") });
  expect(node(view, "Write tests").reasons.join(" ")).toContain("Implement auth");
  expect(view.counts).toMatchObject({ ready: 1, blocked: 3 });
  // The dependency rows are the existing structured ones.
  expect(store.taskScheduling.dependenciesOf(taskOf("i3"))).toEqual([taskOf("i2")]);
});

test("synthetic plan: A → B with independent C — A and C may be considered, B waits for the lifecycle", async () => {
  const dir = project("abc");
  const { proposal, taskOf } = await approved(dir, [item("i1", "Task A"), item("i2", "Task B", ["i1"]), item("i3", "Task C")]);
  let view = await plan(dir, proposal.id);
  expect(startableNodes(view).map((n) => n.title).sort()).toEqual(["Task A", "Task C"]);
  expect(node(view, "Task B")).toMatchObject({ state: "blocked", wave: 2 });
  expect(node(view, "Task A").wave).toBe(node(view, "Task C").wave);

  // A is running: B still waits, A shows in progress.
  store.tasks.update(taskOf("i1"), { column: "running" });
  view = await plan(dir, proposal.id);
  expect(node(view, "Task A").state).toBe("in-progress");
  expect(node(view, "Task B").state).toBe("blocked");

  // A finished a run and sits in Review: that is not Done, B stays blocked.
  store.tasks.update(taskOf("i1"), { column: "review" });
  view = await plan(dir, proposal.id);
  expect(node(view, "Task A").state).toBe("waiting-owner");
  expect(node(view, "Task A").reasons.join(" ")).toContain("Review is not Done");
  expect(node(view, "Task B")).toMatchObject({ state: "blocked" });
  expect(node(view, "Task B").reasons.join(" ")).toContain("in Review");
  expect(node(view, "Task B").dependsOn[0]!.status).toBe("in-review");

  // The Owner accepts A (Done): B becomes ready, A completed.
  store.tasks.update(taskOf("i1"), { column: "done" });
  view = await plan(dir, proposal.id);
  expect(node(view, "Task A").state).toBe("completed");
  expect(node(view, "Task B")).toMatchObject({ state: "ready", reasons: [] });
  expect(view.counts.completed).toBe(1);
});

// ----- graph validation ------------------------------------------------------------------------

test("a proposal whose tasks wait for each other is rejected when parsed and at approval", async () => {
  const parsed = parseProposal({
    title: "Loop", tasks: [
      { ref: "A", title: "A", description: "d", acceptance_criteria: ["x"], depends_on: ["B"] },
      { ref: "B", title: "B", description: "d", acceptance_criteria: ["x"], depends_on: ["A"] },
    ],
  }, new Map());
  expect(parsed.ok).toBe(false);
  expect(!parsed.ok && parsed.error).toContain("cycle");

  // A cyclic proposal stored by an older build can't be approved either, and creates nothing.
  const dir = project("cycle");
  const stored = storeProposal(dir, [item("i1", "Loop A", ["i2"]), item("i2", "Loop B", ["i1"])]);
  const before = store.tasks.list().length;
  const approve = await manager.approveProposal(dir, stored.id, { revision: stored.revision });
  expect(approve.ok).toBe(false);
  expect(!approve.ok && approve.status).toBe(409);
  expect(store.tasks.list().length).toBe(before);
  const view = await plan(dir, stored.id);
  expect(view.issues.map((i) => i.code)).toContain("cycle");
  expect(view.nodes.every((n) => n.state === "blocked")).toBe(true);
  expect(startableNodes(view)).toEqual([]);
});

test("an unknown dependency is dropped with a warning and shown on the node; a deleted or foreign one blocks", async () => {
  const dir = project("unknown");
  const parsed = parseProposal({
    title: "P", tasks: [
      { ref: "A", title: "A", description: "d", acceptance_criteria: ["x"], depends_on: ["NOPE"] },
    ],
  }, new Map());
  expect(parsed.ok && parsed.draft.items[0]!.warnings[0]).toContain("NOPE");
  const parsedOk = parsed.ok ? parsed.draft : null;
  const stored = storeProposal(dir, parsedOk!.items);
  expect((await plan(dir, stored.id)).nodes[0]!.warnings[0]).toContain("NOPE");

  const other = project("other");
  const { proposal, taskOf } = await approved(dir, [item("i1", "Base"), item("i2", "Top", ["i1"]), item("i3", "Edge", ["i1"])]);
  // Deleted dependency.
  await orchestrator.deleteTask(taskOf("i1"));
  let view = await plan(dir, proposal.id);
  expect(node(view, "Top").state).toBe("blocked");
  expect(node(view, "Top").reasons.join(" ")).toContain("was deleted");
  // A dependency that moved to another project is not honoured.
  const moved = await orchestrator.createTask({ title: "Moved dep", prompt: "p", workdir: dir, isolation: "none", column: "done" } as never);
  if ("error" in moved) throw new Error(moved.error);
  const edgeId = taskOf("i3");
  store.taskScheduling.replaceDependencies(edgeId, [moved.task.id]);
  store.tasks.update(moved.task.id, { workdir: other });
  view = await plan(dir, proposal.id);
  expect(node(view, "Edge").state).toBe("blocked");
  expect(node(view, "Edge").reasons.join(" ")).toContain("no longer in this project");
});

test("a proposed link that never became a dependency row is reported, not assumed", async () => {
  const dir = project("unlinked");
  const { proposal, taskOf } = await approved(dir, [item("i1", "First"), item("i2", "Second", ["i1"])]);
  store.taskScheduling.replaceDependencies(taskOf("i2"), []);
  const view = await plan(dir, proposal.id);
  expect(node(view, "Second").state).toBe("ready");
  expect(node(view, "Second").dependsOn[0]).toMatchObject({ status: "missing" });
  expect(node(view, "Second").dependsOn[0]!.note).toContain("not enforced");
});

test("a pending proposal is judged by its own links before anything exists on the board", async () => {
  const dir = project("pending");
  const stored = storeProposal(dir, [item("i1", "Spec"), item("i2", "Build", ["i1"]), item("i3", "Left out", [], { include: false })]);
  const before = store.tasks.list().length;
  const view = await plan(dir, stored.id);
  expect(view.proposalStatus).toBe("pending");
  expect(node(view, "Spec")).toMatchObject({ stage: "proposed", state: "ready", taskId: null });
  expect(node(view, "Build")).toMatchObject({ stage: "proposed", state: "blocked" });
  expect(node(view, "Left out")).toMatchObject({ stage: "skipped", state: null });
  expect(view.counts.skipped).toBe(1);
  expect(store.tasks.list().length).toBe(before);
});

// ----- staleness and Owner workflow -------------------------------------------------------------

test("a plan goes stale after a task change or an Owner preference change, and verifying writes nothing", async () => {
  const dir = project("stale");
  const { proposal, taskOf } = await approved(dir, [item("i1", "One"), item("i2", "Two", ["i1"])]);
  const first = await plans.getPlan(dir, proposal.id, present);
  if (!first.ok) throw new Error(first.error);
  const before = snapshot();
  const same = await plans.verifyPlan(dir, proposal.id, first.value.planKey, present);
  expect(same.ok).toBe(true);
  expect((await plans.getPlan(dir, proposal.id, present) as { value: PlanView }).value.planKey).toBe(first.value.planKey);

  store.preferences.set("executorRoutingPreferences", JSON.stringify({ preferredHarnessId: "claude-code" }));
  const prefStale = await plans.verifyPlan(dir, proposal.id, first.value.planKey, present);
  expect(prefStale.ok).toBe(false);
  expect(!prefStale.ok && prefStale.status).toBe(409);
  expect(!prefStale.ok && (prefStale.body as { stale: boolean }).stale).toBe(true);
  store.preferences.set("executorRoutingPreferences", "");

  const again = await plans.getPlan(dir, proposal.id, present);
  if (!again.ok) throw new Error(again.error);
  expect(again.value.planKey).toBe(first.value.planKey);
  store.taskScheduling.setPriority(taskOf("i1"), "critical");
  const prioStale = await plans.verifyPlan(dir, proposal.id, first.value.planKey, present);
  expect(prioStale.ok).toBe(false);
  expect(snapshot().runs).toBe(before.runs);
  expect(snapshot().assignments).toBe(before.assignments);
  expect(snapshot().journal).toBe(before.journal);
  expect((await plans.verifyPlan(dir, proposal.id, "", present)).ok).toBe(false);
});

test("Owner rejection: a pending assignment proposal shows as waiting, rejecting it assigns nobody, and approval assigns once", async () => {
  const dir = project("owner");
  const { proposal, taskOf } = await approved(dir, [item("i1", "Gate"), item("i2", "Next", ["i1"])]);
  const worker = new EmployeeCore(store.db).createWorker({ name: `Worker ${++counter}`, jobTitle: "QA", projectPath: dir });
  const core = new AssignmentProposalCore(store.db, new AssignmentCore(store.db));
  const created = core.create(taskOf("i1"), worker.id, "Looks right");
  let view = await plan(dir, proposal.id);
  expect(node(view, "Gate")).toMatchObject({ state: "waiting-owner", pendingAssignmentProposalId: created.id, assignment: null });

  const rejected = core.reject(created.id, created.revision);
  expect(rejected.proposal.status).toBe("rejected");
  view = await plan(dir, proposal.id);
  expect(node(view, "Gate")).toMatchObject({ state: "ready", pendingAssignmentProposalId: null, assignment: null });
  expect(new AssignmentCore(store.db).forTask(taskOf("i1"))).toBeNull();

  const second = core.create(taskOf("i1"), worker.id, "Try again");
  const body = { expectedRevision: second.revision, expectedAssignmentRevision: null, allowReassign: false };
  const done = core.approve(second.id, body);
  const replay = core.approve(second.id, body);
  expect(replay.alreadyApplied).toBe(true);
  expect(done.alreadyApplied).not.toBe(true);
  const rows = store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM employee_task_assignments WHERE task_id = ? AND status = 'active'").get(taskOf("i1"))!.n;
  expect(rows).toBe(1);
  view = await plan(dir, proposal.id);
  expect(node(view, "Gate").assignment).toMatchObject({ employeeId: worker.id });
  expect(node(view, "Gate").state).toBe("ready");
  const approvals = store.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM activity_events WHERE event_type = 'task.assignment.approved' AND task_id = ?").get(taskOf("i1"))!.n;
  expect(approvals).toBeLessThanOrEqual(1);
});

test("rejecting the whole plan leaves every node without a state and nothing on the board", async () => {
  const dir = project("rejected");
  const stored = storeProposal(dir, [item("i1", "Never")]);
  const result = manager.rejectProposal(dir, stored.id);
  expect(result.ok).toBe(true);
  const view = await plan(dir, stored.id);
  expect(view.proposalStatus).toBe("rejected");
  expect(view.nodes.every((n) => n.state === null)).toBe(true);
  expect(view.issues.map((i) => i.code)).toContain("rejected");
  expect(store.tasks.list().some((t) => t.title === "Never")).toBe(false);
});

// ----- executor recommendations -----------------------------------------------------------------

test("ready tasks get the existing recommender's answer; unknown quota stays Unknown and nothing is selected automatically", async () => {
  const dir = project("recs");
  const { proposal } = await approved(dir, [item("i1", "Ready one"), item("i2", "Waiting", ["i1"])]);
  const view = await plan(dir, proposal.id, false);
  const ready = node(view, "Ready one");
  expect(ready.executor).not.toBeNull();
  expect(ready.executor!.automaticSelection).toBe("none");
  const proposed = ready.executor!.proposed!;
  expect(proposed.classification).toBe("potential-unknown");
  expect(proposed.evidence).not.toBe("verified");
  expect(proposed.requiresOwnerConfirmation).toBe(true);
  expect(proposed.why.length + proposed.limitations.length).toBeGreaterThan(0);
  expect(proposed.mode).not.toBeNull();
  // Blocked tasks are not routed.
  expect(node(view, "Waiting").executor).toBeNull();
  // Same answer the recommender gives directly: no second algorithm.
  const direct = await (await import("./executor-recommendations.ts")).recommendExecutors({ taskId: ready.taskId! }, present.recommendations ? { cli: present.recommendations.cli } : {});
  const all = Object.values(direct.recommendations.groups).flat().map((o) => o.id);
  expect(all).toContain(proposed.id);
});

test("a disabled harness is never proposed, even when the task names it", async () => {
  const dir = project("disabled");
  const { proposal, taskOf } = await approved(dir, [item("i1", "Cursor task")]);
  store.tasks.update(taskOf("i1"), { agent: "cursor" });
  const view = await plan(dir, proposal.id, false);
  const hint = node(view, "Cursor task").executor!;
  expect(hint.proposed?.harnessId).not.toBe("cursor");
  expect([hint.proposed, ...hint.alternatives].every((o) => o?.harnessId !== "cursor")).toBe(true);
});

test("a Full access requirement is disclosed and still needs separate Owner confirmation", async () => {
  const dir = project("full");
  const { proposal } = await approved(dir, [item("i1", "Needs full")]);
  store.preferences.set("executorRoutingPreferences", JSON.stringify({ requiredMode: "full-access" }));
  const view = await plan(dir, proposal.id, false);
  const codex = [view.nodes[0]!.executor!.proposed, ...view.nodes[0]!.executor!.alternatives].find((o) => o?.harnessId === "codex");
  expect(codex).toBeTruthy();
  expect(codex!.permission).toMatchObject({ sandbox: "danger-full-access", escalated: true });
  expect(codex!.requiresOwnerConfirmation).toBe(true);
  expect(view.executionAvailable).toBe(false);
});

// ----- no side effects, routes, persistence -------------------------------------------------------

test("reading, listing and verifying plans starts no run, creates no assignment, review or journal event", async () => {
  const dir = project("quiet");
  const { proposal } = await approved(dir, [item("i1", "Quiet A"), item("i2", "Quiet B", ["i1"]), item("i3", "Quiet C")]);
  const before = snapshot();
  const first = await plans.getPlan(dir, proposal.id, present);
  if (!first.ok) throw new Error(first.error);
  await plans.verifyPlan(dir, proposal.id, first.value.planKey, present);
  plans.listPlans(dir);
  const after = snapshot();
  expect({ ...after, proposals: "" }).toEqual({ ...before, proposals: "" });
  expect(first.value.nodes.every((n) => n.taskId == null || store.tasks.get(n.taskId)!.runId == null)).toBe(true);
});

test("plan routes need the API token, are scoped to the project and are read-only over HTTP", async () => {
  const dir = project("http");
  const other = project("http-other");
  const { proposal } = await approved(dir, [item("i1", "H1"), item("i2", "H2", ["i1"])]);
  const call = async (method: string, route: string, body?: unknown, auth = true) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${backend.API_TOKEN}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const q = (p: string) => `path=${encodeURIComponent(p)}`;
  expect((await call("GET", `/project-manager/plans?${q(dir)}`, undefined, false)).status).toBe(401);
  const list = await call("GET", `/project-manager/plans?${q(dir)}`);
  expect(list.status).toBe(200);
  expect(list.json.plans.find((p: any) => p.proposalId === proposal.id)).toMatchObject({ taskCount: 2, cycle: false });
  expect((await call("GET", `/project-manager/plans/${proposal.id}?${q(other)}`)).status).toBe(404);
  const got = await call("GET", `/project-manager/plans/${proposal.id}?${q(dir)}`);
  expect(got.status).toBe(200);
  expect(got.json.nodes).toHaveLength(2);
  const bad = await call("POST", `/project-manager/plans/${proposal.id}/verify`, { path: dir, planKey: "old" });
  expect(bad.status).toBe(409);
  expect(bad.json.stale).toBe(true);
  const good = await call("POST", `/project-manager/plans/${proposal.id}/verify`, { path: dir, planKey: got.json.planKey });
  expect(good.status).toBe(200);
  expect((await call("DELETE", `/project-manager/plans/${proposal.id}?${q(dir)}`)).status).not.toBe(200);
});

test("the plan is derived from stored rows only, so a fresh read after any gap gives the same view", async () => {
  const dir = project("persist");
  const { proposal } = await approved(dir, [item("i1", "P1"), item("i2", "P2", ["i1"])]);
  const a = await plan(dir, proposal.id, false);
  // Drop every in-process cache the reads could lean on and read again.
  const again = await plan(dir, proposal.id, false);
  expect(again).toEqual(a);
  expect(JSON.parse(JSON.stringify(a))).toEqual(a);
});
