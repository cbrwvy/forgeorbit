/**
 * Offline verification of QC evidence preview, deterministic missing-evidence
 * recovery, launch-time evidence gating & revalidation, and Owner launch gate.
 *
 * Uses production Owner Trust (`trustClass: "production"`, P-256 test signer)
 * with inert executable substitutes (`AGETOR_CODEX_BIN`, `AGETOR_TMUX_BIN`) and
 * `AGETOR_CODEX_DRIVER` unset — zero real Codex calls, zero working-profile edits.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { makeTask } from "../cli/test-fixtures.ts";
import { PRODUCTION_BUNDLE_ID } from "../shared/owner-trust/protocol.ts";
import { isMissingEvidenceReview } from "../shared/review-evidence.ts";
import { createSyntheticSigner } from "./owner-trust/crypto.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-qc-evidence-repair-")));
const ownerHome = path.join(root, "home");
const dataDirPath = path.join(root, "data");
const spawnLogPath = path.join(root, "inert-spawns.ndjson");
mkdirSync(ownerHome, { recursive: true });
mkdirSync(dataDirPath, { recursive: true });

delete process.env.AGETOR_CODEX_DRIVER;
delete process.env.AGETOR_CLAUDE_DRIVER;
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = dataDirPath;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_API_PORT = "4863";

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
  echo "codex-cli 0.162.1"
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
  printf '{"type":"item.completed","item":{"type":"agent_message","text":"<qc_verdict>PASS</qc_verdict><qc_summary>Inert Reviewer verified src/clamp.ts and observed test.</qc_summary><qc_findings>[]</qc_findings><qc_feedback>Ready for Owner acceptance.</qc_feedback>"}}\\n'
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
  -V) echo "tmux 3.4"; exit 0 ;;
  has-session) exit 1 ;;
  kill-session) exit 0 ;;
  new-session)
    target_cwd=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -e) export "$2"; shift 2 ;;
        -c) target_cwd="$2"; shift 2 ;;
        --) shift; break ;;
        -d|-s|-x|-y) shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$target_cwd" ] && cd "$target_cwd"
    exec "$@"
    ;;
  *) exit 0 ;;
esac
`,
);
chmodSync(tmuxInertPath, 0o755);

process.env.AGETOR_CODEX_BIN = codexInertPath;
process.env.AGETOR_TMUX_BIN = tmuxInertPath;

const stubClampSource = `/**
 * Clamp \`value\` inclusively to \`[min, max]\`.
 */
export function clamp(value: number, min: number, max: number): number {
  throw new Error("Not implemented");
}
`;
const fixedClampSource = `/**
 * Clamp \`value\` inclusively to \`[min, max]\`.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || Number.isNaN(min) || Number.isNaN(max) || min > max) {
    throw new RangeError("Expected non-NaN values with min <= max");
  }

  return Math.min(Math.max(value, min), max);
}
`;
const clampTestSource = `import { expect, test } from "bun:test";
import { clamp } from "./clamp.ts";

test("clamps values inside and outside range", () => {
  expect(clamp(-5, 0, 10)).toBe(0);
  expect(clamp(5, 0, 10)).toBe(5);
  expect(clamp(20, 0, 10)).toBe(10);
});

test("throws RangeError on NaN or min > max", () => {
  expect(() => clamp(1, 5, 2)).toThrow(RangeError);
  expect(() => clamp(Number.NaN, 0, 1)).toThrow(RangeError);
});
`;

let signer = createSyntheticSigner();
const PIN = "cd".repeat(32);
const productionIdentity = {
  bundleId: PRODUCTION_BUNDLE_ID,
  teamId: null,
  signed: true,
  adhoc: false,
  trustClass: "production" as const,
  source: "/tmp/ForgeOrbit.app",
  certSha256: PIN,
  anchorSha256: PIN,
};

let server: { stop: (closeActiveConnections?: boolean) => void };
let apiToken = "";
let dbMod: typeof import("./db.ts");
let gateMod: typeof import("./owner-trust/launch-gate.ts");
let serviceMod: typeof import("./owner-trust/service.ts");
let orchestrator: typeof import("./orchestrator.ts");
let workspaceMod: typeof import("./task-workspace.ts");
let qcMod: typeof import("./task-quality-control.ts");
let trust: ReturnType<typeof import("./owner-trust/service.ts").createOwnerTrust>;
let enrollmentId = "";
let codexProfile: { accountId: string; harnessId: string; directory: string };

const url = (p: string) => `http://127.0.0.1:4863${p}`;
const auth = () => ({ authorization: `Bearer ${apiToken}`, "content-type": "application/json" });

function readSpawnRecords(): Array<{ cwd: string; codexHome: string; args: string }> {
  if (!existsSync(spawnLogPath)) return [];
  const raw = readFileSync(spawnLogPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [cwd = "", codexHome = "", args = ""] = line.split("\t");
    return { cwd, codexHome, args };
  });
}

function makeGitRepo(name: string): string {
  const dir = path.join(root, "repos", name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, private: true }, null, 2));
  writeFileSync(path.join(dir, "src/clamp.ts"), stubClampSource);
  writeFileSync(path.join(dir, "src/clamp.test.ts"), clampTestSource);
  writeFileSync(path.join(dir, ".env"), "TOP_SECRET_TOKEN=must-not-leak\n");
  const runGit = (args: string[]) => {
    const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (res.status !== 0) throw new Error(res.stderr || res.stdout);
  };
  runGit(["init", "-b", "main"]);
  runGit(["add", "README.md", "package.json", "src/clamp.ts", "src/clamp.test.ts"]);
  runGit(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);
  const real = realpathSync(dir);
  dbMod.projects.upsert(real, name);
  return real;
}

function enrollProductionTrust(): void {
  signer = createSyntheticSigner();
  trust = serviceMod.createOwnerTrust({
    database: dbMod.db,
    dataDir: dataDirPath,
    identity: productionIdentity,
  });
  dbMod.db.run("DELETE FROM owner_trust_grant_uses");
  dbMod.db.run("DELETE FROM owner_trust_grants");
  dbMod.db.run("DELETE FROM owner_trust_challenges");
  dbMod.db.run("DELETE FROM owner_trust_enrollments");
  const enrollment = trust.store.insertEnrollment({
    trustClass: "production",
    applicationIdentity: PRODUCTION_BUNDLE_ID,
    publicKeySpki: signer.publicKeySpki,
    keyProtection: "secure-enclave-user-presence",
    label: "Test Owner Mac",
    now: Date.now(),
    signingCertSha256: PIN,
  });
  enrollmentId = enrollment.id;
}

async function seedPublishedClampTask(repo: string, opts?: { withLunaBlocked?: boolean; withCancelledOnly?: boolean }) {
  const created = await orchestrator.createTask({
    title: "Direction 31 — implement clamp",
    prompt: "Implement clamp(value, min, max) in src/clamp.ts so all tests in src/clamp.test.ts pass. Modify only src/clamp.ts.",
    workdir: repo,
    column: "review",
    agent: codexProfile.harnessId,
    model: "gpt-6-luna",
    mode: "auto",
    effort: "low",
    isolation: "none",
  } as never);
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  const staged = await workspaceMod.prepareTaskWorkspace(taskId, { outputPaths: ["src/clamp.ts"] });
  const devRunId = randomUUID();
  const endedAt = Date.now();
  dbMod.runs.insert({
    id: devRunId,
    taskId,
    agent: codexProfile.harnessId,
    status: "succeeded",
    startedAt: endedAt - 2_000,
    endedAt,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
  });
  dbMod.tasks.update(taskId, { runId: devRunId });

  workspaceMod.bindArmedRun(taskId, devRunId);
  // Simulate Developer writing src/clamp.ts inside staging and settling cleanly.
  writeFileSync(path.join(staged.stagingPath, "src/clamp.ts"), fixedClampSource);
  workspaceMod.settleTaskWorkspace(devRunId, 0, null);
  const { captureDeveloperSourceEvidence } = await import("./review-evidence.ts");
  await captureDeveloperSourceEvidence(devRunId);
  const published = await workspaceMod.publishTaskWorkspace(taskId, { approve: true, paths: ["src/clamp.ts"] });
  expect(published.status).toBe("published");

  const savedTaskJson = JSON.stringify({
    prompt: created.task.prompt,
    agent: codexProfile.harnessId,
    model: "gpt-6-luna",
    effort: "low",
    mode: "auto",
    fast: false,
    maxMode: false,
    agentProfileId: null,
    agentProfile: null,
  });

  if (opts?.withCancelledOnly || opts?.withLunaBlocked) {
    const r1 = dbMod.taskQualityReviews.insert({
      id: randomUUID(),
      taskId,
      projectPath: repo,
      round: 1,
      status: "pending",
      findings: [],
      reviewerEmployeeId: null,
      reviewerRoleSlug: null,
      reviewerHarness: codexProfile.harnessId,
      reviewerModel: "gpt-6-luna",
      reviewerProfileId: null,
      implementationRunId: devRunId,
      savedTaskJson,
      requestedAt: endedAt + 500,
    });
    dbMod.taskQualityReviews.markCancelled(r1.id, endedAt + 600);
  }

  let blockedReviewId: string | null = null;
  if (opts?.withLunaBlocked) {
    const r2 = dbMod.taskQualityReviews.insert({
      id: randomUUID(),
      taskId,
      projectPath: repo,
      round: 2,
      status: "pending",
      findings: [],
      reviewerEmployeeId: null,
      reviewerRoleSlug: null,
      reviewerHarness: codexProfile.harnessId,
      reviewerModel: "gpt-6-luna",
      reviewerProfileId: null,
      implementationRunId: devRunId,
      savedTaskJson,
      requestedAt: endedAt + 1_000,
    });
    blockedReviewId = r2.id;
    const revRunId = randomUUID();
    dbMod.runs.insert({
      id: revRunId,
      taskId,
      agent: codexProfile.harnessId,
      status: "succeeded",
      startedAt: endedAt + 1_050,
      endedAt: endedAt + 1_200,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
    });
    dbMod.taskQualityReviews.linkReviewRun(r2.id, revRunId);
    // Intentionally leave evidence_state = NULL to verify narrow compatibility with the pre-fix Luna BLOCKED wording.
    dbMod.taskQualityReviews.complete(r2.id, {
      status: "complete",
      verdict: "BLOCKED",
      summary: "The evidence bundle does not include the implementation diff or source, so I cannot verify whether the requirements are met.",
      findings: [],
      feedback: "Provide a complete review evidence bundle containing the contents or diff for src/clamp.ts. No test result is bound to this source fingerprint.",
      completedAt: endedAt + 1_200,
    });
    dbMod.tasks.setQcState(taskId, {
      activeReviewId: null,
      awaitingOwnerApproval: false,
      latestVerdict: "BLOCKED",
      reworkCount: 0,
      roundCount: 2,
      maxRounds: 5,
      extension: null,
    });
  }

  return { taskId, devRunId, blockedReviewId };
}

beforeAll(async () => {
  dbMod = await import("./db.ts");
  gateMod = await import("./owner-trust/launch-gate.ts");
  serviceMod = await import("./owner-trust/service.ts");
  orchestrator = await import("./orchestrator.ts");
  workspaceMod = await import("./task-workspace.ts");
  qcMod = await import("./task-quality-control.ts");

  dbMod.harnesses.setEnabled("codex", true);
  const { AccountCore } = await import("./account-core.ts");
  const { CodexProfiles } = await import("./codex-profiles.ts");
  const { noteAuthenticationCheck } = await import("./multiaccount/registry.ts");
  const accCore = new AccountCore(dbMod.db);
  const codexProfiles = new CodexProfiles(accCore);
  const profDir = path.join(ownerHome, ".codex-b");
  writeSyntheticCodexProfile(profDir, "d31-profile-b");
  const reg = codexProfiles.register({ displayName: "Codex Profile B", directory: realpathSync(profDir) });
  noteAuthenticationCheck(dbMod.db, reg.accountId, "authenticated", Date.now());
  codexProfile = { accountId: reg.accountId, harnessId: reg.harnessId, directory: reg.directory };

  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: (closeActiveConnections?: boolean) => void };
  apiToken = API_TOKEN;
});

afterAll(() => {
  gateMod?.setOwnerTrustLaunchGateForTest(null);
  server?.stop?.();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(spawnLogPath)) rmSync(spawnLogPath, { force: true });
  enrollProductionTrust();
  gateMod.setOwnerTrustLaunchGateForTest({ trust });
});

test("1. Evidence preview exposes files, diff, fingerprint & observed-test status (after cancelled & BLOCKED), while redacting secrets and refusing ambiguous ownership", async () => {
  const repo = makeGitRepo("preview-visibility");
  const { taskId } = await seedPublishedClampTask(repo, { withLunaBlocked: true });

  const previewRes = await fetch(url(`/tasks/${taskId}/qc-evidence`), { headers: auth() });
  expect(previewRes.status).toBe(200);
  const preview = await previewRes.json() as {
    taskId: string;
    observedTestStatus: string;
    readyForReviewer: boolean;
    sourceFingerprint: string | null;
    files: { path: string; text: string; sha256: string }[];
    diff: string | null;
    omitted: { path: string; reason: string }[];
    test: unknown;
    missingReason: string | null;
    howToSupply: string | null;
  };
  expect(preview.taskId).toBe(taskId);
  expect(preview.observedTestStatus).toBe("missing");
  expect(preview.readyForReviewer).toBe(false);
  expect(preview.sourceFingerprint).toBeString();
  expect(preview.files.find((f) => f.path === "src/clamp.ts")?.text).toContain("Math.min(Math.max(value, min), max)");
  expect(preview.diff).toContain("src/clamp.ts");
  expect(JSON.stringify(preview)).not.toContain("must-not-leak");
  expect(preview.test).toBeNull();
  expect(preview.missingReason).toContain("ForgeOrbit-observed test result");
  expect(preview.howToSupply).toContain("/qc-evidence/test-authorization");

  // Also test ambiguous ownership rejection when project row is removed.
  const outsideDir = path.join(root, "unregistered-dir");
  mkdirSync(outsideDir, { recursive: true });
  const orphan = dbMod.tasks.insert(makeTask({
    id: randomUUID(),
    title: "Orphan",
    prompt: "x",
    column: "review",
    agent: codexProfile.harnessId,
    workdir: outsideDir,
    model: "gpt-6-luna",
    effort: "low",
    mode: "auto",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  const ownedErr = await fetch(url(`/tasks/${orphan.id}/qc-evidence`), { headers: auth() });
  expect(ownedErr.status).toBe(409);
  expect(readSpawnRecords()).toHaveLength(0);
});

test("2. Incomplete evidence blocks Start BEFORE opening macOS dialog & unrelated BLOCKED never qualifies", async () => {
  const repo = makeGitRepo("gate-and-classification");
  const { taskId, blockedReviewId } = await seedPublishedClampTask(repo, { withCancelledOnly: true });

  // Cancel-only task still shows preview and firstReview applicability, without resetting round count.
  const afterCancel = await fetch(url(`/tasks/${taskId}/qc-evidence`), { headers: auth() });
  expect(afterCancel.status).toBe(200);
  const afterCancelRecovery = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: auth() }).then((r) => r.json()) as {
    firstReview: { applicable: boolean; eligible: boolean };
  };
  expect(afterCancelRecovery.firstReview.applicable).toBe(true);
  expect(afterCancelRecovery.firstReview.eligible).toBe(true);

  let dialogCalls = 0;
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      dialogCalls += 1;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });

  // Attempt Start QC Review without an observed test -> must fail BEFORE opening macOS dialog!
  const prepRes = await fetch(url(`/tasks/${taskId}/qc/reviews`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ reviewerHarness: codexProfile.harnessId, reviewerModel: "gpt-6-luna" }),
  });
  expect(prepRes.status).toBe(200);
  const { review } = await prepRes.json() as { review: { id: string; round: number } };
  expect(review.round).toBe(2); // cancelled round 1 preserved!

  const startRes = await fetch(url(`/tasks/${taskId}/qc/reviews/${review.id}/start`), {
    method: "POST",
    headers: auth(),
  });
  expect(startRes.status).toBe(409);
  const errBody = await startRes.json() as { error: string; code?: string };
  expect(errBody.code).toBe("incomplete-evidence");
  expect(errBody.error).toContain("ForgeOrbit-observed test");
  expect(errBody.error).toContain("test-authorization");
  expect(dialogCalls).toBe(0);
  expect(readSpawnRecords()).toHaveLength(0);
  expect(dbMod.tasks.get(taskId)?.qcState?.activeReviewId ?? null).toBeNull();
  expect(blockedReviewId).toBeNull();

  // Deterministic recording vs unrelated BLOCKED:
  // (a) Recorded evidenceState = "missing-test" qualifies regardless of Reviewer wording.
  expect(isMissingEvidenceReview({
    verdict: "BLOCKED",
    evidenceState: "missing-test",
    summary: "Cannot confirm implementation yet.",
    feedback: "Please check.",
  })).toBe(true);
  // (b) Recorded evidenceState = "complete" NEVER qualifies even if wording mentions missing evidence.
  expect(isMissingEvidenceReview({
    verdict: "BLOCKED",
    evidenceState: "complete",
    summary: "The evidence bundle does not include security signoff; missing evidence.",
    feedback: null,
  })).toBe(false);
  // (c) Legacy row (evidenceState = null) with Luna's wording qualifies narrowly...
  expect(isMissingEvidenceReview({
    verdict: "BLOCKED",
    evidenceState: null,
    summary: "The evidence bundle does not include the implementation diff or source, so I cannot verify whether the requirements are met.",
    feedback: "Provide a complete review evidence bundle containing the contents or diff for src/clamp.ts. No test result is bound to this source fingerprint.",
  })).toBe(true);
  // (d) ...while unrelated legacy BLOCKED verdicts do NOT qualify!
  expect(isMissingEvidenceReview({
    verdict: "BLOCKED",
    evidenceState: null,
    summary: "Blocked waiting for external license key provisioning from IT.",
    feedback: "Ask DevOps for the staging API key.",
  })).toBe(false);

  // Confirm DB-level rejection when an unrelated BLOCKED review with complete evidence exists.
  const completedUnrelated = dbMod.taskQualityReviews.insert({
    id: randomUUID(),
    taskId,
    projectPath: repo,
    round: 3,
    status: "pending",
    findings: [],
    reviewerEmployeeId: null,
    reviewerRoleSlug: null,
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6-luna",
    reviewerProfileId: null,
    implementationRunId: dbMod.tasks.get(taskId)!.runId,
    savedTaskJson: JSON.stringify({ prompt: "x", agent: codexProfile.harnessId, model: "gpt-6-luna", effort: "low", mode: "auto", fast: false, maxMode: false, agentProfileId: null, agentProfile: null }),
    requestedAt: Date.now(),
  });
  dbMod.taskQualityReviews.setEvidenceState(completedUnrelated.id, "complete");
  dbMod.taskQualityReviews.complete(completedUnrelated.id, {
    status: "complete",
    verdict: "BLOCKED",
    summary: "Out of scope compliance question; missing evidence of legal approval.",
    findings: [],
    feedback: "Need compliance signoff.",
    completedAt: Date.now(),
  });
  dbMod.tasks.setQcState(taskId, {
    activeReviewId: null,
    awaitingOwnerApproval: false,
    latestVerdict: "BLOCKED",
    reworkCount: 0,
    roundCount: 3,
    maxRounds: 5,
    extension: null,
  });
  const rec = await fetch(url(`/tasks/${taskId}/qc-recovery`), { headers: auth() }).then((r) => r.json()) as {
    evidenceRefresh: { eligible: boolean; blockedReviewId: string | null };
  };
  expect(rec.evidenceRefresh.eligible).toBe(false);
  expect(rec.evidenceRefresh.blockedReviewId).toBeNull();
});

test("3. Full offline repair on Luna BLOCKED fixture, round-limit & shell-test isolation, source-edit invalidation, and inert Reviewer PASS", async () => {
  const repo = makeGitRepo("full-repair");
  const { taskId, devRunId, blockedReviewId } = await seedPublishedClampTask(repo, { withLunaBlocked: true });

  // External shell run does not create any ForgeOrbit observation.
  const shellRun = spawnSync("bun", ["test", "./src/clamp.test.ts"], { cwd: repo, encoding: "utf8" });
  expect(shellRun.status).toBe(0);
  expect(
    dbMod.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM review_test_observations WHERE task_id = ?`).get(taskId)?.n,
  ).toBe(0);

  // Prepare, approve, and execute normal in-app offline test (evidence-refresh qualifies via narrow Luna compatibility).
  const authPrepRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ acknowledgeRisk: true, validMinutes: 30 }),
  });
  expect(authPrepRes.status, await authPrepRes.clone().text()).toBe(201);
  const authPrep = await authPrepRes.json() as { id: string; purpose: string; sourceFingerprint: string };
  expect(authPrep.purpose).toBe("evidence-refresh");

  expect((await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${authPrep.id}/approve`), { method: "POST", headers: auth() })).status).toBe(200);
  const execRes = await fetch(url(`/tasks/${taskId}/qc-evidence/test-authorization/${authPrep.id}/execute`), { method: "POST", headers: auth() });
  expect(execRes.status, await execRes.clone().text()).toBe(200);
  const execBody = await execRes.json() as { bundle: { status: string; digest: string; sourceFingerprint: string; test: { exitCode: number; provenance: string; sourceFingerprint: string } } };
  expect(execBody.bundle.status).toBe("complete");
  expect(execBody.bundle.test.exitCode).toBe(0);
  expect(execBody.bundle.test.provenance).toBe("forgeorbit-observed-test");
  expect(execBody.bundle.test.sourceFingerprint).toBe(execBody.bundle.sourceFingerprint);

  // Old BLOCKED review & Developer run are preserved untouched.
  expect(dbMod.taskQualityReviews.get(blockedReviewId!)?.verdict).toBe("BLOCKED");
  expect(dbMod.runs.listForTask(taskId).filter((r) => !r.qcReviewId)).toHaveLength(1);

  // Preview now shows complete src/clamp.ts source, diff, and passing test bound to the same fingerprint.
  const completePreview = await fetch(url(`/tasks/${taskId}/qc-evidence`), { headers: auth() }).then((r) => r.json()) as {
    observedTestStatus: string;
    readyForReviewer: boolean;
    sourceFingerprint: string;
    files: { path: string; text: string }[];
    diff: string | null;
    test: { exitCode: number; sourceFingerprint: string } | null;
  };
  expect(completePreview.observedTestStatus).toBe("observed");
  expect(completePreview.readyForReviewer).toBe(true);
  expect(completePreview.files.find((f) => f.path === "src/clamp.ts")?.text).toContain("RangeError");
  expect(completePreview.diff).toContain("+  return Math.min(Math.max(value, min), max);");
  expect(completePreview.test?.exitCode).toBe(0);
  expect(completePreview.test?.sourceFingerprint).toBe(completePreview.sourceFingerprint);

  // Mutating src/clamp.ts invalidates old test observation & blocks Start BEFORE macOS confirmation.
  writeFileSync(path.join(repo, "src/clamp.ts"), `${fixedClampSource}\n// tampered\n`);
  const stalePreview = await fetch(url(`/tasks/${taskId}/qc-evidence`), { headers: auth() }).then((r) => r.json()) as {
    observedTestStatus: string;
    readyForReviewer: boolean;
    missingReason: string | null;
  };
  expect(stalePreview.readyForReviewer).toBe(false);
  expect(stalePreview.observedTestStatus).toBe("blocked");
  expect(stalePreview.missingReason).toBeTruthy();

  let dialogCount = 0;
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      dialogCount += 1;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });
  const stalePrep = await fetch(url(`/tasks/${taskId}/qc/reviews`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ reviewerHarness: codexProfile.harnessId, reviewerModel: "gpt-6-luna" }),
  }).then((r) => r.json()) as { review: { id: string } };
  const staleStart = await fetch(url(`/tasks/${taskId}/qc/reviews/${stalePrep.review.id}/start`), { method: "POST", headers: auth() });
  expect(staleStart.status).toBe(409);
  expect(dialogCount).toBe(0);
  expect(readSpawnRecords()).toHaveLength(0);

  // Restore exact published bytes of src/clamp.ts and test launch-time revalidation AFTER macOS confirmation!
  writeFileSync(path.join(repo, "src/clamp.ts"), fixedClampSource);
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      dialogCount += 1;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      // Edit source AFTER Owner signs, BEFORE startTask spawns!
      writeFileSync(path.join(repo, "src/clamp.ts"), `${fixedClampSource}\n// race-edit\n`);
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });
  const racePrep = await fetch(url(`/tasks/${taskId}/qc/reviews`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ reviewerHarness: codexProfile.harnessId, reviewerModel: "gpt-6-luna" }),
  }).then((r) => r.json()) as { review: { id: string } };
  const raceStart = await fetch(url(`/tasks/${taskId}/qc/reviews/${racePrep.review.id}/start`), { method: "POST", headers: auth() });
  expect(raceStart.status).toBe(409);
  expect((await raceStart.json() as { code?: string }).code).toBe("evidence-stale");
  expect(dialogCount).toBe(1);
  expect(readSpawnRecords()).toHaveLength(0);

  // Restore exact bytes and run the genuine inert-spawn Reviewer pass under evidence-refresh + production Owner gate.
  writeFileSync(path.join(repo, "src/clamp.ts"), fixedClampSource);
  dialogCount = 0;
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      dialogCount += 1;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });

  const refreshGrantRes = await fetch(url(`/tasks/${taskId}/qc-recovery`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      reviewerHarness: codexProfile.harnessId,
      reviewerModel: "gpt-6-luna",
      reviewerEffort: "low",
      validMinutes: 30,
      purpose: "evidence-refresh",
    }),
  });
  expect(refreshGrantRes.status, await refreshGrantRes.clone().text()).toBe(201);
  const refreshGrant = await refreshGrantRes.json() as { id: string };
  expect((await fetch(url(`/tasks/${taskId}/qc-recovery/${refreshGrant.id}/approve`), { method: "POST", headers: auth() })).status).toBe(200);
  const launchedRes = await fetch(url(`/tasks/${taskId}/qc-recovery/${refreshGrant.id}/start`), { method: "POST", headers: auth() });
  expect(launchedRes.status, await launchedRes.clone().text()).toBe(200);
  const { runId: reviewerRunId } = await launchedRes.json() as { runId: string };

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && dbMod.tasks.get(taskId)?.qcState?.latestVerdict !== "PASS") {
    await Bun.sleep(40);
  }
  expect(dbMod.tasks.get(taskId)?.qcState?.latestVerdict).toBe("PASS");
  expect(dbMod.tasks.get(taskId)?.column).toBe("review");
  expect(dialogCount).toBe(1);

  const spawns = readSpawnRecords();
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.args).toContain("--sandbox read-only");
  expect(spawns[0]!.codexHome).toBe(codexProfile.directory);

  const prompt = dbMod.runs.events(reviewerRunId).filter((e) => e.stream === "user").map((e) => e.data).join("\n");
  expect(prompt).toContain(`Developer run: ${devRunId}`);
  expect(prompt).toContain(`Source fingerprint: ${completePreview.sourceFingerprint}`);
  expect(prompt).toContain("Math.min(Math.max(value, min), max)");
  expect(prompt).toContain("### Diff");
  expect(prompt).toContain("### ForgeOrbit-observed test");
  expect(prompt).toContain("Exit code: 0");
  expect(prompt).toContain(`Source fingerprint at execution: ${completePreview.sourceFingerprint}`);

  const reviewsAfter = dbMod.taskQualityReviews.listForTask(taskId);
  expect(reviewsAfter.some((r) => r.id === blockedReviewId && r.verdict === "BLOCKED")).toBe(true);
  const passReview = reviewsAfter.find((r) => r.reviewRunId === reviewerRunId);
  expect(passReview?.evidenceState).toBe("complete");

  // Confirm QC round limit is still enforced (never bypassed).
  dbMod.tasks.setQcState(taskId, {
    activeReviewId: null,
    awaitingOwnerApproval: false,
    latestVerdict: "BLOCKED",
    reworkCount: 0,
    roundCount: 5,
    maxRounds: 5,
    extension: null,
  });
  expect(() => qcMod.prepareQcReview({
    taskId,
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6-luna",
  })).toThrow(/Maximum 5 review rounds/);

  // Suppress unused import warning cleanly
  expect(createHash("sha256").update(fixedClampSource).digest("hex")).toBeTruthy();
}, 60_000);

test("4. Workflows whose contract does not require an observed test are not blocked without one", async () => {
  // (a) Orchestrated workflow with explicit `evidencePolicy: "review-without-observed-test"`:
  const repo = makeGitRepo("exempt-workflow");
  const { taskId, devRunId } = await seedPublishedClampTask(repo);
  const { resourceKey } = await import("./orchestrated-resources.ts");
  const h = dbMod.harnesses.getByIdOrKind(codexProfile.harnessId)!;
  const hKey = resourceKey(h);
  const wfId = randomUUID();
  const now = Date.now();
  const wfGrant = {
    id: wfId,
    taskId,
    projectPath: repo,
    developerHarness: codexProfile.harnessId,
    developerModel: "gpt-6-luna",
    implementerEmployeeId: null,
    implementerHarnessId: codexProfile.harnessId,
    implementerModel: "gpt-6-luna",
    implementerEffort: "low",
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6-luna",
    reviewerEmployeeId: null,
    evidencePolicy: "review-without-observed-test",
    autoReviewAfterImplementation: true,
    autoReworkOnChanges: false,
    maxReworkIterations: 0,
    execution: {
      implementerHarnessKey: hKey,
      reviewerHarnessKey: hKey,
      implementerMode: "auto",
      reviewerMode: "ask",
      boundedPolicy: null,
    },
    maxLaunches: 2,
    expiresAt: now + 60_000,
    approvedAt: now,
    approvedBy: "owner",
    grantEpoch: 1,
  };
  const wfData = {
    counters: { launchesUsed: 1, implementationRuns: 1, reviewRuns: 0, reworkCount: 0 },
    progress: { phase: "reviewing", activeReviewId: null, completedImplementationRunIds: [devRunId] },
  };
  dbMod.db.run(
    `INSERT INTO pm_orchestrated_workflows (id, project_path, task_id, status, phase, grant_json, data_json, created_at, updated_at) VALUES (?, ?, ?, 'active', 'reviewing', ?, ?, ?, ?)`,
    [wfId, repo, taskId, JSON.stringify(wfGrant), JSON.stringify(wfData), now, now],
  );

  // Even without any observed test, review-without-observed-test proceeds cleanly and records deterministic missing-test state.
  let dialogCount = 0;
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    nativeApprove: async ({ operation, nonce }) => {
      dialogCount += 1;
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: Date.now(),
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });
  const prep = qcMod.prepareQcReview({
    taskId,
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6-luna",
  }, { implementationRunId: devRunId });
  dbMod.db.run(`UPDATE pm_orchestrated_workflows SET status = 'active', phase = 'reviewing' WHERE id = ?`, [wfId]);
  const started = await qcMod.startQcReview(prep.review.id, wfId);
  expect("runId" in started).toBe(true);
  if (!("runId" in started)) throw new Error(started.error);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && dbMod.taskQualityReviews.get(prep.review.id)?.status !== "complete") {
    await Bun.sleep(40);
  }
  expect(dialogCount).toBe(1);
  expect(readSpawnRecords()).toHaveLength(1);
  expect(dbMod.taskQualityReviews.get(prep.review.id)?.evidenceState).toBe("missing-test");

  // (b) Standalone non-staged docs task with no approved test target also stays unblocked:
  const docsDir = path.join(root, "repos", "docs-only");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, "README.md"), "# Docs\n");
  for (const args of [["init", "-b", "main"], ["add", "README.md"], ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-m", "init"]]) {
    spawnSync("git", ["-C", docsDir, ...args], { encoding: "utf8" });
  }
  const realDocs = realpathSync(docsDir);
  dbMod.projects.upsert(realDocs, "docs-only");
  const docsTask = await orchestrator.createTask({
    title: "Docs update",
    prompt: "Review README update",
    workdir: realDocs,
    column: "review",
    agent: codexProfile.harnessId,
    model: "gpt-6-luna",
    mode: "auto",
    effort: "low",
    isolation: "none",
  } as never);
  if ("error" in docsTask) throw new Error(docsTask.error);
  const docsImplId = randomUUID();
  dbMod.runs.insert({
    id: docsImplId,
    taskId: docsTask.task.id,
    agent: codexProfile.harnessId,
    status: "succeeded",
    startedAt: Date.now() - 1000,
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
  dbMod.tasks.update(docsTask.task.id, { runId: docsImplId });
  const docsPrep = qcMod.prepareQcReview({
    taskId: docsTask.task.id,
    reviewerHarness: codexProfile.harnessId,
    reviewerModel: "gpt-6-luna",
  });
  const docsStarted = await qcMod.startQcReview(docsPrep.review.id);
  expect("runId" in docsStarted).toBe(true);
  if (!("runId" in docsStarted)) throw new Error(docsStarted.error);
  while (Date.now() < Date.now() + 8_000 && dbMod.taskQualityReviews.get(docsPrep.review.id)?.status !== "complete") {
    await Bun.sleep(40);
  }
  expect(dialogCount).toBe(2);
  expect(readSpawnRecords()).toHaveLength(2);
}, 60_000);
