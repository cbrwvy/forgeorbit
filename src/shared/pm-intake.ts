/**
 * Owner / PM intake semantics (BACKLOG column vs Project inbox vs Needs you).
 *
 * - **Backlog column** — shared draft tasks (`column === "backlog"`). Not PM
 *   execution intake; creating or approving into Backlog never starts an agent.
 * - **Project inbox column** — admitted tasks awaiting PM triage
 *   (`column === "inbox"`). Shown in Manager → Project inbox; entering Inbox
 *   does not launch execution.
 * - **Pending proposals** — `TaskProposal` rows with `status === "pending"`.
 *   Owner approval creates Backlog tasks only. Listed under Pending proposals
 *   in the Manager tab, not mixed with inbox tasks.
 * - **Needs you** — task attention + owner approvals (`AttentionPage`,
 *   `/owner-actions`). Never rename it "Inbox".
 */

import type { TaskProposal } from "./project-manager.ts";
import type { ColumnId } from "./types.ts";

/** Pending task proposals awaiting Owner review. Newest first. */
export function pendingProjectInboxProposals(proposals: readonly TaskProposal[]): TaskProposal[] {
  return proposals.filter((p) => p.status === "pending").sort((a, b) => b.updatedAt - a.updatedAt);
}

export function isIntakeDraftColumn(column: ColumnId): boolean {
  return column === "backlog" || column === "inbox";
}
