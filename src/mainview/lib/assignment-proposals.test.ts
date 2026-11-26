import { expect, test } from "bun:test";
import { PROPOSAL_EXECUTION_NOTE, type AssignmentProposal } from "../../shared/assignments/proposals.ts";
import {
  RECENT_STALE_MS,
  approveRequestFor,
  canApprove,
  groupProposals,
  proposalAuthorLabel,
  proposalErrorText,
  proposalEventLabel,
  proposalFromError,
  reassignConsentLabel,
} from "./assignment-proposals.ts";
import { ApiError } from "./api.ts";

function proposal(over: Partial<AssignmentProposal> = {}): AssignmentProposal {
  return {
    id: "p", taskId: "t", projectPath: "/a", projectName: "A", projectRegistered: true,
    task: { title: "Task", column: "ready", archived: false, visibility: "in-project" },
    worker: { id: "w", name: "Ada", jobTitle: "QA", status: "active", archived: false, projectPath: "/a" },
    proposedBy: { kind: "project-manager", employeeId: "m", employeeName: "Max", delegationId: null },
    rationale: "Fits", status: "pending", revision: 1, createdAt: 1, updatedAt: 1, decidedAt: null, decidedFromRevision: null,
    staleReason: null, baseAssignment: null, currentAssignment: null, needsReassign: false, conflicts: [], result: null,
    execution: PROPOSAL_EXECUTION_NOTE,
    ...over,
  };
}

test("groups pending, recently stale, and history", () => {
  const now = 10 * RECENT_STALE_MS;
  const groups = groupProposals([
    proposal({ id: "1" }),
    proposal({ id: "2", status: "stale", decidedAt: now - 1000, staleReason: "x" }),
    proposal({ id: "3", status: "stale", decidedAt: now - RECENT_STALE_MS - 1, staleReason: "x" }),
    proposal({ id: "4", status: "approved", decidedAt: now - 5 }),
    proposal({ id: "5", status: "rejected", decidedAt: now - 5 }),
  ], now);
  expect(groups.pending.map((p) => p.id)).toEqual(["1"]);
  expect(groups.recentStale.map((p) => p.id)).toEqual(["2"]);
  expect(groups.history.map((p) => p.id)).toEqual(["3", "4", "5"]);
});

test("the author label never promotes a manager to owner", () => {
  expect(proposalAuthorLabel(proposal({ proposedBy: { kind: "owner", employeeId: null, employeeName: null, delegationId: null } }))).toBe("You");
  expect(proposalAuthorLabel(proposal())).toBe("Project Manager Max");
  expect(proposalAuthorLabel(proposal({ proposedBy: { kind: "project-manager", employeeId: null, employeeName: null, delegationId: "d" } }))).toContain("Portfolio request");
});

test("Approve needs the replace consent exactly when another worker holds the task", () => {
  const free = proposal();
  expect(canApprove(free, false)).toBe(true);
  const held = proposal({ needsReassign: true, currentAssignment: { assignmentId: "a", employeeId: "o", employeeName: "Olga", revision: 3 }, conflicts: ["held"] });
  expect(canApprove(held, false)).toBe(false);
  expect(canApprove(held, true)).toBe(true);
  expect(reassignConsentLabel(held)).toBe("Replace Olga with Ada");
  expect(approveRequestFor(held, true)).toEqual({ expectedRevision: 1, expectedAssignmentRevision: 3, allowReassign: true });
  expect(approveRequestFor(free, false)).toEqual({ expectedRevision: 1, expectedAssignmentRevision: null, allowReassign: false });
  expect(canApprove(proposal({ conflicts: ["The task was archived."] }), true)).toBe(false);
  expect(canApprove(proposal({ status: "stale" }), true)).toBe(false);
});

test("event labels and error helpers", () => {
  expect(proposalEventLabel({ action: "approved", actor: "owner", reassign: true, note: null })).toContain("replaced");
  expect(proposalEventLabel({ action: "stale", actor: "system", reassign: null, note: "The task was archived." })).toBe("Out of date: The task was archived.");
  const stale = proposal({ status: "stale", staleReason: "x" });
  const err = new ApiError("The task's assignment changed after this was proposed.", 409, { proposal: stale });
  expect(proposalFromError(err)?.id).toBe("p");
  expect(proposalFromError(new Error("x"))).toBeNull();
  expect(proposalErrorText(err)).toBe("The task's assignment changed after this was proposed.");
  expect(proposalErrorText(new Error("y".repeat(500)))).toBe("Couldn't complete the proposal request.");
});
