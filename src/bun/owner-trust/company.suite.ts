/**
 * FO-OWNER-TRUST01 disposable company.
 * Production AccountCore, Router binding, mission admission, Owner proof,
 * durable grants, and the activity journal. The fixture is not a provider.
 */
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { parseOwnerOperation, type OwnerOperation } from "../../shared/owner-trust/protocol.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-owner-trust-company-")));
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CURSOR_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_TMUX_BIN = "/bin/echo";
delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;

const { db, dataDir, projects, runs, tasks } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("../claude-profiles.ts");
const { createTask } = await import("../orchestrator.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { missionScheduler } = await import("../orchestration/mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy, revokeAutonomyPolicy } = await import("../autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal } = await import("../orchestration/mission-replan.ts");
const { stopProjectLifecycle } = await import("../project-lifecycle.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { AssignmentCore } = await import("../assignment-core.ts");
const { productionClaudeLauncher, productionCodexLauncher } = await import("../provider-runtime/live-launch.ts");
const { spawnClaudeViaTmux } = await import("../claude-tmux.ts");
const { spawnCodexViaTmux } = await import("../codex-tmux.ts");
const { taskBindingDigest } = await import("./admission.ts");
const { createSyntheticSigner } = await import("./crypto.ts");
const { admitVerifiedFixture } = await import("./fixture-launch.ts");
const { ownerTrustHttp } = await import("./http.ts");
const { readAuthoritativeOperation } = await import("./preview.ts");
const { buildProofPayload, createOwnerTrust } = await import("./service.ts");

__setClaudeAuthProbeForTest(async (directory) => ({ loggedIn: directory.endsWith("claude-a"), configDirectory: directory }));

function refusalCode(result: { ok: boolean }): string {
  if (result.ok) throw new Error("expected a refusal");
  return (result as unknown as { code: string }).code;
}

test("a disposable company consumes one exact Owner proof and does not start a provider", async () => {
  expect(productionCodexLauncher).toBe(spawnCodexViaTmux);
  expect(productionClaudeLauncher).toBe(spawnClaudeViaTmux);
  const core = new AccountCore(db);
  const codex = new CodexProfiles(core);
  const claude = new ClaudeProfiles(core);
  const model = "gpt-6.1-sol";
  const reviewerModel = "haiku-5.5";
  const codexADir = path.join(home, "codex-a");
  const codexBDir = path.join(home, "codex-b");
  writeSyntheticCodexProfile(codexADir, "synthetic-codex-a");
  writeSyntheticCodexProfile(codexBDir, "synthetic-codex-b");
  const codexA = codex.register({ displayName: "Codex A", directory: realpathSync(codexADir) });
  const codexB = codex.register({ displayName: "Codex B", directory: realpathSync(codexBDir) });
  const claudeADir = path.join(home, "claude-a");
  mkdirSync(claudeADir, { recursive: true });
  const claudeA = claude.register({ displayName: "Claude A", directory: realpathSync(claudeADir), homeAccessAccepted: true });
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  projects.upsert(projectA, "Project A");
  projects.upsert(projectB, "Project B");
  const now = Date.now();
  db.run("INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["cluster-a", "Cluster A", "cluster-a", "Owner trust", now, now]);
  for (const dir of [projectA, projectB]) {
    db.run("INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)", [dir, "cluster-a", now, now]);
  }
  const employees = new EmployeeCore(db);
  const developer = employees.createWorker({ name: "Owner-trust developer", jobTitle: "Developer", projectPath: projectA });
  const reviewer = employees.createWorker({ name: "Owner-trust reviewer", jobTitle: "Reviewer", projectPath: projectA });
  const assignments = new AssignmentCore(db);
  const developerTask = await createTask({
    title: "Developer operation", prompt: "Synthetic company work. Do not call a provider.", workdir: projectA, column: "ready",
    agent: codexA.harnessId, model, mode: "auto", isolation: "none",
  });
  const reviewerTask = await createTask({
    title: "Reviewer operation", prompt: "Read the synthetic result. Do not modify files.", workdir: projectA, column: "ready",
    agent: claudeA.harnessId, model: reviewerModel, mode: "bounded-print", isolation: "none",
  });
  if ("error" in developerTask || "error" in reviewerTask) throw new Error("task create failed");
  assignments.assign(developerTask.task.id, developer.id);
  assignments.assign(reviewerTask.task.id, reviewer.id);
  const policy = createAutonomyPolicy({
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: [projectA, projectB],
    specialistRoles: ["developer", "reviewer"], providers: ["codex", "claude-code"], models: [model, reviewerModel],
    accounts: [codexA.accountId, codexB.accountId, claudeA.accountId],
    maxConcurrentWorkers: 2, maxLaunches: 4, maxDurationMs: 300_000, maxReworkAttempts: 1, expiresAt: now + 300_000,
    permittedActions: ["plan_task", "launch_task", "run_qc", "request_rework"],
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
    completion: { autoComplete: false, conditions: ["qc_pass"] },
  });
  const activation = activateAutonomyPolicy(policy.id);
  const mission = await missionScheduler.prepareMission({
    title: "Owner trust company",
    goal: "Authorize one exact operation",
    tasks: [
      { taskId: developerTask.task.id, projectPath: projectA, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "critical", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: true },
      { taskId: reviewerTask.task.id, projectPath: projectA, clusterId: "cluster-a", specialistRole: "reviewer", assignedEmployeeId: reviewer.id, priority: "high", harnessId: claudeA.harnessId, modelId: reviewerModel, accountId: claudeA.accountId, mode: "bounded-print", qcRequired: true },
    ],
    concurrencyLimits: { globalMax: 2, perProjectMax: 2, perAccountMax: 2, perClusterMax: 2 },
    policyOverride: { qcRequired: true, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
  });
  await missionScheduler.authorizeMission(mission.id, mission.planDigest);
  autonomyPolicyStore.upsertBinding({
    missionId: mission.id, policyId: policy.id, revision: policy.revision, activationId: activation.id, digest: policy.digest,
    mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
  });
  const proposal = prepareMissionResourceProposal(mission.id, {
    taskId: reviewerTask.task.id, role: "reviewer",
    resource: { harnessId: claudeA.harnessId, modelId: reviewerModel, accountId: claudeA.accountId, mode: "bounded-print" },
    reason: "Owner approved a separate read-only reviewer account.",
  });
  settleMissionResourceProposal(mission.id, proposal.id, proposal.digest, "approve");
  missionStore.updateMissionStatus(mission.id, "running", "owner started");
  const current = missionStore.getMission(mission.id)!;
  const dev = tasks.get(developerTask.task.id)!;
  const operation = operationFor({
    requestId: "company-developer",
    projectPath: projectA,
    task: dev,
    missionId: current.id,
    missionRevision: current.planDigest,
    role: "developer",
    providerId: "codex",
    harnessId: codexA.harnessId,
    accountId: codexA.accountId,
    modelId: model,
    mode: "auto",
    filesystem: "workspace-write",
    policy,
  });
  const trust = createOwnerTrust({
    database: db,
    dataDir,
    machineId: "company-machine",
    allowSynthetic: true,
    identity: { bundleId: null, teamId: null, trustClass: "unestablished", adhoc: true, signed: false, source: "company" },
  });
  const signer = createSyntheticSigner();
  const enrollment = trust.enrollSynthetic(signer.publicKeySpki, "company-synthetic");
  const proof = sign(trust, signer, enrollment.id, operation);
  const seen: OwnerOperation[] = [];
  const launched = await admitVerifiedFixture({
    service: trust,
    operation,
    proof,
    fixture: async () => { seen.push(operation); },
  });
  expect(launched).toMatchObject({ processStarted: false, code: "verified-fixture" });
  expect(seen[0]).toMatchObject({ accountId: codexA.accountId, modelId: model, role: "developer" });
  expect(runs.listForTask(dev.id)).toEqual([]);
  expect(trust.admit(proof, operation, { trustClasses: ["synthetic-test"] }).code).toBe("owner-already-consumed");

  const otherAccount = operationFor({
    requestId: "company-other-account",
    projectPath: projectA,
    task: dev,
    missionId: current.id,
    missionRevision: current.planDigest,
    role: "developer",
    providerId: "codex",
    harnessId: codexA.harnessId,
    accountId: codexB.accountId,
    modelId: model,
    mode: "auto",
    filesystem: "workspace-write",
    policy,
    runId: "run-other-account",
  });
  expect(refusalCode(trust.admit(sign(trust, signer, enrollment.id, otherAccount), otherAccount, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-account-unbound");
  expect(refusalCode(parseOwnerOperation({ ...operation, providerId: "cursor" }))).toBe("owner-provider-blocked");
  expect(refusalCode(parseOwnerOperation({ ...operation, modelId: "deepseek-v4", scope: "single:developer:codex:account-a:deepseek-v4" }))).toBe("owner-provider-blocked");
  expect(refusalCode(parseOwnerOperation({ ...operation, gitPublish: true }))).toBe("owner-privileged-excluded");
  expect(refusalCode(parseOwnerOperation({ ...operation, role: "reviewer", filesystem: "workspace-write", scope: `single:reviewer:codex:${codexA.accountId}:${model}` }))).toBe("owner-sandbox");

  const review = tasks.get(reviewerTask.task.id)!;
  const reviewerOperation = operationFor({
    requestId: "company-reviewer",
    projectPath: projectA,
    task: review,
    missionId: current.id,
    missionRevision: current.planDigest,
    role: "reviewer",
    providerId: "claude-code",
    harnessId: claudeA.harnessId,
    accountId: claudeA.accountId,
    modelId: reviewerModel,
    mode: "bounded-print",
    filesystem: "read-only",
    policy,
    runId: "run-reviewer",
  });
  const reviewerLaunch = await admitVerifiedFixture({
    service: trust, operation: reviewerOperation, proof: sign(trust, signer, enrollment.id, reviewerOperation), fixture: async () => {},
  });
  expect(reviewerLaunch).toMatchObject({ processStarted: false, code: "verified-fixture" });
  expect(reviewerOperation.filesystem).toBe("read-only");

  const expiredOperation = operationFor({
    requestId: "company-expired", projectPath: projectA, task: dev, missionId: current.id, missionRevision: current.planDigest,
    role: "developer", providerId: "codex", harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model, mode: "auto",
    filesystem: "workspace-write", policy, runId: "run-expired",
  });
  const expiredIssued = trust.issueChallenge(expiredOperation, enrollment.id);
  if (!expiredIssued.ok) throw new Error(expiredIssued.reason);
  db.run("UPDATE owner_trust_challenges SET expires_at = ? WHERE id = ?", [Date.now() - 1000, expiredIssued.challengeId]);
  const expiredProof = buildProofPayload(expiredOperation, { nonce: expiredIssued.nonce, enrollmentId: enrollment.id, applicationIdentity: "synthetic-test", issuedAt: Date.now() });
  expect(trust.admit({ schema: "forgeorbit-owner-trust-v1", payload: expiredProof, signature: signer.sign(expiredProof) }, expiredOperation, { trustClasses: ["synthetic-test"] }).code).toBe("owner-challenge-expired");

  autonomyPolicyStore.writeEmergency(true, "stop", []);
  const stoppedOperation = operationFor({
    requestId: "company-stopped", projectPath: projectA, task: dev, missionId: current.id, missionRevision: current.planDigest,
    role: "developer", providerId: "codex", harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model, mode: "auto",
    filesystem: "workspace-write", policy, runId: "run-stopped",
  });
  expect(refusalCode(trust.admit(sign(trust, signer, enrollment.id, stoppedOperation), stoppedOperation, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-emergency-stop");
  autonomyPolicyStore.writeEmergency(false, null, []);

  await stopProjectLifecycle(projectB, "Owner paused project B");
  const pausedProject = await createTask({
    title: "Paused project", prompt: "Do not start.", workdir: projectB, column: "ready", agent: codexA.harnessId, model, mode: "auto", isolation: "none",
  });
  if ("error" in pausedProject) throw new Error(pausedProject.error);
  const pausedOperation = operationFor({
    requestId: "company-paused-project", projectPath: projectB, task: tasks.get(pausedProject.task.id)!, missionId: current.id, missionRevision: current.planDigest,
    role: "developer", providerId: "codex", harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model, mode: "auto",
    filesystem: "workspace-write", policy, runId: "run-paused-project",
  });
  expect(refusalCode(trust.admit(sign(trust, signer, enrollment.id, pausedOperation), pausedOperation, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-project-paused");

  await missionScheduler.pauseMission(current.id, "restart check");
  const pausedMission = operationFor({
    requestId: "company-paused-mission", projectPath: projectA, task: tasks.get(dev.id)!, missionId: current.id, missionRevision: missionStore.getMission(current.id)!.planDigest,
    role: "developer", providerId: "codex", harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model, mode: "auto",
    filesystem: "workspace-write", policy, runId: "run-paused-mission",
  });
  expect(refusalCode(trust.admit(sign(trust, signer, enrollment.id, pausedMission), pausedMission, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-mission-paused");
  missionStore.updateMissionStatus(current.id, "running", "resumed without a provider tick");

  revokeAutonomyPolicy(policy.id);
  const revokedPolicy = operationFor({
    requestId: "company-revoked-policy", projectPath: projectA, task: tasks.get(dev.id)!, missionId: current.id, missionRevision: missionStore.getMission(current.id)!.planDigest,
    role: "developer", providerId: "codex", harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model, mode: "auto",
    filesystem: "workspace-write", policy, runId: "run-revoked-policy",
  });
  expect(refusalCode(trust.admit(sign(trust, signer, enrollment.id, revokedPolicy), revokedPolicy, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-policy-revoked");

  const restarted = createOwnerTrust({
    database: db, dataDir, machineId: "company-machine", allowSynthetic: true,
    identity: { bundleId: null, teamId: null, trustClass: "unestablished", adhoc: true, signed: false, source: "restart" },
  });
  expect(refusalCode(restarted.admit(proof, operation, { trustClasses: ["synthetic-test"] }))).toBe("owner-already-consumed");
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const copy = path.join(root, "restored.sqlite");
  copyFileSync(path.join(dataDir, "agetor.sqlite"), copy);
  const restoredDb = new Database(copy);
  const restored = createOwnerTrust({
    database: restoredDb, dataDir: path.join(root, "restored-profile"), machineId: "other-machine", allowSynthetic: true,
    identity: { bundleId: null, teamId: null, trustClass: "unestablished", adhoc: true, signed: false, source: "restored" },
  });
  expect(refusalCode(restored.issueChallenge(operation, enrollment.id))).toBe("owner-restored-inactive");
  restoredDb.close();
  trust.revokeEnrollment(enrollment.id);
  expect(refusalCode(trust.issueChallenge(operation, enrollment.id))).toBe("owner-revoked");

  // Direction 21: Owner authorization does not widen access modes or create Browser/Native CU grants.
  const fullComputerTask = await createTask({
    title: "Full computer task", prompt: "Should stay non-process.", workdir: projectA, column: "ready",
    agent: codexA.harnessId, model, mode: "auto", isolation: "none", accessMode: "full-computer",
  });
  const isolatedClaudeTask = await createTask({
    title: "Isolated claude task", prompt: "Unsupported in isolated.", workdir: projectA, column: "ready",
    agent: claudeA.harnessId, model: reviewerModel, mode: "bounded-print", isolation: "none", accessMode: "isolated",
  });
  if ("error" in fullComputerTask || "error" in isolatedClaudeTask) throw new Error("d21 task create failed");
  const recoverySigner = createSyntheticSigner();
  const reEnrolled = trust.enrollSynthetic(recoverySigner.publicKeySpki, "company-recovered");
  const fcOp = operationFor({
    requestId: "company-full-computer", projectPath: projectA, task: tasks.get(fullComputerTask.task.id)!, missionId: current.id,
    missionRevision: missionStore.getMission(current.id)!.planDigest, role: "developer", providerId: "codex",
    harnessId: codexA.harnessId, accountId: codexA.accountId, modelId: model, mode: "auto", filesystem: "workspace-write", policy, runId: "run-fc",
  });
  expect(refusalCode(trust.admit(sign(trust, recoverySigner, reEnrolled.id, fcOp), fcOp, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-sandbox");
  const isoOp = operationFor({
    requestId: "company-iso-claude", projectPath: projectA, task: tasks.get(isolatedClaudeTask.task.id)!, missionId: current.id,
    missionRevision: missionStore.getMission(current.id)!.planDigest, role: "reviewer", providerId: "claude-code",
    harnessId: claudeA.harnessId, accountId: claudeA.accountId, modelId: reviewerModel, mode: "bounded-print", filesystem: "read-only", policy, runId: "run-iso",
  });
  expect(refusalCode(trust.admit(sign(trust, recoverySigner, reEnrolled.id, isoOp), isoOp, { trustClasses: ["synthetic-test"], consume: false }))).toBe("owner-sandbox");
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM browser_agent_grants").get()!.count).toBe(0);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM native_computer_agent_grants").get()!.count).toBe(0);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runs").get()!.count).toBe(0);

  // Authoritative preview skips full-computer tasks and resolves bound profile accounts.
  const preview = readAuthoritativeOperation(db);
  expect(preview?.operation.taskId).not.toBe(fullComputerTask.task.id);
  expect(preview?.operation.providerId).toBe("claude-code");
  expect(preview?.operation.accountId).toBe(claudeA.accountId);

  const events = db.query<{ event_type: string }, []>("SELECT event_type FROM activity_events WHERE event_type LIKE 'owner.trust.%'").all();
  expect(events.some((row) => row.event_type === "owner.trust.consumed")).toBe(true);
  const before = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_grants").get()!.count;
  const response = await ownerTrustHttp(new Request("http://127.0.0.1/api/owner-trust/approve", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
  }), true);
  expect(response.status).toBe(400);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_grants").get()!.count).toBe(before);
});

function operationFor(input: {
  requestId: string;
  projectPath: string;
  task: { id: string; prompt: string; workdir: string; column: string };
  missionId: string;
  missionRevision: string;
  role: "developer" | "reviewer";
  providerId: "codex" | "claude-code";
  harnessId: string;
  accountId: string;
  modelId: string;
  mode: string;
  filesystem: "workspace-write" | "read-only";
  policy: { revision: number; digest: string; id: string };
  runId?: string;
}): OwnerOperation {
  const parsed = parseOwnerOperation({
    schema: "forgeorbit-owner-trust-v1",
    requestId: input.requestId,
    kind: "single-operation",
    projectPath: input.projectPath,
    taskId: input.task.id,
    missionId: input.missionId,
    missionRevision: input.missionRevision,
    taskStateDigest: taskBindingDigest(input.task),
    missionStateDigest: input.missionRevision,
    role: input.role,
    providerId: input.providerId,
    harnessId: input.harnessId,
    accountId: input.accountId,
    modelId: input.modelId,
    mode: input.mode,
    workspace: input.task.workdir,
    filesystem: input.filesystem,
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: input.policy.id,
    envelopeDigest: input.policy.digest,
    policyRevision: String(input.policy.revision),
    scope: `single:${input.role}:${input.providerId}:${input.accountId}:${input.modelId}`,
    runId: input.runId ?? "run-company",
    attemptId: input.requestId,
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    cancellationAvailable: true,
    externalProcess: false,
    expiresAt: Date.now() + 60_000,
  });
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.reason}`);
  return parsed.operation;
}

function sign(trust: ReturnType<typeof createOwnerTrust>, signer: ReturnType<typeof createSyntheticSigner>, enrollmentId: string, operation: OwnerOperation) {
  const issued = trust.issueChallenge(operation, enrollmentId);
  if (!issued.ok) throw new Error(`${issued.code}: ${issued.reason}`);
  const payload = buildProofPayload(operation, {
    nonce: issued.nonce, enrollmentId, applicationIdentity: "synthetic-test", issuedAt: Date.now(),
  });
  return { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: signer.sign(payload) };
}
