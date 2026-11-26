import { expect, test } from "bun:test";
import { derivePlan, planCycle, startableNodes, type PlanTaskFacts } from "./task-plan.ts";
import type { ProposalItem, TaskProposal } from "./project-manager.ts";
import type { ColumnId } from "./types.ts";

/** FO-ORCH04: pure plan derivation, no database. */
const item = (id: string, title: string, deps: string[] = [], extra: Partial<ProposalItem> = {}): ProposalItem => ({
  id, title, description: "d", priority: "medium", acceptanceCriteria: ["x"],
  dependsOn: deps.map((itemId) => ({ kind: "item" as const, itemId })), parentFeature: null, taskType: "task",
  rationale: "", include: true, duplicate: null, duplicateAction: "use-existing", warnings: [], result: null, ...extra,
});
const created = (taskId: string): ProposalItem["result"] => ({ status: "created", taskId, error: null, at: 1 });
const proposal = (items: ProposalItem[], status: TaskProposal["status"] = "approved"): TaskProposal => ({
  id: "p", projectPath: "/p", messageId: "m", title: "Goal", summary: "", status, items, createdAt: 1, updatedAt: 1, revision: 1,
});

function plan(items: ProposalItem[], boards: Record<string, { column: ColumnId; deps?: string[] }>, status: TaskProposal["status"] = "approved") {
  const facts = (id: string): PlanTaskFacts | null => {
    const row = boards[id];
    return row
      ? { exists: true, inProject: true, title: id, column: row.column, archived: false, live: false, priority: "normal", dependsOn: row.deps ?? [], assignment: null, pendingAssignmentProposalId: null }
      : null;
  };
  return derivePlan({
    proposal: proposal(items, status),
    task: (id) => facts(id) ?? { exists: false, inProject: false, title: id, column: "backlog", archived: false, live: false, priority: "normal", dependsOn: [], assignment: null, pendingAssignmentProposalId: null },
    dependency: (id) => {
      const f = facts(id);
      return f ? { exists: true, inProject: true, title: id, column: f.column, archived: false } : { exists: false, inProject: false, title: id, column: null, archived: false };
    },
  });
}

test("A → B with an independent C: A and C are startable, B is blocked until A is Done", () => {
  const items = [item("a", "A", [], { result: created("ta") }), item("b", "B", ["a"], { result: created("tb") }), item("c", "C", [], { result: created("tc") })];
  const board = (a: ColumnId) => ({ ta: { column: a }, tb: { column: "backlog" as ColumnId, deps: ["ta"] }, tc: { column: "backlog" as ColumnId } });
  expect(startableNodes(plan(items, board("backlog"))).map((n) => n.taskId).sort()).toEqual(["ta", "tc"]);
  expect(plan(items, board("review")).nodes.find((n) => n.taskId === "tb")!.state).toBe("blocked");
  expect(plan(items, board("done")).nodes.find((n) => n.taskId === "tb")!.state).toBe("ready");
});

test("a cycle among items is found and nothing is startable", () => {
  const items = [item("a", "A", ["b"]), item("b", "B", ["a"])];
  expect(planCycle(items)).not.toBeNull();
  const view = plan(items, {}, "pending");
  expect(view.issues.map((i) => i.code)).toContain("cycle");
  expect(startableNodes(view)).toEqual([]);
});

test("a dependency left out of the plan blocks its dependent instead of vanishing", () => {
  const view = plan([item("a", "A", [], { include: false }), item("b", "B", ["a"])], {}, "pending");
  expect(view.nodes.find((n) => n.title === "A")!.state).toBeNull();
  expect(view.nodes.find((n) => n.title === "B")!.state).toBe("blocked");
});

test("Review and Blocked columns wait for the Owner; running is in progress; Done is completed", () => {
  const items = ["a", "b", "c", "d"].map((id) => item(id, id.toUpperCase(), [], { result: created(`t${id}`) }));
  const view = plan(items, { ta: { column: "review" }, tb: { column: "blocked" }, tc: { column: "running" }, td: { column: "done" } });
  expect(view.nodes.map((n) => n.state)).toEqual(["waiting-owner", "waiting-owner", "in-progress", "completed"]);
});
