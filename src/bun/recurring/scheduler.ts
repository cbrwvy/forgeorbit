/**
 * Durable recurring-task materialization service and scheduler (FO-KANBAN-RECURRING01).
 *
 * Uses the existing task creation service (`prepareTaskCreation`), existing
 * UTC availability field (`availableFromUtc`), existing smart queue / hands-off
 * admission (`submitTask`), existing project lifecycle (`checkProjectLaunchAdmission`),
 * and existing Emergency Stop (`autonomyPolicyStore.readEmergency()`).
 *
 * Does NOT create a second AI execution engine.
 *
 * Scheduling granularity:
 *  - Exact `setTimeout` wake for the earliest active `next_due_ms` when <= 60s away.
 *  - Capped at 60s max sleep interval so macOS sleep/wake or system clock shifts
 *    are reconciled promptly without scanning historical tasks.
 *  - Reacts immediately to template create/edit/resume, project resume, and task
 *    completion (`column -> done` for completion-relative templates).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AssignmentCore } from "../assignment-core.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { agentProfiles, dataDir, db, preferences, projects, tasks } from "../db.ts";
import { submitTask as submitHandsoffTask } from "../handsoff/driver.ts";
import { notifySmartQueueChanged, onSmartQueueChange } from "../handsoff/queue-events.ts";
import { handsoffStore } from "../handsoff/store.ts";
import { prepareTaskCreation, subscribeGlobal } from "../orchestrator.ts";
import { checkProjectLaunchAdmission, resolveRegisteredProjectPath } from "../project-lifecycle.ts";
import { ownerProjectOf, taskInProject } from "../project-ownership.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { taskAvailabilityNow } from "../task-availability.ts";
import { normalizeAccessMode } from "../../shared/execution/access-mode.ts";
import {
  buildCompletionOccurrenceKey,
  buildManualOccurrenceKey,
  buildScheduledOccurrenceKey,
  computeCompletionNextDueUtc,
  computeFirstDueUtc,
  computeNextNominalUtc,
  formatOccurrenceTitle,
  normalizeTemplateUrgency,
  planDueOccurrences,
  RECURRENCE_LIMITS,
  validateRecurringPolicies,
  validateScheduleConfig,
  type CreateRecurringTemplateInput,
  type RecurringOccurrence,
  type RecurringScheduleConfig,
  type RecurringSkipReason,
  type RecurringTemplate,
  type RecurringTemplateTaskConfig,
  type RecurringTemplateView,
  type UpdateRecurringTemplateInput,
} from "../../shared/recurring-tasks.ts";
import type { TaskType } from "../../shared/types.ts";
import { RecurringError } from "./errors.ts";
import { recurringStore } from "./store.ts";

export const RECURRING_MAX_WAKE_INTERVAL_MS = 60_000;
const RESTORE_ACK_PREF_KEY = "recurring:lastRestoreAck";

let clockOverride: (() => number) | null = null;
/** Deterministic clock seam for tests; defaults to `taskAvailabilityNow()` so one test clock drives both. */
export function setRecurringClockForTest(next: (() => number) | null): void {
  clockOverride = next;
}
export function recurringNow(): number {
  return clockOverride ? clockOverride() : taskAvailabilityNow();
}

const VALID_TASK_TYPES = new Set<TaskType>(["task", "bug", "spike"]);

/** Per-template serialized promise chains to guarantee concurrent ticks never double-materialize. */
const templateChains = new Map<string, Promise<void>>();

function withTemplateLock<T>(templateId: string, fn: () => Promise<T>): Promise<T> {
  const prev = templateChains.get(templateId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const tail = next.then(() => undefined, () => undefined);
  templateChains.set(templateId, tail);
  void tail.finally(() => {
    if (templateChains.get(templateId) === tail) templateChains.delete(templateId);
  });
  return next;
}

function announceRecurring(projectPath: string, templateId: string | null, action: string): void {
  try {
    broadcastAppEvent({
      type: "recurring",
      projectPath,
      templateId,
      action,
      ts: recurringNow(),
    });
  } catch {
    // Next poll/read catches up.
  }
}

function sanitizeTemplateConfig(raw: unknown, projectPath: string): RecurringTemplateTaskConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const out: RecurringTemplateTaskConfig = {};

  if (typeof rec.acceptanceCriteria === "string") {
    const trimmed = rec.acceptanceCriteria.trim();
    if (trimmed.length > RECURRENCE_LIMITS.maxAcceptanceChars) {
      throw new RecurringError("Acceptance criteria exceeds maximum length.", 400, "invalid-acceptance");
    }
    if (trimmed) out.acceptanceCriteria = trimmed;
  }

  if (Array.isArray(rec.labels)) {
    const labels: string[] = [];
    for (const item of rec.labels) {
      if (typeof item !== "string") continue;
      const clean = item.trim().slice(0, RECURRENCE_LIMITS.maxLabelChars);
      if (clean && !labels.includes(clean)) labels.push(clean);
      if (labels.length >= RECURRENCE_LIMITS.maxLabels) break;
    }
    if (labels.length > 0) out.labels = labels;
  }

  if (typeof rec.agent === "string" && rec.agent.trim()) out.agent = rec.agent.trim();
  if (typeof rec.mode === "string" && rec.mode.trim()) out.mode = rec.mode.trim();
  if (typeof rec.model === "string" && rec.model.trim()) out.model = rec.model.trim();
  else if (rec.model === null) out.model = null;
  if (typeof rec.effort === "string" && rec.effort.trim()) out.effort = rec.effort.trim();
  else if (rec.effort === null) out.effort = null;
  if (typeof rec.fast === "boolean") out.fast = rec.fast;
  if (typeof rec.maxMode === "boolean") out.maxMode = rec.maxMode;

  if (rec.isolation === "worktree" || rec.isolation === "none") {
    out.isolation = rec.isolation;
  }
  if (rec.accessMode !== undefined && rec.accessMode !== null) {
    const normalized = normalizeAccessMode(rec.accessMode);
    if (!normalized) {
      throw new RecurringError(`Invalid accessMode "${String(rec.accessMode)}".`, 400, "invalid-access-mode");
    }
    out.accessMode = normalized;
  }
  if (typeof rec.baseRef === "string" && rec.baseRef.trim()) out.baseRef = rec.baseRef.trim();

  if (typeof rec.agentProfileId === "string" && rec.agentProfileId.trim()) {
    const pid = rec.agentProfileId.trim();
    if (!agentProfiles.get(pid)) {
      throw new RecurringError(`Unknown agent profile "${pid}".`, 400, "invalid-agent-profile");
    }
    out.agentProfileId = pid;
  }

  if (typeof rec.assignedEmployeeId === "string" && rec.assignedEmployeeId.trim()) {
    const eid = rec.assignedEmployeeId.trim();
    const emp = db
      .query<{ id: string; project_path: string | null; status: string; archived_at: number | null }, [string]>(
        `SELECT id, project_path, status, archived_at FROM ai_employees WHERE id = ?`,
      )
      .get(eid);
    if (!emp || emp.archived_at != null || emp.status !== "active" || emp.project_path !== projectPath) {
      throw new RecurringError("Assigned employee must be an active employee of this project.", 400, "invalid-employee");
    }
    out.assignedEmployeeId = eid;
  }

  if (typeof rec.requestedAccountId === "string" && rec.requestedAccountId.trim()) {
    out.requestedAccountId = rec.requestedAccountId.trim().slice(0, 128);
  }

  if (rec.initialColumn === "backlog" || rec.initialColumn === "ready") {
    out.initialColumn = rec.initialColumn;
  }

  if (rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)) {
    const cleanMeta: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(rec.metadata as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      const key = k.trim().slice(0, 64);
      const val = v.trim().slice(0, 240);
      if (key && val) {
        cleanMeta[key] = val;
        count += 1;
        if (count >= 16) break;
      }
    }
    if (count > 0) out.metadata = cleanMeta;
  }

  return out;
}

function buildOccurrencePrompt(template: RecurringTemplate): string {
  const parts: string[] = [template.prompt];
  if (template.templateConfig.acceptanceCriteria) {
    parts.push(`\n\nAcceptance criteria:\n${template.templateConfig.acceptanceCriteria}`);
  }
  if (template.templateConfig.labels && template.templateConfig.labels.length > 0) {
    parts.push(`\n\nLabels: ${template.templateConfig.labels.join(", ")}`);
  }
  return parts.join("");
}

function resolveProject(rawProjectPath: unknown): string {
  const resolved = resolveRegisteredProjectPath(rawProjectPath);
  if (!resolved.ok) {
    throw new RecurringError(resolved.error, resolved.status, "invalid-project");
  }
  return resolved.projectPath;
}

/* ---------------------------------------------------------------------------- public template CRUD */

export async function createRecurringTemplate(
  rawInput: CreateRecurringTemplateInput,
): Promise<{ template: RecurringTemplateView; generatedTaskIds: string[] }> {
  const projectPath = resolveProject(rawInput.projectPath);
  const title = typeof rawInput.title === "string" ? rawInput.title.trim() : "";
  if (!title || title.length > RECURRENCE_LIMITS.maxTitleChars) {
    throw new RecurringError(
      `Title is required and must be at most ${RECURRENCE_LIMITS.maxTitleChars} characters.`,
      400,
      "invalid-title",
    );
  }
  const prompt = typeof rawInput.prompt === "string" ? rawInput.prompt.trim() : "";
  if (!prompt || prompt.length > RECURRENCE_LIMITS.maxPromptChars) {
    throw new RecurringError("Task description / prompt is required.", 400, "invalid-prompt");
  }
  const urgency = normalizeTemplateUrgency(rawInput.urgency);
  const taskType: TaskType =
    rawInput.taskType && VALID_TASK_TYPES.has(rawInput.taskType) ? rawInput.taskType : "task";

  const schedRes = validateScheduleConfig({
    recurrenceType: rawInput.recurrenceType,
    interval: rawInput.interval,
    intervalUnit: rawInput.intervalUnit,
    weekdays: rawInput.weekdays,
    monthlyMode: rawInput.monthlyMode,
    dayOfMonth: rawInput.dayOfMonth,
    missingDayPolicy: rawInput.missingDayPolicy,
    startDateUtc: rawInput.startDateUtc,
    startTimeUtc: rawInput.startTimeUtc,
    endDateUtc: rawInput.endDateUtc,
    maxOccurrences: rawInput.maxOccurrences,
  });
  if (!schedRes.ok) throw new RecurringError(schedRes.error, 400, schedRes.code);

  const policyRes = validateRecurringPolicies({
    submissionMode: rawInput.submissionMode,
    overlapPolicy: rawInput.overlapPolicy,
    missedPolicy: rawInput.missedPolicy,
    catchUpLimit: rawInput.catchUpLimit,
  });
  if (!policyRes.ok) throw new RecurringError(policyRes.error, 400, policyRes.code);

  const templateConfig = sanitizeTemplateConfig(rawInput.templateConfig, projectPath);
  const now = recurringNow();
  const firstDueUtc = computeFirstDueUtc(schedRes.value);
  const firstDueMs = firstDueUtc ? Date.parse(firstDueUtc) : null;

  const created = recurringStore.insertTemplate({
    id: randomUUID(),
    projectPath,
    status: "active",
    title,
    prompt,
    urgency,
    taskType,
    templateConfig,
    recurrenceType: schedRes.value.recurrenceType,
    schedule: schedRes.value,
    submissionMode: policyRes.value.submissionMode,
    overlapPolicy: policyRes.value.overlapPolicy,
    missedPolicy: policyRes.value.missedPolicy,
    catchUpLimit: policyRes.value.catchUpLimit,
    nextDueUtc: firstDueUtc,
    nextDueMs: firstDueMs,
    lastNominalUtc: null,
    occurrenceSeq: 0,
    lastCompletedTaskId: null,
    lastCompletedAt: null,
    createdAt: now,
    updatedAt: now,
    stoppedAt: null,
  });

  announceRecurring(projectPath, created.id, "created");

  // Only materialize immediately when the Owner's selected start time is already due (`firstDueMs <= now`).
  let generatedTaskIds: string[] = [];
  if (firstDueMs != null && firstDueMs <= now) {
    const res = await reconcileRecurringTemplate(created.id);
    generatedTaskIds = res.generatedTaskIds;
  }
  armRecurringWakeTimer();

  return {
    template: recurringStore.getTemplateView(created.id)!,
    generatedTaskIds,
  };
}

/**
 * Explicitly convert an eligible ordinary task into a recurring template.
 * Refuses running, done, archived, pipeline, or already-recurring tasks.
 * Never copies execution state, runs, reviews, QC evidence, working copies, or grants.
 */
export async function convertTaskToRecurringTemplate(
  taskId: string,
  scheduleInput: Omit<CreateRecurringTemplateInput, "projectPath" | "title" | "prompt" | "urgency" | "taskType" | "templateConfig"> & {
    title?: string;
    prompt?: string;
    urgency?: number;
    taskType?: TaskType;
    templateConfig?: RecurringTemplateTaskConfig;
  },
): Promise<{ template: RecurringTemplateView; generatedTaskIds: string[] }> {
  const task = tasks.get(taskId);
  if (!task) throw new RecurringError("Task not found.", 404, "not-found");
  if (task.archivedAt != null) {
    throw new RecurringError("Archived tasks cannot be converted into a recurring template.", 409, "task-archived");
  }
  if (task.pipelineId || task.pipelineParentId) {
    throw new RecurringError("Pipeline tasks cannot be converted into a recurring template.", 409, "task-pipeline");
  }
  if (task.recurringTemplateId) {
    throw new RecurringError("This task already belongs to a recurring template.", 409, "already-recurring");
  }
  if (task.column === "running" || task.column === "done") {
    throw new RecurringError(
      "Running or completed tasks cannot be converted into an active recurring schedule. Create a new recurring template instead.",
      409,
      "ineligible-task-state",
    );
  }
  const projectPath = ownerProjectOf(task.workdir, { fresh: true });
  if (!projectPath || !projects.get(projectPath) || !taskInProject(task, projectPath, { fresh: true })) {
    throw new RecurringError("Task must belong to a registered project.", 409, "invalid-project");
  }

  const assignment = new AssignmentCore(db).forTask(task.id);
  const inheritedConfig: RecurringTemplateTaskConfig = {
    agent: task.agent,
    mode: task.mode ?? undefined,
    model: task.model,
    effort: task.effort,
    fast: task.fast,
    maxMode: task.maxMode,
    isolation: task.isolation,
    accessMode: task.accessMode,
    baseRef: task.baseRef,
    agentProfileId: task.agentProfileId ?? null,
    assignedEmployeeId: assignment?.employeeId ?? null,
    ...(scheduleInput.templateConfig ?? {}),
  };

  return createRecurringTemplate({
    ...scheduleInput,
    projectPath,
    title: scheduleInput.title ?? task.title,
    prompt: scheduleInput.prompt ?? task.prompt,
    urgency: scheduleInput.urgency ?? task.urgency ?? 3,
    taskType: scheduleInput.taskType ?? task.taskType,
    templateConfig: inheritedConfig,
  });
}

/**
 * Edit a recurring template. Applies to FUTURE occurrences only; never mutates,
 * cancels, or resubmits already-generated tasks or historical evidence.
 */
export async function updateRecurringTemplate(
  templateId: string,
  patch: UpdateRecurringTemplateInput,
): Promise<RecurringTemplateView> {
  return withTemplateLock(templateId, async () => {
    const cur = recurringStore.getTemplate(templateId);
    if (!cur) throw new RecurringError("Recurring template not found.", 404, "not-found");
    if (cur.status === "stopped") {
      throw new RecurringError("Stopped recurring templates are archived and cannot be edited.", 409, "template-stopped");
    }

    const nextTitle = patch.title !== undefined ? patch.title.trim() : cur.title;
    if (!nextTitle || nextTitle.length > RECURRENCE_LIMITS.maxTitleChars) {
      throw new RecurringError(
        `Title is required and must be at most ${RECURRENCE_LIMITS.maxTitleChars} characters.`,
        400,
        "invalid-title",
      );
    }
    const nextPrompt = patch.prompt !== undefined ? patch.prompt.trim() : cur.prompt;
    if (!nextPrompt || nextPrompt.length > RECURRENCE_LIMITS.maxPromptChars) {
      throw new RecurringError("Task description / prompt is required.", 400, "invalid-prompt");
    }
    const nextUrgency = patch.urgency !== undefined ? normalizeTemplateUrgency(patch.urgency) : cur.urgency;
    const nextTaskType: TaskType =
      patch.taskType !== undefined
        ? VALID_TASK_TYPES.has(patch.taskType)
          ? patch.taskType
          : cur.taskType
        : cur.taskType;

    const scheduleChanged =
      patch.recurrenceType !== undefined ||
      patch.interval !== undefined ||
      patch.intervalUnit !== undefined ||
      patch.weekdays !== undefined ||
      patch.monthlyMode !== undefined ||
      patch.dayOfMonth !== undefined ||
      patch.missingDayPolicy !== undefined ||
      patch.startDateUtc !== undefined ||
      patch.startTimeUtc !== undefined ||
      patch.endDateUtc !== undefined ||
      patch.maxOccurrences !== undefined;

    const nextScheduleInput = {
      recurrenceType: patch.recurrenceType ?? cur.schedule.recurrenceType,
      interval: patch.interval ?? cur.schedule.interval,
      intervalUnit: patch.intervalUnit ?? cur.schedule.intervalUnit,
      weekdays: patch.weekdays !== undefined ? patch.weekdays : cur.schedule.weekdays,
      monthlyMode: patch.monthlyMode ?? cur.schedule.monthlyMode,
      dayOfMonth: patch.dayOfMonth ?? cur.schedule.dayOfMonth,
      missingDayPolicy: patch.missingDayPolicy ?? cur.schedule.missingDayPolicy,
      startDateUtc: patch.startDateUtc ?? cur.schedule.startDateUtc,
      startTimeUtc: patch.startTimeUtc ?? cur.schedule.startTimeUtc,
      endDateUtc: patch.endDateUtc !== undefined ? patch.endDateUtc : cur.schedule.endDateUtc,
      maxOccurrences: patch.maxOccurrences !== undefined ? patch.maxOccurrences : cur.schedule.maxOccurrences,
    };

    const schedRes = validateScheduleConfig(nextScheduleInput);
    if (!schedRes.ok) throw new RecurringError(schedRes.error, 400, schedRes.code);

    const policyRes = validateRecurringPolicies({
      submissionMode: patch.submissionMode ?? cur.submissionMode,
      overlapPolicy: patch.overlapPolicy ?? cur.overlapPolicy,
      missedPolicy: patch.missedPolicy ?? cur.missedPolicy,
      catchUpLimit: patch.catchUpLimit ?? cur.catchUpLimit,
    });
    if (!policyRes.ok) throw new RecurringError(policyRes.error, 400, policyRes.code);

    const nextConfig =
      patch.templateConfig !== undefined
        ? sanitizeTemplateConfig({ ...cur.templateConfig, ...patch.templateConfig }, cur.projectPath)
        : cur.templateConfig;

    const now = recurringNow();
    let nextDueUtc = cur.nextDueUtc;
    let nextDueMs = cur.nextDueMs;

    if (scheduleChanged) {
      const generatedCount = recurringStore.countGeneratedScheduled(cur.id);
      if (schedRes.value.maxOccurrences != null && generatedCount >= schedRes.value.maxOccurrences) {
        nextDueUtc = null;
        nextDueMs = null;
      } else if (schedRes.value.recurrenceType === "after_completion") {
        const unresolved = recurringStore.countUnresolvedOccurrences(cur.id);
        if (unresolved > 0) {
          nextDueUtc = null;
          nextDueMs = null;
        } else if (cur.lastCompletedAt != null) {
          nextDueUtc = computeCompletionNextDueUtc(schedRes.value, cur.lastCompletedAt, generatedCount);
          nextDueMs = nextDueUtc ? Date.parse(nextDueUtc) : null;
        } else {
          nextDueUtc = computeFirstDueUtc(schedRes.value);
          nextDueMs = nextDueUtc ? Date.parse(nextDueUtc) : null;
        }
      } else {
        // Compute next future occurrence relative to `max(startUtc, now)` so editing
        // a template never replays past timestamps as unintended catch-up.
        const startMs = Date.parse(schedRes.value.startUtc);
        const refMs = Math.max(startMs, now);
        nextDueUtc = computeNextNominalUtc(schedRes.value, refMs, { inclusive: true });
        nextDueMs = nextDueUtc ? Date.parse(nextDueUtc) : null;
      }
    }

    recurringStore.updateTemplate(cur.id, {
      title: nextTitle,
      prompt: nextPrompt,
      urgency: nextUrgency,
      taskType: nextTaskType,
      templateConfig: nextConfig,
      recurrenceType: schedRes.value.recurrenceType,
      schedule: schedRes.value,
      submissionMode: policyRes.value.submissionMode,
      overlapPolicy: policyRes.value.overlapPolicy,
      missedPolicy: policyRes.value.missedPolicy,
      catchUpLimit: policyRes.value.catchUpLimit,
      nextDueUtc,
      nextDueMs,
      updatedAt: now,
    });

    announceRecurring(cur.projectPath, cur.id, "updated");
    armRecurringWakeTimer();
    return recurringStore.getTemplateView(cur.id)!;
  });
}

export async function pauseRecurringTemplate(templateId: string): Promise<RecurringTemplateView> {
  return withTemplateLock(templateId, async () => {
    const cur = recurringStore.getTemplate(templateId);
    if (!cur) throw new RecurringError("Recurring template not found.", 404, "not-found");
    if (cur.status === "stopped") {
      throw new RecurringError("Stopped recurring templates cannot be paused.", 409, "template-stopped");
    }
    if (cur.status !== "paused") {
      recurringStore.updateTemplate(cur.id, { status: "paused", updatedAt: recurringNow() });
      announceRecurring(cur.projectPath, cur.id, "paused");
      armRecurringWakeTimer();
    }
    return recurringStore.getTemplateView(cur.id)!;
  });
}

export async function resumeRecurringTemplate(templateId: string): Promise<{
  template: RecurringTemplateView;
  generatedTaskIds: string[];
}> {
  let projectPath = "";
  await withTemplateLock(templateId, async () => {
    const cur = recurringStore.getTemplate(templateId);
    if (!cur) throw new RecurringError("Recurring template not found.", 404, "not-found");
    if (cur.status === "stopped") {
      throw new RecurringError("Stopped recurring templates cannot be resumed.", 409, "template-stopped");
    }
    projectPath = cur.projectPath;
    if (cur.status !== "active") {
      const now = recurringNow();
      // If `nextDueUtc` was missing on a calendar schedule, compute next from now.
      let nextDueUtc = cur.nextDueUtc;
      let nextDueMs = cur.nextDueMs;
      if (!nextDueUtc && cur.schedule.recurrenceType !== "after_completion") {
        const generatedCount = recurringStore.countGeneratedScheduled(cur.id);
        if (cur.schedule.maxOccurrences == null || generatedCount < cur.schedule.maxOccurrences) {
          nextDueUtc = computeNextNominalUtc(cur.schedule, now, { inclusive: true });
          nextDueMs = nextDueUtc ? Date.parse(nextDueUtc) : null;
        }
      }
      recurringStore.updateTemplate(cur.id, {
        status: "active",
        nextDueUtc,
        nextDueMs,
        updatedAt: now,
      });
      announceRecurring(cur.projectPath, cur.id, "resumed");
    }
  });

  const reconciled = await reconcileRecurringTemplate(templateId);
  armRecurringWakeTimer();
  if (projectPath) announceRecurring(projectPath, templateId, "resumed");
  return {
    template: recurringStore.getTemplateView(templateId)!,
    generatedTaskIds: reconciled.generatedTaskIds,
  };
}

/**
 * Permanently stop recurrence without deleting historical task occurrences or evidence.
 */
export async function stopRecurringTemplate(templateId: string): Promise<RecurringTemplateView> {
  return withTemplateLock(templateId, async () => {
    const cur = recurringStore.getTemplate(templateId);
    if (!cur) throw new RecurringError("Recurring template not found.", 404, "not-found");
    if (cur.status !== "stopped") {
      const now = recurringNow();
      recurringStore.updateTemplate(cur.id, {
        status: "stopped",
        nextDueUtc: null,
        nextDueMs: null,
        stoppedAt: now,
        updatedAt: now,
      });
      announceRecurring(cur.projectPath, cur.id, "stopped");
      armRecurringWakeTimer();
    }
    return recurringStore.getTemplateView(cur.id)!;
  });
}

/**
 * Create a single manual one-off occurrence from a template without altering
 * the regular `nextDueUtc` schedule or scheduled sequence count.
 * Respects existing submission, project lifecycle, Emergency Stop, and Owner authorization rules.
 */
export async function triggerManualOccurrence(templateId: string): Promise<{
  template: RecurringTemplateView;
  occurrence: RecurringOccurrence;
  taskId: string;
}> {
  const result = await withTemplateLock(templateId, async () => {
    const template = recurringStore.getTemplate(templateId);
    if (!template) throw new RecurringError("Recurring template not found.", 404, "not-found");
    if (template.status === "stopped") {
      throw new RecurringError("Cannot create an occurrence from a stopped template.", 409, "template-stopped");
    }
    if (!projects.get(template.projectPath)) {
      throw new RecurringError("Project is no longer registered.", 404, "project-missing");
    }

    const now = recurringNow();
    const nominalUtc = new Date(now).toISOString();
    const occurrenceId = randomUUID();
    const occurrenceKey = buildManualOccurrenceKey(template.id, occurrenceId);
    const title = formatOccurrenceTitle(template.title, nominalUtc, template.schedule);
    const initialColumn =
      template.templateConfig.initialColumn ?? (template.submissionMode === "auto_submit" ? "ready" : "ready");

    const prepared = await prepareTaskCreation(
      {
        title,
        prompt: buildOccurrencePrompt(template),
        column: initialColumn,
        workdir: template.projectPath,
        urgency: template.urgency,
        taskType: template.taskType,
        availableFromUtc: nominalUtc,
        agent: template.templateConfig.agent,
        mode: template.templateConfig.mode,
        model: template.templateConfig.model ?? undefined,
        effort: template.templateConfig.effort ?? undefined,
        fast: template.templateConfig.fast,
        maxMode: template.templateConfig.maxMode,
        isolation: template.templateConfig.isolation,
        accessMode: template.templateConfig.accessMode,
        baseRef: template.templateConfig.baseRef ?? undefined,
        agentProfileId: template.templateConfig.agentProfileId ?? undefined,
      },
      {
        recurringBinding: {
          templateId: template.id,
          occurrenceId,
          nominalUtc,
        },
        createdAt: now,
      },
    );
    if ("error" in prepared) {
      throw new RecurringError(prepared.error, 409, "task-create-failed");
    }

    const wantsSubmit = template.submissionMode === "auto_submit";
    const committed = db.transaction(() => {
      const { task } = prepared.commit();
      if (template.templateConfig.assignedEmployeeId) {
        try {
          new AssignmentCore(db).assign(task.id, template.templateConfig.assignedEmployeeId);
        } catch {
          // Employee may have been archived since template creation; leave unassigned cleanly.
        }
      }
      const occ: RecurringOccurrence = {
        id: occurrenceId,
        templateId: template.id,
        projectPath: template.projectPath,
        occurrenceKey,
        sequenceNumber: template.occurrenceSeq,
        kind: "manual_one_off",
        nominalUtc,
        status: "generated",
        skipReason: null,
        taskId: task.id,
        submissionIntent: wantsSubmit ? "pending" : "none",
        submissionError: null,
        submittedRunId: null,
        createdAt: now,
        updatedAt: now,
      };
      recurringStore.insertOccurrenceOrIgnore(occ);
      return { task, occ };
    })();

    return committed;
  });

  if (result.occ.submissionIntent === "pending") {
    reconcilePendingSubmissions(result.occ.projectPath);
  }
  notifySmartQueueChanged(result.occ.projectPath, "recurring-manual-occurrence");
  announceRecurring(result.occ.projectPath, templateId, "manual-occurrence");

  return {
    template: recurringStore.getTemplateView(templateId)!,
    occurrence: recurringStore.getOccurrence(result.occ.id) ?? result.occ,
    taskId: result.task.id,
  };
}

/* ------------------------------------------------------------------ durable materialization & submission */

export interface ReconcileResult {
  generatedTaskIds: string[];
  skippedCount: number;
  submittedCount: number;
}

/**
 * Reconcile any durable `submission_intent = 'pending'` occurrences through the
 * existing hands-off admission service (`submitHandsoffTask`) idempotently.
 */
export function reconcilePendingSubmissions(projectPath?: string): number {
  const pending = recurringStore.listPendingSubmissions(projectPath);
  if (pending.length === 0) return 0;

  const now = recurringNow();
  const emergency = autonomyPolicyStore.readEmergency().active;
  let submitted = 0;

  for (const occ of pending) {
    if (!occ.taskId) continue;
    if (emergency) {
      recurringStore.updateOccurrenceSubmission(occ.id, {
        submissionIntent: "failed",
        submissionError: "Emergency Stop is active. Automatic submission was halted.",
        submittedRunId: null,
        updatedAt: now,
      });
      continue;
    }

    // Already submitted prior to a crash? Adopt cleanly without duplicating.
    const existingRun = handsoffStore.openRunForTask(occ.taskId) ?? handsoffStore.latestRunForTask(occ.taskId);
    if (existingRun) {
      recurringStore.updateOccurrenceSubmission(occ.id, {
        submissionIntent: "submitted",
        submissionError: null,
        submittedRunId: existingRun.id,
        updatedAt: now,
      });
      submitted += 1;
      continue;
    }

    const template = recurringStore.getTemplate(occ.templateId);
    const admission = checkProjectLaunchAdmission(occ.projectPath);
    if (!admission.allowed) {
      // Leave pending? No: avoid silently firing parked work later if Owner stopped the project;
      // record honest failure so Owner can see or submit manually, or re-evaluate on next occurrence.
      recurringStore.updateOccurrenceSubmission(occ.id, {
        submissionIntent: "failed",
        submissionError: admission.reason ?? "Project is paused.",
        submittedRunId: null,
        updatedAt: now,
      });
      continue;
    }

    const storedPolicy = handsoffStore.getPolicy(occ.projectPath);
    if (!storedPolicy?.policy.enabled) {
      recurringStore.updateOccurrenceSubmission(occ.id, {
        submissionIntent: "failed",
        submissionError: "Work independently is off for this project.",
        submittedRunId: null,
        updatedAt: now,
      });
      continue;
    }

    try {
      const run = submitHandsoffTask(occ.taskId, {
        harnessId: template?.templateConfig.agent ?? undefined,
        model: template?.templateConfig.model ?? undefined,
        accountId: template?.templateConfig.requestedAccountId ?? undefined,
      });
      recurringStore.updateOccurrenceSubmission(occ.id, {
        submissionIntent: "submitted",
        submissionError: null,
        submittedRunId: run.id,
        updatedAt: now,
      });
      submitted += 1;
    } catch (error) {
      const existingAfterRace =
        handsoffStore.openRunForTask(occ.taskId) ?? handsoffStore.latestRunForTask(occ.taskId);
      if (existingAfterRace) {
        recurringStore.updateOccurrenceSubmission(occ.id, {
          submissionIntent: "submitted",
          submissionError: null,
          submittedRunId: existingAfterRace.id,
          updatedAt: now,
        });
        submitted += 1;
      } else {
        recurringStore.updateOccurrenceSubmission(occ.id, {
          submissionIntent: "failed",
          submissionError: error instanceof Error ? error.message : String(error),
          submittedRunId: null,
          updatedAt: now,
        });
      }
    }
  }

  return submitted;
}

/**
 * Materialize due occurrences for a single recurring template transactionally and idempotently.
 */
export async function reconcileRecurringTemplate(templateId: string): Promise<ReconcileResult> {
  const result = await withTemplateLock(templateId, async (): Promise<ReconcileResult> => {
    const template = recurringStore.getTemplate(templateId);
    if (!template || template.status !== "active" || !template.nextDueUtc || template.nextDueMs == null) {
      return { generatedTaskIds: [], skippedCount: 0, submittedCount: 0 };
    }

    const now = recurringNow();
    if (template.nextDueMs > now) {
      return { generatedTaskIds: [], skippedCount: 0, submittedCount: 0 };
    }

    // Validate project exists and is NOT paused/draining/invalid.
    // A paused project must neither launch autonomous work nor accumulate a backlog of generated occurrences.
    if (!projects.get(template.projectPath)) {
      return { generatedTaskIds: [], skippedCount: 0, submittedCount: 0 };
    }
    const admission = checkProjectLaunchAdmission(template.projectPath);
    if (!admission.allowed) {
      return { generatedTaskIds: [], skippedCount: 0, submittedCount: 0 };
    }

    // Emergency Stop prevents autonomous dispatch and automatic recurring submission.
    const emergency = autonomyPolicyStore.readEmergency().active;
    if (emergency && template.submissionMode === "auto_submit") {
      return { generatedTaskIds: [], skippedCount: 0, submittedCount: 0 };
    }

    const generatedSoFar = recurringStore.countGeneratedScheduled(template.id);
    const plan = planDueOccurrences({
      schedule: template.schedule,
      nextDueUtc: template.nextDueUtc,
      nowMs: now,
      missedPolicy: template.missedPolicy,
      catchUpLimit: template.catchUpLimit,
      generatedCountSoFar: generatedSoFar,
    });

    // Apply overlap policy and bounded overlap cap.
    const unresolvedCount = recurringStore.countUnresolvedOccurrences(template.id);
    const eligibleToCreate: Array<{
      nominalUtc: string;
      occurrenceId: string;
      occurrenceKey: string;
      seq: number;
    }> = [];
    const skippedRecords: Array<{
      nominalUtc: string;
      reason: RecurringSkipReason;
      occurrenceKey: string;
      seq: number;
    }> = [];

    for (const item of plan.skipped) {
      skippedRecords.push({
        nominalUtc: item.nominalUtc,
        reason: item.reason,
        occurrenceKey: buildScheduledOccurrenceKey(template.id, item.nominalUtc),
        seq: template.occurrenceSeq,
      });
    }

    let nextSeq = template.occurrenceSeq;
    let openBudget =
      template.overlapPolicy === "skip_if_unresolved"
        ? unresolvedCount > 0
          ? 0
          : 1
        : Math.max(0, RECURRENCE_LIMITS.maxOpenOverlappingOccurrences - unresolvedCount);

    for (const nominalUtc of plan.toGenerate) {
      const candidateSeq = nextSeq + 1;
      const occKey =
        template.recurrenceType === "after_completion"
          ? buildCompletionOccurrenceKey(template.id, template.lastCompletedTaskId, candidateSeq)
          : buildScheduledOccurrenceKey(template.id, nominalUtc);

      if (recurringStore.getOccurrenceByKey(occKey)) {
        // Already materialized in a prior run/crash before template state advanced.
        continue;
      }

      if (openBudget <= 0) {
        skippedRecords.push({
          nominalUtc,
          reason: template.overlapPolicy === "skip_if_unresolved" ? "overlap_unresolved" : "overlap_queue_cap",
          occurrenceKey: occKey,
          seq: nextSeq,
        });
        continue;
      }

      nextSeq = candidateSeq;
      openBudget -= 1;
      eligibleToCreate.push({
        nominalUtc,
        occurrenceId: randomUUID(),
        occurrenceKey: occKey,
        seq: candidateSeq,
      });
    }

    // Prepare task creations asynchronously (resolves git baseRef if needed) before opening the DB transaction.
    const preparedList: Array<{
      slot: (typeof eligibleToCreate)[number];
      prepared: { commit: () => { task: import("../../shared/types.ts").Task } };
    }> = [];

    const initialColumn =
      template.templateConfig.initialColumn ?? (template.submissionMode === "auto_submit" ? "ready" : "ready");

    for (const slot of eligibleToCreate) {
      const title = formatOccurrenceTitle(template.title, slot.nominalUtc, template.schedule);
      const prepared = await prepareTaskCreation(
        {
          title,
          prompt: buildOccurrencePrompt(template),
          column: initialColumn,
          workdir: template.projectPath,
          urgency: template.urgency,
          taskType: template.taskType,
          availableFromUtc: slot.nominalUtc,
          agent: template.templateConfig.agent,
          mode: template.templateConfig.mode,
          model: template.templateConfig.model ?? undefined,
          effort: template.templateConfig.effort ?? undefined,
          fast: template.templateConfig.fast,
          maxMode: template.templateConfig.maxMode,
          isolation: template.templateConfig.isolation,
          accessMode: template.templateConfig.accessMode,
          baseRef: template.templateConfig.baseRef ?? undefined,
          agentProfileId: template.templateConfig.agentProfileId ?? undefined,
        },
        {
          recurringBinding: {
            templateId: template.id,
            occurrenceId: slot.occurrenceId,
            nominalUtc: slot.nominalUtc,
          },
          createdAt: now,
        },
      );
      if ("error" in prepared) {
        // Do not advance template past a transient preparation error.
        return { generatedTaskIds: [], skippedCount: 0, submittedCount: 0 };
      }
      preparedList.push({ slot, prepared });
    }

    // Atomic transaction: insert tasks + occurrence keys + skipped records + advance template next_due.
    const txOut = db.transaction(() => {
      const fresh = recurringStore.getTemplate(template.id);
      if (!fresh || fresh.status !== "active" || fresh.nextDueUtc !== template.nextDueUtc) {
        return { generatedTaskIds: [] as string[], skippedCount: 0 };
      }
      const generatedTaskIds: string[] = [];
      let skippedCount = 0;
      let finalSeq = fresh.occurrenceSeq;
      let finalNominal = fresh.lastNominalUtc;

      for (const sk of skippedRecords) {
        const inserted = recurringStore.insertOccurrenceOrIgnore({
          id: randomUUID(),
          templateId: fresh.id,
          projectPath: fresh.projectPath,
          occurrenceKey: sk.occurrenceKey,
          sequenceNumber: sk.seq,
          kind: "scheduled",
          nominalUtc: sk.nominalUtc,
          status: "skipped",
          skipReason: sk.reason,
          taskId: null,
          submissionIntent: "none",
          submissionError: null,
          submittedRunId: null,
          createdAt: now,
          updatedAt: now,
        });
        if (inserted) skippedCount += 1;
        finalNominal = sk.nominalUtc;
      }

      for (const { slot, prepared } of preparedList) {
        if (recurringStore.getOccurrenceByKey(slot.occurrenceKey)) continue;
        const { task } = prepared.commit();
        if (fresh.templateConfig.assignedEmployeeId) {
          try {
            new AssignmentCore(db).assign(task.id, fresh.templateConfig.assignedEmployeeId);
          } catch {
            // Employee archived/changed; task remains valid and unassigned.
          }
        }
        const inserted = recurringStore.insertOccurrenceOrIgnore({
          id: slot.occurrenceId,
          templateId: fresh.id,
          projectPath: fresh.projectPath,
          occurrenceKey: slot.occurrenceKey,
          sequenceNumber: slot.seq,
          kind: "scheduled",
          nominalUtc: slot.nominalUtc,
          status: "generated",
          skipReason: null,
          taskId: task.id,
          submissionIntent: fresh.submissionMode === "auto_submit" ? "pending" : "none",
          submissionError: null,
          submittedRunId: null,
          createdAt: now,
          updatedAt: now,
        });
        if (!inserted) {
          throw new Error("Duplicate occurrence key detected inside transaction.");
        }
        generatedTaskIds.push(task.id);
        finalSeq = Math.max(finalSeq, slot.seq);
        finalNominal = slot.nominalUtc;
      }

      const nextDueMs = plan.nextDueUtc ? Date.parse(plan.nextDueUtc) : null;
      recurringStore.updateTemplate(fresh.id, {
        nextDueUtc: plan.nextDueUtc,
        nextDueMs: nextDueMs != null && Number.isFinite(nextDueMs) ? nextDueMs : null,
        lastNominalUtc: finalNominal,
        occurrenceSeq: finalSeq,
        updatedAt: now,
      });

      return { generatedTaskIds, skippedCount };
    })();

    const submittedCount =
      txOut.generatedTaskIds.length > 0 && template.submissionMode === "auto_submit"
        ? reconcilePendingSubmissions(template.projectPath)
        : 0;

    if (txOut.generatedTaskIds.length > 0 || txOut.skippedCount > 0) {
      notifySmartQueueChanged(template.projectPath, "recurring-materialized");
      announceRecurring(template.projectPath, template.id, "materialized");
    }

    return {
      generatedTaskIds: txOut.generatedTaskIds,
      skippedCount: txOut.skippedCount,
      submittedCount,
    };
  });

  armRecurringWakeTimer();
  return result;
}

/**
 * Reconcile all active due templates (optionally scoped to one project).
 * Also reconciles any pending durable submission intents.
 */
export async function reconcileDueRecurringTasks(projectPath?: string): Promise<ReconcileResult> {
  const now = recurringNow();
  const due = recurringStore.listDueTemplates(now, projectPath);
  const generatedTaskIds: string[] = [];
  let skippedCount = 0;
  let submittedCount = 0;

  for (const template of due) {
    const res = await reconcileRecurringTemplate(template.id);
    generatedTaskIds.push(...res.generatedTaskIds);
    skippedCount += res.skippedCount;
    submittedCount += res.submittedCount;
  }

  submittedCount += reconcilePendingSubmissions(projectPath);
  armRecurringWakeTimer();
  return { generatedTaskIds, skippedCount, submittedCount };
}

/**
 * Handle genuine task completion (`column === 'done'`) for `after_completion` templates.
 * Failed Developer exits, cancellations, and archival never trigger the next occurrence.
 */
export function handleRecurringTaskCompleted(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || !task.recurringTemplateId) return false;
  if (task.column !== "done" || task.archivedAt != null) return false;

  // If driven by hands-off, verify the run did not end in failed/cancelled.
  const latestRun = handsoffStore.latestRunForTask(task.id);
  if (latestRun && (latestRun.status === "failed" || latestRun.status === "cancelled")) {
    return false;
  }

  const template = recurringStore.getTemplate(task.recurringTemplateId);
  if (!template || template.status !== "active" || template.recurrenceType !== "after_completion") {
    return false;
  }
  if (template.lastCompletedTaskId === task.id) {
    return false; // Idempotent guard
  }
  // Ignore manual one-off occurrences when chaining regular completion-relative schedule?
  // Wait: check if this task was a scheduled occurrence.
  const occ = recurringStore.getOccurrenceByTaskId(task.id);
  if (occ && occ.kind !== "scheduled") return false;

  const now = recurringNow();
  const generatedCount = recurringStore.countGeneratedScheduled(template.id);
  const nextDueUtc = computeCompletionNextDueUtc(template.schedule, now, generatedCount);
  const nextDueMs = nextDueUtc ? Date.parse(nextDueUtc) : null;

  recurringStore.updateTemplate(template.id, {
    lastCompletedTaskId: task.id,
    lastCompletedAt: now,
    nextDueUtc,
    nextDueMs: nextDueMs != null && Number.isFinite(nextDueMs) ? nextDueMs : null,
    updatedAt: now,
  });

  announceRecurring(template.projectPath, template.id, "completion-scheduled");
  armRecurringWakeTimer();
  return true;
}

/** Emergency Stop hook: halt pending automatic submissions so clearing stop never silently launches parked work. */
export function haltRecurringSubmissionsForEmergency(reason: string): number {
  const pending = recurringStore.listPendingSubmissions();
  const now = recurringNow();
  for (const occ of pending) {
    recurringStore.updateOccurrenceSubmission(occ.id, {
      submissionIntent: "failed",
      submissionError: `${reason} Nothing new was submitted.`,
      submittedRunId: null,
      updatedAt: now,
    });
  }
  return pending.length;
}

/* ------------------------------------------------------------------------------- restore guard & boot */

/**
 * If this data directory was restored from a historical backup snapshot
 * (`restore-confirmation.json` not yet acknowledged), skip historical past-due
 * schedules cleanly rather than launching old work merely because timestamps
 * are in the past. Preserves all templates, settings, and occurrence history.
 */
function guardRestoredHistoricalSchedules(): number {
  const confirmationPath = path.join(dataDir, "restore-confirmation.json");
  if (!existsSync(confirmationPath)) return 0;

  let restoreStamp: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(confirmationPath, "utf8")) as {
      snapshotId?: string;
      restoredAt?: string | number;
    };
    restoreStamp = `${raw.snapshotId ?? "unknown"}:${raw.restoredAt ?? "unknown"}`;
  } catch {
    return 0;
  }

  if (preferences.get(RESTORE_ACK_PREF_KEY) === restoreStamp) return 0;

  const now = recurringNow();
  let guarded = 0;

  // Cancel any pending submission intents carried over in the restored database.
  for (const occ of recurringStore.listPendingSubmissions()) {
    recurringStore.updateOccurrenceSubmission(occ.id, {
      submissionIntent: "failed",
      submissionError: "Restored from historical backup; automatic submission skipped.",
      submittedRunId: null,
      updatedAt: now,
    });
    guarded += 1;
  }

  // Advance any active template whose next_due_ms is already in the past to the next future slot.
  for (const template of recurringStore.listDueTemplates(now)) {
    const nextFutureUtc =
      template.recurrenceType === "after_completion"
        ? null
        : computeNextNominalUtc(template.schedule, now, { inclusive: false });
    const nextFutureMs = nextFutureUtc ? Date.parse(nextFutureUtc) : null;

    if (template.nextDueUtc) {
      recurringStore.insertOccurrenceOrIgnore({
        id: randomUUID(),
        templateId: template.id,
        projectPath: template.projectPath,
        occurrenceKey: buildScheduledOccurrenceKey(template.id, template.nextDueUtc),
        sequenceNumber: template.occurrenceSeq,
        kind: "scheduled",
        nominalUtc: template.nextDueUtc,
        status: "skipped",
        skipReason: "restore_historical_skip",
        taskId: null,
        submissionIntent: "none",
        submissionError: null,
        submittedRunId: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    recurringStore.updateTemplate(template.id, {
      nextDueUtc: nextFutureUtc,
      nextDueMs: nextFutureMs != null && Number.isFinite(nextFutureMs) ? nextFutureMs : null,
      updatedAt: now,
    });
    guarded += 1;
  }

  preferences.set(RESTORE_ACK_PREF_KEY, restoreStamp);
  return guarded;
}

/* ---------------------------------------------------------------------------- wake timer & lifecycle */

let initialized = false;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
let unsubGlobal: (() => void) | undefined;
let unsubQueue: (() => void) | undefined;

export function armRecurringWakeTimer(): void {
  if (!initialized) return;
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  const earliest = recurringStore.earliestNextDueMs();
  if (earliest == null) return;
  const delay = Math.max(0, Math.min(earliest - recurringNow(), RECURRING_MAX_WAKE_INTERVAL_MS));
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined;
    void reconcileDueRecurringTasks();
  }, delay);
  wakeTimer.unref?.();
}

export function initRecurringScheduler(): void {
  if (initialized) return;
  initialized = true;

  unsubGlobal = subscribeGlobal((event) => {
    if (event.kind === "column" && event.column === "done") {
      handleRecurringTaskCompleted(event.taskId);
    }
  });

  unsubQueue = onSmartQueueChange((projectPath, reason) => {
    if (reason === "project-resumed" && projectPath) {
      void reconcileDueRecurringTasks(projectPath);
    }
  });

  armRecurringWakeTimer();
}

export function stopRecurringScheduler(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  unsubGlobal?.();
  unsubGlobal = undefined;
  unsubQueue?.();
  unsubQueue = undefined;
  initialized = false;
}

/**
 * Boot-time recovery:
 *  1. Guard restored historical profiles so old schedules never auto-fire on import.
 *  2. Reconcile any pre-crash pending submissions and due active templates.
 *  3. Arm wake timer for the next upcoming due timestamp.
 */
export async function recoverRecurringTasks(): Promise<ReconcileResult> {
  guardRestoredHistoricalSchedules();
  const res = await reconcileDueRecurringTasks();
  armRecurringWakeTimer();
  return res;
}
