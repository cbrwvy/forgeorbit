import { expect, test } from "bun:test";
import { selectProductionTransport, type OwnerLiveAuthorization, type ProductionTransportInput } from "./dispatch.ts";
import type { RuntimeExecutionRequest } from "./negotiate.ts";

function request(overrides: Partial<RuntimeExecutionRequest> = {}): RuntimeExecutionRequest {
  return {
    providerId: "codex",
    harnessId: "codex-a",
    accountId: "acct-a",
    boundAccountId: "acct-a",
    modelId: "gpt-6.1-sol",
    role: "developer",
    permissionMode: "auto",
    projectPath: "/work/app",
    taskId: "task-1",
    missionId: "mission-1",
    runId: "reservation-1",
    attemptId: "reservation-1",
    profileDirectory: "/profiles/codex-a",
    homeAccessAccepted: false,
    transport: "recorded-fixture",
    installed: false,
    ...overrides,
  };
}

function input(overrides: Partial<ProductionTransportInput> = {}, requestOverrides: Partial<RuntimeExecutionRequest> = {}): ProductionTransportInput {
  const next = request(requestOverrides);
  return {
    request: next,
    live: null,
    now: 1_000,
    workspace: next.projectPath,
    filesystem: next.role === "reviewer" ? "read-only" : "workspace-write",
    terminal: false,
    envelopeId: null,
    scope: `${next.role}:${next.providerId}:${next.permissionMode}`,
    ...overrides,
  };
}

function live(overrides: Partial<OwnerLiveAuthorization> = {}): OwnerLiveAuthorization {
  const base = input();
  return {
    id: "auth-1",
    projectPath: base.request.projectPath,
    taskId: base.request.taskId,
    missionId: base.request.missionId,
    role: "developer",
    providerId: "codex",
    harnessId: base.request.harnessId,
    modelId: base.request.modelId,
    accountId: base.request.accountId,
    mode: base.request.permissionMode,
    workspace: base.workspace,
    filesystem: "workspace-write",
    terminal: false,
    envelopeId: null,
    runId: base.request.runId,
    attemptId: base.request.attemptId,
    scope: base.scope,
    expiresAt: 2_000,
    grantedBy: "owner-live-acceptance",
    ...overrides,
  };
}

test("recorded transport keeps the account and does not start a process", () => {
  const selected = selectProductionTransport(input());
  expect(selected.ok).toBe(true);
  if (!selected.ok) return;
  expect(selected.transport).toBe("recorded");
  expect(selected.processStarted).toBe(false);
  expect(selected.launcher).toBe("none");
  expect(selected.plan.accountId).toBe("acct-a");
  expect(selected.plan.envBinding.CODEX_HOME).toBe("/profiles/codex-a");
  expect(selected.plan.argv).toContain("workspace-write");
  expect(selected.readOnly).toBe(false);
});

test("reviewer transport is read-only and a live request without authorization is refused", () => {
  const reviewer = selectProductionTransport(input({}, { role: "reviewer", permissionMode: "ask", providerId: "claude-code", homeAccessAccepted: true, profileDirectory: "/profiles/claude-a" }));
  expect(reviewer.ok).toBe(true);
  if (!reviewer.ok) return;
  expect(reviewer.readOnly).toBe(true);
  expect(reviewer.plan.argv.join(" ")).toContain("Read,Glob,Grep");
  expect(reviewer.plan.argv.join(" ")).not.toContain("Edit");
  const liveRequest = selectProductionTransport(input({}, { transport: "live" }));
  expect(liveRequest).toMatchObject({ ok: false, code: "live-not-authorized", processStarted: false });
});

test("a matching live authorization names the existing launcher and still starts nothing", () => {
  const selected = selectProductionTransport(input({ live: live() }, { transport: "live" }));
  expect(selected.ok).toBe(true);
  if (!selected.ok) return;
  expect(selected.transport).toBe("codex-live");
  expect(selected.launcher).toBe("spawnCodexViaTmux");
  expect(selected.processStarted).toBe(false);
});

test("live authorization mismatches, blocked providers, and consumed work are refused", () => {
  expect(selectProductionTransport(input({ live: live({ accountId: "acct-b" }) }, { transport: "live" })).ok).toBe(false);
  expect(selectProductionTransport(input({}, { accountId: "", boundAccountId: null }))).toMatchObject({ code: "account-mismatch" });
  expect(selectProductionTransport(input({}, { permissionMode: "full-access" }))).toMatchObject({ code: "unrestricted-permission" });
  expect(selectProductionTransport(input({}, { providerId: "cursor" }))).toMatchObject({ ok: false, processStarted: false });
  expect(selectProductionTransport(input({ live: live({ providerId: "codex" }) }, { providerId: "deepseek-dsh", transport: "live" })).ok).toBe(false);
  expect(selectProductionTransport(input({}, { completedRunIds: ["reservation-1"] }))).toMatchObject({ code: "duplicate-run" });
  expect(selectProductionTransport(input({}, { consumedGrantId: "grant-1", priorGrantIds: ["grant-1"] }))).toMatchObject({ code: "grant-consumed" });
  expect(selectProductionTransport(input({}, { resumeSessionAccountId: "acct-b" }))).toMatchObject({ code: "cross-profile-resume" });
  expect(selectProductionTransport(input({}, { projectPaused: true }))).toMatchObject({ code: "project-paused" });
  const reviewerWrite = selectProductionTransport(input({
    live: live({ role: "reviewer", filesystem: "workspace-write", mode: "ask", scope: "reviewer:codex:ask" }),
    filesystem: "read-only",
  }, { role: "reviewer", permissionMode: "ask", transport: "live" }));
  expect(reviewerWrite).toMatchObject({ ok: false, processStarted: false });
});
