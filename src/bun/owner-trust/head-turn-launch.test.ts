/**
 * Production Owner launch gate regression tests for Head of PM isolated turns.
 *
 * Exercises `trustClass: "production"` with a pinned local certificate, an
 * enrolled P-256 test key via the in-process test seam, `AGETOR_CODEX_DRIVER`
 * unset (no fake-driver shortcut), and inert shell shims at `AGETOR_CODEX_BIN`
 * / `AGETOR_TMUX_BIN`. Proves:
 *  - valid single-use approval permits ONLY the exact bound Head turn;
 *  - missing/Bearer-only, preview, cancelled, expired, mismatched, and replayed
 *    approvals cannot launch a provider (0 spawns);
 *  - direct un-gated `runIsolatedTurn` still fails closed;
 *  - applying a Head board proposal still requires separate Owner approval.
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
  CHALLENGE_TTL_MS,
  OWNER_TRUST_SCHEMA,
  PRODUCTION_BUNDLE_ID,
  SINGLE_OPERATION_MAX_MS,
  childInsideEnvelope,
  expectedScope,
  parseOwnerOperation,
  sha256Hex,
  type OwnerOperation,
} from "../../shared/owner-trust/protocol.ts";
import { createSyntheticSigner } from "./crypto.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-head-turn-launch-")));
const ownerHome = path.join(root, "home");
const dataDirPath = path.join(root, "data");
const spawnLogPath = path.join(root, "inert-head-spawns.ndjson");
const replyFilePath = path.join(root, "next-head-reply.txt");
mkdirSync(ownerHome, { recursive: true });
mkdirSync(dataDirPath, { recursive: true });

delete process.env.AGETOR_CODEX_DRIVER;
delete process.env.AGETOR_CLAUDE_DRIVER;
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = dataDirPath;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_API_PORT = "4798";

const codexInertPath = path.join(root, "codex-head-inert.sh");
writeFileSync(
  codexInertPath,
  `#!/bin/sh
set -e
all_args="$*"
while [ "$1" = "-c" ] || [ "$1" = "--config" ] || [ "$1" = "--disable" ] || [ "$1" = "--enable" ]; do
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
if [ "$1" = "features" ] && [ "$2" = "list" ]; then
  for feat in shell_tool apps plugins browser_use computer_use hooks; do
    case " $all_args " in
      *"--disable $feat"*|*"features.$feat=false"*)
        printf '%s  stable  false\\n' "$feat"
        ;;
      *)
        printf '%s  stable  true\\n' "$feat"
        ;;
    esac
  done
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  echo "[]"
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  echo "Usage: codex exec --ephemeral --sandbox <mode>"
  exit 0
fi
if [ "$1" = "exec" ]; then
  cat >/dev/null || true
  printf '%s\\t%s\\t%s\\n' "$(pwd)" "\${CODEX_HOME:-}" "$all_args" >> "${spawnLogPath}"
  reply_text=$(cat "${replyFilePath}" 2>/dev/null || printf '<reply>Board inspected cleanly.</reply>')
  escaped=$(printf '%s' "$reply_text" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')
  printf '{"type":"thread.started","thread_id":"inert-head-thread-1"}\\n'
  printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$escaped"
  printf '{"type":"turn.completed"}\\n'
  exit 0
fi
exit 1
`,
);
chmodSync(codexInertPath, 0o755);

const tmuxInertPath = path.join(root, "tmux-head-inert.sh");
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
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo-head-turn-launch";
}

const PIN = "ef".repeat(32);
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
let orchestratorMod: typeof import("../orchestrator.ts");
let pmMod: typeof import("../portfolio-manager.ts");
let headBoardMod: typeof import("../head-board-proposals.ts");
let isolatedMod: typeof import("../isolated-agent-turn.ts");
let lifecycleMod: typeof import("../project-lifecycle.ts");
let serverMod: typeof import("../server.ts");
let server: ReturnType<typeof import("../server.ts")["startApiServer"]>;
let CodexProfiles: typeof import("../codex-profiles.ts").CodexProfiles;
let noteAuthCheck: typeof import("../multiaccount/registry.ts").noteAuthenticationCheck;
let gateMod: typeof import("./launch-gate.ts");
let serviceMod: typeof import("./service.ts");

let codexProfile: { accountId: string; harnessId: string; directory: string };
let signer = createSyntheticSigner();
let trust: ReturnType<typeof import("./service.ts")["createOwnerTrust"]>;
let enrollmentId: string;
let clockNow = Date.now();
const baseUrl = "http://127.0.0.1:4798";
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
  writeFileSync(path.join(dir, "index.ts"), "export const v = 1;\n");
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
  return dir;
}

async function waitForTurn(turnId: string): Promise<ReturnType<typeof import("../portfolio-manager.ts")["getPortfolioTurn"]>> {
  for (let i = 0; i < 80; i++) {
    const view = pmMod.getPortfolioTurn(turnId);
    if (view && view.status !== "running") return view;
    await Bun.sleep(25);
  }
  return pmMod.getPortfolioTurn(turnId);
}

beforeAll(async () => {
  dbMod = await import("../db.ts");
  orchestratorMod = await import("../orchestrator.ts");
  pmMod = await import("../portfolio-manager.ts");
  headBoardMod = await import("../head-board-proposals.ts");
  isolatedMod = await import("../isolated-agent-turn.ts");
  lifecycleMod = await import("../project-lifecycle.ts");
  serverMod = await import("../server.ts");
  ({ CodexProfiles } = await import("../codex-profiles.ts"));
  ({ noteAuthenticationCheck: noteAuthCheck } = await import("../multiaccount/registry.ts"));
  gateMod = await import("./launch-gate.ts");
  serviceMod = await import("./service.ts");

  const profileDir = path.join(ownerHome, ".codex-head-qa");
  writeSyntheticCodexProfile(profileDir, "head-qa-subject");
  const profiles = new CodexProfiles();
  const registered = profiles.register({ displayName: "Head QA Codex", directory: profileDir });
  codexProfile = { accountId: registered.accountId, harnessId: registered.harnessId, directory: registered.directory };
  noteAuthCheck(dbMod.db, codexProfile.accountId, "authenticated", Date.now());

  const apiConfig = await import("../api-config.ts");
  authHeaders = {
    Authorization: `Bearer ${apiConfig.API_TOKEN}`,
    "Content-Type": "application/json",
  };
  server = serverMod.startApiServer();

  // Configure Head of PM to use the registered Codex profile with preflight consent.
  pmMod.updatePortfolioManagerConfig({ harness: codexProfile.harnessId, model: "gpt-6-luna", effort: "low" });
  const pre = await pmMod.portfolioManagerPreflight();
  if (!pre.ok) throw new Error(`Head preflight failed: ${pre.error}`);
  pmMod.updatePortfolioManagerConfig({
    harness: codexProfile.harnessId,
    model: "gpt-6-luna",
    effort: "low",
    consentKey: pre.value.isolation.consentKey,
  });
});

beforeEach(() => {
  clearSpawnRecords();
  clockNow = Date.now();
  signer = createSyntheticSigner();
  dbMod.db.run("DELETE FROM owner_trust_grant_uses");
  dbMod.db.run("DELETE FROM owner_trust_grants");
  dbMod.db.run("DELETE FROM owner_trust_challenges");
  dbMod.db.run("DELETE FROM owner_trust_decisions");
  dbMod.db.run("DELETE FROM owner_trust_enrollments");
  dbMod.db.run("DELETE FROM owner_trust_profile");
  trust = serviceMod.createOwnerTrust({
    database: dbMod.db,
    dataDir: dataDirPath,
    allowSynthetic: true,
    transportFixture: true,
    identity: productionIdentity,
    now: () => clockNow,
  });
  enrollmentId = trust.enrollTransportFixture(signer.publicKeySpki).id;
  gateMod.setOwnerTrustLaunchGateForTest({ trust, now: () => clockNow });
});

afterAll(() => {
  gateMod.setOwnerTrustLaunchGateForTest(null);
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function installValidApprover(onOperation?: (op: OwnerOperation) => void): void {
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    now: () => clockNow,
    nativeApprove: async ({ operation, nonce, enrollmentId: eid }) => {
      onOperation?.(operation);
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId: eid,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: clockNow,
      });
      return {
        decision: "signed",
        payload,
        signature: signer.sign(payload),
        publicKeySpki: signer.publicKeySpki,
      };
    },
  });
}

test("valid approval permits only the intended Head turn and preserves separate board-proposal approval", async () => {
  const repo = makeGitRepo("head-valid");
  dbMod.projects.upsert(repo, "Head Valid Project");
  const created = await orchestratorMod.createTask({
    title: "Add greet helper",
    prompt: "Add greet helper in index.ts",
    workdir: repo,
    agent: codexProfile.harnessId,
    model: "gpt-6-luna",
    effort: "low",
    mode: "auto",
    isolation: "none",
    column: "backlog",
  });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;

  // Turn 1: Read-only board query.
  writeFileSync(replyFilePath, "<reply>The board has one Backlog task: Add greet helper.</reply>");
  const seenOps: OwnerOperation[] = [];
  installValidApprover((op) => seenOps.push(op));

  const turn1Res = await pmMod.sendPortfolioMessage({
    scope: { kind: "project", path: repo },
    text: "What is on this board?",
  });
  expect(turn1Res.ok).toBe(true);
  if (!turn1Res.ok) throw new Error(turn1Res.error);
  const turn1Done = await waitForTurn(turn1Res.value.turn.id);
  expect(turn1Done?.status).toBe("succeeded");
  expect(seenOps).toHaveLength(1);
  expect(seenOps[0]!.role).toBe("head-of-pm");
  expect(seenOps[0]!.filesystem).toBe("read-only");
  expect(seenOps[0]!.gitRead).toBe(false);
  expect(seenOps[0]!.gitPublish).toBe(false);
  expect(seenOps[0]!.terminalAllowed).toBe(false);
  expect(seenOps[0]!.browserAllowed).toBe(false);
  expect(seenOps[0]!.computerUseAllowed).toBe(false);
  expect(seenOps[0]!.deploymentAllowed).toBe(false);
  expect(seenOps[0]!.externalProcess).toBe(true);
  expect(seenOps[0]!.attemptId).toBe(turn1Res.value.turn.id);
  expect(seenOps[0]!.runId).toBe(isolatedMod.isolatedRunId(turn1Res.value.turn.id));
  expect(seenOps[0]!.taskId).toBe(isolatedMod.isolatedSessionKey(turn1Res.value.turn.id));
  expect(seenOps[0]!.accountId).toBe(codexProfile.accountId);
  expect(seenOps[0]!.projectPath).toBe(repo);
  expect(seenOps[0]!.scope).toBe(`single:head-of-pm:codex:${codexProfile.accountId}:gpt-6-luna`);

  expect(readSpawnRecords()).toHaveLength(1);
  expect(readSpawnRecords()[0]!.codexHome).toBe(codexProfile.directory);
  const uses1 = dbMod.db.query<{ role: string; run_id: string }, []>(
    "SELECT role, run_id FROM owner_trust_grant_uses",
  ).all();
  expect(uses1).toHaveLength(1);
  expect(uses1[0]!.role).toBe("head-of-pm");
  expect(uses1[0]!.run_id).toBe(isolatedMod.isolatedRunId(turn1Res.value.turn.id));
  expect(dbMod.tasks.get(task.id)?.title).toBe("Add greet helper");

  // Turn 2: Head proposes renaming the Backlog task; proposal MUST stay pending until separate Owner approval.
  const proposalAction = JSON.stringify({
    kind: "edit",
    taskId: task.id,
    title: "Add greet helper function",
  });
  writeFileSync(
    replyFilePath,
    `<reply>Proposed renaming the task.</reply><head_board_action>${proposalAction}</head_board_action>`,
  );
  const turn2Res = await pmMod.sendPortfolioMessage({
    scope: { kind: "project", path: repo },
    text: "Propose renaming the Backlog task to Add greet helper function.",
  });
  expect(turn2Res.ok).toBe(true);
  if (!turn2Res.ok) throw new Error(turn2Res.error);
  const turn2Done = await waitForTurn(turn2Res.value.turn.id);
  expect(turn2Done?.status).toBe("succeeded");
  expect(readSpawnRecords()).toHaveLength(2);

  // Proposal is pending and the board task has NOT changed yet.
  const stateBeforeApprove = pmMod.getPortfolioManagerState();
  expect(stateBeforeApprove.ok).toBe(true);
  if (!stateBeforeApprove.ok) throw new Error(stateBeforeApprove.error);
  const pendingProposal = (stateBeforeApprove.value.boardProposals ?? []).find(
    (p) => p.status === "pending" && p.action.kind === "edit" && p.action.taskId === task.id,
  );
  expect(pendingProposal).toBeDefined();
  expect(dbMod.tasks.get(task.id)?.title).toBe("Add greet helper");

  // Separate Owner approval applies the board proposal and spawns ZERO new provider processes.
  const approved = await headBoardMod.resolveHeadBoardProposal(pendingProposal!.messageId, { confirm: true }, "approve");
  expect(approved.ok).toBe(true);
  if (!approved.ok) throw new Error(approved.error);
  expect(approved.value.status).toBe("applied");
  expect(dbMod.tasks.get(task.id)?.title).toBe("Add greet helper function");
  expect(readSpawnRecords()).toHaveLength(2);
});

test("missing, Bearer-only, preview, cancelled, and direct un-gated launches produce 0 spawns", async () => {
  const repo = makeGitRepo("head-refuse");
  dbMod.projects.upsert(repo, "Head Refuse Project");
  const msgCountBefore = pmMod.getPortfolioManagerState().ok
    ? (pmMod.getPortfolioManagerState() as { ok: true; value: { messages: unknown[] } }).value.messages.length
    : 0;

  // 1. Missing native approver over HTTP with valid Bearer token -> 403, 0 spawns.
  const httpRes = await fetch(`${baseUrl}/portfolio-manager/messages`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ scope: { kind: "project", path: repo }, text: "What is on this board?" }),
  });
  expect(httpRes.status).toBe(403);
  const httpBody = await httpRes.json() as { code?: string };
  expect(httpBody.code).toBe("owner-proof-absent");
  expect(readSpawnRecords()).toHaveLength(0);

  // 2. Settings preview proof (`review:*`, `externalProcess: false`) -> refused, 0 spawns.
  const previewOp = parseOwnerOperation({
    schema: OWNER_TRUST_SCHEMA,
    requestId: "review:head-preview-1",
    kind: "single-operation",
    projectPath: repo,
    taskId: "preview-task",
    missionId: "none",
    missionRevision: "none",
    role: "reviewer",
    providerId: "codex",
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    accountId: codexProfile.accountId,
    mode: "ask",
    workspace: repo,
    filesystem: "read-only",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "preview",
    envelopeDigest: sha256Hex("preview"),
    policyRevision: "none",
    scope: expectedScope({
      kind: "single-operation",
      role: "reviewer",
      providerId: "codex",
      accountId: codexProfile.accountId,
      modelId: "gpt-6-luna",
      missionId: "none",
      policyRevision: "none",
    }),
    runId: "none",
    attemptId: "none",
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    expiresAt: clockNow + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true,
    externalProcess: false,
    taskStateDigest: sha256Hex("preview-task"),
    missionStateDigest: sha256Hex("none"),
  }, clockNow);
  expect(previewOp.ok).toBe(true);
  if (!previewOp.ok) throw new Error(previewOp.reason);
  const previewCh = trust.issueChallenge(previewOp.operation, enrollmentId);
  expect(previewCh.ok).toBe(true);
  if (!previewCh.ok) throw new Error(previewCh.reason);
  const previewPayload = serviceMod.buildProofPayload(previewOp.operation, {
    nonce: previewCh.nonce,
    enrollmentId,
    applicationIdentity: PRODUCTION_BUNDLE_ID,
    issuedAt: clockNow,
  });
  const previewProof = {
    schema: OWNER_TRUST_SCHEMA,
    payload: previewPayload,
    signature: signer.sign(previewPayload),
  };
  const previewSend = await pmMod.sendPortfolioMessage(
    { scope: { kind: "project", path: repo }, text: "Try preview proof" },
    {},
    { ownerProof: previewProof },
  );
  expect(previewSend.ok).toBe(false);
  if (!previewSend.ok) expect(previewSend.body?.code).toBe("owner-preview-not-launch");
  expect(readSpawnRecords()).toHaveLength(0);

  // 3. Cancelled native dialog -> 403, 0 grants, 0 spawns, no pending message added.
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    now: () => clockNow,
    nativeApprove: async () => ({
      decision: "cancelled",
      code: "authentication-cancelled",
      reason: "Owner cancelled native dialog.",
    }),
  });
  const cancelledRes = await pmMod.sendPortfolioMessage({
    scope: { kind: "project", path: repo },
    text: "Should cancel cleanly",
  });
  expect(cancelledRes.ok).toBe(false);
  if (!cancelledRes.ok) {
    expect(cancelledRes.status).toBe(403);
    expect(cancelledRes.body?.code).toBe("authentication-cancelled");
  }
  expect(dbMod.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM owner_trust_grants").get()?.c).toBe(0);
  expect(dbMod.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM owner_trust_grant_uses").get()?.c).toBe(0);
  expect(readSpawnRecords()).toHaveLength(0);
  const stateAfterCancel = pmMod.getPortfolioManagerState();
  expect(stateAfterCancel.ok && stateAfterCancel.value.messages.length).toBe(msgCountBefore);

  // 4. Direct un-gated `runIsolatedTurn` bypass without `ownerLaunch` -> blocked, 0 spawns.
  const harness = dbMod.harnesses.get(codexProfile.harnessId)!;
  const directOutcome = await isolatedMod.runIsolatedTurn(
    {
      turnId: crypto.randomUUID(),
      harness,
      mode: "ask",
      model: "gpt-6-luna",
      effort: "low",
      fast: false,
      maxMode: false,
      prompt: "bypass attempt",
      lockdownArgs: [],
      timeoutMs: 10_000,
    },
    { cancelRequested: false, handle: null },
  );
  expect(directOutcome.kind).toBe("failed");
  if (directOutcome.kind === "failed") {
    expect(directOutcome.error).toContain("single-use macOS Owner launch confirmation");
  }
  expect(readSpawnRecords()).toHaveLength(0);
});

test("expired, mismatched, and reused approvals cannot launch a provider (0 spawns)", async () => {
  const repoA = makeGitRepo("head-repo-a");
  const repoB = makeGitRepo("head-repo-b");
  dbMod.projects.upsert(repoA, "Repo A");
  dbMod.projects.upsert(repoB, "Repo B");

  // 1. Expired challenge during approval -> owner-challenge-expired, 0 spawns.
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    now: () => clockNow,
    nativeApprove: async ({ operation, nonce, enrollmentId: eid }) => {
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId: eid,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: clockNow,
      });
      const sig = signer.sign(payload);
      // Advance clock past challenge TTL before returning signature.
      clockNow += CHALLENGE_TTL_MS + 5_000;
      return { decision: "signed", payload, signature: sig, publicKeySpki: signer.publicKeySpki };
    },
  });
  const expiredRes = await pmMod.sendPortfolioMessage({
    scope: { kind: "project", path: repoA },
    text: "Expired turn",
  });
  expect(expiredRes.ok).toBe(false);
  if (!expiredRes.ok) expect(expiredRes.body?.code).toBe("owner-challenge-expired");
  expect(readSpawnRecords()).toHaveLength(0);

  // 2. Build & authorize a ticket for Turn X in Repo A, then test expired/mismatched/reused ticket consumption.
  const turnX = crypto.randomUUID();
  const taskIdX = isolatedMod.isolatedSessionKey(turnX);
  const runIdX = isolatedMod.isolatedRunId(turnX);
  const scratchX = isolatedMod.isolatedTurnScratchDir(turnX);
  const builtX = gateMod.buildHeadTurnOperation({
    turnId: turnX,
    messageId: crypto.randomUUID(),
    taskId: taskIdX,
    runId: runIdX,
    workspace: scratchX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    effort: "low",
    lockdownArgs: [],
    scope: { kind: "project", projectPath: repoA, clusterId: null, projectPaths: [repoA] },
    messageText: "Message X",
    prompt: "Prompt X",
    now: clockNow,
  });
  expect(builtX.ok).toBe(true);
  if (!builtX.ok) throw new Error(builtX.reason);

  let capturedProof: unknown = null;
  gateMod.setOwnerTrustLaunchGateForTest({
    trust,
    now: () => clockNow,
    nativeApprove: async ({ operation, nonce, enrollmentId: eid }) => {
      const payload = serviceMod.buildProofPayload(operation, {
        nonce,
        enrollmentId: eid,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: clockNow,
      });
      const signature = signer.sign(payload);
      capturedProof = { schema: OWNER_TRUST_SCHEMA, payload, signature };
      return { decision: "signed", payload, signature, publicKeySpki: signer.publicKeySpki };
    },
  });
  const authX = await gateMod.authorizeSupervisedLaunch({ built: builtX.built });
  expect(authX.ok).toBe(true);
  if (!authX.ok) throw new Error(authX.reason);

  // Mismatched turnId -> throws, ticket stays unconsumed.
  expect(() => gateMod.consumeHeadTurnLaunchTicket({
    grantId: authX.grantId,
    turnId: crypto.randomUUID(),
    taskId: taskIdX,
    runId: runIdX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    resolvedWorkspace: scratchX,
    taskStateDigest: builtX.built.operation.taskStateDigest,
  })).toThrow(/does not match this Head of PM turn/);

  // Mismatched message/scope digest -> throws.
  expect(() => gateMod.consumeHeadTurnLaunchTicket({
    grantId: authX.grantId,
    turnId: turnX,
    taskId: taskIdX,
    runId: runIdX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    resolvedWorkspace: scratchX,
    taskStateDigest: sha256Hex("tampered-message-or-scope"),
  })).toThrow(/scope or message changed/);

  // Mismatched model -> throws.
  expect(() => gateMod.consumeHeadTurnLaunchTicket({
    grantId: authX.grantId,
    turnId: turnX,
    taskId: taskIdX,
    runId: runIdX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-sol",
    mode: "ask",
    resolvedWorkspace: scratchX,
    taskStateDigest: builtX.built.operation.taskStateDigest,
  })).toThrow(/harness, model, or mode/);

  // Mismatched workspace -> throws.
  expect(() => gateMod.consumeHeadTurnLaunchTicket({
    grantId: authX.grantId,
    turnId: turnX,
    taskId: taskIdX,
    runId: runIdX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    resolvedWorkspace: repoB,
    taskStateDigest: builtX.built.operation.taskStateDigest,
  })).toThrow(/workspace changed/);

  // Consume once with exact matching parameters -> succeeds.
  gateMod.consumeHeadTurnLaunchTicket({
    grantId: authX.grantId,
    turnId: turnX,
    taskId: taskIdX,
    runId: runIdX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    resolvedWorkspace: scratchX,
    taskStateDigest: builtX.built.operation.taskStateDigest,
  });
  gateMod.discardUnconsumedSpawnAuthorization(runIdX);

  // Reuse / replay of the same grantId -> throws.
  expect(() => gateMod.consumeHeadTurnLaunchTicket({
    grantId: authX.grantId,
    turnId: turnX,
    taskId: taskIdX,
    runId: runIdX,
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    resolvedWorkspace: scratchX,
    taskStateDigest: builtX.built.operation.taskStateDigest,
  })).toThrow(/No unused Owner launch confirmation/);

  // Replaying Turn X's signed OwnerProof against a new sendPortfolioMessage in Repo B -> refused, 0 spawns.
  const replaySend = await pmMod.sendPortfolioMessage(
    { scope: { kind: "project", path: repoB }, text: "Replay into Repo B" },
    {},
    { ownerProof: capturedProof },
  );
  expect(replaySend.ok).toBe(false);
  expect(readSpawnRecords()).toHaveLength(0);

  // Expired ticket after authorization -> throws at consumeHeadTurnLaunchTicket.
  const turnExp = crypto.randomUUID();
  const builtExp = gateMod.buildHeadTurnOperation({
    turnId: turnExp,
    messageId: crypto.randomUUID(),
    taskId: isolatedMod.isolatedSessionKey(turnExp),
    runId: isolatedMod.isolatedRunId(turnExp),
    workspace: isolatedMod.isolatedTurnScratchDir(turnExp),
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    effort: "low",
    lockdownArgs: [],
    scope: { kind: "project", projectPath: repoA, clusterId: null, projectPaths: [repoA] },
    messageText: "Will expire after sign",
    prompt: "Prompt Exp",
    now: clockNow,
  });
  expect(builtExp.ok).toBe(true);
  if (!builtExp.ok) throw new Error(builtExp.reason);
  const authExp = await gateMod.authorizeSupervisedLaunch({ built: builtExp.built });
  expect(authExp.ok).toBe(true);
  if (!authExp.ok) throw new Error(authExp.reason);
  clockNow += SINGLE_OPERATION_MAX_MS + 1_000;
  expect(() => gateMod.consumeHeadTurnLaunchTicket({
    grantId: authExp.grantId,
    turnId: turnExp,
    taskId: isolatedMod.isolatedSessionKey(turnExp),
    runId: isolatedMod.isolatedRunId(turnExp),
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    mode: "ask",
    resolvedWorkspace: isolatedMod.isolatedTurnScratchDir(turnExp),
    taskStateDigest: builtExp.built.operation.taskStateDigest,
  })).toThrow(/expired/);
  gateMod.discardUnconsumedLaunchTicket(authExp.grantId);
  expect(readSpawnRecords()).toHaveLength(0);
});

test("Head operation enforces read-only no-git protocol, blocks mission child bypass, and respects Project Stop", async () => {
  const repo = makeGitRepo("head-bounds");
  dbMod.projects.upsert(repo, "Head Bounds Project");

  // Protocol refuses workspace-write or gitRead: true on role: "head-of-pm".
  const baseOp = {
    schema: OWNER_TRUST_SCHEMA,
    requestId: "launch:head-turn:bad-1",
    kind: "single-operation",
    projectPath: repo,
    taskId: "iv-123456789",
    missionId: "none",
    missionRevision: "none",
    role: "head-of-pm",
    providerId: "codex",
    harnessId: codexProfile.harnessId,
    modelId: "gpt-6-luna",
    accountId: codexProfile.accountId,
    mode: "ask",
    workspace: repo,
    filesystem: "workspace-write",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: false,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "head-of-pm-isolated-turn",
    envelopeDigest: sha256Hex("bad"),
    policyRevision: "none",
    scope: `single:head-of-pm:codex:${codexProfile.accountId}:gpt-6-luna`,
    runId: "interview-1234567890abcdef1234567890abcdef",
    attemptId: "bad-1",
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    expiresAt: clockNow + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true,
    externalProcess: true,
    taskStateDigest: sha256Hex("bad"),
    missionStateDigest: sha256Hex("none"),
  };
  const badWrite = parseOwnerOperation(baseOp, clockNow);
  expect(badWrite.ok).toBe(false);
  if (!badWrite.ok) expect(badWrite.code).toBe("owner-sandbox");

  const badGit = parseOwnerOperation({ ...baseOp, filesystem: "read-only", gitRead: true }, clockNow);
  expect(badGit.ok).toBe(false);
  if (!badGit.ok) expect(badGit.code).toBe("owner-sandbox");

  const validHead = parseOwnerOperation({ ...baseOp, filesystem: "read-only", gitRead: false }, clockNow);
  expect(validHead.ok).toBe(true);
  const parentMission = parseOwnerOperation({
    ...baseOp,
    requestId: "mission:1",
    kind: "bounded-mission",
    role: "policy-envelope",
    providerId: "policy-envelope",
    modelId: "policy-envelope",
    accountId: "policy-envelope",
    filesystem: "policy-envelope",
    taskId: "policy-envelope",
    missionId: "m1",
    policyRevision: "1",
    scope: "mission:m1:1",
  }, clockNow);
  expect(parentMission.ok).toBe(true);
  if (parentMission.ok && validHead.ok) {
    expect(childInsideEnvelope(parentMission.operation, validHead.operation)).toContain("Head of PM");
  }

  // Paused project blocks project-scoped Head turn even with valid native signature.
  await lifecycleMod.stopProjectLifecycle(repo, "Paused for Head test");
  installValidApprover();
  const pausedRes = await pmMod.sendPortfolioMessage({
    scope: { kind: "project", path: repo },
    text: "Should be blocked by paused project",
  });
  expect(pausedRes.ok).toBe(false);
  if (!pausedRes.ok) {
    expect(pausedRes.status).toBe(409);
    expect(pausedRes.body?.code).toBe("owner-project-paused");
  }
  expect(readSpawnRecords()).toHaveLength(0);
});
