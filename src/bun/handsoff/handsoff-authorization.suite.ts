/**
 * Project-level Owner authorization for hands-off work, on the PRODUCTION trust path.
 *
 * The identity is a production-class fixture (`app.forgeorbit`, pinned certificate) with a synthetic P-256 signer that
 * stands in for the Secure Enclave: every "native confirmation" here is a TEST authorization counted by
 * `confirmations`, never genuine native authentication. The provider is an inert executable at the real spawn boundary
 * (no fake driver, no provider call). Runs in its own Bun process (see handsoff.test.ts).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { PRODUCTION_BUNDLE_ID, parseOwnerOperation, expectedScope, OWNER_TRUST_SCHEMA, SINGLE_OPERATION_MAX_MS, canonicalize, sha256Hex } from "../../shared/owner-trust/protocol.ts";
import { createSyntheticSigner } from "../owner-trust/crypto.ts";
import { parseHandsoffPolicy, type HandsoffPolicy, type HandsoffResourceRef } from "../../shared/handsoff.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-handsoff-auth-")));
const ownerHome = path.join(root, "home");
const dataDirPath = path.join(root, "data");
const spawnLog = path.join(root, "spawns.log");
mkdirSync(ownerHome, { recursive: true });
mkdirSync(dataDirPath, { recursive: true });
delete process.env.AGETOR_CODEX_DRIVER;
delete process.env.AGETOR_CLAUDE_DRIVER;
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = dataDirPath;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.FORGEORBIT_EMBEDDING_MODEL_ROOT = "/nonexistent/no-model-fixture";

const codexInert = path.join(root, "codex-inert.sh");
writeFileSync(codexInert, `#!/bin/sh
set -e
all_args="$*"
while [ "$1" = "-c" ] || [ "$1" = "--config" ]; do shift 2; done
if [ "$1" = "--version" ]; then echo "codex-cli 0.162.1"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
if [ "$1" = "exec" ]; then
  cat >/dev/null || true
  case "$all_args" in
    *read-only*)
      printf 'reviewer\\t%s\\n' "$(pwd)" >> "${spawnLog}"
      printf '{"type":"thread.started","thread_id":"inert-review"}\\n'
      printf '{"type":"item.completed","item":{"type":"agent_message","text":"<qc_verdict>PASS</qc_verdict><qc_summary>The change is correct.</qc_summary>"}}\\n'
      ;;
    *)
      printf 'developer\\t%s\\n' "$(pwd)" >> "${spawnLog}"
      mkdir -p src
      printf 'export function displayName(name: string): string {\\n  return name.trim();\\n}\\n' > src/profile.ts
      printf 'import { expect, test } from "bun:test";\\nimport { displayName } from "./profile.ts";\\ntest("trims", () => { expect(displayName(" Ada ")).toBe("Ada"); });\\n' > src/profile.test.ts
      printf '{"type":"thread.started","thread_id":"inert-dev"}\\n'
      printf '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}\\n'
      ;;
  esac
  printf '{"type":"turn.completed"}\\n'
  exit 0
fi
exit 1
`);
chmodSync(codexInert, 0o755);
const tmuxInert = path.join(root, "tmux-inert.sh");
writeFileSync(tmuxInert, `#!/bin/sh
set -e
if [ "$1" = "-L" ]; then shift 2; fi
cmd="$1"; if [ -n "$cmd" ]; then shift; fi
case "$cmd" in
  -V) echo "tmux 3.4"; exit 0;;
  has-session) exit 1;;
  kill-session) exit 0;;
  new-session)
    target_cwd=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -e) export "$2"; shift 2;;
        -c) target_cwd="$2"; shift 2;;
        --) shift; break;;
        -d|-s|-x|-y) shift 2;;
        *) shift;;
      esac
    done
    if [ -n "$target_cwd" ]; then cd "$target_cwd"; fi
    exec "$@";;
  *) exit 0;;
esac
`);
chmodSync(tmuxInert, 0o755);
process.env.AGETOR_CODEX_BIN = codexInert;
process.env.AGETOR_TMUX_BIN = tmuxInert;
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo-handsoff-auth";

const PIN = "cd".repeat(32);
const productionIdentity = { bundleId: PRODUCTION_BUNDLE_ID, teamId: null, trustClass: "production" as const, adhoc: false, signed: true, source: "/tmp/ForgeOrbit.app", certSha256: PIN, anchorSha256: PIN };

const store = await import("../db.ts");
const orchestrator = await import("../orchestrator.ts");
const employeeRun = await import("../employee-run.ts");
const gate = await import("../owner-trust/launch-gate.ts");
const service = await import("../owner-trust/service.ts");
const driver = await import("./driver.ts");
const handsoff = await import("./store.ts");
const policyApi = await import("./policy.ts");
const auth = await import("./authorization.ts");
const resources = await import("./resources.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { noteAuthenticationCheck } = await import("../multiaccount/registry.ts");
const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
const { taskBindingDigest } = await import("../owner-trust/admission.ts");
const { getTaskWorkspace } = await import("../task-workspace.ts");

let profile: { accountId: string; harnessId: string };
let signer = createSyntheticSigner();
let trust: ReturnType<typeof service.createOwnerTrust>;
let enrollmentId = "";
let confirmations = 0;
let nextReply: "sign" | "cancel" = "sign";

function installGate() {
  gate.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      confirmations += 1;
      if (nextReply === "cancel") return { decision: "cancelled", code: "authentication-cancelled", reason: "The confirmation was cancelled." };
      const payload = service.buildProofPayload(operation, { nonce, enrollmentId, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: Date.now() });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });
}

beforeAll(async () => {
  store.harnesses.setEnabled("codex", true);
  employeeRun.initEmployeeExecutionTracking();
  driver.initHandsoff();
  const registry = new CodexProfiles(new AccountCore(store.db));
  const dir = path.join(ownerHome, ".codex-b");
  writeSyntheticCodexProfile(dir, "handsoff-auth-profile");
  const reg = registry.register({ displayName: "Codex Profile B", directory: realpathSync(dir) });
  noteAuthenticationCheck(store.db, reg.accountId, "authenticated", Date.now());
  profile = { accountId: reg.accountId, harnessId: reg.harnessId };
});
afterAll(() => {
  driver.stopHandsoffTimers();
  gate.setOwnerTrustLaunchGateForTest(null);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  signer = createSyntheticSigner();
  trust = service.createOwnerTrust({ database: store.db, dataDir: dataDirPath, identity: productionIdentity });
  for (const prev of trust.store.activeByClass("production")) trust.store.setEnrollmentState(prev.id, "removed", Date.now());
  enrollmentId = trust.store.insertEnrollment({
    trustClass: "production", applicationIdentity: PRODUCTION_BUNDLE_ID, publicKeySpki: signer.publicKeySpki,
    keyProtection: "secure-enclave-user-presence", label: "test-production-fixture", now: Date.now(),
    signingCertSha256: PIN,
  } as never).id;
  confirmations = 0;
  nextReply = "sign";
  installGate();
  auth.setAuthorizationClockForTest(null);
  autonomyPolicyStore.writeEmergency(false, null, []);
  if (existsSync(spawnLog)) rmSync(spawnLog, { force: true });
});

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}
let counter = 0;
const BASELINE = `export function displayName(name: string): string {\n  return name;\n}\n`;
async function makeProject(): Promise<string> {
  const name = `proj${++counter}`;
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "src/profile.ts"), BASELINE);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]);
  store.projects.upsert(dir, name);
  const core = new EmployeeCore(store.db);
  core.createWorker({ name: "Dana Developer", jobTitle: "Developer", projectPath: dir });
  core.createWorker({ name: "Rae Reviewer", jobTitle: "Reviewer", projectPath: dir });
  return realpathSync(dir);
}
async function makeTask(project: string, title = "Trim display names") {
  const created = await orchestrator.createTask({
    title, prompt: `${title}. Make displayName trim whitespace.`, workdir: project, column: "ready", agent: profile.harnessId,
    mode: "auto", model: "gpt-6.1-sol", effort: "low", isolation: "worktree", accessMode: "workspace",
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}
function policy(overrides: Record<string, unknown> = {}): HandsoffPolicy {
  const parsed = parseHandsoffPolicy({ enabled: true, autoApply: true, harnessIds: [profile.harnessId], accountIds: [profile.accountId], ...overrides });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.policy;
}
const save = (project: string, overrides: Record<string, unknown> = {}) => {
  const { harnessIds: _h, accountIds: _a, ...body } = policy(overrides);
  return policyApi.saveHandsoffPolicy(project, body);
};
async function until<T>(read: () => T | null | undefined | false, ms = 30_000, label = "condition"): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = read(); if (v) return v as T; await Bun.sleep(40); }
  throw new Error(`Timed out waiting for ${label}`);
}
const settled = (taskId: string, ms = 60_000) => until(() => {
  const run = handsoff.handsoffStore.latestRunForTask(taskId);
  return run && (run.finishedAt != null || run.status === "needs-owner" || run.status === "stopped" || run.status === "waiting") ? run : null;
}, ms, `run of ${taskId}`);
const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t")[0]) : []);
const uses = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM owner_trust_grant_uses").get()!.n;

test("the gate is production-class and a project without authorization cannot launch anything", async () => {
  expect(gate.isProductionOwnerGateActive()).toBe(true);
  const project = await makeProject();
  await save(project);
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("not-authorized");
  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settled(taskId);
  expect(run.status).toBe("needs-owner");
  expect(run.blocker).toMatchObject({ code: "authorization-missing", action: "open-settings" });
  expect(spawns()).toEqual([]);
  expect(confirmations).toBe(0);
  expect(store.runs.listForTask(taskId)).toEqual([]);
}, 90_000);

test("one confirmation authorizes the project; the task then reaches Done with zero further confirmations", async () => {
  const project = await makeProject();
  const queued = await makeTask(project, "Old queued task");
  await save(project);
  const view = await auth.authorizeProject(project, { hours: 8, launches: 6 });
  expect(confirmations).toBe(1);
  expect(view).toMatchObject({ state: "active", launchBudget: 6, launchesUsed: 0, launchesRemaining: 6, required: true });
  expect(view.envelope).toMatchObject({ harnessIds: [profile.harnessId], accountIds: [profile.accountId], developerMode: "auto", reviewerMode: "read-only", autoApply: true });
  expect(view.envelope!.developerModels).toContain("gpt-6.1-sol");
  // Activation starts nothing that was already queued.
  await Bun.sleep(400);
  expect(store.runs.listForTask(queued)).toEqual([]);
  expect(handsoff.handsoffStore.listOpenRuns(project)).toEqual([]);

  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settled(taskId);
  expect({ status: run.status, blocker: run.blocker?.message }).toEqual({ status: "done", blocker: undefined });
  expect(confirmations).toBe(1);
  expect(spawns()).toEqual(["developer", "reviewer"]);
  expect(uses()).toBe(2);
  expect(readFileSync(path.join(project, "src/profile.ts"), "utf8")).toContain("name.trim()");
  expect(run.result!.delivery).toBe("applied");
  expect(run.result!.tests.state).toBe("passed");
  const after = policyApi.readHandsoffPolicy(project).authorization;
  expect(after).toMatchObject({ state: "active", launchesUsed: 2, launchesRemaining: 4 });
  const events = handsoff.handsoffStore.listEvents({ runId: run.id });
  expect(events.some((event) => event.kind === "needs-owner")).toBe(false);
}, 120_000);

test("a cancelled confirmation activates nothing and leaves the previous authorization as it was", async () => {
  const project = await makeProject();
  await save(project);
  nextReply = "cancel";
  await expect(auth.authorizeProject(project)).rejects.toMatchObject({ code: "authentication-cancelled" });
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("not-authorized");
  nextReply = "sign";
  await auth.authorizeProject(project, { launches: 4 });
  const first = policyApi.readHandsoffPolicy(project).authorization;
  expect(first.state).toBe("active");
  nextReply = "cancel";
  await expect(auth.authorizeProject(project, { launches: 9 })).rejects.toMatchObject({ code: "authentication-cancelled" });
  const still = policyApi.readHandsoffPolicy(project).authorization;
  expect(still).toMatchObject({ state: "active", launchBudget: 4, authorizedAt: first.authorizedAt });
  expect(confirmations).toBe(3);
}, 60_000);

test("expired, exhausted and revoked authorizations refuse before any provider starts; revoking needs no confirmation", async () => {
  const project = await makeProject();
  await save(project);
  await auth.authorizeProject(project, { hours: 1, launches: 1 });
  expect(confirmations).toBe(1);
  // Exhausted after the Developer: the Reviewer is refused, nothing else starts.
  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settled(taskId);
  expect(run.status).toBe("needs-owner");
  expect(run.blocker!.code).toBe("authorization-exhausted");
  expect(spawns()).toEqual(["developer"]);
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("exhausted");
  // Expired.
  const realNow = Date.now();
  auth.setAuthorizationClockForTest(() => realNow + 2 * 3_600_000);
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("expired");
  auth.setAuthorizationClockForTest(null);
  // Revoked, with no native prompt.
  const before = confirmations;
  const revoked = await auth.revokeProjectAuthorization(project);
  expect(revoked.state).toBe("revoked");
  expect(confirmations).toBe(before);
  const second = await makeTask(project, "After revoke");
  driver.submitTask(second);
  const blocked = await settled(second);
  expect(blocked.blocker!.code).toBe("authorization-revoked");
  expect(spawns()).toEqual(["developer"]);
}, 120_000);

test("an authorization is bound to its project: another project, even with the same covered profile, is not covered", async () => {
  const a = await makeProject();
  const b = await makeProject();
  await save(a);
  await save(b);
  await auth.authorizeProject(a);
  expect(policyApi.readHandsoffPolicy(a).authorization.state).toBe("active");
  expect(policyApi.readHandsoffPolicy(b).authorization.state).toBe("not-authorized");
  const taskB = await makeTask(b);
  driver.submitTask(taskB);
  const run = await settled(taskB);
  expect(run.blocker!.code).toBe("authorization-missing");
  expect(spawns()).toEqual([]);
  // A claim that names project A's run for project B's task is refused outright.
  const runA = handsoff.handsoffStore.insertRun({ taskId: await makeTask(a, "A task"), projectPath: a, policyRevision: 1, policy: policy() });
  const built = fakeBuilt({ project: b, taskId: taskB, role: "developer" });
  const refused = await gate.authorizeSupervisedLaunch({ built, projectGrant: { handsoffRunId: runA.id, round: 0, intentAt: 1 } });
  expect(refused.ok).toBe(false);
  expect(spawns()).toEqual([]);
}, 90_000);

/** A launch operation as the real builders produce it, with overridable fields. */
function fakeBuilt(input: { project: string; taskId: string; role: "developer" | "reviewer"; harnessId?: string; accountId?: string; modelId?: string; mode?: string; filesystem?: "workspace-write" | "read-only"; gitPublish?: boolean }) {
  const task = store.tasks.get(input.taskId)!;
  const now = Date.now();
  const harnessId = input.harnessId ?? profile.harnessId;
  const accountId = input.accountId ?? profile.accountId;
  const modelId = input.modelId ?? "gpt-6.1-sol";
  const mode = input.mode ?? (input.role === "developer" ? "auto" : "ask");
  const raw = {
    schema: OWNER_TRUST_SCHEMA, requestId: `launch:test:${Math.random()}`, kind: "single-operation", projectPath: input.project, taskId: task.id,
    missionId: "none", missionRevision: "none", role: input.role, providerId: "codex", harnessId, modelId, accountId, mode, workspace: input.project,
    filesystem: input.filesystem ?? (input.role === "developer" ? "workspace-write" : "read-only"), terminalAllowed: false, browserAllowed: false, computerUseAllowed: false,
    gitRead: true, gitPublish: input.gitPublish ?? false, deploymentAllowed: false, envelopeId: "supervised-test", envelopeDigest: "none", policyRevision: "none",
    scope: expectedScope({ kind: "single-operation", role: input.role, providerId: "codex", accountId, modelId, missionId: "none", policyRevision: "none" }),
    runId: "none", attemptId: `attempt-${Math.random()}`, knownCost: "unknown", costCoverage: "unknown-subscription", expiresAt: now + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true, externalProcess: true,
    taskStateDigest: taskBindingDigest({ id: task.id, prompt: task.prompt, workdir: task.workdir, column: task.column }), missionStateDigest: sha256Hex("none"),
  };
  const parsed = parseOwnerOperation(raw, now);
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    operation: parsed.operation, canonical: parsed.canonical, digest: parsed.digest, role: input.role, taskId: task.id, attemptOrReviewId: "x",
    projectPath: input.project, workspace: input.project, allowsLazyWorktree: false, accountId, harnessId, providerId: "codex" as const, modelId, mode,
  };
}

test("a different profile, an unsupported mode, a wider filesystem or a privileged flag is refused at the grant", async () => {
  const project = await makeProject();
  await save(project);
  await auth.authorizeProject(project);
  const taskId = await makeTask(project);
  const run = handsoff.handsoffStore.insertRun({ taskId, projectPath: project, policyRevision: 1, policy: policy() });
  const claim = (n: number) => ({ handsoffRunId: run.id, round: 0, intentAt: 1000 + n });
  const tries: Array<[string, Parameters<typeof fakeBuilt>[0]]> = [
    ["other harness", { project, taskId, role: "developer", harnessId: "codex" }],
    ["other account", { project, taskId, role: "developer", accountId: "some-other-account" }],
    ["other model", { project, taskId, role: "developer", modelId: "gpt-0-not-covered" }],
    ["full access", { project, taskId, role: "developer", mode: "full-access" }],
    ["reviewer writing", { project, taskId, role: "reviewer", mode: "auto", filesystem: "workspace-write" }],
    ["publish", { project, taskId, role: "developer", gitPublish: true }],
  ];
  for (const [index, [label, spec]] of tries.entries()) {
    let result;
    try { result = await gate.authorizeSupervisedLaunch({ built: fakeBuilt(spec), projectGrant: claim(index) }); }
    catch { result = { ok: false }; }
    expect([label, result.ok]).toEqual([label, false]);
  }
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM handsoff_launches WHERE handsoff_run_id = ?").get(run.id)!.n).toBe(0);
}, 60_000);

test("only the chosen role + harness + account pairs are covered: the plain Codex login, which shares the profile's login, is refused", async () => {
  const project = await makeProject();
  const only: HandsoffResourceRef[] = [{ role: "developer", harnessId: profile.harnessId, accountKey: profile.accountId }, { role: "reviewer", harnessId: profile.harnessId, accountKey: profile.accountId }];
  await save(project, { harnessIds: undefined, accountIds: undefined, resources: only });
  expect(await auth.authorizeProject(project)).toBeTruthy();
  const taskId = await makeTask(project);
  const frozen = policy({ harnessIds: undefined, accountIds: undefined, resources: only });
  const run = handsoff.handsoffStore.insertRun({ taskId, projectPath: project, policyRevision: 1, policy: frozen });
  const claim = (n: number) => ({ handsoffRunId: run.id, round: 0, intentAt: 5000 + n });
  const stored = policyApi.readHandsoffPolicy(project);
  expect(stored.policy.resources).toEqual(only);
  expect(stored.authorization.envelope?.resources).toEqual(only);
  expect(stored.authorization.envelope?.harnessIds).toEqual([profile.harnessId]);
  const tries: Array<[string, Parameters<typeof fakeBuilt>[0]]> = [
    ["plain Codex login as Developer", { project, taskId, role: "developer", harnessId: "codex", accountId: "default" }],
    ["plain Codex login as Reviewer", { project, taskId, role: "reviewer", harnessId: "codex", accountId: "default" }],
    ["the profile's harness with the plain login's account", { project, taskId, role: "developer", accountId: "default" }],
  ];
  for (const [index, [label, spec]] of tries.entries()) {
    let result;
    try { result = await gate.authorizeSupervisedLaunch({ built: fakeBuilt(spec), projectGrant: claim(index) }); }
    catch { result = { ok: false }; }
    expect([label, result.ok]).toEqual([label, false]);
  }
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM handsoff_launches WHERE handsoff_run_id = ?").get(run.id)!.n).toBe(0);
  // Router-side selection honours the same pairs: a role that was not covered is never given a resource.
  const developerOnly = policy({ harnessIds: undefined, accountIds: undefined, resources: [only[0]] });
  const choice = resources.chooseResource({ taskId, projectPath: project, title: "x", role: "reviewer", policy: developerOnly, requested: { harnessId: null, modelId: null, accountId: null } });
  expect(choice.ok).toBe(false);
  const chosen = resources.chooseResource({ taskId, projectPath: project, title: "x", role: "developer", policy: developerOnly, requested: { harnessId: null, modelId: null, accountId: null } });
  expect(chosen.ok && chosen.resource.harnessId).toBe(profile.harnessId);
}, 60_000);

test("a wider policy needs renewal; narrowing and cosmetic edits do not, and renewing is one confirmation", async () => {
  const project = await makeProject();
  await save(project, { autoApply: false });
  await auth.authorizeProject(project);
  const state = () => policyApi.readHandsoffPolicy(project).authorization;
  expect(state().state).toBe("active");
  await save(project, { autoApply: false, requireTest: true, maxParallel: 1, autoAssign: false, maxFixRounds: 1, autoDone: false });
  expect(state().state).toBe("active");
  await save(project, { autoApply: true });
  expect(state()).toMatchObject({ state: "needs-renewal", reasons: ["apply"] });
  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settled(taskId);
  expect(run.blocker!.code).toBe("authorization-renewal");
  expect(spawns()).toEqual([]);
  const before = confirmations;
  await auth.authorizeProject(project);
  expect(confirmations).toBe(before + 1);
  expect(state().state).toBe("active");
  expect(state().envelope!.autoApply).toBe(true);
  // Narrowing back never needs a confirmation.
  await save(project, { autoApply: false });
  expect(state().state).toBe("active");
  expect(confirmations).toBe(before + 1);
}, 90_000);

test("concurrent claims, a replayed claim and a restart never exceed the budget or mint two grants for one launch", async () => {
  const project = await makeProject();
  await save(project);
  await auth.authorizeProject(project, { launches: 3 });
  const taskId = await makeTask(project);
  const run = handsoff.handsoffStore.insertRun({ taskId, projectPath: project, policyRevision: 1, policy: policy() });
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, n) =>
    gate.authorizeSupervisedLaunch({ built: fakeBuilt({ project, taskId, role: "developer" }), projectGrant: { handsoffRunId: run.id, round: 0, intentAt: 5000 + n } })));
  if (process.env.HANDSOFF_DEBUG) console.log(JSON.stringify(attempts.map((r) => (r.ok ? "ok" : r.code))));
  expect(attempts.filter((result) => result.ok)).toHaveLength(3);
  expect(attempts.filter((result) => !result.ok && result.code === "handsoff-authorization-exhausted")).toHaveLength(9);
  const rows = () => store.db.query<{ status: string; n: number }, [string]>("SELECT status, COUNT(*) AS n FROM handsoff_launches WHERE handsoff_run_id = ? GROUP BY status").all(run.id);
  expect(rows()).toEqual([{ status: "reserved", n: 3 }]);
  // Replay of a claim key that already holds a reservation is refused, even though budget is gone.
  const replay = await gate.authorizeSupervisedLaunch({ built: fakeBuilt({ project, taskId, role: "developer" }), projectGrant: { handsoffRunId: run.id, round: 0, intentAt: 5000 } });
  expect(replay.ok).toBe(false);
  // A restart drops every in-memory ticket: unused reservations go back to the budget, and the replay is still refused.
  expect(auth.recoverHandsoffAuthorizations()).toEqual({ released: 3 });
  expect(rows()).toEqual([{ status: "released", n: 3 }]);
  expect(policyApi.readHandsoffPolicy(project).authorization).toMatchObject({ launchesUsed: 0, launchesRemaining: 3 });
  const again = await gate.authorizeSupervisedLaunch({ built: fakeBuilt({ project, taskId, role: "developer" }), projectGrant: { handsoffRunId: run.id, round: 0, intentAt: 5000 } });
  expect(again.ok).toBe(false);
  const fresh = await gate.authorizeSupervisedLaunch({ built: fakeBuilt({ project, taskId, role: "developer" }), projectGrant: { handsoffRunId: run.id, round: 0, intentAt: 9000 } });
  expect(fresh.ok).toBe(true);
  expect(spawns()).toEqual([]);
}, 90_000);

test("Emergency Stop refuses dispatch even with a valid grant, and lifting it resumes nothing", async () => {
  const project = await makeProject();
  await save(project);
  await auth.authorizeProject(project);
  const taskId = await makeTask(project);
  autonomyPolicyStore.writeEmergency(true, "test stop", []);
  expect(() => driver.submitTask(taskId)).toThrow(/Emergency Stop/);
  await Bun.sleep(300);
  expect(handsoff.handsoffStore.latestRunForTask(taskId)).toBeNull();
  expect(spawns()).toEqual([]);
  const run = handsoff.handsoffStore.insertRun({ taskId: await makeTask(project, "Second"), projectPath: project, policyRevision: 1, policy: policy() });
  const refused = await gate.authorizeSupervisedLaunch({ built: fakeBuilt({ project, taskId: run.taskId, role: "developer" }), projectGrant: { handsoffRunId: run.id, round: 0, intentAt: 1 } });
  expect(refused).toMatchObject({ ok: false, code: "owner-emergency-stop" });
  autonomyPolicyStore.writeEmergency(false, null, []);
  driver.recoverHandsoff();
  await Bun.sleep(500);
  // Nothing was submitted, nothing started, and lifting the stop submitted or started nothing either.
  expect(spawns()).toEqual([]);
  expect(handsoff.handsoffStore.latestRunForTask(taskId)).toBeNull();
}, 60_000);

test("with automatic application off the original project is untouched and the result is Ready to apply", async () => {
  const project = await makeProject();
  await save(project, { autoApply: false });
  await auth.authorizeProject(project);
  const taskId = await makeTask(project);
  driver.submitTask(taskId);
  const run = await settled(taskId);
  expect(run.status).toBe("ready-to-apply");
  expect(readFileSync(path.join(project, "src/profile.ts"), "utf8")).toBe(BASELINE);
  expect(getTaskWorkspace(taskId)!.status).toBe("settled");
  expect(store.tasks.get(taskId)!.column).not.toBe("done");
  expect(confirmations).toBe(1);
}, 120_000);

test("revoking stops the project's unfinished work; disabling the policy ends the authorization without a confirmation", async () => {
  const project = await makeProject();
  await save(project);
  await auth.authorizeProject(project);
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("active");
  const before = confirmations;
  await policyApi.saveHandsoffPolicy(project, { enabled: false });
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("off");
  expect(confirmations).toBe(before);
  await save(project);
  expect(policyApi.readHandsoffPolicy(project).authorization.state).toBe("revoked");
}, 60_000);

void canonicalize;
