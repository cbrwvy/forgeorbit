import { existsSync, statSync } from "node:fs";
import { db, projects, tasks } from "./db.ts";
import { AssignmentCore, AssignmentCoreError } from "./assignment-core.ts";
import { canAdmitTaskToInbox, admitTaskToInbox } from "./pm-intake.ts";
import { createTask, moveTaskColumn } from "./orchestrator.ts";
import { gitWorkingTreeCapability } from "./worktree.ts";
import { ownerProjectOf, taskInProject } from "./project-ownership.ts";
import { updateScheduling } from "./task-scheduling.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { EmployeeRunError, reviewEmployeeExecution, startEmployeeExecution } from "./employee-run.ts";
import { parseTaskStagingGrant, type TaskStagingGrant } from "../shared/execution/workspace-grant.ts";
import { prepareQcReview, startQcReview, assertCanMoveTaskToDone, acknowledgeQcOwnerReview } from "./task-quality-control.ts";
import { resolveHeadScope, sameHeadScope, type ScopedHeadContext } from "./head-pm-scope.ts";
import type { ManagerResult } from "./project-manager.ts";
import { parseJsonObject } from "../shared/project-manager.ts";
import { lastTagBody, redactSecrets } from "../shared/project-interview.ts";
import type { HeadBoardAction, HeadBoardEditPreview, HeadBoardProposal, HeadScopeSnapshot } from "../shared/head-pm-scope.ts";
import { getMissionResourceProposal, missionResourceOptions, planMissionReallocation, prepareMissionResourceProposal, settleMissionResourceProposal } from "./orchestration/mission-replan.ts";
import { missionStore } from "./orchestration/mission-store.ts";
import { routerV2Service } from "./router-v2/router-v2-service.ts";

export const HEAD_BOARD_TAG = "head_board_action";
const marker = /<\/?head_board_action\b/i;
const applying = new Set<string>();

type Result<T> = ManagerResult<T>;
const fail = (status: number, error: string) => ({ ok: false as const, status, error });

const UNSAFE_BLANK_EDIT_DESCRIPTION_ERROR =
  "Cannot approve this edit proposal because it contains an empty or blank description that would erase the task prompt. Reject this proposal and ask Head of PM for a new edit.";

function hasUnsafeBlankDescriptionField(rawAction: Record<string, unknown>): boolean {
  for (const field of ["description", "prompt"] as const) {
    if (!Object.hasOwn(rawAction, field) || rawAction[field] === undefined) continue;
    if (typeof rawAction[field] !== "string" || rawAction[field].trim().length === 0) return true;
  }
  return false;
}

function validateStoredEditAction(
  rawAction: Record<string, unknown>,
): { ok: true; title?: string; description?: string } | { ok: false; unsafeBlankDescription: boolean; error: string } {
  if (hasUnsafeBlankDescriptionField(rawAction)) {
    return { ok: false, unsafeBlankDescription: true, error: UNSAFE_BLANK_EDIT_DESCRIPTION_ERROR };
  }
  if (Object.hasOwn(rawAction, "title") && rawAction.title !== undefined && typeof rawAction.title !== "string") {
    return { ok: false, unsafeBlankDescription: false, error: "Stored edit proposal has an invalid task title." };
  }
  const title = typeof rawAction.title === "string" ? rawAction.title.trim().replace(/\s+/g, " ") : "";
  const description = typeof rawAction.description === "string"
    ? rawAction.description.trim()
    : (typeof rawAction.prompt === "string" ? rawAction.prompt.trim() : undefined);
  if (!title && !description) {
    return { ok: false, unsafeBlankDescription: false, error: "Stored edit proposal has no valid title or description change." };
  }
  if (title.length > 160 || (description !== undefined && description.length > 4000)) {
    return { ok: false, unsafeBlankDescription: false, error: "Stored edit proposal exceeds character limits." };
  }
  return {
    ok: true,
    ...(title ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

export function readHeadBoardDraft(reply: string, gathered: ScopedHeadContext, sensitive: boolean): Result<HeadBoardAction | null> {
  if (!marker.test(reply)) return { ok: true, value: null };
  if (sensitive) return fail(400, "Board proposals require a separate turn without attached memories, notes, or Computer Use observations.");
  const block = lastTagBody(reply, HEAD_BOARD_TAG);
  if (!block || (reply.match(/<head_board_action\b/gi)?.length ?? 0) !== 1 || block.length > 6000) {
    return fail(400, "Expected one complete board action.");
  }
  const parsed = parseJsonObject(block);
  if (!parsed.ok) return fail(400, parsed.error);
  const value = parsed.value as Record<string, unknown>;

  // Resolve target project: from turn scope or explicit project indicator in the action.
  let targetProjectPath = gathered.scope.projectPath;
  if (!targetProjectPath && (typeof value.projectPath === "string" || typeof value.project === "string")) {
    const rawTarget = (value.projectPath || value.project) as string;
    const resolved = resolveHeadScope({ kind: "project", path: rawTarget }, "selection");
    if (!resolved.ok) return fail(resolved.status, resolved.error);
    targetProjectPath = resolved.value.projectPath;
    if (gathered.scope.scope.kind === "cluster" && gathered.scope.clusterId && !gathered.includesProject(targetProjectPath!)) {
      return fail(400, "The target project is not a member of the selected cluster.");
    }
  }
  if (value.kind === "replan_mission" && typeof value.objective === "string" && !Array.isArray(value.changes) && typeof value.taskId !== "string") {
    const missionId = value.missionId;
    const reason = typeof value.reason === "string" ? redactSecrets(value.reason.trim()) : "";
    const includes = gathered.scope.scope.kind === "workspace" ? (path: string) => !!projects.get(path) : gathered.includesProject;
    if (typeof missionId !== "string" || !reason || reason.length > 500) return fail(400, "A scoped mission and reason are required.");
    const mission = missionStore.getMission(missionId);
    if (!mission || !mission.projects.every(includes) || gathered.scope.scope.kind === "task") {
      return fail(400, "The mission is outside the selected scope.");
    }
    try {
      const planned = planMissionReallocation(missionId, value.objective);
      const first = planned.changes[0]!;
      const stageTask = tasks.get(first.taskId);
      const stagePlan = mission.plan.tasks.find(item => item.taskId === first.taskId);
      if (!stageTask || !stagePlan) return fail(400, "The planned stage is no longer in this mission.");
      return { ok: true, value: {
        kind: "replan_mission", taskId: first.taskId, title: redactSecrets(stageTask.title), projectPath: stagePlan.projectPath,
        missionId, role: first.role, resource: first.resource, reason, changes: planned.changes, objective: planned.allocation.objective,
        allocation: planned.allocation,
      } };
    } catch (error) { return fail(409, (error as Error).message); }
  }
  if (!targetProjectPath) return fail(400, "Select the exact project or task before proposing a board action.");

  if (value.kind === "create") {
    const title = typeof value.title === "string" ? redactSecrets(value.title.trim().replace(/\s+/g, " ")) : "";
    const description = typeof value.description === "string" ? redactSecrets(value.description.trim()) : "";
    if (title && title.length <= 160 && description && description.length <= 4000) {
      return { ok: true, value: { kind: "create", title, description, projectPath: targetProjectPath } };
    }
    return fail(400, "Task create requires a valid title and description.");
  }

  const taskId = typeof value.taskId === "string" ? value.taskId : null;
  const task = taskId ? tasks.get(taskId) : null;
  if (!task || !taskInProject(task, targetProjectPath, { fresh: true })) {
    return fail(400, "The proposed action is invalid or the task was not in this turn's context.");
  }
  // Only a task this turn was actually shown can be proposed for. A task-scoped turn sees exactly one task; company
  // and cluster turns see no task rows, so they can create a task in a named project but cannot edit an existing one.
  // Mission re-allocation is validated against the mission's own plan and scope below, not against board rows.
  if (value.kind !== "replan_mission" && !gathered.taskRows.has(task.id)) {
    return fail(400, "The proposed action is invalid or the task was not in this turn's context. Select the project or the task first.");
  }
  const base = { taskId: task.id, title: redactSecrets(task.title) };

  if (value.kind === "replan_mission") {
    const missionId = value.missionId;
    const reason = typeof value.reason === "string" ? redactSecrets(value.reason.trim()) : "";
    const includes = gathered.scope.scope.kind === "workspace" ? (path: string) => !!projects.get(path) : gathered.includesProject;
    const mission = typeof missionId === "string" ? missionStore.getMission(missionId) : null;
    if (!includes(targetProjectPath!) || gathered.scope.scope.kind === "task" && gathered.scope.scope.id !== task.id ||
      !mission || !mission.projects.every(includes) || !reason || reason.length > 500) {
      return fail(400, "A scoped mission, task, stage and exact resource are required.");
    }
    const resourceOf = (raw: Record<string, unknown>) => {
      const { harnessId, modelId, accountId, mode } = raw;
      return typeof harnessId === "string" && typeof modelId === "string" && typeof accountId === "string" && typeof mode === "string"
        ? { harnessId, modelId, accountId, mode } : null;
    };
    try {
      if (Array.isArray(value.changes)) {
        if (value.changes.length < 1 || value.changes.length > 12) return fail(400, "An atomic proposal needs 1–12 exact stage changes.");
        const changes: Array<{ taskId: string; role: "developer" | "reviewer"; resource: { harnessId: string; modelId: string; accountId: string; mode: string } }> = [];
        for (const item of value.changes) {
          if (!item || typeof item !== "object") return fail(400, "Each stage change must name its task, role and resource.");
          const row = item as Record<string, unknown>;
          const stageTaskId = typeof row.taskId === "string" ? row.taskId : "";
          const role = row.role === "developer" || row.role === "reviewer" ? row.role : null;
          const nested = row.resource && typeof row.resource === "object" ? row.resource as Record<string, unknown> : row;
          const resource = resourceOf(nested);
          const stageTask = tasks.get(stageTaskId);
          const stagePlan = mission.plan.tasks.find(entry => entry.taskId === stageTaskId);
          if (!role || !resource || !stageTask || !stagePlan || !includes(stagePlan.projectPath) || !taskInProject(stageTask, stagePlan.projectPath, { fresh: true })) {
            return fail(400, "Each stage must belong to this mission and scope.");
          }
          const covered = role === "developer" && value.changes.some(other => other && typeof other === "object" &&
            (other as Record<string, unknown>).taskId === stageTaskId && (other as Record<string, unknown>).role === "reviewer");
          if (!missionResourceOptions(missionId as string, stageTaskId, role, covered).some(option =>
            option.harnessId === resource.harnessId && option.modelId === resource.modelId && option.accountId === resource.accountId && option.mode === resource.mode)) {
            return fail(409, "The exact requested resource is unavailable under this mission policy.");
          }
          changes.push({ taskId: stageTaskId, role, resource });
        }
        if (changes[0]?.taskId !== task.id) return fail(400, "The proposal's first stage must match its task.");
        const first = changes[0]!;
        return { ok: true, value: { ...base, kind: "replan_mission", projectPath: targetProjectPath!, missionId: missionId as string,
          role: first.role, resource: first.resource, reason, changes } };
      }
      const resource = resourceOf(value);
      const role = value.role === "developer" || value.role === "reviewer" ? value.role : null;
      if (!role || !resource || !mission.plan.tasks.some(item => item.taskId === task.id && item.projectPath === targetProjectPath)) {
        return fail(400, "A scoped mission, task, stage and exact resource are required.");
      }
      if (!missionResourceOptions(missionId as string, task.id, role).some(option =>
        option.harnessId === resource.harnessId && option.modelId === resource.modelId && option.accountId === resource.accountId && option.mode === resource.mode)) {
        return fail(409, "The exact requested resource is unavailable under this mission policy.");
      }
      return { ok: true, value: { ...base, kind: "replan_mission", projectPath: targetProjectPath!, missionId: missionId as string, role, reason, resource } };
    } catch (error) { return fail(409, (error as Error).message); }
  }

  if (value.kind === "edit") {
    if (task.archivedAt != null || task.pipelineParentId) return fail(400, "Archived or pipeline tasks cannot be edited here.");
    if (Object.hasOwn(value, "title") && value.title !== undefined && typeof value.title !== "string") {
      return fail(400, "Task title must be a string.");
    }
    if (Object.hasOwn(value, "description") && value.description !== undefined && typeof value.description !== "string") {
      return fail(400, "Task description must be a string.");
    }
    if (Object.hasOwn(value, "prompt") && value.prompt !== undefined && typeof value.prompt !== "string") {
      return fail(400, "Task description must be a string.");
    }
    const rawTitle = typeof value.title === "string" ? redactSecrets(value.title.trim().replace(/\s+/g, " ")) : "";
    const rawDesc = typeof value.description === "string" ? redactSecrets(value.description.trim()) : "";
    const rawPrompt = typeof value.prompt === "string" ? redactSecrets(value.prompt.trim()) : "";
    if (rawDesc && rawPrompt && rawDesc !== rawPrompt) {
      return fail(400, "Conflicting task description fields.");
    }
    const currentTitle = redactSecrets(task.title);
    const currentDescription = redactSecrets(task.prompt.trim());
    const title = rawTitle || currentTitle;
    const hasTitleChange = rawTitle.length > 0 && rawTitle !== currentTitle;
    // Empty or whitespace-only description/prompt never implicitly clears an existing prompt;
    // treat blank generated description fields as absent before persistence and preview.
    const nextDescription = rawDesc || rawPrompt || undefined;
    const hasDescriptionChange = nextDescription !== undefined && nextDescription !== currentDescription;
    if (title.length > 160 || (nextDescription && nextDescription.length > 4000)) {
      return fail(400, "Task title or description exceeds character limits.");
    }
    if (!hasTitleChange && !hasDescriptionChange) {
      return fail(400, "Task edit requires a non-empty title change or non-empty description change.");
    }
    return {
      ok: true,
      value: {
        kind: "edit",
        taskId: task.id,
        title,
        ...(hasDescriptionChange ? { description: nextDescription } : {}),
      },
    };
  }

  if (value.kind === "admit") {
    if (task.column !== "backlog") return fail(400, "Only Backlog tasks may be admitted.");
    return { ok: true, value: { ...base, kind: "admit" } };
  }

  if (value.kind === "stage_ready") {
    if (!["inbox", "review", "blocked"].includes(task.column)) return fail(400, "Only Inbox, Review, or Blocked tasks can be moved to Ready.");
    return { ok: true, value: { ...base, kind: "stage_ready" } };
  }

  if (value.kind === "assign") {
    if ((task.column !== "inbox" && task.column !== "ready") || task.pipelineId) return fail(400, "Only Inbox or Ready specialist tasks may be assigned here.");
    // Only a specialist this scope listed can be proposed; an id from anywhere else is not "observed".
    const worker = typeof value.employeeId === "string" ? gathered.workers.get(value.employeeId) ?? null : null;
    if (worker) return { ok: true, value: { ...base, kind: "assign", employeeId: worker.id, employeeName: redactSecrets(worker.name) } };
    return fail(400, "Specialist not found in this scope.");
  }

  if (value.kind === "prioritize") {
    if (value.priority === "low" || value.priority === "normal" || value.priority === "high" || value.priority === "critical") {
      return { ok: true, value: { ...base, kind: "prioritize", priority: value.priority } };
    }
    return fail(400, "Invalid priority level.");
  }

  if (value.kind === "plan_execution") {
    if (typeof value.employeeId === "string" && value.employeeId && !gathered.workers.has(value.employeeId)) {
      return fail(400, "Specialist not found in this scope.");
    }
    const worker = typeof value.employeeId === "string" ? gathered.workers.get(value.employeeId) ?? null : null;
    const harnessId = typeof value.harnessId === "string" ? value.harnessId.trim() : (task.agent || "codex");
    return {
      ok: true,
      value: {
        ...base,
        kind: "plan_execution",
        employeeId: worker?.id ?? "",
        employeeName: worker ? redactSecrets(worker.name) : "",
        harnessId,
        model: typeof value.model === "string" ? value.model : undefined,
        effort: typeof value.effort === "string" ? value.effort : undefined,
        mode: typeof value.mode === "string" ? value.mode : undefined,
      },
    };
  }

  if (value.kind === "execute") {
    const worker = typeof value.employeeId === "string"
      ? db.query<{ id: string; name: string }, [string]>("SELECT id, name FROM ai_employees WHERE id=?").get(value.employeeId)
      : null;
    const harnessId = typeof value.harnessId === "string" ? value.harnessId.trim() : (task.agent || "codex");
    return {
      ok: true,
      value: {
        ...base,
        kind: "execute",
        employeeId: worker?.id,
        employeeName: worker ? redactSecrets(worker.name) : undefined,
        harnessId,
        model: typeof value.model === "string" ? value.model : undefined,
        effort: typeof value.effort === "string" ? value.effort : undefined,
        mode: typeof value.mode === "string" ? value.mode : undefined,
        attemptId: typeof value.attemptId === "string" ? value.attemptId : undefined,
      },
    };
  }

  if (value.kind === "request_qc") {
    if (task.column !== "review" && task.column !== "blocked") return fail(400, "Task must be in Review or Blocked to request QC.");
    return {
      ok: true,
      value: {
        ...base,
        kind: "request_qc",
        reviewerHarness: typeof value.reviewerHarness === "string" ? value.reviewerHarness : undefined,
        reviewerModel: typeof value.reviewerModel === "string" ? value.reviewerModel : undefined,
        reviewerEmployeeId: typeof value.reviewerEmployeeId === "string" ? value.reviewerEmployeeId : undefined,
        reviewerRoleSlug: typeof value.reviewerRoleSlug === "string" ? value.reviewerRoleSlug : undefined,
      },
    };
  }

  if (value.kind === "rework") {
    if (task.column !== "review" && task.column !== "blocked") return fail(400, "Task must be in Review or Blocked to request rework.");
    return {
      ok: true,
      value: {
        ...base,
        kind: "rework",
        feedback: typeof value.feedback === "string" ? redactSecrets(value.feedback) : undefined,
      },
    };
  }

  if (value.kind === "complete") {
    if (task.column !== "review") return fail(400, "Only tasks in Review can be marked complete.");
    return { ok: true, value: { ...base, kind: "complete" } };
  }

  return fail(400, "That board action is unavailable for this task or specialist.");
}

type Row = {
  message_id: string;
  context_json: string;
  action_json: string;
  status: HeadBoardProposal["status"];
  task_id: string | null;
  error: string | null;
  created_at: number;
};

const rowFor = (id: string) => db.query<Row, [string]>("SELECT * FROM head_board_proposals WHERE message_id=?").get(id);

/**
 * The projects a proposal would change, read from the stored action, never from the scope the Owner asked in.
 * A company- or cluster-scoped turn can propose for one project; the card must name it before approval.
 */
function affectedProjectsOf(proposal: HeadBoardProposal): { path: string; name: string }[] {
  const { action, context } = proposal;
  const paths: string[] = [];
  const add = (path: string | null | undefined) => { if (path && !paths.includes(path)) paths.push(path); };
  if (action.kind === "replan_mission") {
    add(action.projectPath);
    const mission = missionStore.getMission(action.missionId);
    for (const change of action.changes ?? []) add(mission?.plan.tasks.find((item) => item.taskId === change.taskId)?.projectPath);
  } else if ("projectPath" in action && action.projectPath) {
    add(action.projectPath);
  } else if ("taskId" in action) {
    const task = tasks.get(action.taskId);
    add(task ? ownerProjectOf(task.workdir, { fresh: true }) : null);
  }
  add(context.projectPath);
  return paths.map((path) => ({ path, name: projects.get(path)?.name ?? path }));
}

function enrichProposalMetadata(proposal: HeadBoardProposal): HeadBoardProposal {
  return { ...enrichOne(proposal), affectedProjects: affectedProjectsOf(proposal) };
}

function editPreviewOf(proposal: HeadBoardProposal): HeadBoardEditPreview | null {
  if (proposal.action.kind !== "edit") return null;
  const rawAction = proposal.action as unknown as Record<string, unknown>;
  const task = tasks.get(proposal.action.taskId);
  const currentTitle = task ? redactSecrets(task.title) : null;
  const currentDescription = task ? redactSecrets(task.prompt) : null;
  const nextTitle = typeof rawAction.title === "string" && rawAction.title.trim().length > 0 ? rawAction.title : null;
  const unsafeBlank = hasUnsafeBlankDescriptionField(rawAction);
  const rawDesc = !unsafeBlank
    ? (typeof rawAction.description === "string" && rawAction.description.trim().length > 0
      ? rawAction.description
      : (typeof rawAction.prompt === "string" && rawAction.prompt.trim().length > 0 ? rawAction.prompt : null))
    : null;
  const descriptionStatus: HeadBoardEditPreview["descriptionStatus"] = unsafeBlank
    ? "unsafe-blank"
    : rawDesc !== null && (proposal.status !== "pending" || currentDescription === null || rawDesc !== currentDescription)
      ? "updated"
      : "unchanged";
  const titleChanged = nextTitle !== null && (
    proposal.status === "pending"
      ? (currentTitle === null ? true : nextTitle !== currentTitle)
      : (descriptionStatus !== "updated" || (currentTitle !== null && nextTitle !== currentTitle))
  );
  return {
    taskId: proposal.action.taskId,
    currentTitle,
    nextTitle,
    titleChanged,
    currentDescription,
    nextDescription: descriptionStatus === "updated" ? rawDesc : null,
    descriptionStatus,
  };
}

function enrichOne(proposal: HeadBoardProposal): HeadBoardProposal {
  const { action } = proposal;
  const editPreview = editPreviewOf(proposal);
  let permissions = "None (draft only)";
  let specialistName: string | null = "employeeName" in action ? (action.employeeName ?? null) : null;
  let provider: string | null = null;
  let policy = "Supervised board policy";
  let sideEffects = "Updates project board.";

  switch (action.kind) {
    case "replan_mission":
      return { ...proposal, missionResource: action.proposalId ? getMissionResourceProposal(action.missionId, action.proposalId) : null };
    case "create":
      permissions = "None (draft creation in Backlog)";
      policy = "Supervised backlog policy";
      sideEffects = "Creates a draft task in Backlog. No specialist runs.";
      break;
    case "edit":
      permissions = "None (task metadata modification)";
      policy = "Supervised edit policy";
      if (editPreview?.descriptionStatus === "unsafe-blank") {
        sideEffects = "Blocked: stored edit proposal contains a blank description that would erase the task prompt.";
      } else if (editPreview?.titleChanged && editPreview.descriptionStatus === "updated") {
        sideEffects = "Updates task title and description.";
      } else if (editPreview?.descriptionStatus === "updated") {
        sideEffects = "Updates task description only. Title stays unchanged.";
      } else {
        sideEffects = "Updates task title only. Description stays unchanged.";
      }
      break;
    case "prioritize":
      permissions = "None (board scheduling priority)";
      policy = "Supervised scheduling policy";
      sideEffects = `Updates task priority to ${action.priority}.`;
      break;
    case "admit":
      permissions = "Owner Backlog admission gate";
      policy = "Supervised intake policy";
      sideEffects = "Moves task from Backlog to Inbox for specialist triage.";
      break;
    case "stage_ready":
      permissions = "Project lifecycle admission check";
      policy = "Supervised ready stage policy";
      sideEffects = "Moves task to Ready for execution review.";
      break;
    case "assign":
      permissions = "None (specialist assignment)";
      policy = "Supervised assignment policy";
      sideEffects = `Assigns specialist ${action.employeeName} to task.`;
      break;
    case "plan_execution":
      permissions = "Read the registered project. A task-owned workspace write needs a separate Owner approval for operation developer-execution, scope task-staging. Full access is not included.";
      provider = `${action.harnessId}${action.model ? ` / ${action.model}` : ""}`;
      policy = "Supervised execution plan";
      sideEffects = "Records an execution review. A task-owned directory is created only after that approval. The specialist is not started.";
      break;
    case "execute":
      permissions = `Task-isolated workspace execution (${action.mode ?? "supervised"})`;
      provider = action.harnessId ? `${action.harnessId}${action.model ? ` / ${action.model}` : ""}` : null;
      policy = "Supervised worker execution (isolated worktree, bounded run)";
      sideEffects = "Launches assigned specialist to implement task in an isolated workspace.";
      break;
    case "request_qc":
      permissions = "Read-only independent QC review";
      provider = action.reviewerHarness ? `${action.reviewerHarness}${action.reviewerModel ? ` / ${action.reviewerModel}` : ""}` : null;
      policy = "Independent QC policy (1 round, PASS/CHANGES_REQUESTED/BLOCKED)";
      sideEffects = "Launches independent AI reviewer to inspect implementation.";
      break;
    case "rework":
      permissions = "Rework lifecycle gate";
      policy = "Supervised rework policy";
      sideEffects = "Returns task to Ready for another implementation attempt.";
      break;
    case "complete":
      permissions = "Owner final acceptance & QC sign-off";
      policy = "Evidence-gated Owner acceptance policy";
      sideEffects = "Marks task Done and acknowledges QC verdict.";
      break;
  }

  const rawAction = action as Record<string, unknown>;
  return {
    ...proposal,
    ...(editPreview ? { editPreview } : {}),
    permissions: (rawAction.permissions as string) ?? permissions,
    specialistName: specialistName ?? (rawAction.specialistName as string) ?? null,
    provider: provider ?? (rawAction.provider as string) ?? null,
    policy: (rawAction.policy as string) ?? policy,
    sideEffects: (rawAction.sideEffects as string) ?? sideEffects,
    result: (rawAction.result as Record<string, unknown>) ?? null,
  };
}

const view = (row: Row): HeadBoardProposal => {
  const base: HeadBoardProposal = {
    messageId: row.message_id,
    context: JSON.parse(row.context_json),
    action: JSON.parse(row.action_json),
    status: row.status,
    taskId: row.task_id,
    error: row.error,
  };
  return enrichProposalMetadata(base);
};

export function saveHeadBoardDraft(messageId: string, context: HeadScopeSnapshot, action: HeadBoardAction): void {
  const now = Date.now();
  let finalContext = context;
  if (action.kind !== "replan_mission" && !finalContext.projectPath) {
    // A company- or cluster-scoped turn that proposes for one project is settled against that project, so the
    // proposal names it and approval re-checks its ownership and cluster membership like any project proposal.
    const target = "projectPath" in action && action.projectPath ? action.projectPath
      : "taskId" in action ? ((t) => (t ? ownerProjectOf(t.workdir, { fresh: true }) : null))(tasks.get(action.taskId)) : null;
    const resolved = target ? resolveHeadScope({ kind: "project", path: target }, "canonical") : null;
    if (resolved?.ok) finalContext = resolved.value;
  }
  let error: string | null = null;
  if (action.kind === "edit") {
    const checked = validateStoredEditAction(action as unknown as Record<string, unknown>);
    if (!checked.ok) error = checked.error;
  }
  if (action.kind === "replan_mission") {
    try {
      const proposal = prepareMissionResourceProposal(action.missionId, action.changes?.length
        ? { reason: action.reason, changes: action.changes, allocation: action.allocation }
        : { taskId: action.taskId, role: action.role, resource: action.resource, reason: action.reason, allocation: action.allocation }, messageId);
      action = { ...action, proposalId: proposal.id, digest: proposal.digest };
    } catch (problem) { error = (problem as Error).message; }
  }
  db.run(
    "INSERT INTO head_board_proposals (message_id,context_json,action_json,status,created_at,updated_at,error) VALUES (?,?,?,?,?,?,?)",
    [messageId, JSON.stringify(finalContext), JSON.stringify(action), error ? "failed" : "pending", now, now, error],
  );
}

function settle(id: string, status: "applied" | "failed" | "rejected", taskId: string | null, error: string | null = null, actionUpdate?: HeadBoardAction) {
  if (actionUpdate) {
    db.run(
      "UPDATE head_board_proposals SET status=?, task_id=?, error=?, action_json=?, updated_at=? WHERE message_id=?",
      [status, taskId, error, JSON.stringify(actionUpdate), Date.now(), id],
    );
  } else {
    db.run(
      "UPDATE head_board_proposals SET status=?, task_id=?, error=?, updated_at=? WHERE message_id=?",
      [status, taskId, error, Date.now(), id],
    );
  }
}

export function headBoardProposals(messageIds: ReadonlySet<string>): HeadBoardProposal[] {
  // A create may have stopped after inserting its reserved task. Inspect only;
  // no interrupted approval is executed or replayed on boot or state reads.
  db.transaction(() => {
    for (const { message_id } of db.query<{ message_id: string }, []>(
      "SELECT message_id FROM head_board_proposals WHERE status='applying'",
    ).all()) if (!applying.has(message_id)) reconcileInterrupted(message_id);
  }).immediate();
  return db.query<Row, []>(`SELECT b.* FROM head_board_proposals b
    JOIN portfolio_manager_messages m ON m.id=b.message_id ORDER BY m.seq`).all()
    .filter((row) => messageIds.has(row.message_id)).map(view);
}

function reconcileInterrupted(id: string): void {
  const row = rowFor(id);
  if (!row || row.status !== "applying" || applying.has(id)) return;
  const action = JSON.parse(row.action_json) as HeadBoardAction;
  if (action.kind === "create" && tasks.get(id)) settle(id, "applied", id);
  else settle(id, "failed", null, "The app closed before this approval completed. Review the board before proposing it again.");
}

class BoardConflict extends Error {}
class BoardNeedsDecision extends Error {}

function readBoardDecision(body: Record<string, unknown>, decision: "approve" | "reject"): { ok: true; grant: TaskStagingGrant | null } | { ok: false; error: string } {
  const keys = Object.keys(body);
  if (body.confirm !== true || keys.some((key) => key !== "confirm" && key !== "executionPermission" && key !== "resourceDigest")) {
    return { ok: false, error: "Explicit Owner confirmation is required." };
  }
  if (!Object.hasOwn(body, "executionPermission")) return { ok: true, grant: null };
  if (decision === "reject") return { ok: false, error: "A rejected proposal cannot carry an execution permission." };
  const parsed = parseTaskStagingGrant(body.executionPermission);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, grant: parsed.grant };
}

export async function resolveHeadBoardProposal(id: string, body: Record<string, unknown>, decision: "approve" | "reject"): Promise<Result<HeadBoardProposal>> {
  const decisionBody = readBoardDecision(body, decision);
  if (!decisionBody.ok) return fail(400, decisionBody.error);
  const grant = decisionBody.grant;
  const initial = db.transaction(() => {
    reconcileInterrupted(id);
    const row = rowFor(id);
    if (!row) return fail(404, "Board proposal not found.");
    const proposal = view(row);
    if (proposal.action.kind === "replan_mission") {
      const { action, context } = proposal;
      if (grant || !action.proposalId || body.resourceDigest !== action.digest || typeof body.resourceDigest !== "string") {
        return fail(409, "Confirm the exact mission resource digest.");
      }
      const current = resolveHeadScope(context.scope);
      const mission = missionStore.getMission(action.missionId);
      const task = tasks.get(action.taskId);
      const allowedProjects = current.ok ? current.value.scope.kind === "workspace" ? null
        : current.value.scope.kind === "cluster" ? new Set(db.query<{ project_path: string }, [string]>(
          "SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ?",
        ).all(current.value.scope.id).map(row => row.project_path)) : new Set([current.value.projectPath]) : new Set();
      const stageIds = action.changes?.map(change => change.taskId) ?? [action.taskId];
      const stagesInScope = stageIds.every(stageId => {
        const stageTask = tasks.get(stageId);
        const stagePlan = mission?.plan.tasks.find(item => item.taskId === stageId);
        return !!stageTask && !!stagePlan && taskInProject(stageTask, stagePlan.projectPath, { fresh: true }) &&
          (!allowedProjects || allowedProjects.has(stagePlan.projectPath));
      });
      if (decision === "approve" && (!current.ok || !sameHeadScope(context, current.value) || !mission || !task ||
        !stagesInScope || allowedProjects && !mission.projects.every(path => allowedProjects.has(path)) ||
        context.scope.kind === "task" && context.scope.id !== action.taskId)) return fail(409, "The mission or task scope changed.");
      try {
        settleMissionResourceProposal(action.missionId, action.proposalId, body.resourceDigest, decision, id);
        settle(id, decision === "approve" ? "applied" : "rejected", action.taskId);
        return { ok: true as const, value: view(rowFor(id)!) };
      } catch (error) { return fail(409, (error as Error).message); }
    }
    if (Object.hasOwn(body, "resourceDigest")) return fail(400, "This action does not take a resource digest.");
    if (proposal.status !== "pending") {
      return proposal.status === (decision === "approve" ? "applied" : "rejected")
        ? { ok: true as const, value: proposal }
        : fail(409, "This board proposal is no longer pending.");
    }
    if (decision === "reject") {
      settle(id, "rejected", null);
      return { ok: true as const, value: view(rowFor(id)!) };
    }
    if (proposal.action.kind === "edit") {
      const checked = validateStoredEditAction(proposal.action as unknown as Record<string, unknown>);
      if (!checked.ok) {
        return fail(409, checked.error);
      }
    }
    db.run("UPDATE head_board_proposals SET status='applying',updated_at=? WHERE message_id=? AND status='pending'", [Date.now(), id]);
    return { ok: true as const, value: { ...proposal, status: "applying" as const }, claimed: true };
  }).immediate();
  if (!initial.ok || initial.value.status !== "applying" || !("claimed" in initial)) return initial;
  const { action, context } = initial.value;
  const path = context.projectPath!;
  applying.add(id);
  const checkScope = () => {
    const current = resolveHeadScope(context.scope);
    const project = projects.get(path);
    if (!current.ok || !sameHeadScope(context, current.value) || !project) {
      throw new BoardConflict("The proposal's project or cluster changed. Ask Head of PM to prepare it again.");
    }
  };
  try {
    checkScope();
    if (grant && action.kind !== "plan_execution") throw new BoardConflict("This board action does not take an execution permission. Nothing was changed.");
    if (action.kind === "create") {
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new BoardConflict("The registered project folder is unavailable.");
      const capability = await gitWorkingTreeCapability(path);
      if (capability.kind === "unknown") throw new BoardConflict("Could not verify the project's Git capability.");
      const created = await createTask({
        title: action.title, prompt: action.description, workdir: path,
        isolation: capability.kind === "git" ? "worktree" : "none", column: "backlog",
      }, { reservedTask: { id, beforeInsert: checkScope } });
      if ("error" in created) throw new BoardConflict(created.error);
      settle(id, "applied", created.task.id);
    } else if (action.kind === "edit") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) {
          throw new BoardConflict("The task changed or is no longer in this project.");
        }
        const checked = validateStoredEditAction(action as unknown as Record<string, unknown>);
        if (!checked.ok) throw new BoardConflict(checked.error);
        const patch: Partial<typeof task> = {};
        if (checked.title && checked.title !== task.title) patch.title = checked.title;
        if (checked.description !== undefined) patch.prompt = checked.description;
        if (Object.keys(patch).length > 0) tasks.update(task.id, patch);
        settle(id, "applied", task.id);
      }).immediate();
    } else if (action.kind === "admit") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
        if (!canAdmitTaskToInbox(task)) throw new BoardConflict("Only Backlog tasks may be admitted.");
        const result = admitTaskToInbox(task.id, path);
        if (!result.ok) throw new BoardConflict(result.error);
        settle(id, "applied", task.id);
      }).immediate();
    } else if (action.kind === "stage_ready") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
        const lifecycle = checkProjectLaunchAdmission(path);
        if (!lifecycle.allowed) throw new BoardConflict(lifecycle.reason!);
        moveTaskColumn(task.id, "ready");
        settle(id, "applied", task.id);
      }).immediate();
    } else if (action.kind === "assign") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
        if ((task.column !== "inbox" && task.column !== "ready") || task.pipelineId) throw new BoardConflict("Only Inbox or Ready specialist tasks may be assigned here.");
        const worker = db.query<{ name: string }, [string]>("SELECT name FROM ai_employees WHERE id=?").get(action.employeeId);
        if (!worker || redactSecrets(worker.name) !== action.employeeName) throw new BoardConflict("The specialist changed.");
        new AssignmentCore(db).assign(task.id, action.employeeId);
        settle(id, "applied", task.id);
      }).immediate();
    } else if (action.kind === "prioritize") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
        const result = updateScheduling(path, task.id, { priority: action.priority });
        if (!result.ok) throw new BoardConflict(result.error);
        settle(id, "applied", task.id);
      }).immediate();
    } else if (action.kind === "plan_execution") {
      checkScope();
      const task = tasks.get(action.taskId);
      if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
      if (action.employeeId && new AssignmentCore(db).forTask(task.id)?.employeeId !== action.employeeId) {
        throw new BoardConflict("The task is no longer assigned to the proposed specialist.");
      }
      const lifecycle = checkProjectLaunchAdmission(path);
      if (!lifecycle.allowed) throw new BoardConflict(lifecycle.reason!);
      let review;
      try {
        review = await reviewEmployeeExecution({
          taskId: task.id,
          harnessId: action.harnessId,
          model: action.model,
          effort: action.effort,
          ...(grant ? { executionPermission: grant } : {}),
        });
      } catch (error) {
        if (error instanceof EmployeeRunError) throw new BoardNeedsDecision(error.message);
        throw error;
      }
      const permissionIssue = (code: string) => code === "task-staging-required" || code === "task-staging-refused" || code === "permission-scope";
      const otherIssue = review.blockingErrors.find((item) => !permissionIssue(item.code));
      if (otherIssue) throw new BoardConflict(otherIssue.message);
      const needsDecision = review.blockingErrors.find((item) => item.code !== "task-staging-required") ?? review.blockingErrors[0];
      if (needsDecision) throw new BoardNeedsDecision(needsDecision.message);
      if (!review.attempt) throw new BoardConflict("Execution plan preflight could not be prepared.");
      routerV2Service.recordDecision({
        projectPath: path,
        taskId: task.id,
        role: "developer",
        policyPreset: routerV2Service.getPolicy(path).preset,
        quotaPolicy: routerV2Service.getPolicy(path).quotaPolicy,
        autonomyMode: routerV2Service.getPolicy(path).autonomyMode,
        selectedHarnessId: action.harnessId,
        selectedModelId: action.model ?? task.model ?? "gpt-6.1-sol",
        selectedAccountId: null,
        selectedMode: review.attempt.requested.mode,
        decisionType: "automatic",
        planDigest: null,
        evaluation: {
          candidateId: JSON.stringify([action.harnessId, null, action.model, action.mode]),
          harnessId: action.harnessId,
          harnessLabel: action.harnessId,
          kind: action.harnessId,
          accountId: null,
          accountLabel: null,
          modelId: action.model ?? task.model ?? "gpt-6.1-sol",
          modelLabel: action.model ?? task.model ?? "gpt-6.1-sol",
          mode: review.attempt.requested.mode,
          modeLabel: action.mode ?? "auto",
          role: "developer",
          eligible: true,
          readiness: "verified-ready",
          eliminationReasons: [],
          scores: {
            quality: { score: 85, evidence: "configured", detail: "Head proposal execution" },
            cost: { score: 75, evidence: "estimated", detail: "Estimated standard cost" },
            latency: { score: 80, evidence: "verified", detail: "Verified latency" },
            quota: { score: 80, evidence: "unknown", detail: "Permissive quota" },
            history: { score: 80, evidence: "unknown", detail: "Cold-start", runCount: 0 },
            preferenceBonus: 0,
            totalScore: 82,
          },
          selectionReasons: ["Head of PM proposed specialist execution plan"],
          warnings: [],
        },
        actualAttribution: null,
      });
      settle(id, "applied", task.id, null, { ...action, result: { attemptId: review.attempt.id, status: review.attempt.status } });
    } else if (action.kind === "execute") {
      checkScope();
      const task = tasks.get(action.taskId);
      if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
      const lifecycle = checkProjectLaunchAdmission(path);
      if (!lifecycle.allowed) throw new BoardConflict(lifecycle.reason!);
      if (task.column === "inbox") moveTaskColumn(task.id, "ready");
      const freshTask = tasks.get(task.id);
      if (!freshTask || freshTask.column !== "ready") throw new BoardConflict("Task must be in Ready before starting execution.");

      let attemptId = action.attemptId;
      let revision = 1;
      if (attemptId) {
        const attempt = db.query<{ id: string; revision: number; status: string }, [string]>("SELECT id, revision, status FROM employee_executions WHERE id=?").get(attemptId);
        if (!attempt) throw new BoardConflict("Employee execution attempt not found.");
        revision = attempt.revision;
      } else {
        const harnessId = action.harnessId || freshTask.agent || "codex";
        const review = await reviewEmployeeExecution({
          taskId: freshTask.id,
          harnessId,
          model: action.model,
          effort: action.effort,
        });
        if (review.blockingErrors.length > 0) throw new BoardConflict(review.blockingErrors[0]!.message);
        if (!review.attempt) throw new BoardConflict("Employee execution could not be prepared.");
        attemptId = review.attempt.id;
        revision = review.attempt.revision;
      }
      const started = await startEmployeeExecution(attemptId, {
        revision,
        confirm: true,
        acknowledgeUsage: true,
      });
      settle(id, "applied", freshTask.id, null, { ...action, result: { attemptId, status: started.attempt?.status ?? "starting" } });
    } else if (action.kind === "request_qc") {
      checkScope();
      const task = tasks.get(action.taskId);
      if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
      const lifecycle = checkProjectLaunchAdmission(path);
      if (!lifecycle.allowed) throw new BoardConflict(lifecycle.reason!);
      const harnessId = action.reviewerHarness || "codex";
      const model = action.reviewerModel || "gpt-6.1-sol";
      const { review } = prepareQcReview({
        taskId: task.id,
        reviewerHarness: harnessId,
        reviewerModel: model,
        reviewerEmployeeId: action.reviewerEmployeeId,
        reviewerRoleSlug: action.reviewerRoleSlug,
      });
      const qcRun = await startQcReview(review.id);
      if ("error" in qcRun) throw new BoardConflict(qcRun.error);
      settle(id, "applied", task.id, null, { ...action, result: { reviewId: review.id, runId: qcRun.runId } });
    } else if (action.kind === "rework") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
        moveTaskColumn(task.id, "ready");
        settle(id, "applied", task.id);
      }).immediate();
    } else if (action.kind === "complete") {
      db.transaction(() => {
        checkScope();
        const task = tasks.get(action.taskId);
        if (!task || task.archivedAt != null || !taskInProject(task, path, { fresh: true })) throw new BoardConflict("The task changed or is no longer in this project.");
        const block = assertCanMoveTaskToDone(task);
        if (block) throw new BoardConflict(block);
        if (task.qcState?.awaitingOwnerApproval && task.qcState.latestVerdict === "PASS") {
          acknowledgeQcOwnerReview(task.id);
        }
        moveTaskColumn(task.id, "done");
        settle(id, "applied", task.id);
      }).immediate();
      void import("./pm-orchestrated-batch.ts").then((batch) => batch.onOrchestratedOwnerDone(action.taskId));
    }
  } catch (error) {
    if (error instanceof BoardNeedsDecision) {
      db.run(
        "UPDATE head_board_proposals SET status='pending', error=?, updated_at=? WHERE message_id=?",
        [redactSecrets(error.message).slice(0, 400), Date.now(), id],
      );
    } else {
      const detail = error instanceof BoardConflict || error instanceof AssignmentCoreError
        ? redactSecrets(error.message).slice(0, 400) : "The board action could not be applied.";
      settle(id, "failed", null, detail);
    }
  } finally {
    applying.delete(id);
  }
  return { ok: true, value: view(rowFor(id)!) };
}
