import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMPTY_EXECUTION_DRAFT, EVIDENCE_TONE, accessText, accountStateLabel, actualText, antigravityAutoAcceptsFileEdits, buildPreflightBody, buildStartBody, canConfirm, canOfferRun, executionInputKey, isLivePhase, isPreflightStale, outcomeLabel, reviewedRevisionOf } from "./employee-execution.ts";

const task = { id: "t", column: "ready" as const, updatedAt: 5, archivedAt: null, ownerProjectPath: "/p", agent: "claude-code" };

test("blank fields stay null and only the explicit choices are sent", () => {
  expect(buildPreflightBody("t", EMPTY_EXECUTION_DRAFT, null)).toEqual({
    taskId: "t", harnessId: null, model: null, effort: null, complexity: null, expectedAssignmentRevision: null,
  });
  expect(buildPreflightBody("t", { harnessId: " codex ", model: "m", effort: "", complexity: "high" }, 3)).toEqual({
    taskId: "t", harnessId: "codex", model: "m", effort: null, complexity: "high", expectedAssignmentRevision: 3,
  });
  expect(Object.keys(buildPreflightBody("t", EMPTY_EXECUTION_DRAFT, null)).sort()).not.toContain("path");
});

test("a result is stale after any change to what it rests on, or after its deadline", () => {
  const key = executionInputKey(task, EMPTY_EXECUTION_DRAFT);
  const shown = { key, validUntil: 1_000 };
  expect(isPreflightStale(null, key, 5_000)).toBe(false);
  expect(isPreflightStale(shown, key, 999)).toBe(false);
  expect(isPreflightStale(shown, key, 1_000)).toBe(true);
  expect(isPreflightStale(shown, executionInputKey({ ...task, updatedAt: 6 }, EMPTY_EXECUTION_DRAFT), 1)).toBe(true);
  expect(isPreflightStale(shown, executionInputKey({ ...task, column: "done" }, EMPTY_EXECUTION_DRAFT), 1)).toBe(true);
  expect(isPreflightStale(shown, executionInputKey({ ...task, ownerProjectPath: "/q" }, EMPTY_EXECUTION_DRAFT), 1)).toBe(true);
  expect(isPreflightStale(shown, executionInputKey(task, { ...EMPTY_EXECUTION_DRAFT, harnessId: "codex" }), 1)).toBe(true);
});

test("labels never call unverified evidence ready or available", () => {
  for (const tone of Object.values(EVIDENCE_TONE)) expect(tone).toMatch(/bg-/);
  for (const label of [outcomeLabel("blocked"), outcomeLabel("prepared"), outcomeLabel("selection-needed"), accountStateLabel("unknown"), accountStateLabel("identified-unverified")]) {
    expect(label).not.toMatch(/ready|available/i);
  }
  expect(accountStateLabel("unknown")).toBe("Account Unknown");
});

test("the reviewed revision is dropped after a stale-assignment answer", () => {
  expect(reviewedRevisionOf(null)).toBeNull();
  expect(reviewedRevisionOf({ assignment: null, blockingErrors: [] })).toBeNull();
  expect(reviewedRevisionOf({ assignment: { id: "a", revision: 2, assignedAt: 1 }, blockingErrors: [] })).toBe(2);
  expect(reviewedRevisionOf({ assignment: { id: "a", revision: 2, assignedAt: 1 }, blockingErrors: [{ code: "stale-assignment", message: "" }] })).toBeNull();
});

test("task details mount the section after the router panel; starting goes only through the review dialog", () => {
  const panel = readFileSync("src/mainview/components/kanban/RunPanel.tsx", "utf8");
  expect(panel).toContain("<ResourceRecommendation key={task.id} task={task} harnesses={harnesses} />");
  expect(panel).toContain("<EmployeeExecution key={`employee-execution-${task.id}`} task={task} harnesses={harnesses} />");
  const section = readFileSync("src/mainview/components/kanban/EmployeeExecution.tsx", "utf8");
  expect(section).toContain('{tr("execution.preflightBanner")}');
  expect(readFileSync("src/shared/execution/preflight.ts", "utf8")).toContain('"Preflight only — no agent started."');
  expect(section).not.toMatch(/startTask|sendRunInput|assignTaskToEmployee|reassignTask|unassignTask|api\.start|api\.cancel/);
});

const prepared = { outcome: "prepared" as const, blockingErrors: [], selection: {} as never, employee: {} as never, assignment: {} as never };

test("Run Employee is offered only for a fresh, prepared, unblocked preflight with a harness", () => {
  expect(canOfferRun(prepared, false)).toBe(true);
  expect(canOfferRun(prepared, true)).toBe(false);
  expect(canOfferRun(null, false)).toBe(false);
  expect(canOfferRun({ ...prepared, outcome: "selection-needed" }, false)).toBe(false);
  expect(canOfferRun({ ...prepared, outcome: "blocked" }, false)).toBe(false);
  expect(canOfferRun({ ...prepared, blockingErrors: [{ code: "x", message: "" }] }, false)).toBe(false);
  expect(canOfferRun({ ...prepared, selection: null }, false)).toBe(false);
  expect(canOfferRun({ ...prepared, assignment: null }, false)).toBe(false);
});

test("confirming needs an open, unexpired review and every required acknowledgement", () => {
  const attempt = { status: "awaiting-approval" as const, expiresAt: 100, usageNotice: null, requiresUnconfirmedAck: false };
  expect(canConfirm(attempt, { usage: false, unconfirmed: false }, 99)).toBe(true);
  expect(canConfirm(attempt, { usage: false, unconfirmed: false }, 100)).toBe(false);
  expect(canConfirm({ ...attempt, status: "started" as never }, { usage: true, unconfirmed: true }, 1)).toBe(false);
  expect(canConfirm({ ...attempt, usageNotice: "bills" }, { usage: false, unconfirmed: false }, 1)).toBe(false);
  expect(canConfirm({ ...attempt, usageNotice: "bills" }, { usage: true, unconfirmed: false }, 1)).toBe(true);
  expect(canConfirm({ ...attempt, requiresUnconfirmedAck: true }, { usage: true, unconfirmed: false }, 1)).toBe(false);
  expect(canConfirm({ ...attempt, requiresUnconfirmedAck: true }, { usage: true, unconfirmed: true }, 1)).toBe(false);
});

test("the confirmation body names the revision and only acknowledgements that apply", () => {
  const attempt = { revision: 3, usageNotice: null, requiresUnconfirmedAck: false };
  expect(buildStartBody(attempt, { usage: true, unconfirmed: true })).toEqual({ revision: 3, confirm: true });
  expect(buildStartBody({ ...attempt, usageNotice: "bills", requiresUnconfirmedAck: true }, { usage: true, unconfirmed: true }))
    .toEqual({ revision: 3, confirm: true, acknowledgeUsage: true, acknowledgeUnconfirmed: true });
  expect(Object.keys(buildStartBody(attempt, { usage: false, unconfirmed: false })).sort()).toEqual(["confirm", "revision"]);
});

test("Unknown is shown as Unknown and only starting or running phases are polled", () => {
  expect(actualText(null)).toBe("Unknown");
  expect(actualText("codex")).toBe("codex");
  expect(isLivePhase("starting")).toBe(true);
  expect(isLivePhase("running")).toBe(true);
  expect(isLivePhase("completed")).toBe(false);
  expect(isLivePhase("unknown-outcome")).toBe(false);
  expect(accessText(3)).toContain("without asking");
  expect(accessText(0)).not.toContain("without asking");
  expect(antigravityAutoAcceptsFileEdits("antigravity", "ask")).toBe(true);
  expect(antigravityAutoAcceptsFileEdits("antigravity", "auto")).toBe(false);
  expect(antigravityAutoAcceptsFileEdits("claude-code", "ask")).toBe(false);
});
