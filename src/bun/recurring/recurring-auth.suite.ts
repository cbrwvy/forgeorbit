/**
 * FO-KANBAN-RECURRING01 — Owner authorization & HTTP auth boundary suite.
 *
 * Verifies under the production Owner Trust gate:
 *  - #17: Expired Owner authorization blocks recurring provider execution; recurring
 *         schedules NEVER renew expired grants or extend authorization duration.
 *  - #18: Exhausted launch budget blocks recurring provider execution; recurring
 *         schedules NEVER increase launch budgets.
 *  - #35 & #36: Invalid recurrence intervals and unauthorized HTTP recurrence mutations
 *         (missing Bearer header, `?token=` query param, wrong token) are rejected.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { PRODUCTION_BUNDLE_ID } from "../../shared/owner-trust/protocol.ts";
import { createSyntheticSigner } from "../owner-trust/crypto.ts";
import { parseHandsoffPolicy, type HandsoffResourceRef } from "../../shared/handsoff.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-recurring-auth-")));
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
process.env.AGETOR_API_PORT = "0";
process.env.FORGEORBIT_EMBEDDING_MODEL_ROOT = "/nonexistent/no-model-fixture";

const codexInert = path.join(root, "codex-inert.sh");
writeFileSync(
  codexInert,
  `#!/bin/sh
set -e
if [ "$1" = "--version" ]; then echo "codex-cli 0.162.1"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
printf 'spawned\\n' >> "${spawnLog}"
exit 0
`,
);
chmodSync(codexInert, 0o755);
process.env.AGETOR_CODEX_BIN = codexInert;
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo-recurring-auth";
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

const store = await import("../db.ts");
const gate = await import("../owner-trust/launch-gate.ts");
const service = await import("../owner-trust/service.ts");
const driver = await import("../handsoff/driver.ts");
const handsoff = await import("../handsoff/store.ts");
const policyApi = await import("../handsoff/policy.ts");
const auth = await import("../handsoff/authorization.ts");
const serverMod = await import("../server.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { EmployeeCore } = await import("../employee-core.ts");
const { noteAuthenticationCheck } = await import("../multiaccount/registry.ts");
const { setTaskAvailabilityClockForTest } = await import("../task-availability.ts");
const recurring = await import("./scheduler.ts");

const BASE_NOW = Date.parse("2026-11-26T12:00:00.000Z");
let now = BASE_NOW;

const signer = createSyntheticSigner();
let trust!: ReturnType<typeof service.createOwnerTrust>;
let enrollmentId = "";
let accountId = "";
let harnessId = "";
let projectPath = "";
let apiBase = "";
let serverHandle: ReturnType<typeof serverMod.startApiServer> | null = null;

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
    label: "recurring-auth-test",
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

  const registry = new CodexProfiles(new AccountCore(store.db));
  const home = path.join(ownerHome, ".codex-rec-auth");
  writeSyntheticCodexProfile(home, "rec-auth-profile");
  const reg = registry.register({ displayName: "Rec Codex Profile", directory: realpathSync(home) });
  noteAuthenticationCheck(store.db, reg.accountId, "authenticated", now);
  accountId = reg.accountId;
  harnessId = reg.harnessId;

  setTaskAvailabilityClockForTest(() => now);
  recurring.setRecurringClockForTest(() => now);
  auth.setAuthorizationClockForTest(() => now);
  driver.setHandsoffDepsForTest({ now: () => now });
  driver.initHandsoff();
  recurring.initRecurringScheduler();

  projectPath = path.join(root, "proj");
  mkdirSync(path.join(projectPath, "src"), { recursive: true });
  writeFileSync(path.join(projectPath, "README.md"), "# rec-auth\n");
  writeFileSync(path.join(projectPath, "src/index.ts"), "export const x = 1;\n");
  await git(projectPath, ["init", "-b", "main"]);
  await git(projectPath, ["config", "user.email", "qa@example.invalid"]);
  await git(projectPath, ["config", "user.name", "QA"]);
  await git(projectPath, ["add", "-A"]);
  await git(projectPath, ["commit", "-m", "init"]);

  projectPath = realpathSync(projectPath);
  store.projects.upsert(projectPath, "rec-auth");
  store.projects.setWorkspaceDevelopment(projectPath, true);
  const employees = new EmployeeCore(store.db);
  employees.createWorker({ name: "Dev A", jobTitle: "Developer", projectPath });
  employees.createWorker({ name: "Rev A", jobTitle: "Reviewer", projectPath });

  const resources: HandsoffResourceRef[] = [
    { role: "developer", harnessId, accountKey: accountId },
    { role: "reviewer", harnessId, accountKey: accountId },
  ];
  const parsed = parseHandsoffPolicy({ enabled: true, autoAssign: true, runOfflineTests: false, autoApply: true, autoDone: true, resources });
  if (!parsed.ok) throw new Error(parsed.error);
  await policyApi.saveHandsoffPolicy(projectPath, parsed.policy);

  serverHandle = serverMod.startApiServer();
  apiBase = `http://127.0.0.1:${serverHandle.port}`;
});

afterAll(() => {
  try { serverHandle?.stop(true); } catch { /* ignore */ }
  recurring.stopRecurringScheduler();
  recurring.setRecurringClockForTest(null);
  driver.stopHandsoffTimers();
  driver.setHandsoffDepsForTest(null);
  auth.setAuthorizationClockForTest(null);
  setTaskAvailabilityClockForTest(null);
  gate.setOwnerTrustLaunchGateForTest(null);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("17. Expired Owner authorization blocks recurring provider execution and never auto-renews", async () => {
  // Authorize project for 1 hour (expires at 13:00 UTC)
  const authorized = await auth.authorizeProject(projectPath, { hours: 1, launches: 4, locale: "en" });
  expect(authorized.state).toBe("active");

  // Schedule auto-submit recurring task for 15:00 UTC (after authorization expires!)
  const { template } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Post-expiry audit",
    prompt: "Check deps",
    recurrenceType: "daily",
    startDateUtc: "2026-11-26",
    startTimeUtc: "15:00",
    submissionMode: "auto_submit",
  });

  // Advance clock to 15:00 UTC (authorization expired 2h ago)
  now = Date.parse("2026-11-26T15:00:00.000Z");
  const res = await recurring.reconcileRecurringTemplate(template.id);
  expect(res.generatedTaskIds.length).toBe(1);
  expect(res.submittedCount).toBe(1);
  const taskId = res.generatedTaskIds[0]!;
  await driver.settledProject(projectPath);

  const run = handsoff.handsoffStore.openRunForTask(taskId)!;
  expect(run.status).toBe("needs-owner");
  expect(run.blocker?.code).toBe("authorization-expired");
  expect(auth.authorizationView(projectPath).state).toBe("expired");
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "").toBe("");

  await driver.cancelHandsoffRun(run.id);
  await recurring.stopRecurringTemplate(template.id);
});

test("18. Exhausted launch budget blocks recurring provider execution and never increases budget", async () => {
  now = Date.parse("2026-11-26T16:00:00.000Z");
  const authorized = await auth.authorizeProject(projectPath, { hours: 4, launches: 2, locale: "en" });
  expect(authorized.state).toBe("active");
  expect(authorized.launchBudget).toBe(2);

  // Exhaust the 2-launch budget directly via recorded consumed launches
  const activeAuthId = store.db
    .query<{ id: string }, [string]>(`SELECT id FROM handsoff_authorizations WHERE project_path = ? AND status = 'active'`)
    .get(projectPath)!.id;
  for (let i = 0; i < 2; i += 1) {
    store.db.run(
      `INSERT INTO handsoff_launches (claim_key, authorization_id, handsoff_run_id, task_id, role, child_grant_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'developer', ?, 'consumed', ?, ?)`,
      [`claim-${i}`, activeAuthId, `hr-prev-${i}`, `t-prev-${i}`, `cg-${i}`, now, now],
    );
  }
  expect(auth.authorizationView(projectPath).state).toBe("exhausted");

  const { template } = await recurring.createRecurringTemplate({
    projectPath,
    title: "Over-budget recurring check",
    prompt: "Should wait for budget",
    recurrenceType: "daily",
    startDateUtc: "2026-11-26",
    startTimeUtc: "17:00",
    submissionMode: "auto_submit",
  });

  now = Date.parse("2026-11-26T17:00:00.000Z");
  const res = await recurring.reconcileRecurringTemplate(template.id);
  expect(res.generatedTaskIds.length).toBe(1);
  const taskId = res.generatedTaskIds[0]!;
  await driver.settledProject(projectPath);

  const run = handsoff.handsoffStore.openRunForTask(taskId)!;
  expect(run.status).toBe("needs-owner");
  expect(run.blocker?.code).toBe("authorization-exhausted");
  expect(auth.authorizationView(projectPath).launchBudget).toBe(2); // Budget was NOT increased
  expect(existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "").toBe("");

  await driver.cancelHandsoffRun(run.id);
  await recurring.stopRecurringTemplate(template.id);
});

test("35 & 36. Unauthorized HTTP recurring mutations and invalid intervals are rejected", async () => {
  const validPayload = {
    projectPath,
    title: "HTTP auth check",
    prompt: "Check auth",
    recurrenceType: "daily",
    startDateUtc: "2026-11-27",
    startTimeUtc: "06:00",
  };

  // Missing Authorization header -> 401
  const noAuth = await fetch(`${apiBase}/recurring/templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validPayload),
  });
  expect(noAuth.status).toBe(401);

  // Query param `?token=` (non-Owner / EventSource token) must be rejected on mutations -> 401
  const queryAuth = await fetch(`${apiBase}/recurring/templates?token=${encodeURIComponent(serverMod.API_TOKEN)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validPayload),
  });
  expect(queryAuth.status).toBe(401);

  // Wrong Bearer token -> 401
  const badAuth = await fetch(`${apiBase}/recurring/templates`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
    body: JSON.stringify(validPayload),
  });
  expect(badAuth.status).toBe(401);

  // Valid Owner Bearer header with invalid interval (0) -> 400
  const badInterval = await fetch(`${apiBase}/recurring/templates`, {
    method: "POST",
    headers: { authorization: `Bearer ${serverMod.API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...validPayload,
      recurrenceType: "custom_interval",
      interval: 0,
      intervalUnit: "hours",
    }),
  });
  expect(badInterval.status).toBe(400);

  // Valid Owner Bearer header with valid schedule -> 201
  const okRes = await fetch(`${apiBase}/recurring/templates`, {
    method: "POST",
    headers: { authorization: `Bearer ${serverMod.API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(validPayload),
  });
  expect(okRes.status).toBe(201);
});
