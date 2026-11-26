import { test, expect } from "bun:test";
import type { TaskProposal } from "./project-manager.ts";
import { pendingProjectInboxProposals } from "./pm-intake.ts";

function proposal(over: Partial<TaskProposal> & Pick<TaskProposal, "id" | "status">): TaskProposal {
  return {
    projectPath: "/p",
    messageId: "m",
    title: "T",
    summary: "",
    items: [],
    createdAt: 1,
    updatedAt: over.updatedAt ?? 1,
    revision: 1,
    ...over,
  };
}

test("project inbox lists only pending proposals", () => {
  const list = pendingProjectInboxProposals([
    proposal({ id: "a", status: "approved", updatedAt: 10 }),
    proposal({ id: "b", status: "pending", updatedAt: 20 }),
    proposal({ id: "c", status: "rejected", updatedAt: 30 }),
    proposal({ id: "d", status: "pending", updatedAt: 5 }),
  ]);
  expect(list.map((p) => p.id)).toEqual(["b", "d"]);
});
