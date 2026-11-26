/**
 * PM chat intake promotion: backlog → project inbox (`column === "inbox"`).
 * Parsed from `<intake_promotions>` in a manager reply; applied only when
 * the owner supplied a single-use intake grant on the same message.
 */

import { capText, lastTagBody } from "./project-interview.ts";
import type { ColumnId, Task } from "./types.ts";

export type IntakeTaskRefLookup = ReadonlyMap<string, { id: string; title: string; column: ColumnId }>;

export const INTAKE_PROMOTION_LIMITS = {
  jsonChars: 4000,
  reasonChars: 400,
  tasks: 20,
} as const;

function stripFence(body: string): string {
  const trimmed = body.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (match ? match[1]! : trimmed).trim();
}

function parseIntakeJsonObject(body: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (body.length > INTAKE_PROMOTION_LIMITS.jsonChars) return { ok: false, error: "it is too large" };
  const cleaned = stripFence(body);
  const attempt = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  let value = attempt(cleaned);
  if (value === undefined) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) value = attempt(cleaned.slice(first, last + 1));
  }
  if (value === undefined) return { ok: false, error: "it is not valid JSON" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "it is not a JSON object" };
  return { ok: true, value: value as Record<string, unknown> };
}

function resolveTaskRef(
  token: string,
  lookup: IntakeTaskRefLookup,
): { ok: true; taskId: string } | { ok: false; error: string } {
  const ref = token.replace(/^#/, "").toLowerCase().slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(ref)) {
    return { ok: false, error: `“${token}” is not a task id like #1a2b3c4d.` };
  }
  const row = lookup.get(ref);
  if (!row) return { ok: false, error: `#${ref} is not a task of this project.` };
  return { ok: true, taskId: row.id };
}

export interface IntakePromotionDraft {
  taskId: string;
  reason: string;
}

export const INTAKE_REPLY_FORMAT = [
  "When the owner explicitly asks you to admit backlog tasks to the project inbox (PM triage), you may list them in JSON. You cannot move tasks yourself: the application applies this only when the owner granted intake promotion on the same message.",
  "<intake_promotions>",
  '{"tasks": ["#1a2b3c4d"], "reason": "Ready for triage."}',
  "</intake_promotions>",
  "Only tasks currently in the Backlog column of this project may be listed. Nothing moves until the grant is consumed.",
].join("\n");

export function parseIntakePromotionDrafts(
  text: string,
  lookup: IntakeTaskRefLookup,
): { drafts: IntakePromotionDraft[]; errors: string[] } {
  const raw = text.replace(/\r\n?/g, "\n");
  if (!raw.includes("<intake_promotions>")) return { drafts: [], errors: [] };
  const body = lastTagBody(raw, "intake_promotions");
  if (body == null) return { drafts: [], errors: ["The intake promotion block was cut off."] };
  const json = parseIntakeJsonObject(capText(body, INTAKE_PROMOTION_LIMITS.jsonChars));
  if (!json.ok) return { drafts: [], errors: [`The intake promotion could not be read (${json.error}).`] };
  const value = json.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { drafts: [], errors: ["The intake promotion must be a JSON object."] };
  }
  const reason = typeof (value as { reason?: unknown }).reason === "string"
    ? capText((value as { reason: string }).reason.trim(), INTAKE_PROMOTION_LIMITS.reasonChars)
    : "";
  const tasksRaw = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksRaw)) return { drafts: [], errors: ["intake_promotions.tasks must be an array."] };
  const drafts: IntakePromotionDraft[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of tasksRaw.slice(0, INTAKE_PROMOTION_LIMITS.tasks)) {
    if (typeof entry !== "string") {
      errors.push("Each intake task must be named by its id (like #1a2b3c4d).");
      continue;
    }
    const resolved = resolveTaskRef(entry.trim(), lookup);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (seen.has(resolved.taskId)) continue;
    seen.add(resolved.taskId);
    drafts.push({ taskId: resolved.taskId, reason });
  }
  if (tasksRaw.length > INTAKE_PROMOTION_LIMITS.tasks) {
    errors.push(`At most ${INTAKE_PROMOTION_LIMITS.tasks} tasks per intake promotion.`);
  }
  return { drafts, errors };
}

/** Whether a task may be admitted from backlog to inbox. */
export function canAdmitTaskToInbox(task: Pick<Task, "column" | "archivedAt" | "pipelineParentId">): boolean {
  if (task.archivedAt != null) return false;
  if (task.pipelineParentId != null) return false;
  return task.column === "backlog";
}

/** Human-readable reason execution must not start from this column. */
export function columnExecutionBlocked(column: ColumnId): string | null {
  switch (column) {
    case "backlog":
      return "This task is still in Backlog. Admit it to the project inbox, then move it to Ready to run.";
    case "inbox":
      return "This task is in the project inbox for PM triage. Move it to Ready when you want to run it.";
    default:
      return null;
  }
}
