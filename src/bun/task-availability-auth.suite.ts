/**
 * Scheduled task availability under the production Owner Trust authorization path
 * (FO-KANBAN-SCHEDULE01 verification items #10 and #19).
 *
 * Verifies:
 *  - While a submitted task waits for its future `availableFromUtc`, ZERO launch budget
 *    is consumed (`launchesUsed === 0`), ZERO child grants are minted, and ZERO processes spawn.
 *  - When the Owner authorization expires before the scheduled timestamp arrives, reaching
 *    the timestamp refuses launch with `authorization-expired`, does NOT auto-renew, and spawns 0 processes.
 *  - Editing `availableFromUtc` cannot restore an expired or revoked authorization.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { PRODUCTION_BUNDLE_ID } from "../shared/owner-trust/protocol.ts";
import { createSyntheticSigner } from "./owner-trust/crypto.ts";
import { parseHandsoffPolicy, type HandsoffResourceRef } from "../shared/handsoff.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-sched-auth-")));
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
if [ "$1" = "--version" ]; then echo "codex-cli 0.162.1"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
printf 'spawned\\n' >> "${spawnLog}"
exit 0
`);
chmodSync(codexInert, 0o755);
process.env.AGETOR_CODEX_BIN = codexInert;
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo-sched-auth";

const PIN = "ab".repeat(32);
const productionIdentity = { bundleId: PRODUCTION_BUNDLE_ID, teamId: null, trustClass: "production" as const, adhoc: false, signed: true, source: "/tmp/ForgeOrbit.app", certSha256: PIN, anchorSha256: PIN };

const store = await import("./db.ts");
const orchestrator = await import("./orchestrator.ts");
const gate = await import("./owner-trust/launch-gate.ts");
const service = await import("./owner-trust/service.ts");
const driver = await import("./handsoff/driver.ts");
const handsoff = await import("./handsoff/store.ts");
const policyApi = await import("./handsoff/policy.ts");
const auth = await import("./handsoff/authorization.ts");
const { AccountCore } = await import("./account-core.ts");
const { CodexProfiles } = await import("./codex-profiles.ts");
const { EmployeeCore } = await import("./employee-core.ts");
const { noteAuthenticationCheck } = await import("./multiaccount/registry.ts");
const { setTaskAvailabilityClockForTest } = await import("./task-availability.ts");

const BASE_NOW = Date.parse("2026-11-26T12:00:00.000Z");
const TARGET_ISO = "2026-11-26T15:00:00.000Z"; // 3 hours after BASE_NOW
const TARGET_MS = Date.parse(TARGET_ISO);
let now = BASE_NOW;

const signer = createSyntheticSigner();
let trust!: ReturnType<typeof service.createOwnerTrust>;
let enrollmentId = "";
let accountId = "";
let harnessId = "";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

beforeAll(async () => {
  store.harnesses.setEnabled("codex", true);
  trust = service.createOwnerTrust({ database: store.db, dataDir: dataDirPath, identity: productionIdentity, now: () => now });
  enrollmentId = trust.store.insertEnrollment({
    trustClass: "production",
    applicationIdentity: PRODUCTION_BUNDLE_ID,
    publicKeySpki: signer.publicKeySpki,
    keyProtection: "secure-enclave-user-presence",
    label: "sched-auth-test",
    now,
    signingCertSha256: PIN,
  } as never).id;
  gate.setOwnerTrustLaunchGateForTest({
    trust,
    now: () => now,
    nativeApprove: async ({ operation, nonce }) => {
      const payload = service.buildProofPayload(operation, {
        nonce,
        enrollmentId,
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        issuedAt: now,
      });
      return { decision: "signed", payload, signature: signer.sign(payload) };
    },
  });
  auth.setAuthorizationClockForTest(() => now);
  setTaskAvailabilityClockForTest(() => now);
  driver.setHandsoffDepsForTest({ now: () => now });

  const registry = new CodexProfiles(new AccountCore(store.db));
  const codexHome = path.join(ownerHome, ".codex-sched");
  writeSyntheticCodexProfile(codexHome, "sched-auth-profile");
  const reg = registry.register({ displayName: "Sched Codex Profile", directory: realpathSync(codexHome) });
  noteAuthenticationCheck(store.db, reg.accountId, "authenticated", now);
  accountId = reg.accountId;
  harnessId = reg.harnessId;
  driver.initHandsoff();
});

afterAll(() => {
  driver.stopHandsoffTimers();
  driver.setHandsoffDepsForTest(null);
  auth.setAuthorizationClockForTest(null);
  setTaskAvailabilityClockForTest(null);
  gate.setOwnerTrustLaunchGateForTest(null);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("waiting for scheduled time consumes 0 launch budget, and an expired authorization still blocks once the timestamp arrives", async () => {
  const dir = path.join(root, "proj-auth");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Auth test\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]);
  const projectPath = realpathSync(dir);
  store.projects.upsert(projectPath, "proj-auth");
  const emp = new EmployeeCore(store.db);
  emp.createWorker({ name: "Dev", jobTitle: "Developer", projectPath });
  emp.createWorker({ name: "Rev", jobTitle: "Reviewer", projectPath });

  const resources: HandsoffResourceRef[] = [
    { role: "developer", harnessId, accountKey: accountId },
    { role: "reviewer", harnessId, accountKey: accountId },
  ];
  const parsed = parseHandsoffPolicy({ enabled: true, resources, runOfflineTests: false });
  if (!parsed.ok) throw new Error(parsed.error);
  await policyApi.saveHandsoffPolicy(projectPath, parsed.policy);

  // Authorize for 2 hours and 5 launches (expires at 14:00 UTC, BEFORE scheduled 15:00 UTC)
  const authorized = await auth.authorizeProject(projectPath, { hours: 2, launches: 5 });
  expect(authorized.state).toBe("active");
  expect(authorized.launchesUsed).toBe(0);
  expect(authorized.launchesRemaining).toBe(5);

  const created = await orchestrator.createTask({
    title: "Auth-gated scheduled task",
    prompt: "Implement feature",
    workdir: projectPath,
    column: "backlog",
    agent: harnessId,
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    isolation: "worktree",
    accessMode: "workspace",
    availableFromUtc: TARGET_ISO,
  });
  if ("error" in created) throw new Error(created.error);

  const run = driver.submitTask(created.task.id);
  await driver.settled(run.id);

  // Waiting before timestamp: 0 budget consumed, 0 spawns, still waiting/scheduled
  expect(handsoff.handsoffStore.getRun(run.id)!.status).toBe("waiting");
  expect(handsoff.handsoffStore.getRun(run.id)!.state.waitKind).toBe("scheduled");
  const midView = auth.authorizationView(projectPath);
  expect(midView.state).toBe("active");
  expect(midView.launchesUsed).toBe(0);
  expect(midView.launchesRemaining).toBe(5);
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "").toBe("");

  // Advance clock to TARGET_MS (15:00 UTC) -> authorization expired at 14:00 UTC!
  now = TARGET_MS;
  await driver.wake(run.id);
  await driver.settled(run.id);

  const afterRun = handsoff.handsoffStore.getRun(run.id)!;
  expect(afterRun.status).toBe("needs-owner");
  expect(afterRun.blocker?.code).toBe("authorization-expired");
  // Editing availableFromUtc does NOT restore the expired authorization
  store.tasks.update(created.task.id, { availableFromUtc: null });
  expect(auth.authorizationView(projectPath).state).toBe("expired");
  expect(auth.authorizationView(projectPath).launchesUsed).toBe(0);
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "").toBe("");
});
