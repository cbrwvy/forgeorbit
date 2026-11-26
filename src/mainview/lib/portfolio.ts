import { intlLocale, t as tr } from "@/i18n/core";

/**
 * Portfolio dashboard view-model (FO-008B).
 *
 * Sorting, filtering, and what-if patches run on data the page already
 * fetched. Nothing here calls a model or writes a project.
 */

import type { ConfidenceLevel, Money } from "../../shared/estimation/types.ts";
import { formatDurationMs, formatMoney } from "@/i18n/estimation";
import type { TaskPriority } from "../../shared/task-scheduling.ts";
import type {
  CountFact,
  PortfolioAnalysis,
  PortfolioDuration,
  PortfolioMoney,
  PortfolioWhatIfPatch,
  ProjectSummary,
  ResourceConflict,
} from "../../shared/portfolio/index.ts";
import type { ProjectSurfacePage, WorkspacePage } from "./workspace.ts";

export const PORTFOLIO_REFRESH_EVENTS = ["execution_batch", "environment_status", "task_dependencies", "harness_usage", "project_lifecycle", "reconnect"] as const;

export type PortfolioRefreshReason = (typeof PORTFOLIO_REFRESH_EVENTS)[number] | "focus" | "open";

export type PortfolioSort =
  | "name"
  | "tasks"
  | "runs"
  | "blocked"
  | "review"
  | "calendar"
  | "cash"
  | "confidence"
  | "conflicts";

export type PortfolioFilter = "all" | "attention" | "review" | "blocked" | "running";

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function formatCount(fact: CountFact | null | undefined): string {
  if (!fact || fact.status === "unknown") return tr("common.unknown");
  if (fact.status === "incomplete") {
    return fact.knownValue == null ? tr("common.partial") : tr("common.partial_known", { p0: String(fact.knownValue) });
  }
  return fact.value == null ? tr("common.unknown") : String(fact.value);
}

export function formatPortfolioDuration(duration: PortfolioDuration | null | undefined): string {
  if (!duration || duration.status === "unknown") return tr("common.unknown");
  if (duration.ms != null && (duration.status === "known" || duration.status === "estimated")) return formatDurationMs(duration.ms);
  if (duration.status === "incomplete") {
    return duration.knownMs == null ? tr("common.partial") : tr("common.partial_known", { p0: String(formatDurationMs(duration.knownMs)) });
  }
  return tr("common.unknown");
}

export function formatPortfolioMoney(money: PortfolioMoney | null | undefined): string {
  if (!money) return tr("common.unknown");
  if (money.status === "not-requested") return tr("common.not_requested");
  if (money.status === "mixed-currency") return tr("common.mixed_currencies");
  if (money.status === "unknown") return tr("common.unknown");
  if (money.status === "incomplete") {
    return money.knownPortion ? tr("common.partial_812250", { p0: String(formatMoney(money.knownPortion)) }) : tr("common.partial");
  }
  return money.money ? formatMoney(money.money) : tr("common.unknown");
}

export function formatMinor(money: Money | null | undefined): string {
  return money ? formatMoney(money) : tr("common.unknown");
}

export function isPortfolioRefreshEvent(type: string): boolean {
  return (PORTFOLIO_REFRESH_EVENTS as readonly string[]).includes(type);
}

/** True when this response is still the newest request. */
export function isCurrentPortfolioRequest(requestId: number, latestId: number): boolean {
  return requestId === latestId;
}

export interface ComparisonRow {
  project: ProjectSummary;
  calendarMs: number | null;
  cashMinor: number | null;
  cashCurrency: string | null;
  confidence: ConfidenceLevel | null;
  conflictCount: number;
}

export function comparisonRows(analysis: PortfolioAnalysis): ComparisonRow[] {
  const slices = new Map((analysis.estimation?.projects ?? []).map((project) => [project.projectId, project]));
  return analysis.projects.map((project) => {
    const slice = slices.get(project.projectId);
    const cash = slice?.additionalCash;
    const money = cash?.status === "known" ? cash.money : null;
    return {
      project,
      calendarMs: slice?.calendar?.status === "known" || slice?.calendar?.status === "estimated" ? slice.calendar.ms : null,
      cashMinor: money?.minor ?? null,
      cashCurrency: money?.currency ?? null,
      confidence: slice?.confidence ?? null,
      conflictCount: analysis.conflicts.filter((conflict) => conflict.class === "confirmed" && conflict.projectIds.includes(project.projectId)).length,
    };
  });
}

export function filterComparison(rows: readonly ComparisonRow[], filter: PortfolioFilter, attentionIds: readonly string[]): ComparisonRow[] {
  const attention = new Set(attentionIds);
  return rows.filter((row) => {
    if (filter === "attention") return attention.has(row.project.projectId);
    if (filter === "review") return (row.project.reviewCount ?? 0) > 0;
    if (filter === "blocked") return (row.project.blockedCount ?? 0) > 0;
    if (filter === "running") return (row.project.activeRunCount ?? 0) > 0;
    return true;
  });
}

export function sortComparison(rows: readonly ComparisonRow[], sort: PortfolioSort): ComparisonRow[] {
  const copy = [...rows];
  copy.sort((a, b) => compareRow(a, b, sort) || a.project.path.localeCompare(b.project.path));
  return copy;
}

function compareRow(a: ComparisonRow, b: ComparisonRow, sort: PortfolioSort): number {
  if (sort === "name") return labelOf(a).localeCompare(labelOf(b));
  if (sort === "tasks") return numberSort(a.project.taskCount, b.project.taskCount);
  if (sort === "runs") return numberSort(a.project.activeRunCount, b.project.activeRunCount);
  if (sort === "blocked") return numberSort(a.project.blockedCount, b.project.blockedCount);
  if (sort === "review") return numberSort(a.project.reviewCount, b.project.reviewCount);
  if (sort === "calendar") return numberSort(a.calendarMs, b.calendarMs);
  if (sort === "cash") return numberSort(a.cashMinor, b.cashMinor);
  if (sort === "confidence") return numberSort(a.confidence ? CONFIDENCE_RANK[a.confidence] : null, b.confidence ? CONFIDENCE_RANK[b.confidence] : null);
  return numberSort(a.conflictCount, b.conflictCount);
}

function numberSort(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

function labelOf(row: ComparisonRow): string {
  return row.project.name?.trim() || row.project.path;
}

export interface WhatIfDraft {
  excludedProjectIds: string[];
  priorities: Array<{ projectId: string; priority: TaskPriority }>;
  concurrency: Array<{ resourceId: string; limit: number }>;
}

export function buildWhatIfPatch(draft: WhatIfDraft): PortfolioWhatIfPatch | null {
  const patch: PortfolioWhatIfPatch = {};
  if (draft.excludedProjectIds.length > 0) patch.excludeProjectIds = [...draft.excludedProjectIds];
  if (draft.priorities.length > 0) {
    patch.projectPriorities = draft.priorities.map((item) => ({
      projectId: item.projectId,
      priority: item.priority,
      origin: "user-provided" as const,
    }));
  }
  if (draft.concurrency.length > 0) {
    patch.concurrency = draft.concurrency.map((item) => ({
      resourceId: item.resourceId,
      limit: item.limit,
      origin: "user-provided" as const,
    }));
  }
  return patch.excludeProjectIds || patch.projectPriorities || patch.concurrency ? patch : null;
}

export interface AttentionLink {
  id: string;
  projectId: string;
  title: string;
  detail: string;
  page: WorkspacePage | "portfolio";
  taskId: string | null;
}

export function attentionLinks(analysis: PortfolioAnalysis): AttentionLink[] {
  const links: AttentionLink[] = [];
  for (const health of analysis.health) {
    for (const finding of health.findings) {
      if (!finding.current) continue;
      if (finding.signal === "active" || finding.signal === "idle") continue;
      links.push({
        id: `${health.projectId}:${finding.source}:${finding.signal}`,
        projectId: health.projectId,
        title: attentionTitle(finding.signal),
        detail: finding.explanation,
        page: pageFor(finding.signal, finding.source),
        taskId: finding.source === "column" ? finding.evidence[0] ?? null : null,
      });
    }
  }
  for (const conflict of analysis.conflicts) {
    if (conflict.class === "potential") continue;
    links.push(conflictLink(conflict));
  }
  return links;
}

function attentionTitle(signal: string): string {
  if (signal === "waiting-for-owner") return tr("common.review_needed");
  if (signal === "blocked") return tr("common.blocked");
  if (signal === "degraded") return tr("common.degraded_environment");
  if (signal === "needs-attention") return tr("common.needs_attention");
  return tr("common.missing_information");
}

function pageFor(signal: string, source: string): ProjectSurfacePage {
  if (source === "environment" || signal === "degraded") return "environment";
  if (source === "batch") return "manager";
  if (source === "run") return "board";
  return "board";
}

function conflictLink(conflict: ResourceConflict): AttentionLink {
  return {
    id: conflict.id,
    projectId: conflict.projectIds[0] ?? "",
    title: conflict.class === "confirmed" ? tr("common.resource_conflict") : tr("common.resource_data_missing"),
    detail: conflict.explanation,
    page: "portfolio",
    taskId: null,
  };
}

/**
 * A stored environment phase with the time it was recorded. The portfolio
 * read does not probe the environment, so a phase older than the snapshot's
 * staleness window (or with no recording time) is shown as Unknown, with the
 * last recording kept as history.
 */
export function environmentPhaseLabel(
  phase: string | null,
  recordedAtMs: number | null,
  capturedAtMs: number,
  stalenessAfterMs: number | null,
): string {
  if (phase == null) return "unknown";
  if (recordedAtMs == null) return `unknown (last recorded ${phase} at an unknown time, not confirmed current)`;
  const recorded = new Date(recordedAtMs).toLocaleString(intlLocale());
  if (stalenessAfterMs == null || capturedAtMs - recordedAtMs > stalenessAfterMs) {
    return `unknown (last recorded ${phase} on ${recorded}, not confirmed current)`;
  }
  return `${phase} (recorded ${recorded})`;
}
