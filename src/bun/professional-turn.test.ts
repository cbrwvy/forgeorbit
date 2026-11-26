import { beforeAll, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFxStubBin } from "../../e2e/isolated-env.ts";
import { MAX_PROMPT_BYTES } from "../shared/employees/profile-types.ts";
import { composeProfessionalPrompt } from "../shared/execution/professional.ts";
import { DEFAULT_MODEL, type AgentKind } from "../shared/types.ts";

// Set before any backend import. Every potential CLI target is an inert stub.
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo014e-")));
process.env.HOME = isolated;
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/bin/echo";
  process.env[`AGETOR_${kind}_DRIVER`] = "fake";
}
process.env.AGETOR_FX_BIN = writeFxStubBin(isolated);
let store: typeof import("./db.ts");
let runtime: typeof import("./orchestrator.ts");
let run: typeof import("./employee-run.ts");
let agents: typeof import("./agents.ts");
let profiles: import("./catalog/employee-profile-core.ts").EmployeeProfileCore;
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let EmployeeRunCore: typeof import("./employee-run-core.ts").EmployeeRunCore;
let professional: typeof import("./professional-runtime.ts");
beforeAll(async () => {
  store = await import("./db.ts"); runtime = await import("./orchestrator.ts");
  run = await import("./employee-run.ts"); agents = await import("./agents.ts");
  professional = await import("./professional-runtime.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ EmployeeRunCore } = await import("./employee-run-core.ts"));
  const { EmployeeProfileCore } = await import("./catalog/employee-profile-core.ts");
  profiles = new EmployeeProfileCore(store.db);
  for (const h of store.harnesses.list()) store.harnesses.setEnabled(h.id, true);
  run.initEmployeeExecutionTracking();
});
let n = 0;
const guidance = "# Historical professional instructions\nUse rigorous tests. PROFILE_EXACT_MARKER";
async function scenario(withProfile = true, kind: AgentKind = "codex", prompt = "Implement the approved task.") {
  const dir = realpathSync(mkdtempSync(path.join(isolated, "project-")));
  writeFileSync(path.join(dir, "README.md"), "# Isolated fixture\n");
  store.projects.upsert(dir, "Professional fixture");
  const employee = new EmployeeCore(store.db).createWorker({ name: `Professional ${++n}`, jobTitle: "Engineer", projectPath: dir });
  const created = await runtime.createTask({ title: `Task ${n}`, prompt, workdir: dir, column: "ready", agent: kind,
    model: DEFAULT_MODEL[kind], isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  new AssignmentCore(store.db).assign(taskId, employee.id);
  if (withProfile) profiles.assignRole(employee.id, { catalogRoleSlug: "engineering-backend-architect", promptMarkdown: guidance });
  return { dir, employee, taskId };
}
const review = (s: { taskId: string }, deps: import("./employee-run.ts").EmployeeRunDeps = {}, harnessId = "codex") =>
  run.reviewEmployeeExecution({ taskId: s.taskId, harnessId }, deps);
async function reviewed(s: { taskId: string }, deps: import("./employee-run.ts").EmployeeRunDeps = {}, harnessId = "codex") {
  const r = await review(s, deps, harnessId);
  expect(r.blockingErrors).toEqual([]); expect(r.attempt).not.toBeNull(); return r.attempt!;
}
const confirm = (a: { id: string; revision: number }, deps: import("./employee-run.ts").EmployeeRunDeps = {}) =>
  run.startEmployeeExecution(a.id, { confirm: true, revision: a.revision, acknowledgeUsage: true }, deps);
async function finished(id: string) {
  for (let i = 0; i < 150; i++) {
    const a = run.getEmployeeRun(id);
    if (a.finishedAt !== null) return a;
    await Bun.sleep(20);
  }
  throw new Error("Fake run did not settle");
}
const payload = (taskId: string) => agents.__getFakeDriver(taskId)!._record[0]!.slice("spawn:".length);


let turns: typeof import("./professional-turn.ts");
beforeAll(async () => { turns = await import("./professional-turn.ts"); });
async function live(kind: AgentKind = "claude-code") {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "60000";
  const s = await scenario(true, kind, "__agetor_fake_claude_handoff__");
  const a = await reviewed(s, {}, kind); const started = await confirm(a);
  expect(started.attempt.status).toBe("started");
  return { ...s, a, runId: started.attempt.runId! };
}
const submit = (t: import("../shared/execution/turn.ts").ProfessionalTurn, extra = {}) => turns.submitProfessionalTurn(t.id,
  { revision: t.revision, idempotencyKey: t.idempotency_key, confirm: true, acknowledgeUsage: true, ...extra });
async function withLive(fn: (s: Awaited<ReturnType<typeof live>>) => Promise<void> | void) {
  const s = await live();
  try { await fn(s); } finally { await runtime.cancelRun(s.runId); }
}

test("initial Turn and separately approved ordered follow-ups retain exact Run, snapshot and payload", () => withLive(async s => {
  const initial = turns.professionalTurnHistory(s.runId);
  expect(initial.turns).toHaveLength(1); expect(initial.turns[0]!.status).toBe("included");
  expect(initial.session.state).toBe("attached");
  const first = turns.reviewProfessionalTurn(s.runId, { prompt: "First approved follow-up: Привет 😀 $HOME `id`", idempotencyKey: "first" }).turn;
  expect(first.status).toBe("reviewed"); expect(agents.__getFakeDriver(s.taskId)!._record.filter(x => x.startsWith("write:"))).toEqual([]);
  expect((await submit(first)).turn.status).toBe("included");
  const second = turns.reviewProfessionalTurn(s.runId, { prompt: "Second follow-up", idempotencyKey: "second" }).turn;
  expect((await submit(second)).turn.status).toBe("included");
  const rows = turns.professionalTurnHistory(s.runId).turns;
  expect(rows.map(t => t.turn_number)).toEqual([1, 2, 3]); expect(rows[2]!.parent_turn_id).toBe(first.id);
  expect(rows.every(t => t.attempt_id === s.a.id && t.run_id === s.runId && t.snapshot_sha256 === rows[0]!.snapshot_sha256)).toBe(true);
  expect(store.runs.countForTask(s.taskId)).toBe(1);
  expect(agents.__getFakeDriver(s.taskId)!._record.filter(x => x.startsWith("write:"))).toEqual([`write:${first.prompt}`, "write:Second follow-up"]);
  expect(rows[1]!.prompt_sha256).toBe(professional.promptSha256(first.prompt!));
  expect(rows[1]!.authorization_ref).toBe(`owner-turn:${first.id}`);
}));

test("follow-up never substitutes an edited active professional revision", () => withLive(async s => {
  const first = turns.reviewProfessionalTurn(s.runId, { prompt: "Use original context", idempotencyKey: "profile-edit" }).turn;
  profiles.updatePrompt(s.employee.id, { expectedRevision: 1, promptMarkdown: "NEW CURRENT PROFILE" });
  expect((await submit(first)).turn.status).toBe("included");
  expect(turns.professionalTurnHistory(s.runId).turns[1]!.snapshot_revision_id).toBe(first.snapshot_revision_id);
  expect(agents.__getFakeDriver(s.taskId)!._record.at(-1)).toBe("write:Use original context");
  expect(run.getEmployeeRun(s.a.id).professional!.binding).toMatchObject({ revision: 1, promptMarkdown: guidance });
}));

test("missing Owner approval, usage acknowledgement and stale CAS send no bytes", () => withLive(async s => {
  const t = turns.reviewProfessionalTurn(s.runId, { prompt: "No unauthorized send", idempotencyKey: "approval" }).turn;
  for (const bad of [{ confirm: false }, { acknowledgeUsage: false }, { revision: 0 }, { revision: 999 }, { permissions: "all" }]) await expect(submit(t, bad)).rejects.toBeDefined();
  expect(agents.__getFakeDriver(s.taskId)!._record.filter(x => x.startsWith("write:"))).toEqual([]);
  expect((await runtime.sendInput(s.runId, "legacy bypass")).delivered).toBe(false);
  expect((await submit(t)).turn.status).toBe("included");
}));

test("persistent idempotency replay and concurrent submissions dispatch exactly once locally", () => withLive(async s => {
  const t = turns.reviewProfessionalTurn(s.runId, { prompt: "Once", idempotencyKey: "once" }).turn;
  expect(turns.reviewProfessionalTurn(s.runId, { prompt: "Once", idempotencyKey: "once" }).replayed).toBe(true);
  expect(() => turns.reviewProfessionalTurn(s.runId, { prompt: "Different", idempotencyKey: "once" })).toThrow("different payload");
  const results = await Promise.all([submit(t), submit(t)]);
  expect(results.filter(r => r.replayed)).toHaveLength(1);
  await submit(t);
  expect(agents.__getFakeDriver(s.taskId)!._record.filter(x => x === "write:Once")).toHaveLength(1);
  expect(store.runs.countForTask(s.taskId)).toBe(1);
}));

for (const mutate of ["assignment", "employee", "session", "project", "harness"] as const) {
  test(`${mutate} identity/authority change invalidates review before delivery`, () => withLive(async s => {
    const t = turns.reviewProfessionalTurn(s.runId, { prompt: "Refuse changed facts", idempotencyKey: mutate }).turn;
    if (mutate === "employee") store.db.run("UPDATE ai_employees SET status = 'archived', archived_at = ? WHERE id = ?", [Date.now(), s.employee.id]);
    if (mutate === "assignment") store.db.run("UPDATE employee_task_assignments SET revision = revision + 1 WHERE task_id = ?", [s.taskId]);
    if (mutate === "session") store.db.run("UPDATE runs SET claude_session_id = 'different-exact-id' WHERE id = ?", [s.runId]);
    if (mutate === "project") store.tasks.update(s.taskId, { workdir: isolated });
    if (mutate === "harness") store.harnesses.setEnabled("claude-code", false);
    try { await expect(submit(t)).rejects.toBeDefined(); expect(agents.__getFakeDriver(s.taskId)!._record.filter(x => x.startsWith("write:"))).toEqual([]); }
    finally { store.harnesses.setEnabled("claude-code", true); }
  }));
}

test("authenticated turn API refuses unauthorized body before reading and rejects override fields", () => withLive(async s => {
  const { employeeExecutionHttp } = await import("./employee-execution-http.ts");
  const request = new Request(`http://fixture/employee-execution/runs/${s.runId}/turn-reviews`, { method: "POST", body: "not-json" });
  expect((await employeeExecutionHttp(request, false)).status).toBe(401); expect(request.bodyUsed).toBe(false);
  const res = await employeeExecutionHttp(new Request(`http://fixture/employee-execution/runs/${s.runId}/turn-reviews`, { method: "POST", body: JSON.stringify({ prompt: "A", idempotencyKey: "api", mode: "auto" }) }), true);
  expect(res.status).toBe(400);
}));

test("CLI control commands and attachment expansion are refused as follow-up user content", () => withLive(s => {
  for (const prompt of ["/permissions", " /model unsafe", "Read @/etc/passwd", "bad\u0000text", "bad\ud800"]) expect(() => turns.reviewProfessionalTurn(s.runId, { prompt, idempotencyKey: "bad" })).toThrow();
}));

for (const kind of ["codex", "gemini", "cursor", "antigravity", "fx"] as const) {
  test(`${kind} professional new-process continuation refuses without creating a Run`, async () => {
    const s = await live(kind);
    try {
      expect(turns.professionalTurnHistory(s.runId).session.state).toBe("unsupported");
      expect(() => turns.reviewProfessionalTurn(s.runId, { prompt: "No hidden spawn", idempotencyKey: kind })).toThrow("unsupported");
      expect((await runtime.sendInput(s.runId, "No legacy bypass")).delivered).toBe(false);
      expect(store.runs.countForTask(s.taskId)).toBe(1);
    } finally { await runtime.cancelRun(s.runId); }
  });
}

test("missing attached session refuses new-process resume with an explicit reason", () => withLive(async s => {
  await runtime.cancelRun(s.runId);
  expect(turns.professionalTurnHistory(s.runId).session).toMatchObject({ state: "unsupported" });
  expect(() => turns.reviewProfessionalTurn(s.runId, { prompt: "No fallback", idempotencyKey: "stopped" })).toThrow("unsupported");
  expect(store.runs.countForTask(s.taskId)).toBe(1);
}));

for (const kind of ["claude-code", "codex", "gemini", "cursor", "antigravity", "fx"] as const) {
  test(`${kind} approved exact-session resume keeps one Run across two completed follow-ups`, async () => {
    const s = await scenario(true, kind, "Initial completed fixture work");
    const a = await reviewed(s, {}, kind); const started = await confirm(a); const runId = started.attempt.runId!;
    await finished(a.id);
    const initialSession = turns.professionalTurnHistory(runId).turns[0]!.session_id;
    expect(initialSession).toBeTruthy();
    for (let i = 1; i <= 2; i++) {
      const history = turns.professionalTurnHistory(runId);
      expect(history.session.state, history.session.reason ?? "").toBe("recoverable");
      const t = turns.reviewProfessionalTurn(runId, { prompt: `Approved ${kind} user content ${i}`, idempotencyKey: `resume-${i}` }).turn;
      const result = await submit(t);
      expect(result.turn.status, result.turn.reason ?? "").toBe("included");
      expect(result.turn.session_id).toBe(initialSession);
      expect(agents.__getFakeDriver(s.taskId)!._record[0]).toBe(`spawn:Approved ${kind} user content ${i}`);
      expect(store.runs.countForTask(s.taskId)).toBe(1);
      await finished(a.id);
    }
    expect(turns.professionalTurnHistory(runId).turns).toHaveLength(3);
    expect(turns.professionalTurnHistory(runId).turns.every(t => t.observed_run_status === "succeeded" && t.observed_run_ended_at !== null)).toBe(true);
    expect(run.getEmployeeRun(a.id).professional!.binding).toMatchObject({ revision: 1, promptMarkdown: guidance });
  });
}


test("authority revoked during asynchronous adapter preparation prevents the fake submission", async () => {
  const s = await scenario(true, "claude-code", "Initial completed work");
  const a = await reviewed(s, {}, "claude-code"); const started = await confirm(a); await finished(a.id);
  const runId = started.attempt.runId!, previous = agents.__getFakeDriver(s.taskId);
  const t = turns.reviewProfessionalTurn(runId, { prompt: "Do not submit after revocation", idempotencyKey: "async-revoke" }).turn;
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "100";
  try {
    const sending = submit(t);
    await Bun.sleep(10); store.db.run("UPDATE employee_task_assignments SET revision = revision + 1 WHERE task_id = ?", [s.taskId]);
    expect((await sending).turn.status).toBe("indeterminate");
    expect(agents.__getFakeDriver(s.taskId)).toBe(previous);
    expect(store.runs.countForTask(s.taskId)).toBe(1);
  } finally { delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS; }
});

test("adapter resume identity mismatch kills the returned handle and never falls back to a new Run", async () => {
  const s = await scenario(true, "codex", "Completed initial work");
  const a = await reviewed(s); const started = await confirm(a); await finished(a.id);
  const runId = started.attempt.runId!, t = turns.reviewProfessionalTurn(runId, { prompt: "Exact identity only", idempotencyKey: "mismatch" }).turn;
  let killed = false, resolve!: (code: number) => void;
  const mock = spyOn(agents, "spawnAgent").mockImplementation(async args => {
    args.onSessionId?.("unexpected-session");
    return { kill: () => { killed = true; resolve(1); }, writeInput: () => false, done: new Promise<number>(r => { resolve = r; }) };
  });
  try { expect((await submit(t)).turn.status).toBe("indeterminate"); expect(killed).toBe(true); expect(store.runs.countForTask(s.taskId)).toBe(1); }
  finally { mock.mockRestore(); }
});

test("raw task terminals and open-tmux cannot bypass professional Turn authorization", () => withLive(async s => {
  const { requiresProfessionalInputReview } = await import("./professional-input-policy.ts");
  const { createTerminal } = await import("./terminals.ts");
  expect(requiresProfessionalInputReview(store.db, s.taskId)).toBe(true);
  expect(await createTerminal(s.taskId)).toMatchObject({ error: expect.stringContaining("Owner Turn review") });
  expect(agents.__getFakeDriver(s.taskId)!._record.filter(x => x.startsWith("write:"))).toEqual([]);
}));


test("boot reattachment uses the current Turn log namespace and preserves Unknown without redelivery", async () => {
  const s = await scenario(true, "codex", "Initial complete work"); const a = await reviewed(s);
  const started = await confirm(a); await finished(a.id); const runId = started.attempt.runId!;
  const t = turns.reviewProfessionalTurn(runId, { prompt: "Prepared at crash boundary", idempotencyKey: "reattach" }).turn;
  const { ProfessionalTurnCore } = await import("./professional-turn-core.ts");
  const storage = new ProfessionalTurnCore(store.db);
  storage.claim(t.id, t.revision, t.idempotency_key, () => JSON.parse(t.facts_json));
  storage.transition(t.id, "claimed", "prepared");
  store.runs.update(runId, { status: "running", endedAt: null, exitCode: null }); store.tasks.update(s.taskId, { column: "running" });
  store.db.run("UPDATE employee_executions SET finished_at = NULL, result = NULL WHERE id = ?", [a.id]);
  profiles.updatePrompt(s.employee.id, { expectedRevision: 1, promptMarkdown: "Current role edited while backend was down" });
  store.runs.appendEvent(runId, "assistant", "Before crash", `${t.id}:native-before`);
  const driver = await import("./codex-tmux.ts"); let captured = "", finish!: (code: number) => void;
  const mocked = spyOn(driver, "reattachCodexSession").mockImplementation(async opts => {
    captured = opts.runId;
    expect(opts.seenLineUuids.has("native-before")).toBe(true);
    expect(opts.seenLineUuids.has(`${t.id}:native-before`)).toBe(false);
    opts.onChunk("assistant", "Fake reattached output", "same-native-id"); opts.onChunk("assistant", "Fake reattached output", "same-native-id");
    return { kill: () => finish(1), writeInput: () => { throw new Error("Reattachment must not send"); }, done: new Promise<number>(r => { finish = r; }) };
  });
  try {
    await runtime.reconcileOrphans(); expect(captured).toBe(t.id);
    run.recoverEmployeeExecutions(); expect(storage.get(t.id).status).toBe("indeterminate");
    expect(store.runs.events(runId).filter(e => e.data === "Fake reattached output")).toHaveLength(1);
    expect(store.runs.countForTask(s.taskId)).toBe(1);
    expect(run.getEmployeeRun(a.id).professional!.binding).toMatchObject({ revision: 1, promptMarkdown: guidance });
  } finally { await runtime.cancelRun(runId); mocked.mockRestore(); }
});


test("initial asynchronously discovered session binds once after adapter acceptance", async () => {
  const s = await scenario(true, "codex", "Initial async session fixture"); const a = await reviewed(s);
  const mocked = spyOn(agents, "spawnAgent").mockImplementation(async args => ({
    kill: () => {}, writeInput: () => false,
    done: new Promise<number>(resolve => { setTimeout(() => { args.onSessionId?.("exact-late-thread"); resolve(0); }, 30); }),
  }));
  try {
    const started = await confirm(a); const runId = started.attempt.runId!;
    expect(turns.professionalTurnHistory(runId).turns[0]!.session_id).toBeNull();
    await finished(a.id);
    expect(turns.professionalTurnHistory(runId).turns[0]!.session_id).toBe("exact-late-thread");
    expect(turns.professionalTurnHistory(runId).session.state).toBe("recoverable");
    expect(() => store.db.run("UPDATE employee_execution_turns SET session_id = 'replacement' WHERE run_id = ?", [runId])).toThrow("immutable");
  } finally { mocked.mockRestore(); }
});


test("asynchronous ACP-style submission remains authorized after its handle is registered", async () => {
  const s = await scenario(true, "fx", "Completed initial ACP fixture"); const a = await reviewed(s, {}, "fx");
  const started = await confirm(a); await finished(a.id); const runId = started.attempt.runId!;
  const t = turns.reviewProfessionalTurn(runId, { prompt: "Approved after handshake", idempotencyKey: "late-gate" }).turn;
  let lateAuthorization: boolean | undefined;
  const mocked = spyOn(agents, "spawnAgent").mockImplementation(async args => ({
    kill: () => {}, writeInput: () => false,
    done: new Promise<number>(resolve => { setTimeout(() => { lateAuthorization = args.authorize?.(); resolve(lateAuthorization ? 0 : 1); }, 30); }),
  }));
  try {
    expect((await submit(t)).turn.status).toBe("included"); await finished(a.id);
    expect(lateAuthorization).toBe(true); expect(store.runs.countForTask(s.taskId)).toBe(1);
  } finally { mocked.mockRestore(); }
});


test("repeated native tool call IDs remain paired within each professional Turn", async () => {
  const s = await scenario(true, "codex", "Initial tool namespace fixture"); const a = await reviewed(s);
  const started = await confirm(a); await finished(a.id); const runId = started.attempt.runId!;
  const ids: string[] = [];
  const mocked = spyOn(agents, "spawnAgent").mockImplementation(async args => {
    args.onChunk("tool_use", JSON.stringify({ id: "item_0", name: "Read", input: {} }), "native-use-0");
    args.onChunk("tool_result", JSON.stringify({ toolUseId: "item_0", content: "Fake tool result" }), "native-result-0");
    return { kill: () => {}, writeInput: () => false, done: new Promise<number>(resolve => setTimeout(() => resolve(0), 20)) };
  });
  try {
    for (let i = 1; i <= 2; i++) {
      const t = turns.reviewProfessionalTurn(runId, { prompt: `Approved tool round ${i}`, idempotencyKey: `tool-round-${i}` }).turn;
      ids.push(`${t.id}:item_0`); expect((await submit(t)).turn.status).toBe("included"); await finished(a.id);
    }
    const events = store.runs.events(runId);
    const uses = events.filter(e => e.stream === "tool_use").map(e => JSON.parse(e.data).id);
    const results = events.filter(e => e.stream === "tool_result").map(e => JSON.parse(e.data).toolUseId);
    expect(uses.slice(-2)).toEqual(ids); expect(results.slice(-2)).toEqual(ids);
    expect(store.runs.countForTask(s.taskId)).toBe(1);
  } finally { mocked.mockRestore(); }
});
