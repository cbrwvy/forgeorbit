/**
 * Builds the operation the Owner is asked to review from database rows.
 * Request JSON is not a source for these fields.
 */
import type { Database } from "bun:sqlite";
import {
  canonicalize,
  expectedScope,
  parseOwnerOperation,
  sha256Hex,
  type OwnerOperation,
} from "../../shared/owner-trust/protocol.ts";

export interface AuthoritativePreview {
  operation: OwnerOperation;
  canonical: string;
  digest: string;
  display: {
    taskTitle: string;
    missionTitle: string;
    employeeRole: string;
    employeeJobTitle: string;
    externalProcessWillStart: false;
  };
}

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  workdir: string;
  agent: string;
  model: string | null;
  mode: string | null;
  column: string;
  worktree_path: string | null;
  access_mode?: string | null;
}

function resolveProviderId(database: Database, agent: string): "codex" | "claude-code" | null {
  const row = one<{ kind: string }>(database, "SELECT kind FROM harnesses WHERE id = ?", [agent]);
  const kind = row?.kind
    ?? (agent === "codex" || agent.startsWith("codex-profile-")
      ? "codex"
      : agent === "claude-code" || agent.startsWith("claude-profile-")
        ? "claude-code"
        : null);
  return kind === "codex" || kind === "claude-code" ? kind : null;
}

export function readAuthoritativeOperation(database: Database, now = Date.now()): AuthoritativePreview | null {
  let tasks: TaskRow[] = [];
  try {
    const columns = database.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    const hasAccessMode = columns.some((col) => col.name === "access_mode");
    tasks = database.query<TaskRow, []>(
      `SELECT id, title, prompt, workdir, agent, model, mode, "column" AS column, worktree_path${hasAccessMode ? ", access_mode" : ""}
       FROM tasks WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 12`,
    ).all();
  } catch {
    return null;
  }
  for (const task of tasks) {
    if (task.access_mode === "full-computer") continue;
    const providerId = resolveProviderId(database, task.agent);
    if (!providerId || !task.model || /deepseek|cursor/i.test(task.model)) continue;
    const reservation = one<{ account_id: string | null; id: string }>(
      database,
      "SELECT id, account_id FROM orchestration_reservations WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1",
      [task.id],
    );
    const binding = reservation?.account_id?.trim()
      ? null
      : one<{ account_id: string }>(
        database,
        "SELECT account_id FROM account_harness_bindings WHERE harness_id = ? LIMIT 1",
        [task.agent],
      );
    const assignment = one<{ employee_id: string }>(
      database,
      "SELECT employee_id FROM employee_task_assignments WHERE task_id = ? AND status = 'active' LIMIT 1",
      [task.id],
    );
    const employee = assignment
      ? one<{ job_title: string }>(database, "SELECT job_title FROM ai_employees WHERE id = ?", [assignment.employee_id])
      : null;
    const reviewer = /review/i.test(employee?.job_title ?? "");
    const mission = missionForTask(database, task.id);
    const accountId = reservation?.account_id?.trim() || binding?.account_id?.trim() || "unbound";
    const workspace = task.worktree_path?.trim() || task.workdir;
    const role = reviewer ? "reviewer" : "developer";
    const filesystem = reviewer ? "read-only" : "workspace-write";
    const missionRevision = mission?.plan_digest || "none";
    const raw = {
      schema: "forgeorbit-owner-trust-v1",
      requestId: `review:${task.id}`,
      kind: "single-operation",
      projectPath: task.workdir,
      taskId: task.id,
      missionId: mission?.id || "none",
      missionRevision,
      role,
      providerId,
      harnessId: task.agent,
      modelId: task.model,
      accountId,
      mode: task.mode?.trim() || "auto",
      workspace,
      filesystem,
      terminalAllowed: false,
      browserAllowed: false,
      computerUseAllowed: false,
      gitRead: true,
      gitPublish: false,
      deploymentAllowed: false,
      envelopeId: "operation",
      envelopeDigest: sha256Hex(canonicalize({ accountId, filesystem, modelId: task.model, role, workspace })),
      policyRevision: "none",
      scope: expectedScope({
        kind: "single-operation",
        role,
        providerId,
        accountId,
        modelId: task.model,
        missionId: mission?.id || "none",
        policyRevision: "none",
      }),
      runId: "none",
      attemptId: reservation?.id || "none",
      knownCost: "unknown",
      costCoverage: "unknown-subscription",
      expiresAt: now + 10 * 60_000,
      cancellationAvailable: true,
      externalProcess: false,
      taskStateDigest: sha256Hex(canonicalize({ column: task.column, id: task.id, prompt: task.prompt, workdir: task.workdir })),
      missionStateDigest: mission
        ? sha256Hex(canonicalize({ id: mission.id, planDigest: mission.plan_digest }))
        : sha256Hex("none"),
    };
    const parsed = parseOwnerOperation(raw, now);
    if (!parsed.ok) continue;
    return {
      operation: parsed.operation,
      canonical: parsed.canonical,
      digest: parsed.digest,
      display: {
        taskTitle: task.title,
        missionTitle: mission?.title || "",
        employeeRole: role,
        employeeJobTitle: employee?.job_title || role,
        externalProcessWillStart: false,
      },
    };
  }
  return null;
}

function one<T>(database: Database, sql: string, params: string[]): T | null {
  try {
    return database.query<T, string[]>(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function missionForTask(database: Database, taskId: string): { id: string; title: string; plan_digest: string } | null {
  try {
    const rows = database.query<{ id: string; title: string; plan_digest: string; plan_json: string }, []>(
      `SELECT id, title, plan_digest, plan_json FROM orchestration_missions
       WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY updated_at DESC LIMIT 8`,
    ).all();
    return rows.find((row) => row.plan_json.includes(taskId)) ?? null;
  } catch {
    return null;
  }
}
