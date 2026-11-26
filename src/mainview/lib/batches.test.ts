import { describe, expect, test } from "bun:test";
import { batchActions, batchCounts, batchInError, groupEntries, monitorGroup, moveId, policySummary, viewOfAction } from "./batches.ts";
import type { BatchEntryView, BatchView } from "../../shared/task-scheduling.ts";

const ready = { state: "ready" as const };

describe("batch actions per status", () => {
  test("only what the status allows; Stop runs only when the batch owns live runs", () => {
    expect(batchActions({ status: "draft", ownedLive: [] })).toEqual(["cancel"]);
    expect(batchActions({ status: "approved", ownedLive: [] })).toEqual(["start", "cancel"]);
    expect(batchActions({ status: "running", ownedLive: ["t"] })).toEqual(["pause", "cancel"]);
    expect(batchActions({ status: "paused", ownedLive: [] })).toEqual(["resume", "cancel"]);
    expect(batchActions({ status: "paused", ownedLive: ["t"] })).toEqual(["resume", "cancel", "stop-runs"]);
    expect(batchActions({ status: "cancelled", ownedLive: ["t"] })).toEqual(["stop-runs"]);
    for (const status of ["completed", "stopped", "cancelled"] as const) {
      expect(batchActions({ status, ownedLive: [] })).toEqual([]);
      expect(batchActions({ status, ownedLive: [] })).not.toContain("start");
    }
  });
});

describe("monitoring groups", () => {
  test("come from the core's own state and readiness", () => {
    expect(monitorGroup({ state: "running", readiness: ready })).toBe("running");
    expect(monitorGroup({ state: "waiting", readiness: ready })).toBe("running");
    expect(monitorGroup({ state: "review", readiness: ready })).toBe("review");
    expect(monitorGroup({ state: "held", readiness: ready })).toBe("hold");
    expect(monitorGroup({ state: "failed", readiness: ready })).toBe("failed");
    expect(monitorGroup({ state: "done", readiness: ready })).toBe("completed");
    expect(monitorGroup({ state: "external", readiness: ready })).toBe("outside");
    expect(monitorGroup({ state: "pending", readiness: ready })).toBe("ready");
    expect(monitorGroup({ state: "pending", readiness: { state: "waiting", on: ["a"] } })).toBe("dependencies");
    expect(monitorGroup({ state: "pending", readiness: { state: "blocked", by: [{ taskId: "a", reason: "x" }] } })).toBe("dependencies");
    const entries = [
      { state: "pending", readiness: ready },
      { state: "review", readiness: ready },
      { state: "pending", readiness: ready },
    ] as Pick<BatchEntryView, "state" | "readiness">[];
    expect(groupEntries(entries).get("ready")).toHaveLength(2);
    expect(batchCounts({ entries: entries as BatchEntryView[] })).toMatchObject({ ready: 2, review: 1, running: 0 });
  });
});

describe("helpers", () => {
  test("reordering, summaries and responses", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b"], "x", 1)).toEqual(["a", "b"]);
    expect(policySummary({
      maxParallel: 2, maxStarts: 5, maxRetriesPerTask: 1, maxDurationMinutes: 30,
      spending: "no-extra", noOverageHarnessIds: [], reviewPolicy: "wait-for-review", onFailure: "pause",
    })).toBe("2 at a time · 5 starts max · 1 retry per task · 30 min limit");
    const view = { id: "b", entries: [] } as unknown as BatchView;
    expect(viewOfAction(view)).toBe(view);
    expect(viewOfAction({ batch: view })).toBe(view);
    expect(batchInError({ error: "x", batch: view })).toBe(view);
    expect(batchInError({ error: "x" })).toBeNull();
    expect(batchInError(null)).toBeNull();
  });
});
