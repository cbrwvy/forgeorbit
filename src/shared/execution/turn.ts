export type TurnStatus = "reviewed" | "approved" | "claimed" | "prepared" | "included" | "failed" | "indeterminate";

/** The large immutable Markdown remains in employee_executions (090). */
export interface ProfessionalTurn {
  id: string;
  run_id: string;
  task_id: string;
  employee_id: string;
  attempt_id: string;
  snapshot_revision_id: string;
  snapshot_sha256: string;
  turn_number: number;
  parent_turn_id: string | null;
  session_id: string | null;
  authorization_ref: string | null;
  prompt: string | null;
  prompt_sha256: string;
  facts_json: string;
  status: TurnStatus;
  revision: number;
  idempotency_key: string;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  submitted_at: number | null;
  settled_at: number | null;
  reason: string | null;
  observed_run_status: string | null;
  observed_run_ended_at: number | null;
}

export interface TurnContext {
  runId: string;
  taskId: string;
  employeeId: string;
  employeeName: string;
  projectPath: string;
  attemptId: string;
  revisionId: string;
  professionalRevision: number;
  snapshotSha256: string;
  sessionId: string;
  authorityKey: string;
  restrictions: unknown;
  mode: string;
}

export interface TurnHistory {
  turns: ProfessionalTurn[];
  session: { state: "attached" | "recoverable" | "unsupported"; reason: string | null };
}
