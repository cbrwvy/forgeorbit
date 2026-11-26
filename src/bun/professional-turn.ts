/** Owner authorization over the existing runtime's attached-session operation. */
import { db, tasks, runs, harnesses } from "./db.ts";
import { EmployeeRunCore } from "./employee-run-core.ts";
import { readProfessionalBinding, promptSha256 } from "./professional-runtime.ts";
import { prepareEmployeeExecution } from "./employee-execution.ts";
import { projectRoutingInput } from "./model-router.ts";
import { ProfessionalTurnCore, TurnError, professionalExecutionKey } from "./professional-turn-core.ts";
import { professionalSession, deliverProfessionalTurn } from "./orchestrator.ts";
import type { TurnContext, TurnHistory } from "../shared/execution/turn.ts";

const core = () => new ProfessionalTurnCore(db);

function context(runId: string, duringSubmission = false): TurnContext {
  const run = runs.get(runId), row = new EmployeeRunCore(db).byRun(runId);
  const task = run && tasks.get(run.taskId);
  if (!run || !row || !task || row.task_id !== task.id || task.runId !== runId || task.archivedAt != null || task.pipelineId) throw new TurnError("Exact employee Run identity is unavailable. A new execution requires Owner review.");
  const binding = readProfessionalBinding(row);
  if (row.status !== "started" || row.approved_at === null || binding?.kind !== "professional" || row.professional_payload_status !== "included" || row.approval_provenance !== "owner") throw new TurnError("Original professional snapshot or adapter acceptance is unavailable.");
  const session = professionalSession(runId, duringSubmission);
  if (!session) throw new TurnError("Professional resume is unsupported: the exact session is busy, missing, mismatched or has an uncertain outcome. A new canonical start requires Owner review.");
  const preflight = prepareEmployeeExecution({ taskId: task.id, harnessId: row.requested_harness_id,
    model: row.requested_model, effort: row.requested_effort, complexity: row.requested_complexity, policy: row.requested_policy,
    expectedAssignmentRevision: row.assignment_revision });
  const errors = preflight.blockingErrors.filter(e => !["task-running", "task-column"].includes(e.code));
  if (errors.length) throw new TurnError(errors[0]!.message);
  const initial = core().initial(runId);
  if (!initial || initial.session_id !== session.sessionId || JSON.parse(initial.facts_json).executionKey !== professionalExecutionKey(task)) throw new TurnError("Original execution configuration changed. A new canonical start requires Owner review.");
  if (preflight.employee?.id !== row.employee_id || preflight.assignment?.id !== row.assignment_id
    || preflight.assignment.revision !== row.assignment_revision || preflight.canonicalProject?.path !== row.project_path
    || task.agent !== row.requested_harness_id) throw new TurnError("Assignment, employee, project or execution permissions changed.");
  // Profile edits deliberately do NOT enter this key. The immutable 090 snapshot is authoritative.
  const { owner } = projectRoutingInput(row.project_path, task.id);
  const harness = harnesses.getByIdOrKind(task.agent);
  if (JSON.parse(initial.facts_json).harnessKey !== promptSha256(JSON.stringify(harness))) throw new TurnError("Original harness configuration changed; new execution approval required.");
  return { runId, taskId: task.id, employeeId: row.employee_id, employeeName: preflight.employee!.name,
    projectPath: row.project_path, attemptId: row.id, revisionId: binding.revisionId,
    professionalRevision: binding.revision, snapshotSha256: promptSha256(row.professional_json!),
    sessionId: session.sessionId, mode: row.requested_mode, restrictions: owner,
    authorityKey: promptSha256(JSON.stringify([professionalExecutionKey(task), preflight.assignment, preflight.selection?.account, owner, harness, session.cwd])) };
}

export function professionalTurnHistory(runId: string): TurnHistory {
  // Reading history never claims, repairs or sends anything.
  let reason: string | null = null;
  try { context(runId); } catch (error) { reason = error instanceof Error ? error.message : "Session unsupported."; }
  return { turns: core().list(runId), session: { state: reason ? "unsupported" : professionalSession(runId)!.state, reason } };
}

function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !fields.includes(k))) throw new TurnError("Unsupported request fields.", 400);
  return raw as Record<string, unknown>;
}
export function reviewProfessionalTurn(runId: string, raw: unknown) {
  const body = object(raw, ["prompt", "idempotencyKey"]);
  return core().review(() => context(runId), body.prompt as string, body.idempotencyKey as string);
}

export function cancelProfessionalTurn(id: string, raw: unknown) {
  const body = object(raw, ["revision"]), storage = core(), turn = storage.get(id);
  if (turn.turn_number === 1 || turn.status !== "reviewed" || body.revision !== turn.revision) throw new TurnError("Only the exact unapproved review can be withdrawn.");
  storage.db.transaction(() => {
    const n = storage.db.run(`UPDATE employee_execution_turns SET status = 'failed', revision = revision + 1,
      settled_at = ?, reason = 'Owner withdrew review; no prompt submitted.' WHERE id = ? AND status = 'reviewed' AND revision = ?`,
    [Date.now(), id, turn.revision]).changes;
    if (n !== 1) throw new TurnError("Stale review revision.");
  }).immediate();
  return { turn: storage.get(id) };
}

export async function submitProfessionalTurn(id: string, raw: unknown) {
  const body = object(raw, ["revision", "idempotencyKey", "confirm", "acknowledgeUsage"]);
  if (body.confirm !== true || body.acknowledgeUsage !== true || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1
    || typeof body.idempotencyKey !== "string") throw new TurnError("Explicit Owner confirmation, usage acknowledgement, revision and idempotency key required.", 400);
  const storage = core(), initial = storage.get(id);
  if (initial.turn_number === 1) throw new TurnError("Initial turns use canonical employee execution approval.");
  const claimed = storage.claim(id, body.revision as number, body.idempotencyKey, () => context(initial.run_id));
  if (claimed.replayed) return claimed;
  try {
    // Preparation commits before any possible adapter send. A crash from here is Unknown.
    if (JSON.stringify(context(initial.run_id)) !== initial.facts_json) throw new TurnError("Review facts changed before submission.");
    storage.transition(id, "claimed", "prepared");
  } catch (error) {
    storage.transition(id, "claimed", "failed", error instanceof Error ? error.message : "Refused before submission.");
    return { turn: storage.get(id), replayed: false };
  }
  try {
    const included = await deliverProfessionalTurn(initial.run_id, initial.id, initial.session_id!, initial.prompt!, () => {
      return JSON.stringify(context(initial.run_id, true)) === initial.facts_json
        && ["prepared", "included"].includes(storage.get(id).status) && storage.get(id).expires_at > Date.now();
    });
    storage.transition(id, "prepared", included ? "included" : "indeterminate", included ? null : "Adapter did not confirm submission. Delivery Unknown; do not resend automatically.");
  } catch {
    // Never persist transport exception text: it may contain user content.
    storage.transition(id, "prepared", "indeterminate", "Transport interrupted. Delivery Unknown; do not resend automatically.");
  }
  return { turn: storage.get(id), replayed: false };
}
