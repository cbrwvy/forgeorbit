import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
/**
 * Cluster dashboard view-model (FO-011B).
 *
 * Formatting and comparison run on data the page already fetched from the
 * cluster API. Nothing here starts an agent, writes a project, or adds a
 * second portfolio analysis.
 */

import { formatDurationMs } from "@/i18n/estimation";
import type { ConfidenceLevel } from "../../shared/estimation/types.ts";
import type { ClusterAggregate } from "../../shared/clusters/aggregate.ts";
import type { Cluster } from "../../shared/clusters/types.ts";
import type { CountFact, PortfolioCalendar, PortfolioEstimation } from "../../shared/portfolio/types.ts";
import { formatCount, formatPortfolioDuration, formatPortfolioMoney } from "./portfolio.ts";

export const COMPARISON_FOOTNOTE =
  "Rows are not added together. A subscription shared by more than one space is not summed. Mixed currencies are not converted. An unknown resource is not treated as unlimited.";

export interface ClusterDraft {
  name: string;
  description: string;
  slug: string;
  color: string;
  icon: string;
  priority: string;
}

export interface ClusterCardMetrics {
  projects: string;
  active: string;
  tasks: string;
  runs: string;
  blockers: string;
  reviews: string;
  estimate: string;
  quality: string;
}

export interface ClusterComparisonRow {
  id: string;
  name: string;
  archived: boolean;
  projects: string;
  activeProjects: string;
  blockedProjects: string;
  pendingReviews: string;
  activeRuns: string;
  agentTime: string;
  calendar: string;
  additionalCosts: string;
  additionalReason: string | null;
  confidence: string;
  confidenceReason: string | null;
}

export interface ClusterComparison {
  rows: ClusterComparisonRow[];
  totals: "omitted";
  reason: string;
}

export function emptyClusterDraft(): ClusterDraft {
  return { name: "", description: "", slug: "", color: "", icon: "", priority: "" };
}

export function draftFromCluster(cluster: Cluster): ClusterDraft {
  return {
    name: cluster.name,
    description: cluster.description,
    slug: cluster.slug ?? "",
    color: cluster.color ?? "",
    icon: cluster.icon ?? "",
    priority: cluster.priority == null ? "" : String(cluster.priority),
  };
}

/** Name is required. Other fields are sent so an edit can clear them. The server still validates. */
export function clusterWriteBody(draft: ClusterDraft): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: tr("common.name_is_required") };
  const body: Record<string, unknown> = {
    name,
    description: draft.description,
    slug: draft.slug.trim() ? draft.slug.trim() : null,
    color: draft.color.trim() ? draft.color.trim() : null,
    icon: draft.icon.trim() ? draft.icon.trim() : null,
  };
  if (draft.priority.trim() === "") {
    body.priority = null;
  } else if (!/^\d+$/.test(draft.priority.trim())) {
    return { ok: false, error: tr("common.priority_must_be_a_whole_number_or_empty") };
  } else {
    body.priority = Number(draft.priority.trim());
  }
  return { ok: true, body };
}

export function isCurrentClusterRequest(requestId: number, latestId: number): boolean {
  return requestId === latestId;
}

export function clusterErrorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return tr("common.couldn_t_reach_clusters");
}

export function completenessLabel(status: "complete" | "partial" | "unknown" | null | undefined): string {
  if (status === "complete") return tr("common.complete");
  if (status === "partial") return tr("common.partial");
  return tr("common.unknown");
}

export function priorityLabel(priority: number | null): string {
  return priority == null ? tr("common.unset") : String(priority);
}

export function clusterCardMetrics(cluster: Cluster, aggregate: ClusterAggregate | null, failed: boolean): ClusterCardMetrics {
  const projects = String(cluster.projectCount);
  if (!aggregate) {
    const unknown = failed ? tr("common.unknown") : "…";
    return {
      projects,
      active: unknown,
      tasks: unknown,
      runs: unknown,
      blockers: unknown,
      reviews: unknown,
      estimate: unknown,
      quality: unknown,
    };
  }
  return {
    projects,
    active: formatCount(aggregate.activeProjects),
    tasks: formatCount(aggregate.counts.tasks),
    runs: formatCount(aggregate.counts.activeRuns),
    blockers: formatCount(aggregate.counts.blockers),
    reviews: formatCount(aggregate.counts.pendingReviews),
    estimate: estimateLabel(aggregate.estimation),
    quality: completenessLabel(aggregate.completeness),
  };
}

export function estimateLabel(estimation: PortfolioEstimation | null | undefined): string {
  if (!estimation) return tr("common.unknown");
  return formatPortfolioDuration(estimation.agent);
}

export function formatClusterCalendar(calendar: PortfolioCalendar | null | undefined): string {
  if (!calendar || calendar.status === "unknown") return tr("common.unknown");
  if ((calendar.status === "known" || calendar.status === "estimated") && calendar.ms != null) return formatDurationMs(calendar.ms);
  if (calendar.status === "incomplete") return tr("common.partial");
  return tr("common.unknown");
}

export function confidenceLabel(level: ConfidenceLevel | null | undefined): string {
  if (level === "low" || level === "medium" || level === "high") {
    return level.slice(0, 1).toUpperCase() + level.slice(1);
  }
  if (level === "none") return tr("common.none_dc937b");
  return tr("common.unknown");
}

export function additionalCostText(aggregate: ClusterAggregate | null): { text: string; reason: string | null } {
  if (!aggregate?.estimation) {
    return { text: tr("common.unknown"), reason: tr("common.no_estimate_was_recorded_unknown_cost_was_not") };
  }
  const cash = aggregate.estimation.additionalCash;
  const shared = aggregate.exclusiveSubscriptionFees === "unknown"
    ? tr("common.a_subscription_is_also_used_outside_this_cluster")
    : null;
  if (cash.status === "mixed-currency") {
    return {
      text: tr("common.mixed_currencies"),
      reason: [cash.note, "Currencies were not converted into one sum.", shared].filter(Boolean).join(" "),
    };
  }
  return { text: formatPortfolioMoney(cash), reason: [cash.note, shared].filter(Boolean).join(" ") || null };
}

export function environmentLabel(aggregate: ClusterAggregate | null): { label: string; reason: string } {
  if (!aggregate?.environments || aggregate.environments.status === "unknown") {
    return {
      label: tr("common.unknown"),
      reason: aggregate?.environments?.note ?? "Environment phase was not read. It was not treated as current.",
    };
  }
  const stale = aggregate.projectEnvironments.filter((row) => row.freshness !== "current");
  if (aggregate.environments.status === "incomplete" || stale.length > 0) {
    return { label: "Partial", reason: "A stale or unproven environment phase is not shown as current." };
  }
  return {
    label: "Known",
    reason: aggregate.environments.note ?? "Recorded project environment phases. This is not a server status.",
  };
}

export function resourceWarningLines(aggregate: ClusterAggregate | null): string[] {
  if (!aggregate) return [tr("common.resource_data_was_not_read_unknown_capacity_was")];
  const lines: string[] = [];
  for (const quota of aggregate.quotas) {
    if (quota.quota.kind === "unknown" || quota.capacity === "unknown") {
      lines.push(`${quota.resourceId}: quota is unknown and is not treated as unlimited.`);
    }
  }
  for (const conflict of aggregate.conflicts) {
    lines.push(conflict.explanation);
  }
  return lines;
}

export function countOrUnknown(fact: CountFact | null | undefined): string {
  return formatCount(fact);
}

export interface ComparisonInput {
  cluster: Cluster;
  aggregate: ClusterAggregate | null;
  unavailableReason?: string | null;
}

export function compareClusters(inputs: readonly ComparisonInput[]): ClusterComparison {
  return {
    totals: "omitted",
    reason: staticLabel(COMPARISON_FOOTNOTE),
    rows: inputs.map((input) => {
      const aggregate = input.aggregate;
      const cost = additionalCostText(aggregate);
      const unavailable = input.unavailableReason ?? null;
      return {
        id: input.cluster.id,
        name: input.cluster.name,
        archived: input.cluster.archivedAt != null,
        projects: String(input.cluster.projectCount),
        activeProjects: aggregate ? formatCount(aggregate.activeProjects) : tr("common.unknown"),
        blockedProjects: aggregate ? formatCount(aggregate.blockedProjects) : tr("common.unknown"),
        pendingReviews: aggregate ? formatCount(aggregate.counts.pendingReviews) : tr("common.unknown"),
        activeRuns: aggregate ? formatCount(aggregate.counts.activeRuns) : tr("common.unknown"),
        agentTime: aggregate ? estimateLabel(aggregate.estimation) : tr("common.unknown"),
        calendar: aggregate ? formatClusterCalendar(aggregate.estimation?.calendar) : tr("common.unknown"),
        additionalCosts: unavailable && !aggregate ? tr("common.unknown") : cost.text,
        additionalReason: unavailable ?? cost.reason,
        confidence: aggregate?.estimation ? confidenceLabel(aggregate.estimation.confidence) : completenessLabel(aggregate?.completeness),
        confidenceReason: unavailable
          ?? aggregate?.estimation?.confidenceNote
          ?? (aggregate ? null : tr("common.the_summary_was_not_available_so_confidence_is")),
      };
    }),
  };
}

export function archiveConfirmCopy(name: string, projectCount: number): { title: string; body: string } {
  const shared = tr("spaces.archive_note");
  if (projectCount > 0) {
    return {
      get title() { return tr("common.archive_c39c49", { p0: String(name) }); },
      body: tr("common.has_project", { p0: String(name), p1: String(projectCount), p2: String(projectCount === 1 ? "" : "s"), p3: String(shared) }),
    };
  }
  return { get title() { return tr("common.archive_c39c49", { p0: String(name) }); }, body: shared };
}

export function moveConfirmCopy(projectName: string, fromName: string, toName: string): { title: string; body: string } {
  return {
    get title() { return tr("common.move", { p0: String(projectName) }); },
    get body() { return tr("common.moves_from_to_this_changes_only_organizational_membership", { p0: String(projectName), p1: String(fromName), p2: String(toName) }); },
  };
}

export function unassignConfirmCopy(projectName: string, clusterName: string): { title: string; body: string } {
  return {
    get title() { return tr("common.remove_from", { p0: String(projectName), p1: String(clusterName) }); },
    get body() { return tr("common.leaves_this_removes_only_organizational_membership_the_project", { p0: String(projectName), p1: String(clusterName) }); },
  };
}
