import { expect, test } from "bun:test";
import { parseCancelRequest, parseStartRequest, phaseOf, reasonOfRun, resultOfRunStatus } from "./run.ts";

test("the confirmation is explicit and carries identifiers and flags only", () => {
  expect(parseStartRequest({ revision: 2, confirm: true })).toEqual({ revision: 2, acknowledgeUsage: false, acknowledgeUnconfirmed: false, acknowledgeFullAccess: false });
  expect(parseStartRequest({ revision: 1, confirm: true, acknowledgeUsage: true })).toMatchObject({ acknowledgeUsage: true });
  for (const bad of [
    null, [], "x", {}, { revision: 1 }, { revision: 1, confirm: false }, { revision: 0, confirm: true }, { revision: 1.5, confirm: true },
    { revision: 1, confirm: true, command: "ls" }, { revision: 1, confirm: true, path: "/etc" }, { revision: 1, confirm: true, acknowledgeUsage: "yes" },
  ]) expect(() => parseStartRequest(bad)).toThrow();
});

test("a withdrawal may name a revision and nothing else", () => {
  expect(parseCancelRequest(undefined)).toEqual({ revision: null });
  expect(parseCancelRequest({ revision: 3 })).toEqual({ revision: 3 });
  expect(() => parseCancelRequest({ revision: 3, force: true })).toThrow();
  expect(() => parseCancelRequest({ revision: "3" })).toThrow();
});

test("phases are honest: Running only for an accepted start, Completed only for a finished run", () => {
  const row = (status: Parameters<typeof phaseOf>[0]["status"], result: Parameters<typeof phaseOf>[0]["result"] = null) => ({ status, result });
  expect(phaseOf(row("awaiting-approval"), null)).toBe("awaiting-approval");
  expect(phaseOf(row("starting"), null)).toBe("starting");
  expect(phaseOf(row("started"), null)).toBe("unknown-outcome"); // no verified live handle or readable terminal run
  expect(phaseOf(row("started"), "starting")).toBe("starting");
  expect(phaseOf(row("started"), "running")).toBe("running");
  expect(phaseOf(row("started"), "succeeded")).toBe("completed");
  expect(phaseOf(row("started", "succeeded"), "running")).toBe("completed");
  expect(phaseOf(row("started"), "failed")).toBe("failed");
  expect(phaseOf(row("started"), "cancelled")).toBe("cancelled");
  expect(phaseOf(row("started"), "orphaned")).toBe("unknown-outcome");
  expect(phaseOf(row("start-failed"), null)).toBe("failed");
  expect(phaseOf(row("indeterminate"), null)).toBe("unknown-outcome");
  expect(phaseOf(row("rejected"), null)).toBe("not-started");
  // A review that never became a start is never shown as success.
  for (const status of ["expired", "superseded", "cancelled", "rejected"] as const) expect(phaseOf(row(status), "succeeded")).not.toBe("completed");
});

test("run results map from run statuses and reasons carry no secrets", () => {
  expect(resultOfRunStatus("running")).toBeNull();
  expect(resultOfRunStatus("succeeded")).toBe("succeeded");
  expect(reasonOfRun("failed", 2)).toBe("The run failed (exit code 2).");
  expect(reasonOfRun("failed", null)).toBe("The run failed.");
  expect(reasonOfRun("orphaned", null)).toContain("not confirmed");
});
