/**
 * Seeds a disposable QA company with production services.
 * The mission stays authorized and is not started. No provider process.
 *
 * bun --no-env-file scripts/qa-providers-live-ready01-seed.ts <runtime>
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import { writeSyntheticCodexProfile } from "../e2e/codex-profile-fixture.ts";

const runtime = realpathSync(process.argv[2] ?? "");
if (!/^\/private\/tmp\/fo-providers-live-ready01-[A-Za-z0-9]+\/runtime$/.test(runtime)) {
  throw new Error("Refusing to seed outside the disposable QA runtime");
}
const home = path.join(runtime, "home");
const data = path.join(runtime, "data");
const stub = path.join(runtime, "seed-stub");
writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
process.env.HOME = home;
process.env.AGETOR_DATA_DIR = data;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CURSOR_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = stub;
process.env.AGETOR_CLAUDE_BIN = stub;
process.env.AGETOR_TMUX_BIN = stub;

const { db, harnesses, projects, tasks } = await import("../src/bun/db.ts");
const { AccountCore } = await import("../src/bun/account-core.ts");
const { CodexProfiles } = await import("../src/bun/codex-profiles.ts");
const { ClaudeProfiles, __setClaudeAuthProbeForTest } = await import("../src/bun/claude-profiles.ts");
const { createTask } = await import("../src/bun/orchestrator.ts");
const { missionStore } = await import("../src/bun/orchestration/mission-store.ts");
const { missionScheduler } = await import("../src/bun/orchestration/mission-scheduler.ts");
const { createAutonomyPolicy, activateAutonomyPolicy } = await import("../src/bun/autonomy/policy-engine.ts");
const { autonomyPolicyStore } = await import("../src/bun/autonomy/policy-store.ts");
const { prepareMissionResourceProposal, settleMissionResourceProposal } = await import("../src/bun/orchestration/mission-replan.ts");
const { stopProjectLifecycle } = await import("../src/bun/project-lifecycle.ts");
const { EmployeeCore } = await import("../src/bun/employee-core.ts");
const { AssignmentCore } = await import("../src/bun/assignment-core.ts");

harnesses.setEnabled("codex", true);
harnesses.setEnabled("claude-code", true);
__setClaudeAuthProbeForTest(async (directory) => ({ loggedIn: directory.endsWith("claude-a"), configDirectory: directory }));

function privateDir(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

const codexADir = privateDir(path.join(home, "codex-a"));
const codexBDir = privateDir(path.join(home, "codex-b"));
const claudeADir = privateDir(path.join(home, "claude-a"));
writeSyntheticCodexProfile(codexADir, "synthetic-codex-a");
writeSyntheticCodexProfile(codexBDir, "synthetic-codex-b");
writeFileSync(path.join(claudeADir, "synthetic-authenticated"), "synthetic-claude-a");
chmodSync(path.join(codexADir, "synthetic-authenticated"), 0o600);
chmodSync(path.join(codexBDir, "synthetic-authenticated"), 0o600);
chmodSync(path.join(claudeADir, "synthetic-authenticated"), 0o600);

const core = new AccountCore(db);
const codex = new CodexProfiles(core);
const claude = new ClaudeProfiles(core);
const model = "gpt-6.1-sol";
const reviewerModel = "haiku-5.5";
const codexA = codex.register({ displayName: "Codex A", directory: codexADir });
const codexB = codex.register({ displayName: "Codex B", directory: codexBDir });
const claudeA = claude.register({ displayName: "Claude A", directory: claudeADir, homeAccessAccepted: true });

const projectOne = privateDir(path.join(runtime, "projects", "project-one"));
const projectTwo = privateDir(path.join(runtime, "projects", "project-two"));
projects.upsert(projectOne, "Project One");
projects.upsert(projectTwo, "Project Two");
const now = Date.now();
db.run("INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["cluster-a", "Cluster A", "cluster-a", "Live-ready QA cluster", now, now]);
for (const dir of [projectOne, projectTwo]) {
  db.run("INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)", [dir, "cluster-a", now, now]);
}

async function taskIn(title: string, workdir: string, agent: string, column: "backlog" | "ready", mode = "auto", modelId = model) {
  const created = await createTask({
    title, prompt: "Synthetic company work. Do not call a provider.", workdir, column, agent, model: modelId, mode, isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

const employees = new EmployeeCore(db);
const developer = employees.createWorker({ name: "Pipeline developer", jobTitle: "Developer", projectPath: projectOne });
const assignments = new AssignmentCore(db);
const life = await taskIn("Lifecycle", projectOne, codexA.harnessId, "ready");
const failed = await taskIn("Provider failure", projectOne, codexA.harnessId, "ready");
const cancelled = await taskIn("Cancellation", projectOne, codexA.harnessId, "ready");
const pausedTask = await taskIn("Paused project", projectTwo, codexA.harnessId, "ready");
await taskIn("Blocked Cursor", projectOne, "cursor", "backlog");
await taskIn("Blocked DeepSeek", projectOne, "claude-code", "backlog", "auto", "deepseek-chat");
for (const row of [life, failed, cancelled]) assignments.assign(row.id, developer.id);

const fixtures = {
  [`${failed.id}:developer`]: { outcome: "provider-error", tokens: null },
  [`${cancelled.id}:developer`]: { outcome: "hold", tokens: null },
};
const fixtureFile = path.join(home, "provider-fixtures.json");
const verdictFile = path.join(home, "qc-verdict.txt");
writeFileSync(fixtureFile, JSON.stringify(fixtures));
writeFileSync(verdictFile, "CHANGES_REQUESTED\nPASS\n");
chmodSync(fixtureFile, 0o600);
chmodSync(verdictFile, 0o600);

const policy = createAutonomyPolicy({
  mode: "full-autonomy", scopeKind: "workspace", scopeRef: "company", projects: [projectOne, projectTwo],
  specialistRoles: ["developer", "reviewer"], providers: ["codex", "claude-code"], models: [model, reviewerModel],
  accounts: [codexA.accountId, codexB.accountId, claudeA.accountId],
  maxConcurrentWorkers: 1, maxLaunches: 8, maxDurationMs: 300_000, maxReworkAttempts: 1, expiresAt: now + 3_600_000,
  permittedActions: ["plan_task", "launch_task", "run_qc", "request_rework"],
  qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
  completion: { autoComplete: false, conditions: ["qc_pass"] },
});
const activation = activateAutonomyPolicy(policy.id);
const mission = await missionScheduler.prepareMission({
  title: "Pipeline company",
  goal: "Run the recorded provider path through QC",
  tasks: [
    { taskId: life.id, projectPath: projectOne, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "critical", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: true },
    { taskId: failed.id, projectPath: projectOne, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "high", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false },
    { taskId: cancelled.id, projectPath: projectOne, clusterId: "cluster-a", specialistRole: "developer", assignedEmployeeId: developer.id, priority: "normal", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false },
    { taskId: pausedTask.id, projectPath: projectTwo, clusterId: "cluster-a", specialistRole: "developer", priority: "low", harnessId: codexA.harnessId, modelId: model, accountId: codexA.accountId, mode: "auto", qcRequired: false },
  ],
  concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1, perClusterMax: 1 },
  policyOverride: { qcRequired: true, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
});
await missionScheduler.authorizeMission(mission.id, mission.planDigest);
autonomyPolicyStore.upsertBinding({
  missionId: mission.id, policyId: policy.id, revision: policy.revision, activationId: activation.id, digest: policy.digest,
  mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [],
});
const proposal = prepareMissionResourceProposal(mission.id, {
  taskId: life.id, role: "reviewer",
  resource: { harnessId: claudeA.harnessId, modelId: reviewerModel, accountId: claudeA.accountId, mode: "bounded-print" },
  reason: "Owner approved a separate read-only reviewer account.",
});
settleMissionResourceProposal(mission.id, proposal.id, proposal.digest, "approve");
const stopped = await stopProjectLifecycle(projectTwo, "Owner paused this project");
if (stopped.lifecycle.state !== "paused") throw new Error("Project Two did not pause");
const stored = missionStore.getMission(mission.id);
if (!stored || stored.status !== "authorized") throw new Error(`Mission status is ${stored?.status ?? "missing"}`);
if (tasks.list().some((task) => task.runId)) throw new Error("Seed started a run");

const summary = {
  missionId: mission.id,
  lifecycleTaskId: life.id,
  failedTaskId: failed.id,
  cancelledTaskId: cancelled.id,
  pausedTaskId: pausedTask.id,
  codexA: codexA.accountId,
  codexB: codexB.accountId,
  claudeA: claudeA.accountId,
  fixtureFile,
  verdictFile,
  projectOne,
  projectTwo,
};
writeFileSync(path.join(runtime, "seed-summary.json"), JSON.stringify(summary, null, 2));
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(JSON.stringify(summary));
process.exit(0);
