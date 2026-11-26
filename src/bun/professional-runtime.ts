/** FO-014D: snapshot/resolution only. No launcher, CLI probes, credentials or account access. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Task } from "../shared/types.ts";
import type { ProfessionalBinding } from "../shared/execution/professional.ts";
import { MAX_PROMPT_BYTES } from "../shared/employees/profile-types.ts";
import { EmployeeProfileCore } from "./catalog/employee-profile-core.ts";
import type { EmployeeRunRow } from "./employee-run-core.ts";
import { ownershipOf, verifyLaunchScope } from "./project-ownership.ts";

export const promptSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const sha = /^[a-f0-9]{64}$/;

function validatePrompt(prompt: string, hash: string): void {
  if (typeof prompt !== "string" || !prompt.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)
    || !prompt.isWellFormed()) throw new Error("Professional Markdown is malformed (empty, control characters or invalid Unicode).");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error(`Professional prompt exceeds ${MAX_PROMPT_BYTES} bytes.`);
  if (!sha.test(hash) || promptSha256(prompt) !== hash) throw new Error("Professional prompt SHA-256 validation failed.");
}

export function resolveProfessionalBinding(db: Database, employeeId: string, now = Date.now()): ProfessionalBinding {
  const profile = new EmployeeProfileCore(db).getProfile(employeeId);
  if (!profile) return { kind: "legacy" };
  const rev = profile.activePrompt;
  validatePrompt(rev.promptMarkdown, rev.promptSha256);
  if (rev.employeeId !== employeeId || rev.revision !== profile.currentRevision
    || rev.catalogRoleSlug !== profile.catalogRoleSlug || rev.professionalTitle !== profile.professionalTitle
    || rev.division !== profile.division) throw new Error("Professional profile and active revision disagree.");
  if (!profile.template || !sha.test(profile.template.sha256)) throw new Error("Original professional template is unavailable or invalid.");
  return {
    kind: "professional", employeeId, revisionId: rev.id, revision: rev.revision,
    catalogRoleSlug: rev.catalogRoleSlug, professionalTitle: rev.professionalTitle,
    promptMarkdown: rev.promptMarkdown, promptSha256: rev.promptSha256,
    originalTemplateSha256: profile.template.sha256, sourceCommit: profile.template.sourceCommit, boundAt: now,
  };
}

/** Always check the frozen bytes, even if current revision pointers still match. */
export function readProfessionalBinding(row: Pick<EmployeeRunRow, "professional_json" | "employee_id">): ProfessionalBinding | null {
  if (!row.professional_json) return null;
  const value = JSON.parse(row.professional_json) as ProfessionalBinding;
  if (value.kind === "legacy") return value;
  if (value.kind !== "professional" || value.employeeId !== row.employee_id || !Number.isSafeInteger(value.revision)
    || value.revision < 1 || !value.revisionId || !value.catalogRoleSlug || !value.professionalTitle
    || !sha.test(value.originalTemplateSha256) || !Number.isFinite(value.boundAt)) throw new Error("Invalid professional snapshot.");
  validatePrompt(value.promptMarkdown, value.promptSha256);
  return value;
}

/** Explicit policy: any profile edit/reassignment since review requires a new review. */
export function verifyProfessionalBinding(db: Database, row: EmployeeRunRow): ProfessionalBinding | null {
  const frozen = readProfessionalBinding(row);
  const current = resolveProfessionalBinding(db, row.employee_id, frozen?.kind === "professional" ? frozen.boundAt : 0);
  if (frozen === null && current.kind === "legacy") return null; // pre-090 legacy approval
  if (JSON.stringify(frozen) !== JSON.stringify(current)) throw new Error("Professional profile changed since review. Review and approve the run again.");
  return frozen;
}

export function assignedProfessionalEmployee(db: Database, taskId: string): string | null {
  return db.query<{ employee_id: string }, [string]>(`SELECT a.employee_id FROM employee_task_assignments a
    JOIN ai_employee_professional_profiles p ON p.employee_id = a.employee_id
    WHERE a.task_id = ? AND a.status = 'active'`).get(taskId)?.employee_id ?? null;
}

/** Synchronous, repeated inside the run-recording transaction after every async preflight. */
export function professionalRuntimeClaim(db: Database, row: EmployeeRunRow, task: Task): ProfessionalBinding | null {
  if (row.task_id !== task.id || row.status !== "starting" || row.approval_provenance !== "owner"
    || row.approved_at === null || row.expires_at <= Date.now() || row.run_id !== null) throw new Error("Employee execution approval is stale or already consumed.");
  const employee = db.query<{ status: string; project_path: string | null; archived_at: number | null }, [string]>(
    "SELECT status, project_path, archived_at FROM ai_employees WHERE id = ?").get(row.employee_id);
  const assignment = db.query<{ id: string; revision: number; employee_id: string; project_path: string }, [string]>(
    "SELECT id, revision, employee_id, project_path FROM employee_task_assignments WHERE task_id = ? AND status = 'active'").get(task.id);
  if (!employee || employee.status !== "active" || employee.archived_at !== null || employee.project_path !== row.project_path
    || !assignment || assignment.id !== row.assignment_id || assignment.revision !== row.assignment_revision
    || assignment.employee_id !== row.employee_id || assignment.project_path !== row.project_path) throw new Error("Employee or assignment changed since review.");
  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned" || owner.projectPath !== row.project_path || !verifyLaunchScope(task, row.project_path).ok) throw new Error("Employee execution project scope changed.");
  return verifyProfessionalBinding(db, row);
}

/** Does not authorize another process. Reattach/reconcile preserves the original run and snapshot. */
export function professionalContinuationProblem(db: Database, taskId: string, excludeRunId = ""): string | null {
  const row = db.query<{ professional_json: string | null }, [string, string]>(`SELECT e.professional_json FROM runs r
    LEFT JOIN employee_executions e ON e.run_id = r.id WHERE r.task_id = ? AND r.id != ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`).get(taskId, excludeRunId);
  const binding = row?.professional_json ? JSON.parse(row.professional_json) as ProfessionalBinding : null;
  return binding?.kind === "professional" || assignedProfessionalEmployee(db, taskId)
    ? "Professional task continuation requires a single-use Turn review and owner confirmation through employee execution. Ordinary unapproved follow-up/resume is unsupported here; in-place reattachment remains supported."
    : null;
}
