import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * FO-008D: every project-scoped module uses the same ownership contract, and
 * a launch re-checks it on its own. Module calls only — no server, no real
 * CLI: harness probes and `startTask` are injected stubs, so nothing spawns.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo008d-scopes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let db: typeof import("./db.ts");
let own: typeof import("./project-ownership.ts");
let scheduling: typeof import("./task-scheduling.ts");
let exec: typeof import("./project-execution.ts");
let batches: typeof import("./execution-batches.ts");
let manager: typeof import("./project-manager.ts");

const okHarness = async (harness: { id: string; kind: string }) => ({
  harnessId: harness.id,
  kind: harness.kind,
  bin: "/bin/echo",
  available: true,
  path: "/bin/echo",
  version: "9.9.9",
  reason: null,
  installHint: null,
  account: null,
  usage: null,
  loggedIn: true,
  authHelp: null,
}) as never;

let startCalls: string[] = [];
const deps = () => ({
  checkHarness: okHarness,
  envNames: () => [],
  startTask: (async (taskId: string) => {
    startCalls.push(taskId);
    return { runId: `run-${taskId}` };
  }) as never,
});

beforeAll(async () => {
  db = await import("./db.ts");
  own = await import("./project-ownership.ts");
  scheduling = await import("./task-scheduling.ts");
  exec = await import("./project-execution.ts");
  batches = await import("./execution-batches.ts");
  manager = await import("./project-manager.ts");
  db.harnesses.setEnabled("codex", true);
});

beforeEach(() => {
  for (const project of db.projects.list()) db.projects.delete(project.path);
  exec.__testing.reset();
  startCalls = [];
});

function scratch(name: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `fo008d-${name}-`)));
}

function project(name: string, root = scratch(name)): string {
  mkdirSync(root, { recursive: true });
  db.projects.upsert(root, name);
  return root;
}

function addTask(workdir: string, title: string, fields: Record<string, unknown> = {}): string {
  const now = Date.now();
  const id = randomUUID();
  db.tasks.insert({
    id,
    title,
    prompt: `${title}\n\n## Acceptance criteria\n- done`,
    column: "backlog",
    agent: "codex",
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: "gpt-6.1-sol",
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  } as never);
  return id;
}

describe("the contract", () => {
  test("root, subfolder, nested project, similar names, escape and ambiguity", () => {
    const outer = project("Outer");
    const nested = path.join(outer, "apps", "api");
    mkdirSync(path.join(nested, "src"), { recursive: true });
    db.projects.upsert(nested, "Nested");
    mkdirSync(path.join(outer, "docs"), { recursive: true });
    const sibling = `${outer}2`;
    mkdirSync(sibling, { recursive: true });
    const outside = scratch("outside");
    symlinkSync(outside, path.join(outer, "escape"));
    const other = project("Other");
    mkdirSync(path.join(other, "lib"));
    symlinkSync(path.join(other, "lib"), path.join(outer, "vendored"));

    expect(own.ownershipOf(outer)).toEqual({ kind: "owned", projectPath: outer, via: "exact" });
    expect(own.ownershipOf(path.join(outer, "docs"))).toEqual({ kind: "owned", projectPath: outer, via: "subfolder" });
    expect(own.ownershipOf(path.join(nested, "src"))).toEqual({ kind: "owned", projectPath: nested, via: "subfolder" });
    expect(own.ownershipOf(sibling).kind).toBe("unattributed");
    expect(own.ownershipOf(path.join(outer, "escape"))).toEqual({ kind: "unattributed", reason: "symlink-escape" });
    expect(own.ownershipOf(path.join(outer, "vendored")).kind).toBe("ambiguous");
    expect(own.ownershipFields(path.join(outer, "escape")).projectOwnership).toBe("symlink-escape");
  });

  test("a confirmed worktree belongs to its main checkout; an unconfirmed one to nobody", () => {
    const main = project("Main");
    const wt = scratch("wt");
    mkdirSync(path.join(main, ".git", "worktrees", "w1"), { recursive: true });
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "w1")}\n`);
    writeFileSync(path.join(main, ".git", "worktrees", "w1", "gitdir"), `${path.join(wt, ".git")}\n`);
    expect(own.ownershipOf(wt, { fresh: true })).toEqual({ kind: "owned", projectPath: main, via: "worktree" });

    const fakeWt = scratch("fakewt");
    writeFileSync(path.join(fakeWt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "nope")}\n`);
    expect(own.ownershipOf(fakeWt, { fresh: true }).kind).toBe("unattributed");
  });

  test("the cache follows registry changes", () => {
    const dir = scratch("late");
    mkdirSync(path.join(dir, "sub"));
    expect(own.ownerProjectOf(path.join(dir, "sub"))).toBeNull();
    db.projects.upsert(dir, "Late");
    expect(own.ownerProjectOf(path.join(dir, "sub"))).toBe(dir);
    db.projects.delete(dir);
    expect(own.ownerProjectOf(path.join(dir, "sub"))).toBeNull();
  });

  test("verifyLaunchScope checks ownership, the real folder and the worktree", () => {
    const a = project("A");
    const b = project("B");
    mkdirSync(path.join(a, "pkg"));
    const sub = { id: "t1", workdir: path.join(a, "pkg"), worktreePath: null, pipelineParentId: null };
    expect(own.verifyLaunchScope(sub, a)).toEqual({ ok: true });
    expect(own.verifyLaunchScope(sub, b)).toMatchObject({ ok: false, code: "task-outside-project" });
    expect(own.verifyLaunchScope({ ...sub, workdir: path.join(a, "gone") }, a)).toMatchObject({ ok: false, code: "workdir-missing" });
    const ownWorktree = path.join(db.dataDir, "worktrees", "t1");
    expect(own.verifyLaunchScope({ ...sub, worktreePath: ownWorktree }, a)).toEqual({ ok: true });
    expect(own.verifyLaunchScope({ ...sub, worktreePath: path.join(db.dataDir, "worktrees", "someone-else") }, a)).toMatchObject({ ok: false, code: "foreign-worktree" });
    expect(own.verifyLaunchScope({ ...sub, worktreePath: path.join(db.dataDir, "worktrees", "t1", "..", "t2") }, a)).toMatchObject({ ok: false, code: "foreign-worktree" });
    expect(own.verifyLaunchScope({ ...sub, worktreePath: b }, a)).toMatchObject({ ok: false, code: "foreign-worktree" });
    expect(own.verifyLaunchScope({ ...sub, pipelineParentId: "p" }, a)).toMatchObject({ ok: false, code: "pipeline-step" });
  });
});

describe("modules share it", () => {
  test("the project manager context lists subfolder tasks and never foreign ones", async () => {
    const a = project("Alpha");
    mkdirSync(path.join(a, "web"));
    const outside = scratch("out");
    symlinkSync(outside, path.join(a, "link"));
    addTask(a, "Root task");
    addTask(path.join(a, "web"), "Web subfolder task");
    addTask(`${a}-copy`, "Similar name task");
    addTask(path.join(a, "link"), "Escaped task");
    const gathered = await manager.gatherManagerContext(a, { ...(await import("../shared/project-manager.ts")).DEFAULT_MANAGER_CONFIG });
    const titles = gathered.context.backlog.map((item) => item.title).sort();
    expect(titles).toEqual(["Root task", "Web subfolder task"]);
  });

  test("scheduling: subfolder tasks link within the project; other projects stay out", () => {
    const a = project("Sched A");
    const b = project("Sched B");
    mkdirSync(path.join(a, "svc"));
    const root = addTask(a, "Root");
    const sub = addTask(path.join(a, "svc"), "Sub");
    const foreign = addTask(b, "Foreign");
    const listed = scheduling.listScheduling(a);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.tasks.map((item) => item.taskId).sort()).toEqual([root, sub].sort());
    const linked = scheduling.updateScheduling(a, root, { dependsOn: [sub] });
    expect(linked.ok).toBe(true);
    const cross = scheduling.updateScheduling(a, root, { dependsOn: [foreign] });
    expect(cross.ok).toBe(false);
    expect(scheduling.updateScheduling(a, foreign, { priority: "high" })).toMatchObject({ ok: false, status: 404 });
  });

  test("supervised execution: a subfolder task can be prepared; another project's task can't", async () => {
    const a = project("Exec A");
    const b = project("Exec B");
    mkdirSync(path.join(a, "pkg"));
    const sub = addTask(path.join(a, "pkg"), "Sub task");
    const foreign = addTask(b, "B task");
    const prepared = await exec.prepareExecution(a, { taskId: sub }, deps());
    if (!prepared.ok) throw new Error(prepared.error);
    const codes = prepared.value.execution.checks.filter((item) => item.level === "error").map((item) => item.code);
    expect(codes).not.toContain("task-other-project");
    expect(await exec.prepareExecution(a, { taskId: foreign }, deps())).toMatchObject({ ok: false, status: 404 });
  });

  test("a foreign worktree blocks the preflight and the start", async () => {
    const a = project("Wt A");
    const id = addTask(a, "Wrong worktree");
    db.tasks.update(id, { worktreePath: path.join(db.dataDir, "worktrees", "another-task") } as never);
    const prepared = await exec.prepareExecution(a, { taskId: id }, deps());
    if (!prepared.ok) throw new Error(prepared.error);
    const view = prepared.value.execution;
    expect(view.checks.some((item) => item.code === "foreign-worktree" && item.level === "error")).toBe(true);
    const approved = await exec.approveExecution(a, view.id, { revision: view.revision, acknowledgeUsage: true }, deps());
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.error).toContain("not its own worktree");
    expect(startCalls).toEqual([]);
  });

  test("a symlink-escaped task can't be prepared through the project its path is in", async () => {
    const a = project("Esc A");
    const outside = scratch("esc-out");
    symlinkSync(outside, path.join(a, "out"));
    const id = addTask(path.join(a, "out"), "Escaped");
    expect(await exec.prepareExecution(a, { taskId: id }, deps())).toMatchObject({ ok: false, status: 404 });
  });

  test("batches: subfolder tasks join; foreign tasks don't; a launch re-checks scope", async () => {
    const a = project("Batch A");
    const b = project("Batch B");
    mkdirSync(path.join(a, "mod"));
    const sub = addTask(path.join(a, "mod"), "Batch sub");
    const foreign = addTask(b, "Batch foreign");
    const created = await batches.createBatch(a, { taskIds: [sub] }, deps());
    expect(created.ok).toBe(true);
    expect(await batches.createBatch(a, { taskIds: [foreign] }, deps())).toMatchObject({ ok: false, status: 404 });

    // A launch for the wrong project, or into a foreign worktree, is held and never starts.
    const task = db.tasks.get(foreign)!;
    const req = {
      projectPath: a,
      taskId: foreign,
      batchId: "batch-x",
      batchTitle: "X",
      executionId: randomUUID(),
      config: exec.configFromTask(task),
      expectFingerprint: "f",
      fingerprintOf: () => "f",
      verify: () => null,
    };
    expect(await exec.launchBatchTask(req, deps())).toMatchObject({ kind: "held", code: "task-missing" });
    db.tasks.update(sub, { worktreePath: path.join(db.dataDir, "worktrees", "elsewhere") } as never);
    const subTask = db.tasks.get(sub)!;
    const held = await exec.launchBatchTask({ ...req, taskId: sub, config: exec.configFromTask(subTask), executionId: randomUUID() }, deps());
    expect(held).toMatchObject({ kind: "held", code: "scope:foreign-worktree" });
    expect(startCalls).toEqual([]);
  });
});
