import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import {
  observePool, PLANNING_PROMPT, recordPool, recordRefusal, seedPlanningHistory, writeProjectManifest, type PlanningContext,
} from "../../../scripts/qa-portfolio-planning-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-portfolio-planning-")));
const localHome = join(root, "home");
mkdirSync(localHome);
process.env.HOME = localHome;
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_DISABLE_UPDATES = "1";

const { db, projects, tasks, runs } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { forecast, optionKey } = await import("./forecast.ts");
const { routerV2Service } = await import("../router-v2/router-v2-service.ts");
const { approveAllocationPlan, applyAllocationPlan } = await import("../allocation-plans.ts");
const { usageAnalyticsHttp } = await import("./http.ts");

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
const alphaPath = join(root, "Alpha");
const betaPath = join(root, "Beta");
for (const path of [alphaPath, betaPath]) writeProjectManifest(path);
projects.upsert(alphaPath, "Alpha");
projects.upsert(betaPath, "Beta");
const now = Date.now();
const ctx: PlanningContext = { a, b, c, d, alphaPath, betaPath, model, now };

function task(title: string, harnessId: string, workdir: string) {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'backlog',?,?,?,'auto',?,?)`, [id, title, PLANNING_PROMPT, harnessId, workdir, model, now - 5000, now - 5000]);
  return id;
}

const accounts = new Set([a.accountId, b.accountId, c.accountId, d.accountId]);
const selectCandidates = routerV2Service.gatherCandidatesSync.bind(routerV2Service);
spyOn(routerV2Service, "gatherCandidatesSync").mockImplementation(role => selectCandidates(role)
  .filter(row => row.accountId !== null && accounts.has(row.accountId) && row.modelId === model)
  .map(row => ({ ...row, simulated: false, cliInstalled: true, cliLoggedIn: true })));

seedPlanningHistory(db, ctx);
const t1 = task("Alpha parser", a.harnessId, alphaPath);
const t3 = task("Alpha parser tests", a.harnessId, alphaPath);
const t2 = task("Beta importer", b.harnessId, betaPath);
db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [t3, t1, now]);
const sharedA = recordPool(core, a.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
const sharedB = recordPool(core, b.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
recordPool(core, d.accountId, "independent", 100_000_000, null, now);
recordRefusal(db, c, now);
const selection = { taskIds: [t1, t3, t2] };
const probe = forecast(selection, now);
const total = probe.capacity.rows.find(row => row.shared)!.knownDemand;
const alphaOnly = forecast({ taskIds: [t1, t3] }, now).capacity.rows.find(row => row.shared)!.knownDemand;
const betaOnly = forecast({ taskIds: [t2] }, now).capacity.rows.find(row => row.shared)!.knownDemand;
// Each project fits on its own; together they do not.
const balance = Math.max(alphaOnly, betaOnly) + Math.floor((total - Math.max(alphaOnly, betaOnly)) / 2);
observePool(core, sharedA.id, a.accountId, "shared", balance, "shared-credit", now);
observePool(core, sharedB.id, b.accountId, "shared", balance, "shared-credit", now);

afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

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

test("the fixture shape: each project fits the shared balance, both together do not", () => {
  expect(alphaOnly).toBeLessThan(balance);
  expect(betaOnly).toBeLessThan(balance);
  expect(total).toBeGreaterThan(balance);
  const result = forecast(selection, now);
  const pools = result.capacity.rows.filter(row => row.accountIds.includes(a.accountId) || row.accountIds.includes(b.accountId));
  expect(pools).toHaveLength(1); // the shared pool is one row, not one per account
  const pool = pools[0]!;
  expect(pool).toMatchObject({ shared: true, status: "insufficient", evidence: "verified", remaining: balance, knownDemand: total, unknownStages: 0 });
  expect(pool.unit).toEqual({ kind: "money", currency: "USD" });
  expect(pool.shortfall).toBe(total - balance);
  expect(pool.accountIds.toSorted()).toEqual([a.accountId, b.accountId].toSorted());
  expect(forecast({ taskIds: [t1, t3] }, now).capacity.rows.find(row => row.shared)).toMatchObject({ status: "fits", shortfall: null });
  expect(forecast({ taskIds: [t2] }, now).capacity.rows.find(row => row.shared)).toMatchObject({ status: "fits", shortfall: null });
});

test("the first constraint per task separates waiting on a task from the resource shortfall", () => {
  const result = forecast(selection, now);
  const byTask = new Map(result.constraints.map(item => [item.taskId, item]));
  // T1 is first in the pool's charging order and fits: nothing constrains it.
  expect(byTask.get(t1)?.first).toBeNull();
  // T3 waits on T1 first. The pool still fits its own stages.
  expect(byTask.get(t3)?.first).toMatchObject({ kind: "dependency", waitingOn: [{ taskId: t1, title: "Alpha parser" }] });
  // T2 is the task the pool cannot fund, and says which pool, window and unit.
  const own = byTask.get(t2)!.first!;
  expect(own.kind).toBe("quota-shortfall");
  expect(own.pool).toMatchObject({ shared: true, unit: { kind: "money", currency: "USD" }, remaining: balance, knownDemand: total, shortfall: total - balance });
  expect(own.stageKind).not.toBeNull();
  expect(result.firstConstraint).toEqual({ taskId: t2, kind: "quota-shortfall" });
  // A forecast is not an authorization: the start approval blocker stays and no date is promised.
  expect(result.blockers).toContain("start-approval");
  expect(result.blockers).toContain("capacity");
  expect(result.completionWindow).toBeNull();
});

test("previewing the independent alternative moves T2 off the shared pool without changing anything stored", () => {
  const before = snapshot();
  const base = forecast(selection, now);
  const option = base.estimates.find(e => e.taskId === t2)!.developerOptions.find(o => o.accountId === d.accountId && o.modelId === model)!;
  expect(option.eligibility).toBe("eligible");
  const preview = forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(option) } }, now);
  const cmp = preview.comparison!;
  expect(cmp.changed).toEqual({ harness: true, account: true, model: false, mode: false });
  expect(cmp.current?.accountId).toBe(b.accountId);
  expect(cmp.proposed?.accountId).toBe(d.accountId);
  const shared = cmp.pools.find(pool => pool.shared)!;
  expect(shared.current).toMatchObject({ status: "insufficient", knownDemand: total });
  expect(shared.proposed).toMatchObject({ status: "fits", knownDemand: alphaOnly });
  expect(shared.knownDemandDelta).toBe(alphaOnly - total);
  const independent = cmp.pools.find(pool => pool.accountIds.includes(d.accountId))!;
  expect(independent.current).toBeNull(); // the pool was not charged before
  expect(independent.proposed).toMatchObject({ status: "fits", unknownStages: 0 });
  expect(independent.knownDemandDelta).toBeNull(); // no baseline to subtract from
  expect(cmp.affected.map(row => row.taskId)).toContain(t2);
  expect(cmp.affected.find(row => row.taskId === t2)).toMatchObject({ current: { kind: "quota-shortfall" }, proposed: { kind: "busy-slot", resources: ["global"] } });
  expect(cmp.cost.reason).toBeNull();
  expect(cmp.cost.delta?.currency).toBe("USD");
  // The shortfall is gone, so the schedule no longer rests on an unresolved pool.
  expect(preview.blockers).not.toContain("capacity");
  expect(cmp.elapsed.reason).toBe("capacity-unresolved"); // the CURRENT side was unresolved
  expect(cmp.completionWindow).toMatchObject({ current: null, proposed: null });
  expect(cmp.completionWindow.blockers).toContain("start-approval");
  expect(snapshot()).toEqual(before);
});

test("an eligible alternative with Unknown capacity is distinguished from a known shortfall", () => {
  const before = snapshot();
  const base = forecast(selection, now);
  const option = base.estimates.find(e => e.taskId === t2)!.developerOptions.find(o => o.accountId === c.accountId && o.modelId === model)!;
  expect(option.eligibility).toBe("eligible");
  // The recorded refusal is shown beside the candidate and never changes its eligibility or rank.
  expect(base.candidateRefusals[optionKey(option)]).toMatchObject({ kind: "usage-limit", accountId: c.accountId });
  const preview = forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(option) } }, now);
  const cmp = preview.comparison!;
  expect(cmp.changed.account).toBe(true);
  const first = preview.constraints.find(item => item.taskId === t2)!.first!;
  expect(first.kind).toBe("quota-unknown");
  expect(first.reason).toBe("no-quota-evidence");
  expect(preview.blockers).toContain("capacity");
  expect(cmp.affected.find(row => row.taskId === t2)).toMatchObject({ proposed: { kind: "quota-unknown" } });
  // Unknown is not a number: no demand delta, and the schedule difference is withheld.
  expect(cmp.elapsed.delta).toBeNull();
  expect(cmp.elapsed.reason).toBe("capacity-unresolved");
  expect(cmp.cost.reason).toBeNull(); // C has recorded price and history, so only its capacity is Unknown
  expect(preview.completionWindow).toBeNull();
  // With the Owner's explicit assumption the schedule resolves, and the assumption is echoed back as one.
  const assumed = forecast({ ...selection, save: false, alternative: { taskId: t2, optionKey: optionKey(option) }, assumptions: { unknownCapacity: true, startAuthorized: true } }, now);
  expect(assumed.comparison!.assumptions).toMatchObject({ unknownCapacity: true, startAuthorized: true });
  expect(snapshot()).toEqual(before);
});

test("the refusal changes neither selection nor ranking", () => {
  const withRefusal = forecast(selection, now);
  db.run("UPDATE provider_refusal_observations SET superseded_at = ?", [now]);
  const without = forecast(selection, now);
  db.run("UPDATE provider_refusal_observations SET superseded_at = NULL");
  const strip = (result: typeof withRefusal) => result.estimates.map(e => ({
    selected: e.developer && optionKey(e.developer), options: e.developerOptions.map(optionKey),
    eligibility: e.developerOptions.map(o => o.eligibility), worker: e.worker, completion: e.completion,
  }));
  expect(strip(withRefusal)).toEqual(strip(without));
  expect(Object.keys(without.candidateRefusals)).toEqual([]);
});

test("a preview never applies a proposal; approval stays digest-bound and a changed plan carries nothing over", async () => {
  const base = forecast(selection, now);
  const option = base.estimates.find(e => e.taskId === t2)!.developerOptions.find(o => o.accountId === d.accountId)!;
  const alternative = { taskId: t2, optionKey: optionKey(option) };
  forecast({ ...selection, save: false, alternative }, now);
  expect(db.query("SELECT COUNT(*) AS n FROM allocation_plans").get()).toEqual({ n: 0 });
  // The separate Review path is the only thing that writes a proposal, and it still selects nothing.
  const response = await usageAnalyticsHttp(new Request("http://localhost/api/usage-analytics/fallback-proposal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alternative),
  }), true);
  expect(response!.status).toBe(201);
  const proposal = await response!.json() as { record: { id: string; status: string }; planDigest: string };
  expect(proposal.record.status).toBe("proposed");
  expect(tasks.get(t2)?.agent).toBe(b.harnessId);
  expect(() => approveAllocationPlan(proposal.record.id, "0".repeat(64))).toThrow();
  expect(tasks.get(t2)?.agent).toBe(b.harnessId);
  await expect(applyAllocationPlan(proposal.record.id, proposal.planDigest)).rejects.toThrow(); // not approved yet
  const approved = approveAllocationPlan(proposal.record.id, proposal.planDigest);
  expect(approved.record.status).toBe("approved");
  expect(tasks.get(t2)?.agent).toBe(b.harnessId); // approval alone selects nothing
  expect(runs.countForTask(t2)).toBe(0);
  // The task changes after approval: the approved digest no longer applies.
  db.run("UPDATE tasks SET prompt = prompt || ' More.' WHERE id = ?", [t2]);
  await expect(applyAllocationPlan(proposal.record.id, approved.record.approvedDigest!)).rejects.toThrow();
  expect(tasks.get(t2)?.agent).toBe(b.harnessId);
  expect(runs.countForTask(t2)).toBe(0);
});

test("a new quota reading after the alternative was reviewed makes the review stale: approval and apply are refused and nothing is selected", async () => {
  const base = forecast(selection, now);
  const option = base.estimates.find(e => e.taskId === t2)!.developerOptions.find(o => o.accountId === d.accountId)!;
  const alternative = { taskId: t2, optionKey: optionKey(option) };
  const propose = async () => usageAnalyticsHttp(new Request("http://localhost/api/usage-analytics/fallback-proposal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alternative),
  }), true);
  const first = await (await propose())!.json() as { record: { id: string; status: string; plan: { forecastChange: { evidenceKey: string } } }; planDigest: string; canApprove: boolean };
  expect(first.record.plan.forecastChange.evidenceKey).toMatch(/^[0-9a-f]{64}$/);
  expect(first.canApprove).toBe(true);
  const agentBefore = tasks.get(t2)?.agent;
  // A newer reading for the proposed account arrives after the Owner reviewed the comparison.
  const definition = db.query<{ id: string }, [string]>("SELECT id FROM quota_definitions WHERE account_id = ? LIMIT 1").get(d.accountId)!;
  observePool(core, definition.id, d.accountId, "independent", 40_000_000, null, Date.now());
  expect(() => approveAllocationPlan(first.record.id, first.planDigest)).toThrow("Quota evidence changed");
  expect(tasks.get(t2)?.agent).toBe(agentBefore);
  expect(runs.countForTask(t2)).toBe(0);
  // Reviewing again binds the new evidence and is a new proposal with its own digest.
  const second = await (await propose())!.json() as { record: { id: string }; planDigest: string; canApprove: boolean };
  expect(second.record.id).not.toBe(first.record.id);
  expect(second.canApprove).toBe(true);
  const approved = approveAllocationPlan(second.record.id, second.planDigest);
  expect(approved.record.status).toBe("approved");
  expect(tasks.get(t2)?.agent).toBe(agentBefore); // approval alone selects nothing
  // A reading arriving after approval refuses the apply as well.
  observePool(core, definition.id, d.accountId, "independent", 30_000_000, null, Date.now());
  await expect(applyAllocationPlan(second.record.id, approved.record.approvedDigest!)).rejects.toThrow();
  expect(tasks.get(t2)?.agent).toBe(agentBefore);
  expect(runs.countForTask(t2)).toBe(0);
});
