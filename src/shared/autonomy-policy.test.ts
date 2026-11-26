import { expect, test } from "bun:test";
import {
  buildLowRiskMemoryCandidate,
  evaluateApplicablePolicies,
  normalizePolicyBody,
  policyDigest,
  revisionExpands,
  type ApplicablePolicy,
  type AutonomyPolicyBody,
} from "./autonomy-policy.ts";

const now = 1_700_000_000_000;

function body(overrides: Record<string, unknown> = {}): AutonomyPolicyBody {
  return normalizePolicyBody({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects: ["/proj/a", "/proj/b"],
    clusters: ["cluster-a"],
    specialistRoles: ["developer", "reviewer", "head"],
    providers: ["claude-code"],
    models: ["haiku-4.5", "sonnet-5"],
    allowUnscopedAccount: true,
    maxConcurrentWorkers: 2,
    maxLaunches: 10,
    maxDurationMs: 3_600_000,
    maxReworkAttempts: 1,
    permittedActions: ["launch_task", "run_qc", "complete_task", "plan_task"],
    completion: { autoComplete: true, conditions: ["qc_pass"] },
    expiresAt: now + 3_600_000,
    ...overrides,
  }, now);
}

function policy(id: string, value: AutonomyPolicyBody): ApplicablePolicy {
  return { id, revision: 1, digest: policyDigest(value), body: value };
}

const counters = {
  launchesUsed: 0,
  launchesInFlight: 0,
  reworkUsedForTask: 0,
  now,
  activatedAt: now,
  lifecycleAllowed: true,
  emergencyStopped: false,
  paused: false,
  revoked: false,
  expired: false,
};

test("a broader policy cannot grant an action a project policy withholds", () => {
  const workspace = policy("wide", body());
  const project = policy("narrow", body({
    scopeKind: "project",
    scopeRef: "/proj/a",
    projects: ["/proj/a"],
    permittedActions: ["plan_task"],
    completion: { autoComplete: false, conditions: ["qc_pass"] },
  }));
  const denied = evaluateApplicablePolicies([workspace, project], {
    action: "launch_task",
    projectPath: "/proj/a",
    role: "developer",
    provider: "claude-code",
    model: "haiku-4.5",
  }, counters);
  expect(denied.allow).toBe(false);
  expect(denied.policyId).toBe("narrow");
  const allowed = evaluateApplicablePolicies([workspace], {
    action: "launch_task",
    projectPath: "/proj/b",
    role: "developer",
    provider: "claude-code",
    model: "haiku-4.5",
  }, counters);
  expect(allowed.allow).toBe(true);
  expect(allowed.policyId).toBe("wide");
});

test("revisions that add scope or budget are expansions, and digests ignore key order", () => {
  const previous = body();
  const next = body({ projects: ["/proj/a", "/proj/b", "/proj/c"], maxLaunches: 11 });
  expect(revisionExpands(previous, next)).toContain("project:/proj/c");
  expect(revisionExpands(previous, next)).toContain("launches");
  expect(policyDigest(previous)).toBe(policyDigest({ ...previous, projects: [...previous.projects].reverse() }));
});

test("always-denied and blocked providers cannot be permitted", () => {
  expect(() => body({ permittedActions: ["production_deploy"] })).toThrow(/cannot be permitted/);
  expect(() => body({ providers: ["cursor"], models: ["composer-2.5"] })).toThrow(/Cursor/);
  const capped = body({ spending: { requireEnforceableCap: true } });
  expect(capped.spending.enforceable).toBe(false);
  expect(capped.spending.measured).toBe(false);
});

test("an unverifiable spend cap and a secret observation are refused", () => {
  const capped = evaluateApplicablePolicies([policy("cap", body({ spending: { requireEnforceableCap: true, limitUsd: 5 } }))], {
    action: "launch_task",
    projectPath: "/proj/a",
    role: "developer",
    provider: "claude-code",
    model: "haiku-4.5",
  }, counters);
  expect(capped.allow).toBe(false);
  expect(capped.reason).toContain("not enforceable");
  expect(buildLowRiskMemoryCandidate({
    taskTitle: "Fix",
    projectPath: "/proj/a",
    reviewId: "review-1",
    verdict: "PASS",
    summary: "Use token sk-abcdefghijklmnopqrstuvwxyz",
  }).ok).toBe(false);
  expect(buildLowRiskMemoryCandidate({
    taskTitle: "Fix",
    projectPath: "/proj/a",
    reviewId: "review-1",
    verdict: "BLOCKED",
    summary: "A real summary.",
  }).ok).toBe(false);
});
