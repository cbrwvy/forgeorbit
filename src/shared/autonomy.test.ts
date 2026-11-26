import { expect, test } from "bun:test";
import {
  AUTONOMY_FORBIDDEN_ORIGINS,
  autonomyModeVerdict,
  effectiveGrantStatus,
  evaluateAutonomousRun,
  sanitizeGrant,
  type AutonomyGrant,
  type RunGateFacts,
} from "./autonomy.ts";

/** FO-ORCH08: the pure decision. Every hard stop is one test; nothing here touches a database. */
const NOW = 1_000_000;

function grant(extra: Partial<AutonomyGrant> = {}): AutonomyGrant {
  return {
    id: "g1", batchId: "b1", status: "active", approvedAt: NOW - 1000, approvedBy: "owner", expiresAt: NOW + 60_000,
    taskIds: ["t1"],
    resources: [{ taskId: "t1", stepName: null, harnessId: "codex", model: "m1", mode: "ask", accessLevel: 0, profileId: null, accountId: null, quotaEvidence: "unknown" }],
    maxRuns: 3, maxParallelism: 1, acknowledgedUnknownQuota: [],
    planEvidence: { previewKey: "pk", entries: [{ taskId: "t1", signature: "sig", fingerprint: "fp", dependsOn: [] }], queue: null },
    stopConditions: [], cost: "run-count-only", endedAt: null, endReason: null, epoch: 0, ...extra,
  };
}

function facts(extra: Partial<RunGateFacts> = {}): RunGateFacts {
  return {
    origin: "batch", now: NOW, batchStatus: "running", rootTaskId: "t1", competingBatches: 0, approvalPreviewKey: "pk",
    entry: { present: true, signatureNow: "sig", approvedSignature: "sig", fingerprintOk: true, dependenciesSame: true, dependenciesDone: true, tombstones: false },
    used: 0, live: 0,
    current: { harnessId: "codex", kind: "codex", model: "m1", mode: "ask", accessLevel: 0, accountId: null },
    ...extra,
  };
}

const code = (g: AutonomyGrant, f: RunGateFacts) => {
  const v = evaluateAutonomousRun(g, f);
  return v.allowed ? "allowed" : v.code;
};

test("a matching Run is allowed, and every changed binding is a hard stop with its own code", () => {
  expect(code(grant(), facts())).toBe("allowed");
  expect(code(grant({ status: "revoked" }), facts())).toBe("grant-revoked");
  expect(code(grant(), facts({ now: NOW + 60_000 }))).toBe("grant-expired");
  expect(code(grant({ status: "expired" }), facts())).toBe("grant-expired");
  expect(code(grant(), facts({ used: 3 }))).toBe("grant-exhausted");
  expect(code(grant(), facts({ batchStatus: "paused" }))).toBe("batch-not-running");
  for (const status of ["cancelled", "stopped"]) expect(code(grant(), facts({ batchStatus: status }))).toBe("batch-not-running");
  expect(code(grant(), facts({ competingBatches: 1 }))).toBe("competing-batch");
  expect(code(grant(), facts({ rootTaskId: "t2" }))).toBe("task-not-granted");
  expect(code(grant(), facts({ approvalPreviewKey: "other" }))).toBe("plan-changed");
  expect(code(grant(), facts({ entry: { ...facts().entry, signatureNow: "changed" } }))).toBe("configuration-changed");
  expect(code(grant(), facts({ entry: { ...facts().entry, fingerprintOk: false } }))).toBe("task-changed");
  expect(code(grant(), facts({ entry: { ...facts().entry, dependenciesSame: false } }))).toBe("dependencies-changed");
  expect(code(grant(), facts({ entry: { ...facts().entry, tombstones: true } }))).toBe("dependency-deleted");
  expect(code(grant(), facts({ entry: { ...facts().entry, dependenciesDone: false } }))).toBe("dependency-not-done");
  expect(code(grant(), facts({ live: 1 }))).toBe("parallelism-reached");
});

test("exact harness/model/mode/account binding: no other model, harness, mode or account is ever accepted", () => {
  const cur = facts().current!;
  expect(code(grant(), facts({ current: { ...cur, model: "m2" } }))).toBe("resource-not-granted");
  expect(code(grant(), facts({ current: { ...cur, harnessId: "claude-code", kind: "claude-code", mode: "ask" } }))).toBe("resource-not-granted");
  expect(code(grant(), facts({ current: { ...cur, mode: "auto", accessLevel: 3 } }))).toBe("permission-changed");
  expect(code(grant(), facts({ current: { ...cur, accessLevel: 2 } }))).toBe("permission-broadened");
  expect(code(grant(), facts({ current: { ...cur, accountId: "acc-1" } }))).toBe("account-changed");
  // An account known at grant time must still be that account.
  const bound = grant({ resources: [{ ...grant().resources[0]!, accountId: "acc-1" }] });
  expect(code(bound, facts({ current: { ...cur, accountId: "acc-1" } }))).toBe("allowed");
  expect(code(bound, facts({ current: { ...cur, accountId: null } }))).toBe("account-changed");
  // A pipeline task itself runs no agent; its steps are each checked.
  expect(code(grant(), facts({ current: null }))).toBe("allowed");
});

test("Full access and every no-check mode is refused; fx auto-resume is not covered by a grant", () => {
  expect(autonomyModeVerdict("codex", "full-access").allowed).toBe(false);
  expect(autonomyModeVerdict("codex", "ask").allowed).toBe(true);
  expect(autonomyModeVerdict("codex", "auto").allowed).toBe(true); // sandboxed: ORCH02 rules decide the layout
  expect(autonomyModeVerdict("claude-code", "bypass").allowed).toBe(false);
  expect(autonomyModeVerdict("claude-code", "auto").allowed).toBe(true);
  expect(autonomyModeVerdict("antigravity", "auto").allowed).toBe(false);
  expect(autonomyModeVerdict("antigravity", "ask").allowed).toBe(true);
  expect(autonomyModeVerdict("cursor", "auto").allowed).toBe(false);
  expect(autonomyModeVerdict("gemini", "auto").allowed).toBe(false);
  expect(autonomyModeVerdict("fx", "yolo").allowed).toBe(false);
  expect(autonomyModeVerdict("fx", "ask").allowed).toBe(true);
  expect(autonomyModeVerdict("codex", "made-up").allowed).toBe(false); // unknown ids are never assumed safe
  expect(autonomyModeVerdict(null, "ask").allowed).toBe(false);
  const cur = facts().current!;
  const wide = grant({ resources: [{ ...grant().resources[0]!, mode: "full-access", accessLevel: 4 }] });
  expect(code(wide, facts({ current: { ...cur, mode: "full-access", accessLevel: 4 } }))).toBe("mode-not-allowed");
  expect(AUTONOMY_FORBIDDEN_ORIGINS).toContain("fx-auto-resume");
  expect(code(grant(), facts({ origin: "fx-auto-resume" }))).toBe("origin-not-granted");
  for (const origin of ["batch", "pipeline-step", "handoff-reminder"] as const) expect(code(grant(), facts({ origin }))).toBe("allowed");
});

test("the status is derived from the clock and the counter without writing; a revoked grant stays revoked", () => {
  expect(effectiveGrantStatus(grant(), NOW, 0)).toBe("active");
  expect(effectiveGrantStatus(grant(), NOW + 60_000, 0)).toBe("expired");
  expect(effectiveGrantStatus(grant(), NOW, 3)).toBe("exhausted");
  expect(effectiveGrantStatus(grant({ status: "revoked" }), NOW + 10 ** 9, 99)).toBe("revoked");
});

test("a stored grant is read back strictly; garbage is no grant", () => {
  const g = grant();
  expect(sanitizeGrant(JSON.parse(JSON.stringify(g)))).toEqual(g);
  expect(sanitizeGrant(null)).toBeNull();
  expect(sanitizeGrant({ ...g, status: "forever" })).toBeNull();
  expect(sanitizeGrant({ ...g, maxRuns: "many" })).toBeNull();
  expect(sanitizeGrant({ ...g, planEvidence: null })).toBeNull();
});
