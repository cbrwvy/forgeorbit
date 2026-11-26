import { expect, test } from "bun:test";
import type { ProjectPermissionRequest } from "./project-permissions.ts";
import { buildProjectTestEvidence, projectTestFreshness, projectTestKind, type CurrentSourceBinding } from "./project-test-evidence.ts";

const NOW = 1_000_000;

function request(over: Partial<ProjectPermissionRequest> = {}): ProjectPermissionRequest {
  return {
    id: "r1", projectPath: "/p", taskId: "t1", taskTitle: "T", action: "run_project_test",
    command: "bun test ./src/a.test.ts", argv: ["test", "./src/a.test.ts"], cwd: "/ws/t1",
    sourceFingerprint: "src-A", commandFingerprint: "cmd-A", status: "completed", authority: "owner-once", origin: "owner", originRunId: null, ruleId: null,
    reason: null, exitCode: 0, summary: "SECRET-OUTPUT", isolation: "macos-offline-seatbelt",
    createdAt: 100, expiresAt: NOW + 1000, decidedAt: 110, startedAt: 111, finishedAt: 120,
    ...over,
  };
}
const binding = (over: Partial<CurrentSourceBinding> = {}): CurrentSourceBinding => ({ projectPath: "/p", stagingPath: "/ws/t1", status: "settled", sourceFingerprint: "src-A", ...over });
const build = (requests: ProjectPermissionRequest[], current: CurrentSourceBinding | null = binding()) =>
  buildProjectTestEvidence({ taskId: "t1", projectPath: "/p", requests, current, now: NOW });

test("kinds: only an observed exit 0 is a pass; refused, denied and blocked are not failures", () => {
  expect(projectTestKind("completed", 0)).toBe("passed");
  expect(projectTestKind("completed", null)).toBe("interrupted");
  expect(projectTestKind("completed", 1)).toBe("failed");
  expect(projectTestKind("failed", 1)).toBe("failed");
  // No observed exit code: it is not known whether a test started or what it found.
  expect(projectTestKind("failed", null)).toBe("interrupted");
  expect(projectTestKind("interrupted", null)).toBe("interrupted");
  expect(projectTestKind("interrupted", 0)).toBe("interrupted");
  for (const s of ["denied", "cancelled", "expired", "blocked", "something-new"]) expect(projectTestKind(s, null)).toBe("did-not-run");
  expect(projectTestKind("pending", null)).toBe("pending");
  expect(projectTestKind("running", null)).toBe("running");
});

test("freshness: current only when project, workspace and bytes all match", () => {
  const r = request();
  expect(projectTestFreshness(r, binding())).toEqual({ freshness: "current", reason: "matches" });
  expect(projectTestFreshness(r, binding({ status: "published" })).freshness).toBe("current");
  expect(projectTestFreshness(r, binding({ sourceFingerprint: "src-B" }))).toEqual({ freshness: "historical", reason: "source-changed" });
  expect(projectTestFreshness(r, binding({ stagingPath: "/ws/t1-new" }))).toEqual({ freshness: "historical", reason: "workspace-changed" });
  expect(projectTestFreshness(r, binding({ status: "executing", sourceFingerprint: null }))).toEqual({ freshness: "historical", reason: "workspace-in-progress" });
  expect(projectTestFreshness(r, binding({ sourceFingerprint: null }))).toEqual({ freshness: "unverified", reason: "source-unreadable" });
  expect(projectTestFreshness(r, binding({ status: "abandoned" })).freshness).toBe("unverified");
  expect(projectTestFreshness(r, binding({ projectPath: "/other" })).freshness).toBe("unverified");
  expect(projectTestFreshness(r, null)).toEqual({ freshness: "unverified", reason: "workspace-unavailable" });
});

test("evidence: nothing requested is not-run; foreign rows are dropped", () => {
  expect(build([]).kind).toBe("not-run");
  const foreign = [request({ id: "x", taskId: "t2" }), request({ id: "y", projectPath: "/other" })];
  const evidence = build(foreign);
  expect(evidence.kind).toBe("not-run");
  expect(evidence.latest).toBeNull();
  expect(buildProjectTestEvidence({ taskId: "t1", projectPath: null, requests: [request()], current: binding(), now: NOW }).kind).toBe("not-run");
});

test("evidence: the latest request is the headline; an earlier pass never hides it and never counts as current proof", () => {
  const pass = request({ id: "pass", createdAt: 100 });
  const pending = request({ id: "new", createdAt: 200, status: "pending", exitCode: null, finishedAt: null, startedAt: null, decidedAt: null });
  const e = build([pass, pending]);
  expect(e.kind).toBe("pending");
  expect(e.latest?.requestId).toBe("new");
  expect(e.lastResult?.requestId).toBe("pass");
  expect(e.currentPass).toBe(false);
  const blocked = request({ id: "blk", createdAt: 300, status: "blocked", exitCode: null, finishedAt: 310 });
  const b = build([blocked, pass, pending]);
  expect(b.kind).toBe("did-not-run");
  expect(b.latest?.freshness).toBeNull();
  expect(b.currentPass).toBe(false);
  expect(build([pass]).currentPass).toBe(true);
});

test("evidence: a pending request past its time reads as expired, and no output is carried", () => {
  const e = build([request({ status: "pending", exitCode: null, expiresAt: NOW - 1 })]);
  expect(e.kind).toBe("did-not-run");
  expect(e.latest?.status).toBe("expired");
  expect(JSON.stringify(build([request()]))).not.toContain("SECRET-OUTPUT");
});

test("evidence: a stale pass stays a recorded pass but is not current proof", () => {
  const e = build([request()], binding({ sourceFingerprint: "src-B" }));
  expect(e.kind).toBe("passed");
  expect(e.latest?.freshness).toBe("historical");
  expect(e.currentPass).toBe(false);
});

test("evidence: an interrupted attempt is never 'did not run' and never hides or becomes a pass", () => {
  const pass = request({ id: "pass", createdAt: 100 });
  const interrupted = request({ id: "int", createdAt: 200, status: "interrupted", authority: "owner-once", exitCode: null, finishedAt: 210 });
  const e = build([pass, interrupted]);
  expect(e.kind).toBe("interrupted");
  expect(e.latest?.freshness).toBeNull();
  expect(e.lastResult?.requestId).toBe("pass");
  expect(e.currentPass).toBe(false);
  // Only a status that itself establishes "no process started" reads as did-not-run.
  expect(build([request({ status: "blocked", exitCode: null })]).kind).toBe("did-not-run");
});
