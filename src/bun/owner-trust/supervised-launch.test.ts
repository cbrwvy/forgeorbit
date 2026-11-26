/**
 * Production Owner launch gate verification for supervised Developer and
 * independent read-only Reviewer runs.
 *
 * Exercises the production trust path (`trustClass: "production"`, pinned local
 * cert, P-256 test signer via in-process test seam) with an inert executable
 * substitute at the final `AGETOR_CODEX_BIN` / `AGETOR_TMUX_BIN` spawn boundary
 * and `AGETOR_CODEX_DRIVER` unset (no fake-driver shortcut, no real Codex calls,
 * and zero edits to the working profile).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import {
  OWNER_TRUST_SCHEMA,
  PRODUCTION_BUNDLE_ID,
  SINGLE_OPERATION_MAX_MS,
  parseOwnerOperation,
  type OwnerOperation,
} from "../../shared/owner-trust/protocol.ts";
import { createSyntheticSigner } from "./crypto.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-owner-launch-")));
const ownerHome = path.join(root, "home");
const dataDirPath = path.join(root, "data");
const spawnLogPath = path.join(root, "inert-spawns.ndjson");
mkdirSync(ownerHome, { recursive: true });
mkdirSync(dataDirPath, { recursive: true });

// Keep fake drivers off and place inert executables at the final spawn boundary.
delete process.env.AGETOR_CODEX_DRIVER;
delete process.env.AGETOR_CLAUDE_DRIVER;
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = dataDirPath;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_API_PORT = "4794";

const codexInertPath = path.join(root, "codex-inert.sh");
writeFileSync(
  codexInertPath,
  `#!/bin/sh
set -e
all_args="$*"
while [ "$1" = "-c" ] || [ "$1" = "--config" ]; do
  shift 2
done
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.160.0"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo "Logged in using ChatGPT"
  exit 0
fi
if [ "$1" = "exec" ]; then
  cat >/dev/null || true
  printf '%s\\t%s\\t%s\\n' "$(pwd)" "\${CODEX_HOME:-}" "$all_args" >> "${spawnLogPath}"
  printf '{"type":"thread.started","thread_id":"inert-thread-1"}\\n'
  printf '{"type":"item.completed","item":{"type":"agent_message","text":"<qc_verdict>PASS</qc_verdict><qc_summary>Inert QC check passed.</qc_summary>"}}\\n'
  printf '{"type":"turn.completed"}\\n'
  exit 0
fi
exit 1
`,
);
chmodSync(codexInertPath, 0o755);

const tmuxInertPath = path.join(root, "tmux-inert.sh");
writeFileSync(
  tmuxInertPath,
  `#!/bin/sh
set -e
if [ "$1" = "-L" ]; then shift 2; fi
cmd="$1"
if [ -n "$cmd" ]; then shift; fi
case "$cmd" in
  -V)
    echo "tmux 3.4"
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  kill-session)
    exit 0
    ;;
  new-session)
    target_cwd=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -e)
          export "$2"
          shift 2
          ;;
        -c)
          target_cwd="$2"
          shift 2
          ;;
        --)
          shift
          break
          ;;
        -d|-s|-x|-y)
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    if [ -n "$target_cwd" ]; then cd "$target_cwd"; fi
    exec "$@"
    ;;
  *)
    exit 0
    ;;
esac
`,
);
chmodSync(tmuxInertPath, 0o755);

process.env.AGETOR_CODEX_BIN = codexInertPath;
process.env.AGETOR_TMUX_BIN = tmuxInertPath;
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo-owner-launch";
}

const PIN = "cd".repeat(32);
const productionIdentity = {
  bundleId: PRODUCTION_BUNDLE_ID,
  teamId: null,
  trustClass: "production" as const,
  adhoc: false,
  signed: true,
  source: "/tmp/ForgeOrbit.app",
  certSha256: PIN,
  anchorSha256: PIN,
};

let dbMod: typeof import("../db.ts");
let orchestrator: typeof import("../orchestrator.ts");
let employeeRun: typeof import("../employee-run.ts");
let employeeRunCore: typeof import("../employee-run-core.ts");
let qc: typeof import("../task-quality-control.ts");
let execMod: typeof import("../project-execution.ts");
let serverMod: typeof import("../server.ts");
let server: ReturnType<typeof import("../server.ts")["startApiServer"]>;
let AccountCore: typeof import("../account-core.ts").AccountCore;
let CodexProfiles: typeof import("../codex-profiles.ts").CodexProfiles;
let EmployeeCore: typeof import("../employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("../assignment-core.ts").AssignmentCore;
let noteAuthCheck: typeof import("../multiaccount/registry.ts").noteAuthenticationCheck;
let agentsMod: typeof import("../agents.ts");
let gateMod: typeof import("./launch-gate.ts");
let serviceMod: typeof import("./service.ts");

let codexProfile: { accountId: string; harnessId: string; directory: string };
let signer = createSyntheticSigner();
let trust: ReturnType<typeof import("./service.ts")["createOwnerTrust"]>;
let enrollmentId: string;
const baseUrl = "http://127.0.0.1:4794";
let authHeaders: Record<string, string>;

function readSpawnRecords(): Array<{ cwd: string; codexHome: string; args: string }> {
  if (!existsSync(spawnLogPath)) return [];
  const raw = readFileSync(spawnLogPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [cwd = "", codexHome = "", args = ""] = line.split("\t");
    return { cwd, codexHome, args };
  });
}

function clearSpawnRecords(): void {
  if (existsSync(spawnLogPath)) rmSync(spawnLogPath, { force: true });
}

function makeGitRepo(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(root, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "clamp.ts"), "export function clamp(v: number) { return v; }\n");
  for (const args of [
    ["init"],
    ["config", "user.email", "d31@example.com"],
    ["config", "user.name", "D31"],
    ["add", "."],
    ["commit", "-m", "init"],
  ]) {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  dbMod.projects.upsert(dir, name);
  return dir;
}

function freshTrust(): void {
  signer = createSyntheticSigner();
  trust = serviceMod.createOwnerTrust({
    database: dbMod.db,
    dataDir: dataDirPath,
    identity: productionIdentity,
  });
  for (const prev of trust.store.activeByClass("production")) {
    trust.store.setEnrollmentState(prev.id, "removed", Date.now());
  }
  // Enroll via helper-attestation shape (in-memory test fixture only, distinct from genuine SE).
  const enrollment = trust.store.insertEnrollment({
    trustClass: "production",
    applicationIdentity: PRODUCTION_BUNDLE_ID,
    publicKeySpki: signer.publicKeySpki,
    keyProtection: "secure-enclave-user-presence",
    label: "test-production-fixture",
    now: Date.now(),
    signingCertSha256: PIN,
  });
  enrollmentId = enrollment.id;
}

async function prepareDevAttempt(projectDir: string) {
  const created = await orchestrator.createTask({
    title: "Implement clamp",
    prompt: "Implement clamp in clamp.ts",
    workdir: projectDir,
    column: "ready",
    agent: codexProfile.harnessId,
    model: "gpt-6.1-sol",
    mode: "auto",
    effort: "low",
    isolation: "none",
    accessMode: "workspace",
  } as never);
  if ("error" in created) throw new Error(created.error);
  const employee = new EmployeeCore(dbMod.db).createWorker({
    name: "D31 Developer",
    jobTitle: "Developer",
    projectPath: projectDir,
  });
  new AssignmentCore(dbMod.db).assign(created.task.id, employee.id);
  const review = await employeeRun.reviewEmployeeExecution({
    taskId: created.task.id,
    harnessId: codexProfile.harnessId,
    model: "gpt-6.1-sol",
    effort: "low",
  });
  if (!review.attempt) {
    throw new Error(`Expected attempt, got blockers: ${JSON.stringify(review.blockingErrors)}`);
  }
  return { task: created.task, employee, attempt: review.attempt };
}

async function waitForRunEnd(runId: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const run = dbMod.runs.get(runId);
    if (run && run.status !== "running" && run.endedAt != null) return;
    await Bun.sleep(25);
  }
  throw new Error(`Run ${runId} did not finish within timeout`);
}

beforeAll(async () => {
  dbMod = await import("../db.ts");
  orchestrator = await import("../orchestrator.ts");
  employeeRun = await import("../employee-run.ts");
  employeeRunCore = await import("../employee-run-core.ts");
  qc = await import("../task-quality-control.ts");
  execMod = await import("../project-execution.ts");
  serverMod = await import("../server.ts");
  agentsMod = await import("../agents.ts");
  serviceMod = await import("./service.ts");
  gateMod = await import("./launch-gate.ts");
  ({ AccountCore } = await import("../account-core.ts"));
  ({ CodexProfiles } = await import("../codex-profiles.ts"));
  ({ EmployeeCore } = await import("../employee-core.ts"));
  ({ AssignmentCore } = await import("../assignment-core.ts"));
  ({ noteAuthenticationCheck: noteAuthCheck } = await import("../multiaccount/registry.ts"));

  expect(agentsMod.agentDriverIsFake("codex")).toBe(false);

  employeeRun.initEmployeeExecutionTracking();
  server = serverMod.startApiServer();
  authHeaders = {
    authorization: `Bearer ${serverMod.API_TOKEN}`,
    "content-type": "application/json",
  };

  dbMod.harnesses.setEnabled("codex", true);
  const accCore = new AccountCore(dbMod.db);
  const codexProfiles = new CodexProfiles(accCore);
  const profDir = path.join(ownerHome, ".codex-b");
  writeSyntheticCodexProfile(profDir, "d31-profile-b");
  const reg = codexProfiles.register({ displayName: "Codex Profile B", directory: realpathSync(profDir) });
  noteAuthCheck(dbMod.db, reg.accountId, "authenticated", Date.now());
  codexProfile = { accountId: reg.accountId, harnessId: reg.harnessId, directory: reg.directory };
});

afterAll(() => {
  gateMod?.setOwnerTrustLaunchGateForTest(null);
  server?.stop(true);
  dbMod?.db.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  employeeRun.__testing.reset();
  clearSpawnRecords();
  freshTrust();
});

test("1. Bearer-only Start, direct startTask, legacy approveExecution, sendInput, and spawnAgent bypasses produce zero spawns", async () => {
  gateMod.setOwnerTrustLaunchGateForTest({ trust }); // production identity, no nativeApprove -> refuses Bearer-only!
  const repo = makeGitRepo("bypass");
  const { task, attempt } = await prepareDevAttempt(repo);

  // Bearer-only HTTP /employee-execution/attempts/:id/start with confirm: true -> refused (no spawns)
  const httpStart = await fetch(`${baseUrl}/employee-execution/attempts/${encodeURIComponent(attempt.id)}/start`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ revision: attempt.revision, confirm: true }),
  });
  expect(httpStart.status).toBe(403);
  const settledAttempt = employeeRun.getEmployeeRun(attempt.id);
  expect(settledAttempt.status).toBe("rejected");

  // Direct startTask & POST /tasks/:id/start -> refused (no spawns)
  const directStart = await orchestrator.startTask(task.id);
  expect("error" in directStart).toBe(true);
  const httpTaskStart = await fetch(`${baseUrl}/tasks/${encodeURIComponent(task.id)}/start`, {
    method: "POST",
    headers: authHeaders,
  });
  expect(httpTaskStart.status).toBe(400);

  // Legacy PM execution proposal/approve -> refused before launch
  const proposal = await execMod.prepareExecution(repo, { taskId: task.id });
  if (proposal.ok) {
    const approved = await execMod.approveExecution(repo, proposal.value.execution.id, {
      revision: proposal.value.execution.revision,
    });
    expect(approved.ok).toBe(false);
  }

  // sendInput CLI resume bypass -> refused
  const fakeRunId = crypto.randomUUID();
  dbMod.runs.insert({
    id: fakeRunId,
    taskId: task.id,
    agent: codexProfile.harnessId,
    status: "succeeded",
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: "inert-thread-0",
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
  });
  const resumed = await orchestrator.sendInput(fakeRunId, "Bypass follow-up");
  expect(resumed.delivered).toBe(false);

  // Direct spawnAgent bypass -> refused
  await expect(agentsMod.spawnAgent({
    taskId: task.id,
    runId: crypto.randomUUID(),
    harness: dbMod.harnesses.get(codexProfile.harnessId)!,
    cwd: repo,
    prompt: "Direct spawn bypass",
    onChunk: () => {},
    opts: { model: "gpt-6.1-sol", mode: "auto" },
  })).rejects.toThrow();

  expect(readSpawnRecords()).toHaveLength(0);
});

test("2. Settings preview proof (review:<taskId>, externalProcess: false) is rejected for both Developer and Reviewer with zero spawns", async () => {
  gateMod.setOwnerTrustLaunchGateForTest({ trust });
  const repo = makeGitRepo("preview-reject");
  const { task, attempt } = await prepareDevAttempt(repo);

  const now = Date.now();
  const previewOpRes = parseOwnerOperation({
    schema: OWNER_TRUST_SCHEMA,
    requestId: `review:${task.id}`,
    kind: "single-operation",
    projectPath: repo,
    taskId: task.id,
    missionId: "none",
    missionRevision: "none",
    role: "developer",
    providerId: "codex",
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6.1-sol",
    accountId: codexProfile.accountId,
    mode: "auto",
    workspace: repo,
    filesystem: "workspace-write",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "operation",
    envelopeDigest: "preview-digest",
    policyRevision: "none",
    scope: `single:developer:codex:${codexProfile.accountId}:gpt-6.1-sol`,
    runId: "none",
    attemptId: attempt.id,
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    expiresAt: now + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true,
    externalProcess: false,
    taskStateDigest: "preview-task",
    missionStateDigest: "preview-mission",
  }, now);
  if (!previewOpRes.ok) throw new Error(previewOpRes.reason);

  const issued = trust.issueChallenge(previewOpRes.operation, enrollmentId);
  if (!issued.ok) throw new Error(issued.reason);
  const payload = serviceMod.buildProofPayload(previewOpRes.operation, {
    nonce: issued.nonce,
    enrollmentId,
    applicationIdentity: PRODUCTION_BUNDLE_ID,
    issuedAt: now,
  });
  const previewProof = {
    schema: OWNER_TRUST_SCHEMA,
    payload,
    signature: signer.sign(payload),
  };

  await expect(employeeRun.startEmployeeExecution(
    attempt.id,
    { revision: attempt.revision, confirm: true },
    { ownerProof: previewProof },
  )).rejects.toMatchObject({ code: "owner-preview-not-launch" });

  // Also test read-only Reviewer rejecting preview proof
  dbMod.tasks.update(task.id, { column: "review" });
  const implRunId = crypto.randomUUID();
  dbMod.runs.insert({
    id: implRunId,
    taskId: task.id,
    agent: codexProfile.harnessId,
    status: "succeeded",
    startedAt: now - 500,
    endedAt: now - 100,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
  });
  dbMod.tasks.update(task.id, { runId: implRunId });
  const preparedQc = qc.prepareQcReview({
    taskId: task.id,
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6.1-sol",
  });
  const qcRes = await qc.startQcReview(preparedQc.review.id, undefined, undefined, { ownerProof: previewProof });
  expect("error" in qcRes).toBe(true);
  expect(readSpawnRecords()).toHaveLength(0);
});

test("3. Stale task, expired proof, revoked enrollment, and mismatched operation proofs are all rejected with zero spawns", async () => {
  const repo = makeGitRepo("invalid-proofs");

  // (a) Stale proof: task prompt changes after signature is created
  {
    const { task, attempt } = await prepareDevAttempt(repo);
    gateMod.setOwnerTrustLaunchGateForTest({
      trust,
      nativeApprove: async ({ operation, nonce }) => {
        const issuedAt = Date.now();
        const payload = serviceMod.buildProofPayload(operation, {
          nonce,
          enrollmentId,
          applicationIdentity: PRODUCTION_BUNDLE_ID,
          issuedAt,
        });
        const signature = signer.sign(payload);
        // Mutate task prompt AFTER Owner signed it, before admit validates!
        dbMod.tasks.update(task.id, { prompt: "TAMPERED_PROMPT" });
        return { decision: "signed", payload, signature };
      },
    });
    await expect(employeeRun.startEmployeeExecution(
      attempt.id,
      { revision: attempt.revision, confirm: true },
    )).rejects.toMatchObject({ code: "owner-task-stale" });
    expect(readSpawnRecords()).toHaveLength(0);
  }

  // (b) Expired proof
  {
    let fakeClock = Date.now();
    const timedTrust = serviceMod.createOwnerTrust({
      database: dbMod.db,
      dataDir: dataDirPath,
      identity: productionIdentity,
      now: () => fakeClock,
    });
    const activeEnroll = timedTrust.store.activeByClass("production")[0]!;
    const { attempt } = await prepareDevAttempt(repo);
    gateMod.setOwnerTrustLaunchGateForTest({
      trust: timedTrust,
      now: () => fakeClock,
      nativeApprove: async ({ operation, nonce, enrollmentId: eid }) => {
        const signedAt = fakeClock;
        const payload = serviceMod.buildProofPayload(operation, {
          nonce,
          enrollmentId: eid || activeEnroll.id,
          applicationIdentity: PRODUCTION_BUNDLE_ID,
          issuedAt: signedAt,
        });
        const signature = signer.sign(payload);
        // Advance clock past expiration after signing, before admit() runs.
        fakeClock = operation.expiresAt + 1_000;
        return { decision: "signed", payload, signature };
      },
    });
    await expect(employeeRun.startEmployeeExecution(
      attempt.id,
      { revision: attempt.revision, confirm: true },
    )).rejects.toMatchObject({ code: "owner-challenge-expired" });
    expect(readSpawnRecords()).toHaveLength(0);
  }

  // (c) Revoked enrollment
  {
    const { attempt } = await prepareDevAttempt(repo);
    gateMod.setOwnerTrustLaunchGateForTest({ trust });
    trust.revokeEnrollment(enrollmentId);
    await expect(employeeRun.startEmployeeExecution(
      attempt.id,
      { revision: attempt.revision, confirm: true },
    )).rejects.toMatchObject({ code: "owner-revoked" });
    expect(readSpawnRecords()).toHaveLength(0);
  }

  // (d) Operation mismatch (proof signed for wrong model)
  {
    freshTrust();
    const { attempt } = await prepareDevAttempt(repo);
    gateMod.setOwnerTrustLaunchGateForTest({
      trust,
      nativeApprove: async ({ operation, nonce }) => {
        const wrongOp: OwnerOperation = {
          ...operation,
          modelId: "gpt-99-other",
          scope: `single:${operation.role}:${operation.providerId}:${operation.accountId}:gpt-99-other`,
        };
        const payload = serviceMod.buildProofPayload(wrongOp, {
          nonce,
          enrollmentId,
          applicationIdentity: PRODUCTION_BUNDLE_ID,
          issuedAt: Date.now(),
        });
        return { decision: "signed", payload, signature: signer.sign(payload) };
      },
    });
    await expect(employeeRun.startEmployeeExecution(
      attempt.id,
      { revision: attempt.revision, confirm: true },
    )).rejects.toMatchObject({ code: "owner-operation-mismatch" });
    expect(readSpawnRecords()).toHaveLength(0);
  }
});

test("4. Valid Developer proof reaches exactly one inert spawn, enforces single-use, blocks concurrent duplicate starts, and never replays after failure", async () => {
  const repo = makeGitRepo("dev-valid");
  const { task, attempt } = await prepareDevAttempt(repo);

  const seenOperations: OwnerOperation[] = [];
  let releaseDialog!: () => void;
  const dialogGate = new Promise<void>((resolve) => { releaseDialog = resolve; });

  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      seenOperations.push(operation);
      await dialogGate;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });

  // Launch two concurrent Start requests while macOS dialog is open.
  const req1 = employeeRun.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true });
  await Bun.sleep(30);
  const req2 = employeeRun.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true });
  releaseDialog();

  const [res1, res2] = await Promise.all([req1, req2]);
  const primary = res1.replayed ? res2 : res1;
  const secondary = res1.replayed ? res1 : res2;
  expect(primary.replayed).toBe(false);
  expect(secondary.replayed).toBe(true);
  expect(seenOperations).toHaveLength(1);
  expect(seenOperations[0]).toMatchObject({
    role: "developer",
    providerId: "codex",
    harnessId: codexProfile.harnessId,
    accountId: codexProfile.accountId,
    modelId: "gpt-6.1-sol",
    mode: "auto",
    workspace: repo,
    filesystem: "workspace-write",
    externalProcess: true,
  });
  expect(seenOperations[0]!.requestId.startsWith("review:")).toBe(false);

  expect(primary.attempt.runId).toBeTruthy();
  await waitForRunEnd(primary.attempt.runId!);
  const spawns = readSpawnRecords();
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.codexHome).toBe(codexProfile.directory);
  expect(spawns[0]!.args).toContain("gpt-6.1-sol");

  const grantUses = dbMod.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE task_id = ? AND role = 'developer'",
  ).get(task.id)?.n;
  expect(grantUses).toBe(1);

  // Interrupted startup after approval consumption: never automatically replays and refuses second Start.
  clearSpawnRecords();
  const secondTaskSetup = await prepareDevAttempt(repo);
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });
  const interrupted = await employeeRun.startEmployeeExecution(
    secondTaskSetup.attempt.id,
    { revision: secondTaskSetup.attempt.revision, confirm: true },
    {
      launch: async () => ({ kind: "held", code: "simulated-interrupt", reason: "Simulated failure after proof consumption." }),
    },
  );
  expect(interrupted.attempt.status).toBe("rejected");
  expect(readSpawnRecords()).toHaveLength(0);
  await expect(employeeRun.startEmployeeExecution(
    secondTaskSetup.attempt.id,
    { revision: secondTaskSetup.attempt.revision, confirm: true },
  )).rejects.toThrow("This review is rejected");
  expect(readSpawnRecords()).toHaveLength(0);
});

test("5. Independent read-only Reviewer enforces exact read-only operation, blocks concurrent starts, reaches one inert spawn, and leaves task in Review", async () => {
  const repo = makeGitRepo("qc-valid");
  const created = await orchestrator.createTask({
    title: "Clamp review",
    prompt: "Review clamp.ts",
    workdir: repo,
    column: "review",
    agent: codexProfile.harnessId,
    model: "gpt-6.1-sol",
    mode: "auto",
    effort: "low",
    isolation: "none",
  } as never);
  if ("error" in created) throw new Error(created.error);
  const implRunId = crypto.randomUUID();
  dbMod.runs.insert({
    id: implRunId,
    taskId: created.task.id,
    agent: codexProfile.harnessId,
    status: "succeeded",
    startedAt: Date.now() - 1_000,
    endedAt: Date.now() - 100,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
  });
  dbMod.tasks.update(created.task.id, { runId: implRunId });

  // Ensure a non-read-only reviewer mode is refused if requested at operation construction.
  const prepared = qc.prepareQcReview({
    taskId: created.task.id,
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6.1-sol",
  });
  const badContract = gateMod.buildQcReviewOperation({
    review: prepared.review,
    task: dbMod.tasks.get(created.task.id)!,
    projectPath: repo,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6.1-sol",
    mode: "auto", // NOT read-only!
  });
  expect(badContract.ok).toBe(false);
  if (!badContract.ok) expect(badContract.code).toBe("owner-sandbox");

  const seenReviewerOps: OwnerOperation[] = [];
  let releaseReviewerDialog!: () => void;
  const reviewerDialogGate = new Promise<void>((resolve) => { releaseReviewerDialog = resolve; });

  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce, enrollmentId: challEnrollmentId }) => {
      seenReviewerOps.push(operation);
      await reviewerDialogGate;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId: challEnrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });

  // Concurrent QC review Start calls: second must fail while first awaits native confirmation.
  const firstCall = qc.startQcReview(prepared.review.id);
  await Bun.sleep(25);
  const concurrentSecond = qc.startQcReview(prepared.review.id);
  releaseReviewerDialog();

  await expect(concurrentSecond).rejects.toMatchObject({ code: "already-starting" });
  const started = await firstCall;
  if (!("runId" in started)) throw new Error(started.error);
  expect("runId" in started).toBe(true);

  expect(seenReviewerOps).toHaveLength(1);
  expect(seenReviewerOps[0]).toMatchObject({
    role: "reviewer",
    filesystem: "read-only",
    mode: "ask",
    providerId: "codex",
    harnessId: codexProfile.harnessId,
    accountId: codexProfile.accountId,
    modelId: "gpt-6.1-sol",
    workspace: repo,
    externalProcess: true,
  });

  await waitForRunEnd(started.runId);
  const spawns = readSpawnRecords();
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.codexHome).toBe(codexProfile.directory);
  expect(spawns[0]!.args).toContain("--sandbox");
  expect(spawns[0]!.args).toContain("read-only");

  // QC PASS does not move the task out of Review automatically.
  expect(dbMod.tasks.get(created.task.id)?.column).toBe("review");
  const reviewRow = dbMod.taskQualityReviews.get(prepared.review.id);
  expect(reviewRow?.verdict).toBe("PASS");

  const reviewerGrantUses = dbMod.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE task_id = ? AND role = 'reviewer'",
  ).get(created.task.id)?.n;
  expect(reviewerGrantUses).toBe(1);
});
