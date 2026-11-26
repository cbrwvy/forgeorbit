import { expect, test } from "bun:test";
import { classifyHarnessEvidence, evidenceLabel, nextActionFor, parsePreflightRequest } from "./preflight.ts";

const NOW = 1_000;
const verifiedFact = { value: true, verification: "verified" as const, source: "fixture", observedAt: NOW - 1, expiresAt: NOW + 100 };
const none = [{ authorization: null, availability: null, support: null }];
const assessment = (status: "verified" | "conditional" | "excluded", conflicts: string[] = []) => ({ status, conflicts });

test("evidence states keep verified, conditional, unknown, blocked and conflicting apart", () => {
  expect(classifyHarnessEvidence(false, [assessment("verified")], none, NOW)).toBe("blocked");
  expect(classifyHarnessEvidence(true, [], [], NOW)).toBe("unknown");
  expect(classifyHarnessEvidence(true, [assessment("verified")], none, NOW)).toBe("verified");
  expect(classifyHarnessEvidence(true, [assessment("excluded"), assessment("verified")], none, NOW)).toBe("verified");
  expect(classifyHarnessEvidence(true, [assessment("excluded")], none, NOW)).toBe("blocked");
  // Exhausted capacity excludes the resource; it is not conflicting source evidence.
  expect(classifyHarnessEvidence(true, [assessment("excluded", ["Quota is exhausted"])], none, NOW)).toBe("blocked");
  expect(classifyHarnessEvidence(true, [assessment("conditional", ["Quota sources conflict: q"])], none, NOW)).toBe("conflicting");
  // Conditional needs some current positive fact; otherwise everything is merely unknown.
  expect(classifyHarnessEvidence(true, [assessment("conditional")], none, NOW)).toBe("unknown");
  expect(classifyHarnessEvidence(true, [assessment("conditional")], [{ authorization: verifiedFact, availability: null, support: null }], NOW)).toBe("conditional");
  expect(classifyHarnessEvidence(true, [assessment("conditional")], [{ authorization: { ...verifiedFact, expiresAt: NOW - 1 }, availability: null, support: null }], NOW)).toBe("unknown");
});

test("labels never claim a resource is ready or available", () => {
  for (const state of ["verified", "conditional", "unknown", "blocked", "conflicting"] as const) {
    expect(evidenceLabel(state)).not.toMatch(/ready|available/i);
  }
});

test("the request schema is strict", () => {
  const id = "task-1";
  expect(parsePreflightRequest({ taskId: id })).toEqual({
    taskId: id, harnessId: null, model: null, effort: null, complexity: null, policy: "balanced", expectedAssignmentRevision: null,
  });
  expect(parsePreflightRequest({ taskId: id, harnessId: "codex", complexity: "high", policy: "quality-first", expectedAssignmentRevision: 3 }))
    .toMatchObject({ harnessId: "codex", complexity: "high", policy: "quality-first", expectedAssignmentRevision: 3 });
  for (const bad of [null, [], "x", {}, { taskId: id, path: "/tmp" }, { taskId: id, accountId: "a" }, { taskId: id, command: "ls" },
    { taskId: id, policy: "x" }, { taskId: id, complexity: "unknown" }, { taskId: id, expectedAssignmentRevision: 1.5 },
    { taskId: id, harnessId: "\n" }, { taskId: 7 }]) {
    expect(() => parsePreflightRequest(bad)).toThrow();
  }
});

test("the next action points at a review the owner must confirm, never at starting an agent", () => {
  const base = { assignment: null, requested: { harnessId: null, model: null, effort: null, complexity: null } };
  expect(nextActionFor({ ...base, blockingErrors: [{ code: "no-assignment", message: "" }] }).code).toBe("assign-worker");
  expect(nextActionFor({ ...base, blockingErrors: [{ code: "task-archived", message: "" }] }).code).toBe("resolve-blockers");
  expect(nextActionFor({ ...base, blockingErrors: [] }).code).toBe("select-harness");
  const done = nextActionFor({ ...base, requested: { ...base.requested, harnessId: "codex" }, blockingErrors: [] });
  expect(done.code).toBe("await-execution-stage");
  expect(done.text).toContain("nothing starts until you confirm");
});
