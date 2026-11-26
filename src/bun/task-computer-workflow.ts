import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { db, runs, tasks } from "./db.ts";
import { defaultBrowserSessionManager } from "./browser-session.ts";
import { defaultNativeComputerSessionManager } from "./native-computer-session.ts";
import { verifyLaunchScope, ownershipOf } from "./project-ownership.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { isWorkspaceDevelopmentEnabled } from "./project-permissions.ts";
import { stagingCwdForTask } from "./task-workspace.ts";
import { autonomyPolicyStore } from "./autonomy/policy-store.ts";
import { resolveInterviewIsolation } from "./interview-isolation.ts";
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";
import type { Harness, Task } from "../shared/types.ts";
import {
  parseComputerPlan, parseTaskComputerScope, workflowPage,
  type TaskComputerOutcome, type TaskComputerReview, type TaskComputerRun, type TaskComputerScope, type TaskComputerStep,
} from "../shared/task-computer-workflow.ts";

interface ScopeRow { revision: string; project_path: string; scope_json: string; used: number }
interface RunRow { run_id: string; outcome: TaskComputerOutcome; steps_json: string; screenshot: Uint8Array | null }
export interface ReviewedComputerWorkflow {
  scope: TaskComputerReview;
  documentDigest?: string;
  lockdownArgs: string[];
}
export interface BoundComputerWorkflow {
  projectPath: string;
  scope: TaskComputerScope;
  review: ReviewedComputerWorkflow;
}

function loadScope(taskId: string) {
  const row = db.query<ScopeRow, [string]>("SELECT revision, project_path, scope_json, used FROM task_computer_workflows WHERE task_id = ?").get(taskId);
  return row && { revision: row.revision, projectPath: row.project_path, scope: JSON.parse(row.scope_json) as TaskComputerScope, used: row.used === 1 };
}

function digestDocument(root: string, relative: string) {
  const workspace = realpathSync(root);
  const filename = join(workspace, relative);
  if (!filename.startsWith(workspace + sep) || realpathSync(filename) !== filename) throw new Error("The document must be inside the approved workspace without symlinks.");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error("Choose a small, regular UTF-8 .txt file.");
    const bytes = Buffer.alloc(stat.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error("The document changed during verification.");
    const body = bytes.subarray(0, count);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error("Choose a plain-text UTF-8 document.");
    return createHash("sha256").update(body).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function reviewScope(task: Task, row: NonNullable<ReturnType<typeof loadScope>>): TaskComputerReview {
  const { scope, revision } = row;
  return scope.kind === "browser"
    ? { kind: "browser", revision, origin: new URL(scope.url).origin, page: workflowPage(scope.url),
        expected: scope.expected, submitLabel: scope.submitLabel, fields: scope.fields.map(field => field.label) }
    : { kind: "textedit", revision, application: "TextEdit", workspace: task.workdir, document: scope.document, writable: scope.edit !== null };
}

function checkWriteWorkspace(task: Task, projectPath: string, scope: TaskComputerScope) {
  if (scope.kind !== "textedit" || !scope.edit) return;
  const staging = stagingCwdForTask(task.id);
  if (task.isolation !== "none" || isWorkspaceDevelopmentEnabled(projectPath) || staging.cwd || staging.block) {
    throw new Error("A TextEdit save needs a task in its project folder without Git worktree or task working-copy isolation.");
  }
}

export function taskComputerView(task: Task) {
  const row = loadScope(task.id);
  const result = db.query<RunRow, [string]>(
    "SELECT run_id, outcome, steps_json, screenshot IS NOT NULL AS screenshot FROM task_computer_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
  ).get(task.id);
  return {
    review: row ? reviewScope(task, row) : null,
    used: row?.used ?? false,
    run: result ? {
      runId: result.run_id, outcome: result.outcome, steps: JSON.parse(result.steps_json) as TaskComputerStep[], screenshot: Boolean(result.screenshot),
    } satisfies TaskComputerRun : null,
  };
}

export function taskComputerScreenshot(taskId: string, runId: string): Uint8Array | null {
  return db.query<Pick<RunRow, "screenshot">, [string, string]>(
    "SELECT screenshot FROM task_computer_runs WHERE task_id = ? AND run_id = ?",
  ).get(taskId, runId)?.screenshot ?? null;
}

export async function saveTaskComputerScope(taskId: string, body: unknown) {
  const task = tasks.get(taskId);
  if (!task || task.archivedAt != null || task.pipelineId || task.pipelineParentId || task.objectiveMissionId ||
    task.column === "running" || task.column === "done" || task.accessMode === "full-computer") {
    throw new Error("This workflow needs an open, ordinary task outside any active run.");
  }
  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned" || !verifyLaunchScope(task, owner.projectPath).ok) throw new Error("Choose a task inside a registered project.");
  if (body === null) {
    db.run("DELETE FROM task_computer_workflows WHERE task_id = ?", [taskId]);
    return taskComputerView(task);
  }
  const scope = parseTaskComputerScope(body);
  checkWriteWorkspace(task, owner.projectPath, scope);
  if (scope.kind === "browser") {
    const decision = await (await defaultBrowserSessionManager()).checkTaskDestination(scope.url);
    if (!decision.ok) throw new Error(decision.error);
  } else {
    digestDocument(task.workdir, scope.document);
  }
  const fresh = tasks.get(taskId);
  if (!fresh || fresh.archivedAt != null || ["running", "done"].includes(fresh.column) || fresh.workdir !== task.workdir ||
    fresh.pipelineId || fresh.pipelineParentId || fresh.objectiveMissionId || fresh.accessMode === "full-computer" ||
    fresh.computerWorkflowRevision !== task.computerWorkflowRevision) throw new Error("The task or scope changed. Review it again.");
  db.run(`INSERT INTO task_computer_workflows(task_id, revision, project_path, scope_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision, project_path=excluded.project_path, scope_json=excluded.scope_json, used=0`,
    [taskId, randomUUID(), owner.projectPath, JSON.stringify(scope)]);
  return taskComputerView(fresh);
}

export async function prepareComputerWorkflowReview(task: Task, harness: Harness, mode: string): Promise<ReviewedComputerWorkflow | undefined> {
  if (!task.computerWorkflowRevision) return;
  const row = loadScope(task.id);
  if (!row || row.revision !== task.computerWorkflowRevision || !verifyLaunchScope(task, row.projectPath).ok) {
    throw new Error("The task's computer workflow changed. Review it again.");
  }
  if (harness.kind !== "codex" || mode !== "ask" || task.accessMode === "full-computer") {
    throw new Error("For this workflow, choose Codex with Ask mode in the task's execution settings.");
  }
  if (row.used) {
    throw new Error("This workflow was already used. Save its scope again to authorize a new attempt.");
  }
  checkWriteWorkspace(task, row.projectPath, row.scope);
  const isolation = await resolveInterviewIsolation(harness, { noCache: true });
  if (!isolation.ok) throw new Error(isolation.error);
  return {
    scope: reviewScope(task, row),
    documentDigest: row.scope.kind === "textedit" ? digestDocument(task.workdir, row.scope.document) : undefined,
    lockdownArgs: isolation.isolation.args,
  };
}

export function bindComputerWorkflow(task: Task, reviewed: ReviewedComputerWorkflow | undefined): BoundComputerWorkflow {
  const row = loadScope(task.id);
  if (!reviewed || !row || row.used || reviewed.scope.revision !== row.revision || task.computerWorkflowRevision !== row.revision ||
    JSON.stringify(reviewed.scope) !== JSON.stringify(reviewScope(task, row)) ||
    !verifyLaunchScope(task, row.projectPath).ok ||
    (row.scope.kind === "textedit" && reviewed.documentDigest !== digestDocument(task.workdir, row.scope.document))) {
    throw new Error("The computer workflow or selected document changed. Review it again.");
  }
  checkWriteWorkspace(task, row.projectPath, row.scope);
  return { projectPath: row.projectPath, scope: row.scope, review: reviewed };
}

export function reserveComputerWorkflow(taskId: string, runId: string, binding: BoundComputerWorkflow) {
  const revision = binding.review.scope.revision;
  const changed = db.run("UPDATE task_computer_workflows SET used = 1 WHERE task_id = ? AND revision = ? AND used = 0", [taskId, revision]).changes;
  if (!changed) throw new Error("This workflow was already used. Save a fresh scope before running it again.");
  db.run("INSERT INTO task_computer_runs(run_id, task_id, revision, outcome) VALUES (?, ?, ?, 'planning')", [runId, taskId, revision]);
}

export function abortComputerWorkflow(runId: string, outcome: "stopped" | "runtime" = "stopped") {
  db.run("UPDATE task_computer_runs SET outcome = ? WHERE run_id = ? AND outcome IN ('planning','running')", [outcome, runId]);
}

export function reconcileComputerWorkflows() {
  db.run(`UPDATE task_computer_runs SET outcome = 'interrupted'
    WHERE outcome IN ('planning','running') AND run_id IN (SELECT id FROM runs WHERE status <> 'running')`);
}

export function captureComputerPlan(emit: ChunkHandler) {
  let text = "";
  return {
    onChunk: ((stream, data, lineUuid) => {
      if (stream === "assistant") text = (text + data).slice(0, 11_000);
      if (stream === "status" && data.startsWith('{"accountProfile":')) emit(stream, data, lineUuid);
    }) satisfies ChunkHandler,
    text: () => text,
  };
}

export function finishComputerWorkflow(
  task: Task,
  runId: string,
  binding: BoundComputerWorkflow,
  provider: SpawnedAgent,
  planText: () => string,
): SpawnedAgent {
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    abortComputerWorkflow(runId);
  };
  const admit = () => {
    const current = tasks.get(task.id);
    if (abort.signal.aborted || !current || current.archivedAt != null || current.runId !== runId ||
      current.computerWorkflowRevision !== binding.review.scope.revision || runs.get(runId)?.status !== "running" ||
      current.workdir !== task.workdir || current.isolation !== task.isolation ||
      !checkProjectLaunchAdmission(binding.projectPath).allowed || autonomyPolicyStore.readEmergency().active) {
      abort.abort();
      throw new Error("The task is stopped or no longer authorized.");
    }
    if (binding.scope.kind === "textedit" && binding.scope.edit && isWorkspaceDevelopmentEnabled(binding.projectPath)) {
      abort.abort();
      throw new Error("The project now requires working-copy isolation.");
    }
  };
  const done = provider.done.then(async code => {
    let outcome: TaskComputerOutcome = "runtime";
    let screenshot: Uint8Array | undefined;
    const steps: TaskComputerStep[] = [];
    const record = (step: TaskComputerStep) => {
      steps.push(step);
      db.run("UPDATE task_computer_runs SET steps_json = ? WHERE run_id = ?", [JSON.stringify(steps), runId]);
    };
    try {
      admit();
      if (code !== 0) return code;
      let plan: ReturnType<typeof parseComputerPlan>;
      try { plan = parseComputerPlan(planText(), binding.scope); }
      catch { outcome = "invalid-plan"; return 1; }
      db.run("UPDATE task_computer_runs SET outcome = 'running' WHERE run_id = ?", [runId]);
      if (binding.scope.kind === "browser" && Array.isArray(plan)) {
        ({ outcome, screenshot } = await (await defaultBrowserSessionManager()).runTaskWorkflow(binding.scope, plan, abort.signal, admit, record));
      } else if (binding.scope.kind === "textedit" && typeof plan === "string") {
        outcome = await (await defaultNativeComputerSessionManager()).runTaskDocument(
          binding.scope, task.workdir, binding.review.documentDigest!, plan, abort.signal, admit, record,
        );
      }
      admit();
      return outcome === "verified" ? 0 : 1;
    } catch {
      if (abort.signal.aborted) outcome = "stopped";
      return 1;
    } finally {
      db.run("UPDATE task_computer_runs SET outcome = ?, screenshot = ? WHERE run_id = ?",
        [abort.signal.aborted ? "stopped" : outcome, abort.signal.aborted ? null : screenshot ?? null, runId]);
    }
  }, () => {
    abortComputerWorkflow(runId, abort.signal.aborted ? "stopped" : "runtime");
    return 1;
  });
  return {
    done, writeInput: () => false,
    kill: () => { stop(); provider.kill(); },
    ...(provider.terminate ? { terminate: () => { stop(); return provider.terminate!(); } } : {}),
  };
}
