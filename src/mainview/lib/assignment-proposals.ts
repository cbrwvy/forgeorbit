import { t as tr } from "@/i18n/core";
/**
 * Display helpers for assignment proposals (FO-010D). Labels only: nothing
 * here scores a worker, estimates fit, or implies that approval starts work.
 */

import { ApiError } from "./api";
import { proposalStatusLabel, type AssignmentProposal, type AssignmentProposalEvent, type ProposalStatus } from "../../shared/assignments/proposals.ts";

/** A decided-and-out-of-date proposal stays visible this long before it is only history. */
export const RECENT_STALE_MS = 24 * 60 * 60 * 1000;

export interface ProposalGroups {
  pending: AssignmentProposal[];
  recentStale: AssignmentProposal[];
  history: AssignmentProposal[];
}

export function groupProposals(proposals: readonly AssignmentProposal[], now: number): ProposalGroups {
  const pending: AssignmentProposal[] = [];
  const recentStale: AssignmentProposal[] = [];
  const history: AssignmentProposal[] = [];
  for (const proposal of proposals) {
    if (proposal.status === "pending") pending.push(proposal);
    else if (proposal.status === "stale" && proposal.decidedAt != null && now - proposal.decidedAt < RECENT_STALE_MS) recentStale.push(proposal);
    else history.push(proposal);
  }
  return { pending, recentStale, history };
}

export function proposalAuthorLabel(proposal: Pick<AssignmentProposal, "proposedBy">): string {
  const { kind, employeeName, delegationId } = proposal.proposedBy;
  if (kind === "owner") return tr("common.you");
  const who = employeeName ? tr("common.project_manager_592766", { p0: String(employeeName) }) : tr("common.project_manager");
  return delegationId ? tr("common.answering_a_portfolio_request_you_approved", { p0: String(who) }) : who;
}

export function proposalStatusTone(status: ProposalStatus): "success" | "warning" | "danger" | "muted" | "info" {
  switch (status) {
    case "pending": return "info";
    case "approved": return "success";
    case "stale": return "warning";
    case "rejected": return "danger";
    case "cancelled": return "muted";
  }
}

export { proposalStatusLabel };

/** The request body the owner's Approve click sends: exactly what they saw. */
export function approveRequestFor(proposal: Pick<AssignmentProposal, "revision" | "currentAssignment">, allowReassign: boolean) {
  return {
    expectedRevision: proposal.revision,
    expectedAssignmentRevision: proposal.currentAssignment?.revision ?? null,
    allowReassign,
  };
}

/** Approve is allowed only when nothing blocks it and, if it replaces a worker, the owner said so. */
export function canApprove(proposal: Pick<AssignmentProposal, "status" | "needsReassign" | "conflicts" | "currentAssignment">, consent: boolean): boolean {
  if (proposal.status !== "pending") return false;
  const blocking = proposal.conflicts.length > 0 && !proposal.needsReassign;
  if (blocking) return false;
  return !proposal.needsReassign || consent;
}

export function reassignConsentLabel(proposal: Pick<AssignmentProposal, "worker" | "currentAssignment">): string {
  const from = proposal.currentAssignment?.employeeName ?? tr("common.the_current_worker");
  return tr("common.replace_with", { p0: String(from), p1: String(proposal.worker.name ?? tr("common.this_worker")) });
}

export function proposalEventLabel(event: Pick<AssignmentProposalEvent, "action" | "actor" | "reassign" | "note">): string {
  const who = event.actor === "owner" ? tr("common.you") : event.actor === "project-manager" ? tr("common.project_manager") : tr("common.system");
  switch (event.action) {
    case "created": return tr("common.proposed_this_worker", { p0: String(who) });
    case "approved": return event.reassign ? tr("common.approved_it_and_replaced_the_previous_worker", { p0: String(who) }) : tr("common.approved_it", { p0: String(who) });
    case "rejected": return tr("common.rejected_it", { p0: String(who) });
    case "cancelled": return tr("common.cancelled_it", { p0: String(who) });
    case "stale": return event.note ? tr("common.out_of_date", { p0: String(event.note) }) : tr("common.out_of_date_b6715b");
  }
}

export function proposalErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const raw = error.message.trim();
    if (error.status === 401) return tr("common.the_app_is_not_authorized_reload_it");
    if (raw && raw.length <= 300) return raw;
  }
  const raw = error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string"
    ? (error as { message: string }).message.trim()
    : "";
  return raw && raw.length <= 300 ? raw : tr("common.couldn_t_complete_the_proposal_request");
}

/** The proposal inside a 409 body, when the core attached the now-current state. */
export function proposalFromError(error: unknown): AssignmentProposal | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (body && typeof body === "object" && "proposal" in body) {
    const proposal = (body as { proposal?: unknown }).proposal;
    if (proposal && typeof proposal === "object" && "id" in proposal && "status" in proposal) return proposal as AssignmentProposal;
  }
  return null;
}

export const PROPOSAL_NOTE =
  "A proposal is only a suggestion. Approving it records who is responsible for the task. It does not start a run, choose a model, or switch an account.";
