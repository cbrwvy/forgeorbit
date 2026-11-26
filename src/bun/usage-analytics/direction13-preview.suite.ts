import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import {
  observePool, PLANNING_PROMPT, recordPool, recordRefusal, seedPlanningHistory, writeProjectManifest, type PlanningContext,
} from "../../../scripts/qa-portfolio-planning-fixture.ts";

/**
 * FO-DIRECTION13. The same planning case as portfolio-planning.suite.ts, but with the REAL fake-driver candidates (every candidate
 * is Simulated, as in the packaged QA window) instead of a mock. It proves the QA-only preview seam and its confinement:
 * a Simulated candidate can be previewed in the guarded QA build and never anywhere else, the preview stays read-only, an Unknown
 * capacity is never feasible, and a pool in another unit is never added to a money pool.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-direction13-")));
const localHome = join(root, "home");
mkdirSync(localHome);
process.env.HOME = localHome;
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_DISABLE_UPDATES = "1";

const { db, projects } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { forecast, optionKey } = await import("./forecast.ts");
const { enableNativeQa, nativeQaRoot } = await import("../native-qa-state.ts");
const { routerV2Service } = await import("../router-v2/router-v2-service.ts");

const core = new AccountCore(db);
const profiles = new CodexProfiles(core);
const model = "gpt-6.1-sol";
const account = (name: string) => {
  const directory = join(localHome, name);
  writeSyntheticCodexProfile(directory, "synthetic-" + name);
  return profiles.register({ displayName: name, directory });
};
const a = account("Alpha account");
const b = account("Beta account");
const c = account("Unknown capacity account");
const d = account("Independent account");
const e = account("Other unit account");
const alphaPath = join(root, "Alpha");
const betaPath = join(root, "Beta");
for (const path of [alphaPath, betaPath]) writeProjectManifest(path);
projects.upsert(alphaPath, "Alpha");
projects.upsert(betaPath, "Beta");
const now = Date.now();
const ctx: PlanningContext = { a, b, c, d, alphaPath, betaPath, model, now };
const task = (title: string, harnessId: string, workdir: string) => {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'backlog',?,?,?,'auto',?,?)`, [id, title, PLANNING_PROMPT, harnessId, workdir, model, now - 5000, now - 5000]);
  return id;
};
// The packaged QA window runs the real sign-in check against its inert stub, which reports the CLI installed and signed in.
// Here only those two facts are supplied; `simulated` is whatever the fake drivers really report (true).
const accounts = new Set([a.accountId, b.accountId, c.accountId, d.accountId, e.accountId]);
const gather = routerV2Service.gatherCandidatesSync.bind(routerV2Service);
type Role = Parameters<typeof gather>[0];
const flags = (login: (accountId: string) => boolean | null) => (role: Role) => gather(role)
  .filter(row => row.accountId !== null && accounts.has(row.accountId) && row.modelId === model)
  .map(row => ({ ...row, cliInstalled: true, cliLoggedIn: login(row.accountId!) }));
const candidateSpy = spyOn(routerV2Service, "gatherCandidatesSync").mockImplementation(flags(() => true));

seedPlanningHistory(db, ctx);
const t1 = task("Alpha parser", a.harnessId, alphaPath);
const t3 = task("Alpha parser tests", a.harnessId, alphaPath);
const t2 = task("Beta importer", b.harnessId, betaPath);
db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [t3, t1, now]);
const sharedA = recordPool(core, a.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
const sharedB = recordPool(core, b.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
recordPool(core, d.accountId, "independent", 100_000_000, null, now);
recordRefusal(db, c, now);
// Account E has a verified pool, but in tokens: a different unit from the USD price of the work.
const tokenPool = core.createDefinition({ accountId: e.accountId, scope: "account", category: "subscription", unit: { kind: "tokens" }, window: "monthly tokens" });
core.recordTrustedObservations("recorded-contract", [{ quotaId: tokenPool.id, values: {
  observedAt: now - 1000, expiresAt: now + 43_200_000, resetAt: null, limit: 5_000_000, used: null, remaining: 4_000_000, indicator: null, confidence: "high",
}, evidence: { provider: "openai", accountId: e.accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
  officialUrl: "https://example.invalid", checkedAt: "2026-11-14", receivedAt: now, sharedPool: null, limitations: "Recorded QA evidence" } }]);
const selection = { taskIds: [t1, t3, t2] };
const total = forecast(selection, now).capacity.rows.find(row => row.shared)!.knownDemand;
const alphaOnly = forecast({ taskIds: [t1, t3] }, now).capacity.rows.find(row => row.shared)!.knownDemand;
const betaOnly = forecast({ taskIds: [t2] }, now).capacity.rows.find(row => row.shared)!.knownDemand;
const balance = Math.max(alphaOnly, betaOnly) + Math.floor((total - Math.max(alphaOnly, betaOnly)) / 2);
observePool(core, sharedA.id, a.accountId, "shared", balance, "shared-credit", now);
observePool(core, sharedB.id, b.accountId, "shared", balance, "shared-credit", now);
const option = (accountId: string, result = forecast(selection, now)) =>
  result.estimates.find(item => item.taskId === t2)!.developerOptions.find(o => o.accountId === accountId && o.modelId === model)!;
const snapshot = () => ({
  tasks: db.query("SELECT id, \"column\", agent, model, mode, run_id FROM tasks ORDER BY id").all(),
  runs: db.query("SELECT COUNT(*) AS n FROM runs").get(),
  estimates: db.query("SELECT COUNT(*) AS n, MAX(id) AS last FROM usage_task_estimates").get(),
  groups: db.query("SELECT COUNT(*) AS n FROM usage_group_forecasts").get(),
  plans: db.query("SELECT COUNT(*) AS n FROM allocation_plans").get(),
  preferences: db.query("SELECT COUNT(*) AS n FROM project_account_preferences").get(),
  missions: db.query("SELECT COUNT(*) AS n FROM orchestration_missions").get(),
  refusals: db.query("SELECT COUNT(*) AS n FROM provider_refusal_observations").get(),
  quotas: db.query("SELECT COUNT(*) AS n FROM quota_observations").get(),
});
afterAll(() => { enableNativeQa(""); db.close(); rmSync(root, { recursive: true, force: true }); });

test("outside the guarded QA build a Simulated candidate is never eligible and cannot be previewed", () => {
  expect(nativeQaRoot()).toBeFalsy();
  expect(forecast(selection, now).constraints.find(item => item.taskId === t2)!.first).toMatchObject({ kind: "resource-evidence" });
  const independent = option(d.accountId);
  expect(independent).toMatchObject({ simulated: true, eligibility: "blocked", eligibilityReason: "Simulated harness." });
  expect(() => forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(independent) } }, now)).toThrow("currently unavailable");
});

test("a Simulated candidate with no sign-in answer is a preflight candidate outside QA and eligible only for the QA preview", () => {
  candidateSpy.mockImplementation(flags(() => null));
  try {
    enableNativeQa("");
    expect(option(d.accountId)).toMatchObject({ simulated: true, eligibility: "blocked" });
    enableNativeQa(root);
    expect(option(d.accountId)).toMatchObject({ simulated: true, eligibility: "eligible" });
    // An account the Router eliminates is never made eligible by the seam: a definite sign-in failure stays blocked.
    candidateSpy.mockImplementation(flags(accountId => accountId === d.accountId ? false : null));
    expect(option(d.accountId).eligibility).toBe("blocked");
  } finally {
    enableNativeQa("");
    candidateSpy.mockImplementation(flags(() => true));
  }
});

test("no environment variable and no stored setting can switch the preview seam on", () => {
  for (const key of ["FORGEORBIT_NATIVE_QA", "FORGEORBIT_QA", "NATIVE_QA", "AGETOR_NATIVE_QA", "FORGEORBIT_NATIVE_QA_ROOT", "__FORGEORBIT_NATIVE_QA_ROOT__"]) process.env[key] = root;
  expect(nativeQaRoot()).toBeFalsy();
  expect(option(d.accountId).eligibility).toBe("blocked");
  for (const key of ["FORGEORBIT_NATIVE_QA", "FORGEORBIT_QA", "NATIVE_QA", "AGETOR_NATIVE_QA", "FORGEORBIT_NATIVE_QA_ROOT", "__FORGEORBIT_NATIVE_QA_ROOT__"]) delete process.env[key];
  // The only caller of the switch is the QA build's own bootstrap, from a build-time constant.
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.(test|suite)\./.test(name)) continue;
      if (/enableNativeQa\(/.test(readFileSync(full, "utf8"))) callers.push(full.replace(join(import.meta.dir, "../.."), "src"));
    }
  };
  walk(join(import.meta.dir, "../.."));
  expect(callers.toSorted()).toEqual(["src/bun/native-qa-bootstrap.ts", "src/bun/native-qa-state.ts"]);
  expect(readFileSync(join(import.meta.dir, "../native-qa-bootstrap.ts"), "utf8")).toContain("__FORGEORBIT_NATIVE_QA_ROOT__");
});

test("in the guarded QA build a Simulated candidate can be previewed, stays labelled Simulated, and nothing is stored", () => {
  enableNativeQa(root);
  const before = snapshot();
  const independent = option(d.accountId);
  expect(independent).toMatchObject({ simulated: true, planningEligible: true, eligibility: "eligible", eligibilityReason: "Simulated harness (QA preview only)." });
  // The pool shortfall, not the Simulated label, is the first thing named for the task the pool cannot fund.
  expect(forecast(selection, now).constraints.find(item => item.taskId === t2)!.first).toMatchObject({ kind: "quota-shortfall" });
  // The Router's own verdict on the candidate is unchanged: the seam never reaches it.
  const routed = routerV2Service.evaluateTaskSync({ taskId: t2, projectId: betaPath, role: "developer", complexity: "low" }, { candidates: routerV2Service.gatherCandidatesSync("developer") });
  expect(routed.eligible.concat(routed.ineligible).every(item => item.candidateId.length > 0)).toBe(true);
  const preview = forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(independent) } }, now);
  const cmp = preview.comparison!;
  expect(cmp.changed).toEqual({ harness: true, account: true, model: false, mode: false });
  expect(cmp.proposed?.accountId).toBe(d.accountId);
  const shared = cmp.pools.find(pool => pool.shared)!;
  expect(shared.current).toMatchObject({ status: "insufficient", knownDemand: total });
  expect(shared.proposed).toMatchObject({ status: "fits", knownDemand: alphaOnly });
  expect(cmp.affected.map(row => row.taskId)).toContain(t2);
  // A Simulated resource never produces a date: the launch approval stays unresolved.
  expect(preview.completionWindow).toBeNull();
  expect(preview.blockers).toContain("start-approval");
  expect(snapshot()).toEqual(before);
});

test("an eligible alternative with Unknown capacity is never feasible, in the QA preview either", () => {
  enableNativeQa(root);
  const before = snapshot();
  const unknown = option(c.accountId);
  expect(unknown.eligibility).toBe("eligible");
  const preview = forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(unknown) } }, now);
  const first = preview.constraints.find(item => item.taskId === t2)!.first!;
  expect(first).toMatchObject({ kind: "quota-unknown", reason: "no-quota-evidence" });
  expect(preview.blockers).toContain("capacity");
  expect(preview.comparison!.elapsed).toMatchObject({ delta: null, reason: "capacity-unresolved" });
  expect(preview.completionWindow).toBeNull();
  // The recorded refusal is shown beside the candidate; it is neither a reading nor a reason to rank it differently.
  expect(preview.candidateRefusals[optionKey(unknown)]).toMatchObject({ kind: "usage-limit", accountId: c.accountId });
  expect(snapshot()).toEqual(before);
});

test("a verified pool in another unit is never added to, or compared with, the money pool", () => {
  enableNativeQa(root);
  const other = option(e.accountId);
  expect(other.planningEligible).toBe(true);
  const preview = forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(other) } }, now);
  const rows = preview.capacity.rows;
  // The USD pools keep their own units and numbers; the token pool never supplies a USD balance or demand.
  for (const row of rows.filter(r => r.unit.kind === "money")) expect(row.unit).toEqual({ kind: "money", currency: "USD" });
  expect(rows.some(r => r.accountIds.includes(e.accountId) && r.unit.kind === "money")).toBe(false);
  const first = preview.constraints.find(item => item.taskId === t2)!.first!;
  expect(first.kind).toBe("quota-unknown");
  expect(preview.completionWindow).toBeNull();
  expect(preview.comparison!.elapsed.delta).toBeNull();
});

