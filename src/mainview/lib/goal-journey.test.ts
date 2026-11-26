import { describe, expect, test } from "bun:test";
import { journeyOrder, journeyRowOf, qcOutcomeOf } from "./goal-journey";
import type { Task } from "../../shared/types.ts";

const qc = (over: Partial<NonNullable<Task["qcState"]>> = {}): NonNullable<Task["qcState"]> => ({
  activeReviewId: null, awaitingOwnerApproval: false, latestVerdict: null, reworkCount: 0, roundCount: 0, maxRounds: 3, ...over,
});
const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", title: "Task", column: "backlog", archivedAt: null, agent: "claude-code", model: null, runId: null, updatedAt: 1, pipelineParentId: null, ...over,
} as Task);

describe("qcOutcomeOf", () => {
  test("no state or no verdict is 'not run', never a pass", () => {
    expect(qcOutcomeOf(task())).toBe("not-run");
    expect(qcOutcomeOf(task({ qcState: qc() }))).toBe("not-run");
  });
  test("each verdict reads as its own word", () => {
    expect(qcOutcomeOf(task({ qcState: qc({ latestVerdict: "PASS" }) }))).toBe("passed");
    expect(qcOutcomeOf(task({ qcState: qc({ latestVerdict: "CHANGES_REQUESTED" }) }))).toBe("failed");
    expect(qcOutcomeOf(task({ qcState: qc({ latestVerdict: "BLOCKED" }) }))).toBe("blocked");
    expect(qcOutcomeOf(task({ qcState: qc({ activeReviewId: "r1", latestVerdict: "PASS" }) }))).toBe("running");
  });
});

describe("journeyRowOf", () => {
  test("a task that finished without a quality check offers no Accept", () => {
    const row = journeyRowOf(task({ column: "review" }));
    expect(row.phase).toBe("awaiting-qc");
    expect(row.qc).toBe("not-run");
    expect(row.canAccept).toBe(false);
    expect(row.needsYou).toBe(false);
  });
  test("QC PASS waiting on the Owner offers Accept and needs the Owner", () => {
    const row = journeyRowOf(task({ column: "review", qcState: qc({ latestVerdict: "PASS", awaitingOwnerApproval: true, roundCount: 1 }) }));
    expect(row).toMatchObject({ phase: "awaiting-owner-acceptance", qc: "passed", canAccept: true, needsYou: true });
  });
  test("a pass that is no longer waiting on the Owner (or failed or blocked) never offers Accept", () => {
    for (const verdict of ["PASS", "CHANGES_REQUESTED", "BLOCKED"] as const) {
      const row = journeyRowOf(task({ column: "review", qcState: qc({ latestVerdict: verdict, awaitingOwnerApproval: false, roundCount: 1 }) }));
      expect(row.canAccept).toBe(false);
    }
  });
  test("archived, pipeline-step and done tasks never offer Accept", () => {
    const waiting = qc({ latestVerdict: "PASS", awaitingOwnerApproval: true, roundCount: 1 });
    expect(journeyRowOf(task({ column: "review", qcState: waiting, archivedAt: 5 })).canAccept).toBe(false);
    expect(journeyRowOf(task({ column: "review", qcState: waiting, pipelineParentId: "p" })).canAccept).toBe(false);
    expect(journeyRowOf(task({ column: "done", qcState: waiting })).canAccept).toBe(false);
  });
  test("running reads as active, blocked as needing the Owner", () => {
    expect(journeyRowOf(task({ column: "running" })).active).toBe(true);
    expect(journeyRowOf(task({ column: "blocked" })).needsYou).toBe(true);
  });
});

describe("journeyOrder", () => {
  test("needs-you first, then running, then the rest, finished last", () => {
    const ordered = journeyOrder([
      task({ id: "done", column: "done", updatedAt: 9 }),
      task({ id: "backlog", column: "backlog", updatedAt: 8 }),
      task({ id: "running", column: "running", updatedAt: 1 }),
      task({ id: "blocked", column: "blocked", updatedAt: 2 }),
    ]).map((item) => item.task.id);
    expect(ordered).toEqual(["blocked", "running", "backlog", "done"]);
  });
});
