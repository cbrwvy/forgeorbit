/** FO-MULTIACCOUNT02 acceptance. Synthetic profiles and fake drivers only. */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { evaluateCandidates, type EvaluatorCandidateInput } from "../shared/router-v2/evaluator.ts";
import { DEFAULT_ROUTER_POLICY, type TaskRequirementsInput } from "../shared/router-v2/types.ts";
import { evaluateApplicablePolicies, normalizePolicyBody, policyDigest, type ApplicablePolicy } from "../shared/autonomy-policy.ts";
import { answerAccountQuestion } from "../shared/accounts/execution-profile.ts";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-multiaccount02-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);

const { db, harnesses } = await import("./db.ts");
const { AccountCore } = await import("./account-core.ts");
const { accountHttp } = await import("./account-http.ts");
const { LegacyUsageBridge } = await import("./account-usage-bridge.ts");
const { CodexProfiles } = await import("./codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("./claude-profiles.ts");
const { harnessEnv, buildCommand } = await import("./agents.ts");
const { explainBinding, authenticateBinding, profileCapacityAllows, reservationBlocksRelaunch } = await import("./multiaccount/binding.ts");
const { listExecutionProfiles, noteAuthenticationCheck, setProjectAccountPreference, writeExecutionMeta, loadAccountAnswerSnapshot } = await import("./multiaccount/registry.ts");
const { missionStore } = await import("./orchestration/mission-store.ts");
const { RouterV2Service } = await import("./router-v2/router-v2-service.ts");

const core = new AccountCore(db);
const codex = new CodexProfiles(core);
const claude = new ClaudeProfiles(core);
__setClaudeAuthProbeForTest(async (directory) => ({ loggedIn: directory.endsWith("claude-a"), configDirectory: directory }));

function codexDir(name: string, subject: string) {
  const directory = path.join(ownerHome, name);
  writeSyntheticCodexProfile(directory, subject);
  return directory;
}
function claudeDir(name: string) {
  const directory = path.join(ownerHome, name);
  mkdirSync(directory, { recursive: true });
  return realpathSync(directory);
}

afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("explicit HOME consent updates only the existing Claude registration and unlocks its account check", async () => {
  const selected = claude.register({ displayName: "Selected", directory: claudeDir("consent-claude-a"), homeAccessAccepted: false });
  const other = claude.register({ displayName: "Other", directory: claudeDir("consent-claude-b"), homeAccessAccepted: false });
  const codexAccount = core.createAccount({ displayName: "Codex", provider: "openai" });
  const legacy = new LegacyUsageBridge(db);
  const request = (route: string, method = "GET", value?: unknown, authorized = true) =>
    accountHttp(new Request(`http://localhost/account-core/${route}`, {
      method, body: value === undefined ? undefined : JSON.stringify(value),
    }), core, legacy, authorized);
  const route = `claude-profiles/${selected.accountId}`;
  const accept = { homeAccessAccepted: true };

  expect((await request("execution-profiles")).status).toBe(200);
  expect((await request(`${route}/check`, "POST")).status).toBe(409);
  expect((await request(route, "PATCH", accept, false)).status).toBe(401);
  expect((await request(route, "PATCH", { homeAccessAccepted: false })).status).toBe(409);
  expect((await request(route, "PATCH", { ...accept, accountId: other.accountId })).status).toBe(409);
  expect((await request(`claude-profiles/${codexAccount.id}`, "PATCH", accept)).status).toBe(409);
  expect((await request(`accounts/${selected.accountId}`, "PATCH", { displayName: "Selected Claude" })).status).toBe(200);
  expect(claude.view(selected.accountId)).toMatchObject({ homeAccessAccepted: false, availability: "acceptance-required" });
  const selectedBefore = core.getAccount(selected.accountId);
  const otherBefore = core.getAccount(other.accountId);
  const resourceBefore = harnesses.get(selected.harnessId);
  const bindingsBefore = core.bindings(selected.accountId);

  const response = await request(route, "PATCH", accept);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    accountId: selected.accountId, directory: selected.directory, harnessId: selected.harnessId,
    homeAccessAccepted: true, availability: "unchecked", authentication: "unknown", support: "partial",
  });
  expect(core.getAccount(selected.accountId).claudeProfile).toEqual({ ...selectedBefore.claudeProfile!, ...accept });
  expect(core.getAccount(other.accountId)).toEqual(otherBefore);
  expect(core.getAccount(codexAccount.id)).toEqual(codexAccount);
  expect(harnesses.get(selected.harnessId)).toEqual(resourceBefore);
  expect(core.bindings(selected.accountId)).toEqual(bindingsBefore);
  expect(claude.list()).toHaveLength(2);
  expect((await request(`claude-profiles/${other.accountId}/check`, "POST")).status).toBe(409);

  const checked = await request(`${route}/check`, "POST");
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({ authentication: "authenticated", availability: "ready", verifiedSubject: null });
  claude.remove(selected.accountId);
  claude.remove(other.accountId);
  core.archiveAccount(codexAccount.id);
});

test("synthetic profiles bind exactly, keep Unknown identity, and do not invent quota", async () => {
  const work = codex.register({ displayName: "Work", directory: codexDir("codex-work", "synthetic-work") });
  const personal = codex.register({ displayName: "Personal", directory: codexDir("codex-personal", "synthetic-personal") });
  const claudeADir = claudeDir("claude-a");
  const claudeBDir = claudeDir("claude-b");
  const blockedAcceptance = claude.register({ displayName: "Claude A", directory: claudeADir, homeAccessAccepted: false });
  expect(explainBinding({ harnessId: blockedAcceptance.harnessId, accountId: blockedAcceptance.accountId, modelId: "haiku-5.5", mode: "ask" }).ok).toBe(false);
  const claudeA = claude.register({ displayName: "Claude A", directory: claudeADir, homeAccessAccepted: true }, blockedAcceptance.accountId);
  const claudeB = claude.register({ displayName: "Claude B", directory: claudeBDir, homeAccessAccepted: true });

  expect(new Set([work.accountId, personal.accountId, claudeA.accountId, claudeB.accountId]).size).toBe(4);
  expect(await codex.check(work.accountId)).toMatchObject({ authentication: "authenticated", quota: "unknown" });
  expect(await codex.check(personal.accountId)).toMatchObject({ authentication: "authenticated" });
  const checkedA = await claude.check(claudeA.accountId);
  const checkedB = await claude.check(claudeB.accountId);
  expect(checkedA.verifiedSubject).toBeNull();
  expect(checkedA.support).toBe("partial");
  expect(checkedA.availability).toBe("ready");
  expect(checkedB.availability).toBe("authentication-required");
  noteAuthenticationCheck(db, work.accountId, "authenticated", Date.now());
  noteAuthenticationCheck(db, claudeA.accountId, "authenticated", Date.now());
  noteAuthenticationCheck(db, claudeB.accountId, "required", Date.now());

  writeExecutionMeta(db, work.accountId, { models: [{ id: "gpt-6-luna", eligibility: "declared", modes: ["ask", "auto"] }], concurrencyLimit: 1, providerSharedLimit: 1, configuredIdentity: "work-label" });
  writeExecutionMeta(db, personal.accountId, { models: [{ id: "gpt-6.1-sol", eligibility: "declared", modes: ["ask", "auto"] }], concurrencyLimit: 1 });
  writeExecutionMeta(db, claudeA.accountId, { models: [{ id: "haiku-5.5", eligibility: "declared", modes: ["ask"] }] });
  writeExecutionMeta(db, claudeB.accountId, { disabled: true });

  const definition = core.createDefinition({ accountId: work.accountId, subscriptionId: null, scope: "requests", unit: { kind: "requests" }, window: "5h" });
  core.recordTrustedObservations("synthetic", [{
    quotaId: definition.id,
    values: { remaining: 40, limit: 100, used: 60, confidence: "high", expiresAt: Date.now() + 3_600_000 },
    evidence: {
      provider: "openai", accountId: work.accountId, subject: "synthetic-quota-subject", method: "provider-account",
      sourceId: "synthetic", officialUrl: "https://example.invalid/quota", checkedAt: "2026-11-10", receivedAt: Date.now(),
      sharedPool: null, limitations: "synthetic fixture, not a provider subject",
    },
  }]);
  const observed = core.createDefinition({ accountId: personal.accountId, subscriptionId: null, scope: "requests", unit: { kind: "requests" }, window: "5h" });
  core.recordObservation(observed.id, { remaining: 9, limit: 10, used: 1, confidence: "low", expiresAt: Date.now() + 3_600_000 });

  const profiles = listExecutionProfiles(db);
  const workProfile = profiles.find((profile) => profile.accountId === work.accountId)!;
  const personalProfile = profiles.find((profile) => profile.accountId === personal.accountId)!;
  const claudeProfile = profiles.find((profile) => profile.accountId === claudeA.accountId)!;
  const unavailable = profiles.find((profile) => profile.accountId === claudeB.accountId)!;
  expect(workProfile.verifiedSubject).toBeNull();
  expect(workProfile.configuredIdentity).toBe("work-label");
  expect(workProfile.subjectLabel).toBe("Configured");
  expect(workProfile.quota).toMatchObject({ status: "verified", remaining: 40 });
  expect(JSON.stringify(workProfile)).not.toContain("synthetic-quota-subject");
  expect(personalProfile.quota).toEqual({ status: "observed", remaining: null, unit: null });
  expect(claudeProfile.support).toBe("partial");
  expect(claudeProfile.verifiedSubject).toBeNull();
  expect(claudeProfile.quota.status).toBe("unknown");
  expect(unavailable.executionReady).toBe(false);
  expect(unavailable.disabled).toBe(true);

  const workEnv = harnessEnv(harnesses.get(work.harnessId)!);
  const personalEnv = harnessEnv(harnesses.get(personal.harnessId)!);
  expect(workEnv.CODEX_HOME).toBe(work.directory);
  expect(personalEnv.CODEX_HOME).toBe(personal.directory);
  expect(workEnv.CODEX_HOME).not.toBe(personalEnv.CODEX_HOME);
  const claudeEnv = harnessEnv(harnesses.get(claudeA.harnessId)!);
  expect(claudeEnv.CLAUDE_CONFIG_DIR).toBe(claudeA.directory);
  expect(claudeEnv.HOME).toBeUndefined();

  const mismatch = explainBinding({ harnessId: personal.harnessId, accountId: work.accountId, modelId: "gpt-6-luna", mode: "ask" });
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.reason).toContain("mismatch");
  const wrongModel = explainBinding({ harnessId: work.harnessId, accountId: work.accountId, modelId: "gpt-6.1-sol", mode: "ask" });
  expect(wrongModel.ok).toBe(false);
  const unavailableLaunch = await authenticateBinding({ harnessId: claudeB.harnessId, accountId: claudeB.accountId, modelId: "haiku-5.5", mode: "ask" });
  expect(unavailableLaunch.ok).toBe(false);
  expect(explainBinding({ harnessId: "claude-code", accountId: null, modelId: "sonnet-5.5", mode: "ask" }).ok).toBe(true);

  const router = new RouterV2Service(db);
  const gathered = router.gatherCandidatesSync("developer");
  expect(gathered.filter((row) => row.harnessId === work.harnessId).map((row) => row.modelId)).toEqual(["gpt-6-luna"]);
  expect(gathered.some((row) => row.harnessId === work.harnessId && row.modelId === "gpt-6.1-sol")).toBe(false);
  for (const row of gathered) {
    if (row.kind === "cursor") expect(row.activeBlocks).toContain("cursor-internal-sandbox-unavailable");
    if (row.kind === "deepseek-dsh" || row.kind === "deepseek") expect(row.activeBlocks?.join(" ")).toContain("deepseek");
  }
  const pinned = evaluateCandidates(gathered, {
    taskId: "task-a", projectId: "/tmp/project-a", role: "developer", requestedAccountId: claudeB.accountId,
  }, DEFAULT_ROUTER_POLICY);
  expect(pinned.selected).toBeNull();
  expect(pinned.accountPin?.honored).toBe(false);
  const recommendation = evaluateCandidates(gathered, {
    taskId: "task-b", projectId: "/tmp/project-b", role: "developer", requestedAccountId: work.accountId, requestedModelId: "gpt-6-luna",
  }, { ...DEFAULT_ROUTER_POLICY, preset: "lowest-cost", weights: { quality: 0, cost: 100, latency: 0, quota: 0, history: 0 } });
  expect(recommendation.selected?.accountId).toBe(work.accountId);
  expect(recommendation.selected?.modelId).toBe("gpt-6-luna");

  expect(profileCapacityAllows(db, work.accountId, 3, new Map([[work.accountId, 1]])).allow).toBe(false);
  expect(profileCapacityAllows(db, personal.accountId, 3, new Map([[work.accountId, 1]])).allow).toBe(false);
  expect(reservationBlocksRelaunch("running")).toBe(true);
  expect(reservationBlocksRelaunch("released")).toBe(false);

  const now = Date.now();
  const policyBody = normalizePolicyBody({
    mode: "full-autonomy", scopeKind: "workspace", scopeRef: "workspace", projects: ["/tmp/project-a"],
    specialistRoles: ["developer", "reviewer"], providers: ["openai", "anthropic", "codex", "claude-code"],
    models: ["gpt-6-luna", "haiku-5.5"], accounts: [work.accountId], allowUnscopedAccount: false,
    permittedActions: ["launch_task", "select_model"], maxConcurrentWorkers: 2, maxLaunches: 4, maxDurationMs: 3_600_000,
    expiresAt: now + 3_600_000,
  }, now);
  const policy: ApplicablePolicy = { id: "policy-1", revision: 1, digest: policyDigest(policyBody), body: policyBody };
  const counters = { launchesUsed: 0, launchesInFlight: 0, reworkUsedForTask: 0, now, activatedAt: now, lifecycleAllowed: true, emergencyStopped: false, paused: false, revoked: false, expired: false };
  expect(evaluateApplicablePolicies([policy], { action: "launch_task", projectPath: "/tmp/project-a", role: "developer", provider: "openai", model: "gpt-6-luna", accountId: personal.accountId }, counters).allow).toBe(false);
  expect(evaluateApplicablePolicies([policy], { action: "launch_task", projectPath: "/tmp/project-a", role: "developer", provider: "openai", model: "gpt-6-luna", accountId: work.accountId }, counters).allow).toBe(true);

  const preference = setProjectAccountPreference(db, { projectPath: "/tmp/project-a", role: "developer", accountId: work.accountId }, now);
  expect(preference?.accountId).toBe(work.accountId);
  const restored = listExecutionProfiles(db, now + 60_000);
  expect(restored.map((profile) => profile.accountId).sort()).toEqual(profiles.map((profile) => profile.accountId).sort());
  const restoredWork = restored.find((profile) => profile.accountId === work.accountId)!;
  expect(restoredWork.authentication).toBe("unknown");
  expect(restoredWork.executionReady).toBe(false);
  expect(restoredWork.lastVerifiedAt).not.toBeNull();
  expect(restoredWork.verifiedSubject).toBeNull();

  const answer = answerAccountQuestion("Which AI accounts are available?", loadAccountAnswerSnapshot(db));
  expect(answer).toContain("Work");
  expect(answer).toContain("Unknown");
  expect(answer).not.toContain("synthetic-quota-subject");
  expect(answerAccountQuestion("Why is Claude B unavailable?", { profiles: restored, preferences: [], attributions: [] })).toContain("Claude B");

  const built = buildCommand(harnesses.get(work.harnessId)!, "synthetic", { model: "gpt-6-luna", effort: "low", mode: "ask", codexWorkspaceLayout: "non-git" });
  expect(built.env?.CODEX_HOME).toBe(work.directory);
  const cursor = evaluateCandidates([
    { ...gathered[0], kind: "cursor", accountId: "cursor-1", activeBlocks: ["cursor-internal-sandbox-unavailable"] } as EvaluatorCandidateInput,
  ], { taskId: "t", projectId: "/tmp/project-a", role: "developer" } satisfies TaskRequirementsInput, DEFAULT_ROUTER_POLICY);
  expect(cursor.selected).toBeNull();
});

test("an active reservation is not replaced by a second worker", () => {
  const missionId = "mission-multiaccount02";
  db.run(
    `INSERT INTO orchestration_missions (id, title, goal, status, revision, clusters_json, projects_json, plan_json, plan_digest, concurrency_limits_json, state_json, history_json, created_at, updated_at)
     VALUES (?, 'Synthetic', 'Synthetic', 'running', 1, '[]', '[]', '{}', 'digest', '{}', '{}', '[]', ?, ?)`,
    [missionId, Date.now(), Date.now()],
  );
  missionStore.createReservation({ missionId, taskId: "task-once", projectPath: "/tmp/project-a", employeeId: "worker", accountId: "acct", harnessId: "codex", modelId: "gpt-6-luna", status: "running" });
  expect(() => missionStore.createReservation({ missionId, taskId: "task-once", projectPath: "/tmp/project-a", employeeId: "worker", accountId: "other", harnessId: "codex", modelId: "gpt-6-luna", status: "starting" })).toThrow(/second worker/i);
  expect(missionStore.getReservation("task-once")?.accountId).toBe("acct");
});
