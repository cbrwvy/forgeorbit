/**
 * SQLite persistence for recurring task templates and occurrence history (FO-KANBAN-RECURRING01).
 */
import { db } from "../db.ts";
import { normalizeUrgency } from "../../shared/board-order.ts";
import type {
  RecurrenceType,
  RecurringMissedPolicy,
  RecurringOccurrence,
  RecurringOccurrenceHistoryItem,
  RecurringOccurrenceKind,
  RecurringOccurrenceStatus,
  RecurringOverlapPolicy,
  RecurringScheduleConfig,
  RecurringSkipReason,
  RecurringSubmissionIntent,
  RecurringSubmissionMode,
  RecurringTemplate,
  RecurringTemplateStats,
  RecurringTemplateStatus,
  RecurringTemplateTaskConfig,
  RecurringTemplateView,
} from "../../shared/recurring-tasks.ts";
import type { TaskType } from "../../shared/types.ts";

interface TemplateRow {
  id: string;
  project_path: string;
  status: string;
  title: string;
  prompt: string;
  urgency: number;
  task_type: string;
  template_config_json: string;
  recurrence_type: string;
  schedule_json: string;
  submission_mode: string;
  overlap_policy: string;
  missed_policy: string;
  catch_up_limit: number;
  next_due_utc: string | null;
  next_due_ms: number | null;
  last_nominal_utc: string | null;
  occurrence_seq: number;
  last_completed_task_id: string | null;
  last_completed_at: number | null;
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
}

interface OccurrenceRow {
  id: string;
  template_id: string;
  project_path: string;
  occurrence_key: string;
  sequence_number: number;
  kind: string;
  nominal_utc: string;
  status: string;
  skip_reason: string | null;
  task_id: string | null;
  submission_intent: string;
  submission_error: string | null;
  submitted_run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface OccurrenceHistoryRow extends OccurrenceRow {
  task_title: string | null;
  task_column: string | null;
  task_archived_at: number | null;
  task_updated_at: number | null;
  handsoff_status: string | null;
  handsoff_finished_at: number | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toTemplate(row: TemplateRow): RecurringTemplate {
  return {
    id: row.id,
    projectPath: row.project_path,
    status: row.status as RecurringTemplateStatus,
    title: row.title,
    prompt: row.prompt,
    urgency: normalizeUrgency(row.urgency),
    taskType: row.task_type as TaskType,
    templateConfig: parseJson<RecurringTemplateTaskConfig>(row.template_config_json, {}),
    recurrenceType: row.recurrence_type as RecurrenceType,
    schedule: parseJson<RecurringScheduleConfig>(row.schedule_json, {
      recurrenceType: row.recurrence_type as RecurrenceType,
      interval: 1,
      intervalUnit: "days",
      weekdays: [],
      monthlyMode: "day_of_month",
      dayOfMonth: 1,
      missingDayPolicy: "skip",
      startDateUtc: "1970-01-01",
      startTimeUtc: "00:00",
      startUtc: "1970-01-01T00:00:00.000Z",
      endDateUtc: null,
      maxOccurrences: null,
    }),
    submissionMode: row.submission_mode as RecurringSubmissionMode,
    overlapPolicy: row.overlap_policy as RecurringOverlapPolicy,
    missedPolicy: row.missed_policy as RecurringMissedPolicy,
    catchUpLimit: row.catch_up_limit,
    nextDueUtc: row.next_due_utc,
    nextDueMs: row.next_due_ms,
    lastNominalUtc: row.last_nominal_utc,
    occurrenceSeq: row.occurrence_seq,
    lastCompletedTaskId: row.last_completed_task_id,
    lastCompletedAt: row.last_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at,
  };
}

function toOccurrence(row: OccurrenceRow): RecurringOccurrence {
  return {
    id: row.id,
    templateId: row.template_id,
    projectPath: row.project_path,
    occurrenceKey: row.occurrence_key,
    sequenceNumber: row.sequence_number,
    kind: row.kind as RecurringOccurrenceKind,
    nominalUtc: row.nominal_utc,
    status: row.status as RecurringOccurrenceStatus,
    skipReason: (row.skip_reason as RecurringSkipReason | null) ?? null,
    taskId: row.task_id,
    submissionIntent: row.submission_intent as RecurringSubmissionIntent,
    submissionError: row.submission_error,
    submittedRunId: row.submitted_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHistoryItem(row: OccurrenceHistoryRow): RecurringOccurrenceHistoryItem {
  const base = toOccurrence(row);
  const completedAt =
    row.task_column === "done"
      ? (row.handsoff_finished_at ?? row.task_updated_at ?? null)
      : null;
  return {
    ...base,
    taskTitle: row.task_title ?? null,
    taskColumn: row.task_column ?? null,
    taskArchivedAt: row.task_archived_at ?? null,
    taskUpdatedAt: row.task_updated_at ?? null,
    taskCompletedAt: completedAt,
    handsoffStatus: row.handsoff_status ?? null,
  };
}

const HISTORY_SELECT = `
  SELECT o.*,
         t.title AS task_title,
         t."column" AS task_column,
         t.archived_at AS task_archived_at,
         t.updated_at AS task_updated_at,
         (SELECT hr.status FROM handsoff_runs hr WHERE hr.task_id = o.task_id ORDER BY hr.created_at DESC, hr.rowid DESC LIMIT 1) AS handsoff_status,
         (SELECT hr.finished_at FROM handsoff_runs hr WHERE hr.task_id = o.task_id ORDER BY hr.created_at DESC, hr.rowid DESC LIMIT 1) AS handsoff_finished_at
    FROM recurring_occurrences o
    LEFT JOIN tasks t ON t.id = o.task_id
`;

export const recurringStore = {
  insertTemplate(t: RecurringTemplate): RecurringTemplate {
    db.run(
      `INSERT INTO recurring_templates (
         id, project_path, status, title, prompt, urgency, task_type, template_config_json,
         recurrence_type, schedule_json, submission_mode, overlap_policy, missed_policy, catch_up_limit,
         next_due_utc, next_due_ms, last_nominal_utc, occurrence_seq,
         last_completed_task_id, last_completed_at, created_at, updated_at, stopped_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.projectPath,
        t.status,
        t.title,
        t.prompt,
        t.urgency,
        t.taskType,
        JSON.stringify(t.templateConfig),
        t.recurrenceType,
        JSON.stringify(t.schedule),
        t.submissionMode,
        t.overlapPolicy,
        t.missedPolicy,
        t.catchUpLimit,
        t.nextDueUtc,
        t.nextDueMs,
        t.lastNominalUtc,
        t.occurrenceSeq,
        t.lastCompletedTaskId,
        t.lastCompletedAt,
        t.createdAt,
        t.updatedAt,
        t.stoppedAt,
      ],
    );
    return this.getTemplate(t.id)!;
  },

  getTemplate(id: string): RecurringTemplate | null {
    const row = db
      .query<TemplateRow, [string]>(`SELECT * FROM recurring_templates WHERE id = ?`)
      .get(id);
    return row ? toTemplate(row) : null;
  },

  listTemplates(projectPath?: string): RecurringTemplate[] {
    const rows = projectPath
      ? db
          .query<TemplateRow, [string]>(
            `SELECT * FROM recurring_templates WHERE project_path = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC, id ASC`,
          )
          .all(projectPath)
      : db
          .query<TemplateRow, []>(
            `SELECT * FROM recurring_templates ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC, id ASC`,
          )
          .all();
    return rows.map(toTemplate);
  },

  /** Indexed lookup of active templates whose `next_due_ms <= nowMs`. */
  listDueTemplates(nowMs: number, projectPath?: string): RecurringTemplate[] {
    const rows = projectPath
      ? db
          .query<TemplateRow, [number, string]>(
            `SELECT * FROM recurring_templates
              WHERE status = 'active' AND next_due_ms IS NOT NULL AND next_due_ms <= ? AND project_path = ?
              ORDER BY next_due_ms ASC, id ASC`,
          )
          .all(nowMs, projectPath)
      : db
          .query<TemplateRow, [number]>(
            `SELECT * FROM recurring_templates
              WHERE status = 'active' AND next_due_ms IS NOT NULL AND next_due_ms <= ?
              ORDER BY next_due_ms ASC, id ASC`,
          )
          .all(nowMs);
    return rows.map(toTemplate);
  },

  /** Indexed lookup of the earliest upcoming active `next_due_ms` across all projects. */
  earliestNextDueMs(): number | null {
    const row = db
      .query<{ next_due_ms: number | null }, []>(
        `SELECT MIN(next_due_ms) AS next_due_ms
           FROM recurring_templates
          WHERE status = 'active' AND next_due_ms IS NOT NULL`,
      )
      .get();
    return typeof row?.next_due_ms === "number" ? row.next_due_ms : null;
  },

  updateTemplate(
    id: string,
    patch: Partial<{
      status: RecurringTemplateStatus;
      title: string;
      prompt: string;
      urgency: number;
      taskType: TaskType;
      templateConfig: RecurringTemplateTaskConfig;
      recurrenceType: RecurrenceType;
      schedule: RecurringScheduleConfig;
      submissionMode: RecurringSubmissionMode;
      overlapPolicy: RecurringOverlapPolicy;
      missedPolicy: RecurringMissedPolicy;
      catchUpLimit: number;
      nextDueUtc: string | null;
      nextDueMs: number | null;
      lastNominalUtc: string | null;
      occurrenceSeq: number;
      lastCompletedTaskId: string | null;
      lastCompletedAt: number | null;
      updatedAt: number;
      stoppedAt: number | null;
    }>,
  ): RecurringTemplate | null {
    const cur = this.getTemplate(id);
    if (!cur) return null;
    const next: RecurringTemplate = {
      ...cur,
      status: patch.status ?? cur.status,
      title: patch.title ?? cur.title,
      prompt: patch.prompt ?? cur.prompt,
      urgency: patch.urgency !== undefined ? normalizeUrgency(patch.urgency) : cur.urgency,
      taskType: patch.taskType ?? cur.taskType,
      templateConfig: patch.templateConfig ?? cur.templateConfig,
      recurrenceType: patch.recurrenceType ?? cur.recurrenceType,
      schedule: patch.schedule ?? cur.schedule,
      submissionMode: patch.submissionMode ?? cur.submissionMode,
      overlapPolicy: patch.overlapPolicy ?? cur.overlapPolicy,
      missedPolicy: patch.missedPolicy ?? cur.missedPolicy,
      catchUpLimit: patch.catchUpLimit ?? cur.catchUpLimit,
      nextDueUtc: patch.nextDueUtc !== undefined ? patch.nextDueUtc : cur.nextDueUtc,
      nextDueMs: patch.nextDueMs !== undefined ? patch.nextDueMs : cur.nextDueMs,
      lastNominalUtc: patch.lastNominalUtc !== undefined ? patch.lastNominalUtc : cur.lastNominalUtc,
      occurrenceSeq: patch.occurrenceSeq ?? cur.occurrenceSeq,
      lastCompletedTaskId:
        patch.lastCompletedTaskId !== undefined ? patch.lastCompletedTaskId : cur.lastCompletedTaskId,
      lastCompletedAt: patch.lastCompletedAt !== undefined ? patch.lastCompletedAt : cur.lastCompletedAt,
      updatedAt: patch.updatedAt ?? Date.now(),
      stoppedAt: patch.stoppedAt !== undefined ? patch.stoppedAt : cur.stoppedAt,
    };

    db.run(
      `UPDATE recurring_templates
          SET status = ?, title = ?, prompt = ?, urgency = ?, task_type = ?, template_config_json = ?,
              recurrence_type = ?, schedule_json = ?, submission_mode = ?, overlap_policy = ?,
              missed_policy = ?, catch_up_limit = ?, next_due_utc = ?, next_due_ms = ?,
              last_nominal_utc = ?, occurrence_seq = ?, last_completed_task_id = ?,
              last_completed_at = ?, updated_at = ?, stopped_at = ?
        WHERE id = ?`,
      [
        next.status,
        next.title,
        next.prompt,
        next.urgency,
        next.taskType,
        JSON.stringify(next.templateConfig),
        next.recurrenceType,
        JSON.stringify(next.schedule),
        next.submissionMode,
        next.overlapPolicy,
        next.missedPolicy,
        next.catchUpLimit,
        next.nextDueUtc,
        next.nextDueMs,
        next.lastNominalUtc,
        next.occurrenceSeq,
        next.lastCompletedTaskId,
        next.lastCompletedAt,
        next.updatedAt,
        next.stoppedAt,
        id,
      ],
    );
    return this.getTemplate(id);
  },

  insertOccurrenceOrIgnore(occ: RecurringOccurrence): boolean {
    const res = db.run(
      `INSERT OR IGNORE INTO recurring_occurrences (
         id, template_id, project_path, occurrence_key, sequence_number, kind,
         nominal_utc, status, skip_reason, task_id, submission_intent,
         submission_error, submitted_run_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        occ.id,
        occ.templateId,
        occ.projectPath,
        occ.occurrenceKey,
        occ.sequenceNumber,
        occ.kind,
        occ.nominalUtc,
        occ.status,
        occ.skipReason,
        occ.taskId,
        occ.submissionIntent,
        occ.submissionError,
        occ.submittedRunId,
        occ.createdAt,
        occ.updatedAt,
      ],
    );
    return res.changes > 0;
  },

  getOccurrence(id: string): RecurringOccurrence | null {
    const row = db
      .query<OccurrenceRow, [string]>(`SELECT * FROM recurring_occurrences WHERE id = ?`)
      .get(id);
    return row ? toOccurrence(row) : null;
  },

  getOccurrenceByKey(occurrenceKey: string): RecurringOccurrence | null {
    const row = db
      .query<OccurrenceRow, [string]>(`SELECT * FROM recurring_occurrences WHERE occurrence_key = ?`)
      .get(occurrenceKey);
    return row ? toOccurrence(row) : null;
  },

  getOccurrenceByTaskId(taskId: string): RecurringOccurrence | null {
    const row = db
      .query<OccurrenceRow, [string]>(`SELECT * FROM recurring_occurrences WHERE task_id = ?`)
      .get(taskId);
    return row ? toOccurrence(row) : null;
  },

  listPendingSubmissions(projectPath?: string): RecurringOccurrence[] {
    const rows = projectPath
      ? db
          .query<OccurrenceRow, [string]>(
            `SELECT * FROM recurring_occurrences
              WHERE submission_intent = 'pending' AND task_id IS NOT NULL AND project_path = ?
              ORDER BY created_at ASC, id ASC`,
          )
          .all(projectPath)
      : db
          .query<OccurrenceRow, []>(
            `SELECT * FROM recurring_occurrences
              WHERE submission_intent = 'pending' AND task_id IS NOT NULL
              ORDER BY created_at ASC, id ASC`,
          )
          .all();
    return rows.map(toOccurrence);
  },

  updateOccurrenceSubmission(
    id: string,
    patch: {
      submissionIntent: RecurringSubmissionIntent;
      submissionError?: string | null;
      submittedRunId?: string | null;
      updatedAt: number;
    },
  ): void {
    db.run(
      `UPDATE recurring_occurrences
          SET submission_intent = ?, submission_error = ?, submitted_run_id = ?, updated_at = ?
        WHERE id = ?`,
      [
        patch.submissionIntent,
        patch.submissionError ?? null,
        patch.submittedRunId ?? null,
        patch.updatedAt,
        id,
      ],
    );
  },

  /**
   * Count unresolved occurrences belonging to `templateId`.
   * Covers backlog, inbox, ready, scheduled waiting, running, review, blocked/rework,
   * authorization waiting, failed requiring intervention, or any open hands-off run.
   */
  countUnresolvedOccurrences(templateId: string): number {
    const row = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n
           FROM recurring_occurrences o
           JOIN tasks t ON t.id = o.task_id
          WHERE o.template_id = ?
            AND o.status = 'generated'
            AND t.archived_at IS NULL
            AND (
              t."column" != 'done'
              OR EXISTS (
                SELECT 1 FROM handsoff_runs hr
                 WHERE hr.task_id = t.id AND hr.finished_at IS NULL
              )
            )`,
      )
      .get(templateId);
    return row?.n ?? 0;
  },

  countGeneratedScheduled(templateId: string): number {
    const row = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n
           FROM recurring_occurrences
          WHERE template_id = ? AND kind = 'scheduled' AND status = 'generated'`,
      )
      .get(templateId);
    return row?.n ?? 0;
  },

  listOccurrenceHistory(templateId: string, limit = 100): RecurringOccurrenceHistoryItem[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = db
      .query<OccurrenceHistoryRow, [string, number]>(
        `${HISTORY_SELECT}
          WHERE o.template_id = ?
          ORDER BY o.created_at DESC, o.sequence_number DESC, o.id DESC
          LIMIT ?`,
      )
      .all(templateId, safeLimit);
    return rows.map(toHistoryItem);
  },

  computeStats(templateId: string): RecurringTemplateStats {
    const history = this.listOccurrenceHistory(templateId, 500);
    let totalGenerated = 0;
    let completed = 0;
    let unresolved = 0;
    let skipped = 0;
    let latestOccurrence: RecurringOccurrenceHistoryItem | null = null;
    let activeOccurrence: RecurringOccurrenceHistoryItem | null = null;

    for (const item of history) {
      if (!latestOccurrence && item.status === "generated") {
        latestOccurrence = item;
      }
      if (item.status === "skipped") {
        skipped += 1;
        continue;
      }
      totalGenerated += 1;
      const isDone = item.taskColumn === "done";
      const isArchived = item.taskArchivedAt != null;
      const taskExists = item.taskColumn != null;
      if (isDone) {
        completed += 1;
      } else if (taskExists && !isArchived) {
        unresolved += 1;
        if (!activeOccurrence) activeOccurrence = item;
      }
    }

    if (!latestOccurrence && history.length > 0) {
      latestOccurrence = history[0]!;
    }

    return {
      totalGenerated,
      completed,
      unresolved,
      skipped,
      latestOccurrence,
      activeOccurrence,
    };
  },

  getTemplateView(id: string): RecurringTemplateView | null {
    const template = this.getTemplate(id);
    if (!template) return null;
    return { ...template, stats: this.computeStats(template.id) };
  },

  listTemplateViews(projectPath?: string): RecurringTemplateView[] {
    return this.listTemplates(projectPath).map((t) => ({
      ...t,
      stats: this.computeStats(t.id),
    }));
  },
};
