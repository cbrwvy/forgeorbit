import { expect, test } from "bun:test";
import {
  assignmentActionLabel,
  assignmentColumnLabel,
  assignmentHistoryDetail,
  assignmentProvenanceLabel,
  assignmentVisibilityNote,
  unassignTaskConfirmCopy,
} from "./task-assignments.ts";

test("assignment labels use real status words and invent no cost or model", () => {
  expect(assignmentColumnLabel("ready", false)).toBe("Ready");
  expect(assignmentColumnLabel("done", true)).toBe("Done · Archived");
  expect(assignmentColumnLabel(null, true)).toBe("Archived");
  expect(assignmentProvenanceLabel("owner")).toBe("Owner");
  expect(assignmentActionLabel("reassigned")).toBe("Reassigned");
  expect(assignmentVisibilityNote("in-project")).toBeNull();
  expect(assignmentVisibilityNote("diverged")).toContain("not moved");
  expect(assignmentHistoryDetail({ action: "reassigned", employeeName: "Bea", previousEmployeeName: "Ada" })).toBe(
    "Reassigned from Ada to Bea.",
  );
  expect(assignmentHistoryDetail({ action: "assigned", employeeName: null, previousEmployeeName: null })).toContain("Unknown employee");
  const copy = unassignTaskConfirmCopy("Fix the gate");
  expect(copy.confirmLabel).toBe("Unassign");
  expect(copy.description).toContain("history is kept");
  expect(JSON.stringify({ copy, note: assignmentVisibilityNote("missing") })).not.toMatch(/cost|hours|model used|performance/i);
});
