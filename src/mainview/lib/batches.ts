import { intlLocale, t as tr } from "@/i18n/core";

/**
 * Presentation helpers for execution batches (FO-005C.2). Labels, the
 * monitoring groups and which buttons a status shows. No scheduling rules
 * live here: what may start, what is ready and what is held all come from
 * the core's `BatchView` (`readiness`, `state`, `hold`, `next`), and every
 * action is checked again by the core.
 */

import type {
  BatchEntryState,
  BatchEntryView,
  BatchPolicy,
  BatchStatus,
  BatchView,
  FailurePolicy,
  ReviewPolicy,
  SpendingPolicy,
  TaskPriority,
} from "../../shared/task-scheduling.ts";

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  get draft() { return tr("common.draft"); },
  get approved() { return tr("common.approved"); },
  get running() { return tr("common.running"); },
  get paused() { return tr("common.paused"); },
  get completed() { return tr("common.completed"); },
  get stopped() { return tr("common.stopped"); },
  get cancelled() { return tr("common.cancelled"); },
};

export const BATCH_STATUS_TONE: Record<BatchStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-info/15 text-info",
  running: "bg-info/15 text-info",
  paused: "bg-warning/15 text-warning",
  completed: "bg-success/15 text-success",
  stopped: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

export const ENTRY_STATE_LABEL: Record<BatchEntryState, string> = {
  get pending() { return tr("common.queued"); },
  get starting() { return tr("common.starting_aeed4d"); },
  get running() { return tr("common.running"); },
  get waiting() { return tr("common.waiting_for_your_answer"); },
  get review() { return tr("common.waiting_for_your_review"); },
  get done() { return tr("common.done"); },
  get failed() { return tr("common.failed"); },
  get cancelled() { return tr("common.stopped"); },
  get held() { return tr("common.on_hold"); },
  get missing() { return tr("common.missing"); },
  get external() { return tr("common.run_outside_the_batch"); },
};

export const ENTRY_STATE_TONE: Record<BatchEntryState, string> = {
  pending: "bg-muted text-muted-foreground",
  starting: "bg-info/15 text-info",
  running: "bg-info/15 text-info",
  waiting: "bg-warning/15 text-warning",
  review: "bg-warning/15 text-warning",
  done: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-muted text-muted-foreground",
  held: "bg-warning/15 text-warning",
  missing: "bg-danger/15 text-danger",
  external: "bg-muted text-muted-foreground",
};

export const PRIORITY_OPTIONS: { id: TaskPriority; label: string }[] = [
  { id: "critical", get label() { return tr("common.critical"); } },
  { id: "high", get label() { return tr("common.high"); } },
  { id: "normal", get label() { return tr("common.normal"); } },
  { id: "low", get label() { return tr("common.low"); } },
];

export const PRIORITY_TONE: Record<TaskPriority, string> = {
  critical: "text-danger",
  high: "text-warning",
  normal: "text-muted-foreground",
  low: "text-muted-foreground",
};

export const SPENDING_OPTIONS: { id: SpendingPolicy; label: string; detail: string }[] = [
  {
    id: "no-extra",
    get label() { return tr("common.no_extra_spending"); },
    get detail() { return tr("common.only_subscription_logins_a_harness_whose_account_might"); },
  },
  {
    id: "allow-overage",
    get label() { return tr("common.allow_possible_overage"); },
    get detail() { return tr("common.subscriptions_may_draw_paid_extra_usage_once_their"); },
  },
  {
    id: "allow-paid",
    get label() { return tr("common.allow_paid_usage"); },
    get detail() { return tr("common.per_request_apis_too_you_confirm_each_harness"); },
  },
];

export const REVIEW_OPTIONS: { id: ReviewPolicy; label: string; detail: string }[] = [
  { id: "wait-for-review", get label() { return tr("common.wait_for_my_review"); }, get detail() { return tr("common.nothing_new_starts_while_a_finished_task_waits"); } },
  { id: "continue-independent", get label() { return tr("common.continue_independent_tasks"); }, get detail() { return tr("common.tasks_that_don_t_depend_on_it_keep"); } },
];

export const FAILURE_OPTIONS: { id: FailurePolicy; label: string; detail: string }[] = [
  { id: "pause", get label() { return tr("common.pause_the_batch"); }, get detail() { return tr("common.a_failed_stopped_or_held_task_pauses_everything"); } },
  { id: "continue", get label() { return tr("common.continue_with_the_rest"); }, get detail() { return tr("common.tasks_that_depend_on_the_failed_one_wait"); } },
];

export const ACCESS_TEXT = [tr("common.read_only_plan"), "Asks before acting", "Accepts edits, asks for commands", "Hands-off", "No permission checks"];

export type BatchAction = "start" | "pause" | "resume" | "cancel" | "stop-runs";

/**
 * Which lifecycle buttons a status shows. The core refuses anything else
 * too; this only keeps buttons for impossible actions off the screen.
 */
export function batchActions(view: Pick<BatchView, "status" | "ownedLive">): BatchAction[] {
  switch (view.status) {
    case "draft":
      return ["cancel"];
    case "approved":
      return ["start", "cancel"];
    case "running":
      return ["pause", "cancel"];
    case "paused":
      return view.ownedLive.length > 0 ? ["resume", "cancel", "stop-runs"] : ["resume", "cancel"];
    case "completed":
    case "stopped":
    case "cancelled":
      return view.ownedLive.length > 0 ? ["stop-runs"] : [];
  }
}

export type MonitorGroup = "running" | "ready" | "dependencies" | "review" | "hold" | "completed" | "failed" | "outside";

export const MONITOR_GROUPS: { id: MonitorGroup; label: string }[] = [
  { id: "running", get label() { return tr("common.running"); } },
  { id: "review", get label() { return tr("common.waiting_for_your_review"); } },
  { id: "hold", get label() { return tr("common.on_hold"); } },
  { id: "failed", get label() { return tr("common.failed_or_stopped"); } },
  { id: "ready", get label() { return tr("common.ready"); } },
  { id: "dependencies", get label() { return tr("common.waiting_for_dependencies"); } },
  { id: "completed", get label() { return tr("common.completed"); } },
  { id: "outside", get label() { return tr("common.outside_the_batch"); } },
];

/** Which monitoring group an entry belongs to, from the core's own state
 *  and readiness (never re-derived here). */
export function monitorGroup(entry: Pick<BatchEntryView, "state" | "readiness">): MonitorGroup {
  switch (entry.state) {
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "review":
      return "review";
    case "held":
      return "hold";
    case "failed":
    case "cancelled":
    case "missing":
      return "failed";
    case "done":
      return "completed";
    case "external":
      return "outside";
    case "pending":
      return entry.readiness.state === "ready" ? "ready" : "dependencies";
  }
}

export function groupEntries<T extends Pick<BatchEntryView, "state" | "readiness">>(entries: readonly T[]): Map<MonitorGroup, T[]> {
  const out = new Map<MonitorGroup, T[]>();
  for (const entry of entries) {
    const group = monitorGroup(entry);
    const list = out.get(group) ?? [];
    list.push(entry);
    out.set(group, list);
  }
  return out;
}

/** The view an action answered with (`{ batch }` or the view itself). */
export function viewOfAction(value: BatchView | { batch: BatchView }): BatchView {
  return "batch" in value && value.batch && typeof value.batch === "object" && "entries" in value.batch ? value.batch : (value as BatchView);
}

/** The batch carried in an error body (409s return the refreshed one). */
export function batchInError(body: unknown): BatchView | null {
  if (!body || typeof body !== "object") return null;
  const batch = (body as { batch?: unknown }).batch;
  return batch && typeof batch === "object" && "entries" in batch ? (batch as BatchView) : null;
}

/** Counts shown on a batch row and the monitoring header. */
export function batchCounts(view: Pick<BatchView, "entries">): Record<MonitorGroup, number> {
  const out: Record<MonitorGroup, number> = { running: 0, ready: 0, dependencies: 0, review: 0, hold: 0, completed: 0, failed: 0, outside: 0 };
  for (const entry of view.entries) out[monitorGroup(entry)] += 1;
  return out;
}

export function policySummary(policy: BatchPolicy): string {
  const parts = [
    tr("common.at_a_time", { p0: String(policy.maxParallel) }),
    `${policy.maxStarts} start${policy.maxStarts === 1 ? "" : "s"} max`,
    policy.maxRetriesPerTask > 0 ? tr("common.retr_per_task", { p0: String(policy.maxRetriesPerTask), p1: String(policy.maxRetriesPerTask === 1 ? "y" : "ies") }) : tr("common.no_retries"),
    policy.maxDurationMinutes ? tr("common.min_limit", { p0: String(policy.maxDurationMinutes) }) : tr("common.no_time_limit"),
  ];
  return parts.join(" · ");
}

/** Move one item up (-1) or down (+1) in an id list. */
export function moveId(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const at = ids.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

export function formatTime(at: number | null | undefined): string {
  if (!at) return "—";
  return new Date(at).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
