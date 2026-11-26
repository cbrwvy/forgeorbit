import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foux02e-")));
process.env.AGETOR_DATA_DIR = isolated;
const store = await import("./db.ts");
const { readOwnerActions } = await import("./owner-actions.ts");

test("nothing waits on an empty database", () => {
  expect(readOwnerActions()).toEqual({
    proposals: [],
    delegations: [],
    batchHolds: [],
    orchestratedWorkflowHolds: [],
    orchestratedBatchHolds: [],
    memoryProposals: [],
    deploymentRequestHolds: [],
    deploymentExecutionAuthHolds: [],
    projectPermissionRequests: [],
  });
});

test("only what really waits on the Owner is listed: pending proposals, retryable delegations, held batches", () => {
  const now = Date.now();
  store.projectManagers.putProposal("/p/a", "pa", "pending", JSON.stringify({ title: "Login work" }), now);
  store.projectManagers.putProposal("/p/a", "pb", "approved", JSON.stringify({ title: "Done already" }), now);
  store.projectManagers.putProposal("/p/b", "pc", "rejected", JSON.stringify({ title: "Rejected" }), now);
  store.portfolioManagerStore.putDelegation("d1", "/p/a", "m1", "proposed", JSON.stringify({ title: "Ask A" }), now);
  store.portfolioManagerStore.putDelegation("d2", "/p/b", "m1", "failed", JSON.stringify({ title: "Retry B" }), now);
  store.portfolioManagerStore.putDelegation("d3", "/p/b", "m1", "answered", JSON.stringify({ title: "Answered" }), now);
  for (const [id, status] of [["b1", "paused"], ["b2", "approved"], ["b3", "stopped"], ["b4", "running"], ["b5", "completed"], ["b6", "draft"]] as const) {
    store.executionBatches.put({ id, projectPath: "/p/a", status, data: JSON.stringify({ title: `Batch ${id}` }), createdAt: now });
  }
  const result = readOwnerActions();
  expect(result.proposals.map((row) => row.id)).toEqual(["pa"]);
  expect(result.proposals[0]).toMatchObject({ projectPath: "/p/a", title: "Login work" });
  expect(result.delegations.map((row) => row.id).sort()).toEqual(["d1", "d2"]);
  expect(result.batchHolds.map((row) => `${row.id}:${row.status}`).sort()).toEqual(["b1:paused", "b2:approved", "b3:stopped"]);
});
