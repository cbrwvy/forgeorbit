import { expect, test } from "bun:test";
import type { Task } from "../../shared/types.ts";
import { collectAttention, summarizeAttention, type AttentionTask } from "./attention";

// Compile-time guard: a real `Task` row must be accepted as-is by the aggregator.
export const fromBoard = (tasks: Task[]) => collectAttention(tasks);

const t = (over: Partial<AttentionTask> & { id: string }): AttentionTask => ({
  title: over.id, column: "backlog", updatedAt: 1, archivedAt: null, workdir: "/p/a", ...over,
});

test("only tasks that wait on the Owner are listed, most urgent first, then newest", () => {
  const items = collectAttention([
    t({ id: "idle" }),
    t({ id: "review-old", column: "review", updatedAt: 1 }),
    t({ id: "review-new", column: "review", updatedAt: 9 }),
    t({ id: "blocked", column: "blocked", updatedAt: 5 }),
    t({ id: "asking", column: "running", pendingInteractionCount: 2, updatedAt: 3 }),
    t({ id: "pipe", column: "running", pipelineRun: { status: "blocked", blocked: [{}] }, updatedAt: 4 }),
    t({ id: "fx", column: "ready", fxRecovery: { state: "paused", runId: "r", pausedAt: 1, autoResume: null, autoResumeCount: 0 } as never, updatedAt: 6 }),
  ]);
  expect(items.map((i) => [i.taskId, i.kind])).toEqual([
    ["asking", "answer"], ["pipe", "pipeline-blocked"], ["blocked", "blocked"], ["fx", "fx-paused"], ["review-new", "review"], ["review-old", "review"],
  ]);
  expect(items[0]!.count).toBe(2);
});

test("archived tasks and hidden pipeline step rows never appear", () => {
  expect(collectAttention([
    t({ id: "a", column: "review", archivedAt: 5 }),
    t({ id: "step", column: "blocked", pipelineParentId: "parent" }),
  ])).toEqual([]);
});

test("a question outranks the column it sits in, and each task is listed once", () => {
  const items = collectAttention([t({ id: "x", column: "blocked", pendingInteractionCount: 1 })]);
  expect(items).toHaveLength(1);
  expect(items[0]!.kind).toBe("answer");
});

test("qc-owner attention outranks ordinary review", () => {
  const items = collectAttention([
    t({ id: "plain-review", column: "review", updatedAt: 1 }),
    t({
      id: "qc-pass",
      column: "review",
      updatedAt: 2,
      qcState: { activeReviewId: null, awaitingOwnerApproval: true, latestVerdict: "PASS", reworkCount: 0, roundCount: 1, maxRounds: 5 },
    }),
  ]);
  expect(items.map((i) => [i.taskId, i.kind])).toEqual([
    ["qc-pass", "qc-owner"],
    ["plain-review", "review"],
  ]);
});

test("active QC review is not listed in Needs you", () => {
  expect(
    collectAttention([
      t({
        id: "qc-run",
        column: "review",
        qcState: { activeReviewId: "r1", awaitingOwnerApproval: false, latestVerdict: null, reworkCount: 0, roundCount: 0, maxRounds: 5 },
      }),
    ]),
  ).toEqual([]);
});

test("Project context filters by owning project; Global covers all of them", () => {
  const tasks = [
    t({ id: "a", column: "review", ownerProjectPath: "/p/a" }),
    t({ id: "b", column: "review", ownerProjectPath: "/p/b" }),
    t({ id: "c", column: "review", workdir: "/p/c" }),
  ];
  expect(collectAttention(tasks, { projectPath: "/p/b" }).map((i) => i.taskId)).toEqual(["b"]);
  expect(collectAttention(tasks, { projectPath: "/p/c" }).map((i) => i.taskId)).toEqual(["c"]);
  expect(collectAttention(tasks)).toHaveLength(3);
});

test("the summary names the most urgent kind for the orb/badge", () => {
  expect(summarizeAttention([])).toEqual({
    total: 0,
    byKind: { answer: 0, "pipeline-blocked": 0, blocked: 0, "fx-paused": 0, "qc-owner": 0, review: 0 },
    top: null,
  });
  const s = summarizeAttention(collectAttention([t({ id: "r", column: "review" }), t({ id: "b", column: "blocked" })]));
  expect(s.total).toBe(2);
  expect(s.top).toBe("blocked");
});
