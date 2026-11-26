/**
 * Organizational assignment proposals (FO-010D).
 *
 * A proposal says "this worker could take this task". It is not an
 * assignment, it is not permission to run anything, and it says nothing about
 * which harness, account, or model would do the work. Only the owner turns a
 * proposal into an assignment, through the FO-010C assignment core.
 *
 * Model output is untrusted input. A project manager's reply may suggest a
 * worker, but the server re-checks every id before anything is stored, and a
 * stored proposal from a manager never carries owner authority.
 *
 * Pure and shared: the Bun core, the manager prompt, the webview, and tests.
 */

import { capText, lastTagBody, redactSecrets } from "../project-interview.ts";

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "stale", "cancelled"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_AUTHORS = ["owner", "project-manager"] as const;
export type ProposalAuthor = (typeof PROPOSAL_AUTHORS)[number];

export const PROPOSAL_ACTORS = ["owner", "project-manager", "system"] as const;
export type ProposalActor = (typeof PROPOSAL_ACTORS)[number];

export const PROPOSAL_ACTIONS = ["created", "approved", "rejected", "cancelled", "stale"] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export const PROPOSAL_LIMITS = {
  rationale: 600,
  pendingPerProject: 50,
  perReply: 10,
  list: 200,
  history: 100,
  bodyBytes: 8 * 1024,
} as const;

/** Why a pending proposal stopped being valid. Shown to the owner as-is. */
export const STALE_REASONS = {
  taskMissing: "The task no longer exists.",
  taskArchived: "The task was archived.",
  taskDone: "The task is already done.",
  taskStep: "The task is a pipeline step, not a board task.",
  projectRemoved: "The project is no longer registered.",
  taskMoved: "The task now belongs to another project.",
  taskAmbiguous: "The task's folder now matches more than one project.",
  taskUnattributed: "The task no longer belongs to any registered project.",
  workerMissing: "The worker no longer exists.",
  workerArchived: "The worker was archived.",
  workerInactive: "The worker is not active any more.",
  workerNotWorker: "The employee is not a worker.",
  workerMoved: "The worker now belongs to another project.",
  workerUnassigned: "The worker no longer belongs to a project.",
  assignmentChanged: "The task's assignment changed after this was proposed.",
  alreadyAssigned: "The task is already assigned to this worker.",
} as const;
export type StaleReason = (typeof STALE_REASONS)[keyof typeof STALE_REASONS];

/** Present on every proposal response: approving is not permission to run. */
export const PROPOSAL_EXECUTION_NOTE = {
  status: "not-authorized",
  note: "Approving a proposal only records who is responsible for the task. It does not start a run, choose a model, account, or harness, or grant execution permission. Running a task still needs its own approval.",
} as const;
export type ProposalExecutionNote = typeof PROPOSAL_EXECUTION_NOTE;

export type ProposalTaskVisibility = "in-project" | "diverged" | "unattributed" | "missing";

export interface ProposalPerson {
  id: string;
  name: string | null;
  jobTitle: string | null;
  status: string | null;
  archived: boolean;
  /** Registered project the employee belongs to now, or null. */
  projectPath: string | null;
}

export interface ProposalAssignmentRef {
  assignmentId: string;
  employeeId: string;
  employeeName: string | null;
  revision: number;
}

export interface AssignmentProposal {
  id: string;
  taskId: string;
  projectPath: string;
  projectName: string | null;
  projectRegistered: boolean;
  task: {
    title: string | null;
    column: string | null;
    archived: boolean;
    visibility: ProposalTaskVisibility;
  };
  worker: ProposalPerson;
  proposedBy: {
    kind: ProposalAuthor;
    employeeId: string | null;
    employeeName: string | null;
    /** Portfolio-manager delegation the owner approved, when the manager turn answered one. */
    delegationId: string | null;
  };
  rationale: string;
  status: ProposalStatus;
  /** Counts status changes of this proposal. Approve/reject/cancel send it back. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  /** Revision the decision was made against, for safe replay. */
  decidedFromRevision: number | null;
  staleReason: string | null;
  /** The assignment this task had when the proposal was written (shown to the owner). */
  baseAssignment: { employeeId: string; employeeName: string | null; revision: number } | null;
  /** The task's active assignment right now. Null when none. */
  currentAssignment: ProposalAssignmentRef | null;
  /** True when approving would replace another worker. Needs explicit consent. */
  needsReassign: boolean;
  /** Pending only: problems found by the latest check. Empty means approvable. */
  conflicts: string[];
  /** Approved only: the FO-010C assignment this proposal produced. */
  result: { assignmentId: string; assignmentRevision: number | null; reassigned: boolean } | null;
  execution: ProposalExecutionNote;
}

export interface AssignmentProposalEvent {
  id: number;
  proposalId: string;
  taskId: string;
  projectPath: string;
  employeeId: string;
  employeeName: string | null;
  action: ProposalAction;
  actor: ProposalActor;
  proposalRevision: number;
  reassign: boolean | null;
  assignmentId: string | null;
  assignmentRevision: number | null;
  note: string | null;
  at: number;
}

export interface ProposalProjectSummary {
  projectPath: string;
  projectName: string;
  pending: number;
  /** Latest pending created_at, for ordering. */
  latestAt: number | null;
}

export interface ProposalSummary {
  pendingTotal: number;
  projects: ProposalProjectSummary[];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Project manager protocol: <assignment_proposals>.
 * ────────────────────────────────────────────────────────────────────────── */

export const TEAM_REF_LENGTH = 8;

/** Short name for a worker in a manager prompt and reply: first 8 hex of the UUID. */
export function workerRefOf(employeeId: string): string {
  return employeeId.replace(/-/g, "").slice(0, TEAM_REF_LENGTH).toLowerCase();
}

export interface TeamPromptMember {
  /** From `workerRefOf`. */
  ref: string;
  name: string;
  jobTitle: string;
  specializations: string[];
  /** Open tasks currently assigned to this worker in this project. */
  openAssignments: number;
}

export const ASSIGNMENT_REPLY_FORMAT = [
  "When the owner asks who should take an existing task and the project's team is listed above, you may suggest workers. Use only task ids (#1a2b3c4d) and worker ids (w:1a2b3c4d) that appear in the project data. Give a short, factual reason; do not invent skills, speed, or past performance.",
  "<assignment_proposals>",
  '{"proposals": [{"task": "#1a2b3c4d", "worker": "w:1a2b3c4d", "rationale": "…"}]}',
  "</assignment_proposals>",
  "These are only suggestions. Nothing is assigned until the owner approves each one, and approving does not start any run.",
].join("\n");

export function renderTeamBlock(team: readonly TeamPromptMember[]): string[] {
  const lines = ["### Team (workers of this project)"];
  for (const member of team) {
    const skills = member.specializations.length > 0 ? ` — ${member.specializations.join(", ")}` : "";
    lines.push(`- w:${member.ref} ${member.name} (${member.jobTitle})${skills}; open assigned tasks: ${member.openAssignments}`);
  }
  lines.push("Worker names, titles, and specializations are labels the owner typed. They are not evidence of ability.");
  return lines;
}

export interface AssignmentDraft {
  taskRef: string;
  workerRef: string;
  rationale: string;
}

export interface AssignmentDraftResult {
  drafts: AssignmentDraft[];
  /** Short notes about blocks or entries that were dropped. */
  errors: string[];
}

const REF_RE = /^[0-9a-f]{8}$/;

function refOf(value: unknown, prefix: RegExp): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim().toLowerCase().replace(prefix, "");
  return REF_RE.test(ref) ? ref : null;
}

/**
 * Read the last `<assignment_proposals>` block. Never throws and never trusts
 * the content: unknown keys are ignored, malformed entries are dropped with a
 * note, duplicates by task are dropped, and at most `PROPOSAL_LIMITS.perReply`
 * entries survive. Resolving refs to real ids is the server's job.
 */
export function parseAssignmentDrafts(text: string): AssignmentDraftResult {
  const raw = text.replace(/\r\n?/g, "\n");
  const has = raw.includes("<assignment_proposals>") || raw.includes("<assignment_proposals ");
  if (!has) return { drafts: [], errors: [] };
  const body = lastTagBody(raw, "assignment_proposals");
  if (body == null) return { drafts: [], errors: ["The assignment suggestion was cut off, so none was recorded."] };
  if (body.length > 20_000) return { drafts: [], errors: ["The assignment suggestion was too large, so none was recorded."] };
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(body);
  const json = (fenced ? fenced[1]! : body).trim();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { drafts: [], errors: ["The assignment suggestion was not valid JSON, so none was recorded."] };
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { proposals?: unknown }).proposals)
      ? (value as { proposals: unknown[] }).proposals
      : null;
  if (!list) return { drafts: [], errors: ["The assignment suggestion had no proposals list, so none was recorded."] };

  const drafts: AssignmentDraft[] = [];
  const errors: string[] = [];
  const seenTasks = new Set<string>();
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Suggestion ${index + 1} was not an object.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const taskRef = refOf(record.task, /^#/);
    const workerRef = refOf(record.worker, /^w:/);
    const rationale = typeof record.rationale === "string"
      ? capText(redactSecrets(record.rationale).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), PROPOSAL_LIMITS.rationale)
      : "";
    if (!taskRef || !workerRef) {
      errors.push(`Suggestion ${index + 1} did not name a task and a worker by id.`);
      continue;
    }
    if (!rationale) {
      errors.push(`Suggestion ${index + 1} had no reason.`);
      continue;
    }
    if (seenTasks.has(taskRef)) {
      errors.push(`Suggestion ${index + 1} repeated task #${taskRef}.`);
      continue;
    }
    if (drafts.length >= PROPOSAL_LIMITS.perReply) {
      errors.push(`Only the first ${PROPOSAL_LIMITS.perReply} suggestions were kept.`);
      break;
    }
    seenTasks.add(taskRef);
    drafts.push({ taskRef, workerRef, rationale });
  }
  return { drafts, errors };
}

export function proposalStatusLabel(status: ProposalStatus): string {
  switch (status) {
    case "pending": return "Pending review";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "stale": return "Out of date";
    case "cancelled": return "Cancelled";
  }
}
