/**
 * One answer to "what waits for the Owner?" (FO-UX02-D stage 2 → UX02-E).
 *
 * The rail's "Needs you" badge, the "Needs you" page and the Head of PM orb all
 * count the same three things, from the stores that already hold them:
 *
 *  - tasks that wait on the Owner (`collectAttention`: a question, a result to
 *    review, a block, a paused run, a blocked pipeline);
 *  - approvals: pending task proposals and delegations (`/owner-actions`);
 *  - execution batches on hold: paused, approved-but-not-started, stopped on a limit.
 *
 * They stay apart in the wording. A blocked task is "needs you", never "an
 * approval"; a task that merely waits for another task's dependency is not
 * listed at all because nothing is needed from the Owner. Resource and quota
 * gaps are information on the page, not counted here.
 */

import { collectAttention, summarizeAttention, type AttentionSummary, type AttentionTask } from "./attention";
import { getLocale, plural, t as tr } from "@/i18n/core";
import type { OwnerActionsPayload } from "../../shared/owner-actions.ts";

export interface OwnerActions {
  /** Tasks waiting on the Owner, same source as the "Needs you" page. */
  tasks: AttentionSummary;
  /** Pending task proposals and delegations. */
  approvals: number;
  /** Execution batches on hold. */
  holds: number;
  /** Independent ("Work independently") tasks that stopped on one real decision. */
  independent: number;
  total: number;
}

export const EMPTY_OWNER_ROWS: OwnerActionsPayload = { proposals: [], memoryProposals: [], delegations: [], batchHolds: [], orchestratedWorkflowHolds: [], orchestratedBatchHolds: [], deploymentRequestHolds: [] };

export function ownerActions(tasks: readonly AttentionTask[], opts: { projectPath?: string | null; rows?: OwnerActionsPayload | null }): OwnerActions {
  const summary = summarizeAttention(collectAttention(tasks, { projectPath: opts.projectPath }));
  const rows = opts.rows ?? EMPTY_OWNER_ROWS;
  const inScope = <T extends { projectPath: string }>(list: readonly T[]) => (opts.projectPath ? list.filter((row) => row.projectPath === opts.projectPath) : list);
  const approvals = inScope(rows.proposals).length
    + inScope(rows.memoryProposals ?? []).length
    + inScope(rows.delegations).length
    + inScope(rows.deploymentRequestHolds ?? []).length
    + inScope(rows.projectPermissionRequests ?? []).length;
  const holds = inScope(rows.batchHolds).length + inScope(rows.orchestratedWorkflowHolds ?? []).length;
  const independent = inScope(rows.handsoffBlockers ?? []).length;
  return { tasks: summary, approvals, holds, independent, total: summary.total + approvals + holds + independent };
}

const form = (n: number) => plural(getLocale(), n, { one: "one", few: "few", many: "many", other: "other" });

/** "2 tasks need you · 1 approval waiting · 1 batch on hold", or the empty sentence. */
export function ownerActionsText(actions: OwnerActions): string {
  if (actions.total === 0) return tr("uxfix.owner.none");
  const parts: string[] = [];
  if (actions.tasks.total > 0) parts.push(tr(`uxfix.owner.tasks_${form(actions.tasks.total)}` as "uxfix.owner.tasks_one", { count: actions.tasks.total }));
  if (actions.approvals > 0) parts.push(tr(`uxfix.owner.approvals_${form(actions.approvals)}` as "uxfix.owner.approvals_one", { count: actions.approvals }));
  if (actions.independent > 0) parts.push(tr(`handsoff.owner.count_${form(actions.independent)}` as "handsoff.owner.count_one", { count: actions.independent }));
  if (actions.holds > 0) parts.push(tr(`uxfix.owner.holds_${form(actions.holds)}` as "uxfix.owner.holds_one", { count: actions.holds }));
  return parts.join(" · ");
}
