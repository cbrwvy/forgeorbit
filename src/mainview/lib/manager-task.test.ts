import { expect, test } from "bun:test";
import { managerTaskView } from "./manager-task";
import { EMPTY_QC_STATE } from "../../shared/task-quality-control";
import type { Task, TaskQcState } from "../../shared/types";
import { translate } from "../i18n/core";

const task = (column: Task["column"], qcState: TaskQcState | null = null) => ({ column, qcState, archivedAt: null, pendingInteractionCount: 0 });
const pass = { ...EMPTY_QC_STATE, latestVerdict: "PASS" as const, roundCount: 3, awaitingOwnerApproval: true };

test("Direction 31: successful execution, review PASS and acceptance are separate", () => {
  expect(managerTaskView(task("review"))).toMatchObject({ stage: "needs-review", action: "review" });
  const acceptance = managerTaskView(task("review", pass));
  expect(acceptance).toEqual({ stage: "acceptance", action: "accept", needsDecision: true });
  expect(translate("ru", `manager.stage.${acceptance.stage}`)).toBe("Результат готов к приёмке");
  expect(translate("ru", "manager.action.accept")).toBe("Принять результат");
  expect(managerTaskView(task("done", { ...pass, awaitingOwnerApproval: false }))).toEqual({ stage: "accepted", action: null, needsDecision: false });
});

test("current activity and blockers outrank earlier PASS", () => {
  expect(managerTaskView(task("running", pass)).stage).toBe("running");
  expect(managerTaskView(task("review", { ...pass, activeReviewId: "current" })).stage).toBe("reviewing");
  expect(managerTaskView(task("review", { ...pass, latestVerdict: "BLOCKED", awaitingOwnerApproval: false })).stage).toBe("blocked");
  expect(managerTaskView({ ...task("review", pass), pendingInteractionCount: 1 })).toMatchObject({ stage: "blocked", action: "answer" });
  expect(managerTaskView(task("review", { ...pass, latestVerdict: null })).action).toBe("review");
  expect(managerTaskView(task("review", { ...pass, latestVerdict: null, roundCount: 5 }))).toMatchObject({ stage: "blocked", action: "answer" });
  expect(managerTaskView(task("review", { ...pass, awaitingOwnerApproval: false })).action).toBe("review");
});

test("returned results need rework, never acceptance", () => {
  for (const qc of [pass, { ...pass, awaitingOwnerApproval: false }, { ...pass, latestVerdict: "CHANGES_REQUESTED" as const, awaitingOwnerApproval: false }]) {
    expect(managerTaskView(task("ready", qc))).toMatchObject({ stage: "returned", action: "setup", needsDecision: true });
  }
  expect(managerTaskView({ ...task("review", pass), archivedAt: 1 })).toEqual({ stage: "archived", action: null, needsDecision: false });
});
