export type HeadScope =
  | { kind: "workspace" }
  | { kind: "cluster"; id: string }
  | { kind: "project"; path: string }
  | { kind: "task"; id: string };

export interface HeadScopeSnapshot {
  scope: HeadScope;
  label: string;
  projectPath: string | null;
  projectAddedAt: number | null;
  clusterId: string | null;
}

export type HeadBoardAction =
  | { kind: "replan_mission"; taskId: string; title: string; projectPath: string; missionId: string;
      role: "developer" | "reviewer"; resource: { harnessId: string; modelId: string; accountId: string; mode: string };
      changes?: Array<{ taskId: string; role: "developer" | "reviewer"; resource: { harnessId: string; modelId: string; accountId: string; mode: string } }>;
      objective?: string;
      allocation?: { objective: string; optimal: boolean; explored: number; limit: number; feasible: boolean };
      reason: string; proposalId?: string; digest?: string; result?: Record<string, unknown> | string | null }
  | { kind: "create"; title: string; description: string; projectPath?: string; result?: Record<string, unknown> | string | null }
  | { kind: "edit"; taskId: string; title: string; description?: string; result?: Record<string, unknown> | string | null }
  | { kind: "prioritize"; taskId: string; title: string; priority: "critical" | "high" | "normal" | "low"; result?: Record<string, unknown> | string | null }
  | { kind: "admit"; taskId: string; title: string; result?: Record<string, unknown> | string | null }
  | { kind: "stage_ready"; taskId: string; title: string; result?: Record<string, unknown> | string | null }
  | { kind: "assign"; taskId: string; title: string; employeeId: string; employeeName: string; result?: Record<string, unknown> | string | null }
  | { kind: "plan_execution"; taskId: string; title: string; employeeId: string; employeeName: string; harnessId: string; model?: string; effort?: string | null; mode?: string; result?: Record<string, unknown> | string | null }
  | { kind: "execute"; taskId: string; title: string; employeeId?: string; employeeName?: string; harnessId?: string; model?: string; effort?: string | null; mode?: string; attemptId?: string; result?: Record<string, unknown> | string | null }
  | { kind: "request_qc"; taskId: string; title: string; reviewerHarness?: string; reviewerModel?: string; reviewerEmployeeId?: string; reviewerRoleSlug?: string; result?: Record<string, unknown> | string | null }
  | { kind: "rework"; taskId: string; title: string; feedback?: string; result?: Record<string, unknown> | string | null }
  | { kind: "complete"; taskId: string; title: string; result?: Record<string, unknown> | string | null };

export interface HeadBoardEditPreview {
  taskId: string;
  currentTitle: string | null;
  nextTitle: string | null;
  titleChanged: boolean;
  currentDescription: string | null;
  nextDescription: string | null;
  descriptionStatus: "unchanged" | "updated" | "unsafe-blank";
}

export interface HeadBoardProposal {
  messageId: string;
  context: HeadScopeSnapshot;
  action: HeadBoardAction;
  status: "pending" | "applying" | "applied" | "rejected" | "failed";
  taskId: string | null;
  error: string | null;
  missionResource?: ReturnType<typeof import("../bun/orchestration/mission-replan.ts").getMissionResourceProposal>;
  /** The projects this proposal would change, from its stored action. Always listed before approval. */
  affectedProjects?: { path: string; name: string }[];
  /** Structured field-level preview for edit actions, derived only from the validated stored action and task record. */
  editPreview?: HeadBoardEditPreview | null;
  permissions?: string | null;
  specialistName?: string | null;
  provider?: string | null;
  policy?: string | null;
  sideEffects?: string | null;
  result?: Record<string, unknown> | string | null;
}

export const headScopeKey = (scope: HeadScope): string => {
  switch (scope.kind) {
    case "workspace": return "workspace";
    case "cluster": return `cluster:${scope.id}`;
    case "project": return `project:${scope.path}`;
    case "task": return `task:${scope.id}`;
  }
};

export function parseHeadScope(raw: unknown): HeadScope | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const string = (field: string) => typeof value[field] === "string" && value[field].length > 0
    && value[field].length <= 4096 && !value[field].includes("\0") ? value[field] : null;
  if (value.kind === "workspace" && Object.keys(value).length === 1) return { kind: "workspace" };
  if (Object.keys(value).length !== 2) return null;
  const id = string("id");
  const path = string("path");
  if (value.kind === "cluster" && id) return { kind: "cluster", id };
  if (value.kind === "project" && path) return { kind: "project", path };
  if (value.kind === "task" && id) return { kind: "task", id };
  return null;
}

export function storedHeadScope(raw: unknown): HeadScopeSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const scope = parseHeadScope(value.scope);
  if (!scope || typeof value.label !== "string") return null;
  if (value.projectPath !== null && typeof value.projectPath !== "string") return null;
  if (value.projectAddedAt !== null && typeof value.projectAddedAt !== "number") return null;
  if (value.clusterId !== null && typeof value.clusterId !== "string") return null;
  return { scope, label: value.label, projectPath: value.projectPath, projectAddedAt: value.projectAddedAt, clusterId: value.clusterId };
}

export const HEAD_BOARD_FORMAT = [
  "In a selected project or task, or in workspace/cluster scope targeting a registered project, you may propose ONE board action. Keep all prose inside <reply>…</reply>. Put the action after it in <head_board_action>…</head_board_action> as one JSON object:",
  '{"kind":"create","title":"…","description":"…"} — adds to Backlog. Can specify "projectPath" if in workspace or cluster scope.',
  '{"kind":"edit","taskId":"…","title":"…","description":"…"} — edits an existing task title and/or description (omit "description" to leave the task prompt unchanged; never send an empty description).',
  '{"kind":"admit","taskId":"…"} — requests Owner approval to move a Backlog task to Inbox.',
  '{"kind":"stage_ready","taskId":"…"} — moves an Inbox task to Ready for execution review.',
  '{"kind":"assign","taskId":"…","employeeId":"…"} — assigns an eligible specialist to the task.',
  '{"kind":"prioritize","taskId":"…","priority":"high"} — updates task priority (critical, high, normal, low).',
  '{"kind":"plan_execution","taskId":"…","employeeId":"…","harnessId":"…","model":"…"} — prepares an execution plan review.',
  '{"kind":"execute","taskId":"…","employeeId":"…","harnessId":"…","model":"…"} — proposes to authorize and run specialist execution.',
  '{"kind":"request_qc","taskId":"…","reviewerHarness":"…","reviewerModel":"…"} — requests independent QC review for a completed run.',
  '{"kind":"rework","taskId":"…"} — moves task back to Ready after QC changes requested.',
  '{"kind":"replan_mission","missionId":"…","taskId":"…","role":"reviewer","harnessId":"…","modelId":"…","accountId":"…","mode":"…","reason":"…"} — proposes one exact eligible resource. Use "changes":[{"taskId":"…","role":"developer","harnessId":"…","modelId":"…","accountId":"…","mode":"…"}] for one atomic multi-stage amendment, or "objective":"fastest"|"lowest-charge"|"balanced"|"quota-preserving"|"minimum-wait" to ask the shared planner for the remaining stages. Include projectPath for workspace or cluster scope. The Owner reviews the exact digest before it applies.',
  '{"kind":"complete","taskId":"…"} — marks task Done and confirms QC acceptance.',
  "Use only exact IDs listed in this turn. Never copy secrets, Brain or restricted observations into a worker task. No command, file, infrastructure, deployment, or unapproved launch action is available.",
].join("\n");
