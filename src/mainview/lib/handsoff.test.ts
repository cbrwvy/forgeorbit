import { describe, expect, test } from "bun:test";
import { authorizationNeedsAction, authorizationTone, blockerText, canSubmitForWork, eventText, handsoffHeadline, handsoffNeedsYou, renewalReasonsText } from "./handsoff";
import { policyEnabledFor, runForTask } from "./handsoff-events";
import { ownerActions } from "./owner-actions";
import type { HandsoffOverview, HandsoffRun } from "../../shared/handsoff.ts";
import { DEFAULT_HANDSOFF_POLICY, EMPTY_HANDSOFF_STATE } from "../../shared/handsoff.ts";

const run = (patch: Partial<HandsoffRun>): HandsoffRun => ({
  id: "r1", taskId: "t1", projectPath: "/p", policyRevision: 1, policy: DEFAULT_HANDSOFF_POLICY, stage: "developing", status: "active", round: 0,
  state: EMPTY_HANDSOFF_STATE, blocker: null, result: null, createdAt: 1, updatedAt: 1, finishedAt: null, ...patch,
});

describe("what the Owner reads", () => {
  test("work in progress, a wait and a stop are never 'needs you'", () => {
    for (const status of ["active", "waiting", "stopped", "done", "ready-to-apply", "awaiting-accept", "failed", "cancelled"] as const) {
      expect(handsoffNeedsYou(run({ status }))).toBe(false);
    }
    expect(handsoffNeedsYou(run({ status: "needs-owner" }))).toBe(true);
    expect(handsoffNeedsYou(null)).toBe(false);
  });
  test("an automatic step reads as its stage; an applied-less result reads 'Ready to apply', not Done", () => {
    expect(handsoffHeadline(run({ stage: "testing" })).text).toBe("Checking");
    expect(handsoffHeadline(run({ stage: "finished", status: "ready-to-apply" })).text).toBe("Ready to apply");
    expect(handsoffHeadline(run({ stage: "finished", status: "done" }))).toEqual({ text: "Done", tone: "success" });
  });
  test("a blocker is plain language, an unknown code falls back to the core's own sentence", () => {
    expect(blockerText({ code: "apply-conflict", message: "raw" })).toMatch(/Nothing was overwritten/);
    expect(blockerText({ code: "nope" as never, message: "raw core sentence" })).toBe("raw core sentence");
    expect(eventText("applied")).toBe("Applied to the project folder");
  });
});

describe("Submit for work", () => {
  const task = { column: "ready", archivedAt: null, pipelineId: null, pipelineParentId: null } as never;
  test("offered only for a Backlog or Ready task of a project that turned the policy on, with no open run", () => {
    expect(canSubmitForWork(task, true, null)).toBe(true);
    expect(canSubmitForWork(task, false, null)).toBe(false);
    expect(canSubmitForWork({ ...(task as object), column: "running" } as never, true, null)).toBe(false);
    expect(canSubmitForWork({ ...(task as object), column: "done" } as never, true, null)).toBe(false);
    expect(canSubmitForWork({ ...(task as object), pipelineId: "p" } as never, true, null)).toBe(false);
    expect(canSubmitForWork(task, true, { finishedAt: null })).toBe(false);
    expect(canSubmitForWork(task, true, { finishedAt: 5 })).toBe(true);
  });
});

describe("the Needs-you count", () => {
  const overview: HandsoffOverview = { policies: [{ projectPath: "/p", enabled: true, revision: 1, autoApply: true, autoDone: true }], runs: [run({ status: "active" }), run({ id: "r2", taskId: "t2", status: "needs-owner" })] };
  test("only a run waiting on a decision is counted; running work adds nothing", () => {
    expect(policyEnabledFor(overview, "/p")).toBe(true);
    expect(policyEnabledFor(overview, "/q")).toBe(false);
    expect(runForTask(overview, "t1")?.status).toBe("active");
    const rows = { proposals: [], delegations: [], batchHolds: [], handsoffBlockers: [{ projectPath: "/p", id: "r2", taskId: "t2", title: "T2", code: "apply-conflict", message: "m", action: "retry" as const }] };
    expect(ownerActions([], { rows })).toMatchObject({ independent: 1, total: 1 });
    expect(ownerActions([], { rows: { ...rows, handsoffBlockers: [] } })).toMatchObject({ independent: 0, total: 0 });
  });
});

describe("project authorization wording", () => {
  test("one action exists exactly where the Owner can act", () => {
    for (const state of ["not-authorized", "needs-renewal", "expired", "exhausted", "revoked"] as const) expect(authorizationNeedsAction(state)).toBe(true);
    for (const state of ["active", "off", "not-required"] as const) expect(authorizationNeedsAction(state)).toBe(false);
    expect(authorizationTone("active")).toBe("success");
    expect(authorizationTone("expired")).toBe("warning");
  });
  test("what widened is plain words; an unknown field is shown as itself", () => {
    expect(renewalReasonsText(["accounts", "apply"])).toBe("more accounts, applying the result to the project folder");
    expect(renewalReasonsText(["mystery"])).toBe("mystery");
  });
  test("each authorization blocker is a project-level sentence that names where to act", () => {
    for (const code of ["authorization-missing", "authorization-expired", "authorization-exhausted", "authorization-renewal", "authorization-revoked"] as const) {
      expect(blockerText({ code, message: "raw" })).toMatch(/project's settings/);
    }
  });
});
