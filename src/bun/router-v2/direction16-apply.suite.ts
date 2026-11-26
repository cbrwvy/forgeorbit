/**
 * Direction 16 — the plan-apply boundary.
 * POST /api/router-v2/plans/apply receives the plan from the client. A plan is a recommendation:
 * it must not be able to rewrite a task unless the server can still stand behind every slot.
 * Fake drivers and synthetic Codex profiles only. No provider call, no inference.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import { DEFAULT_ROUTER_POLICY } from "../../shared/router-v2/types.ts";
import { computePlanDigest, planMultiProjectAllocation } from "../../shared/router-v2/multi-project-planner.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-direction16-apply-")));
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const { db, harnesses, projects, tasks } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { createTask } = await import("../orchestrator.ts");
const { routerV2Service } = await import("./router-v2-service.ts");
const { writeExecutionMeta } = await import("../multiaccount/registry.ts");

harnesses.setEnabled("codex", true);
const profiles = new CodexProfiles(new AccountCore(db));
const model = "gpt-6.1-sol";
const account = (name: string) => {
  const directory = path.join(home, name);
  writeSyntheticCodexProfile(directory, `synthetic-${name}`);
  return profiles.register({ displayName: name, directory: realpathSync(directory) });
};
const A = account("apply-a");
const B = account("apply-b");
const projectPath = path.join(root, "project");
mkdirSync(projectPath);
projects.upsert(projectPath, "Apply boundary");

async function taskOn(title: string, harnessId: string) {
  const created = await createTask({ title, prompt: "Synthetic.", workdir: projectPath, column: "ready", agent: harnessId, model, mode: "auto", isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

/** A plan the way the Owner gets one: issued by the service, which remembers its digest. */
async function issuedPlanFor(taskIds: string[], accountId: string) {
  const candidates = routerV2Service.gatherCandidatesSync("developer").filter(row => row.accountId === accountId && row.modelId === model);
  return routerV2Service.planMultiProject([{ projectPath, taskIds }], { candidatesMap: new Map(taskIds.map(id => [id, candidates])) });
}

/** A plan the planner function made but the service never issued. */
function planFor(taskIds: string[], accountId: string) {
  const candidates = routerV2Service.gatherCandidatesSync("developer").filter(row => row.accountId === accountId && row.modelId === model);
  return planMultiProjectAllocation(
    taskIds.map(taskId => ({
      projectPath, projectPriority: "normal" as const,
      task: { taskId, projectId: projectPath, title: taskId, type: "general" as const, complexity: "low" as const, role: "developer" as const },
      candidates,
    })),
    { ...DEFAULT_ROUTER_POLICY, scopeId: projectPath },
  );
}

const settings = (taskId: string) => { const t = tasks.get(taskId)!; return [t.agent, t.model, t.mode]; };
/** Everything a refused apply could have touched: task settings, runs, reservations, account preferences, decisions, missions. */
const fingerprint = () => JSON.stringify(["tasks", "runs", "orchestration_reservations", "project_account_preferences", "router_v2_decisions", "orchestration_missions"]
  .map((table) => [table, db.query(`SELECT * FROM ${table}`).all()]));

test("a plan whose contents do not match its digest is refused and changes nothing", async () => {
  const taskId = await taskOn("Forged contents", A.harnessId);
  const plan = await issuedPlanFor([taskId], B.accountId);
  const before = fingerprint();
  const forged = structuredClone(plan);
  forged.slots[0]!.selectedCandidate!.harnessId = "codex";
  forged.slots[0]!.selectedCandidate!.modelId = "gpt-6-astra";
  const result = routerV2Service.applyPlan(forged, forged.planDigest, { recheck: true });
  expect(result.success).toBe(false);
  expect(result.errors.join(" ")).toContain("do not match its digest");
  expect(fingerprint()).toBe(before);
});

test("a plan the client re-signed for a blocked provider is refused (never issued)", async () => {
  const taskId = await taskOn("Re-signed plan", A.harnessId);
  const plan = planFor([taskId], B.accountId);
  const before = fingerprint();
  const forged = structuredClone(plan);
  forged.slots[0]!.selectedCandidate!.harnessId = "cursor";
  forged.slots[0]!.selectedCandidate!.kind = "cursor";
  forged.planDigest = computePlanDigest(forged);
  const result = routerV2Service.applyPlan(forged, forged.planDigest, { recheck: true });
  expect(result.success).toBe(false);
  expect(result.errors.join(" ")).toContain("was not issued");
  expect(fingerprint()).toBe(before);
});

test("an approved plan applies once; replaying it is refused", async () => {
  const taskId = await taskOn("Replay", A.harnessId);
  const plan = await issuedPlanFor([taskId], B.accountId);
  const first = routerV2Service.applyPlan(plan, plan.planDigest, { recheck: true });
  expect(first.errors).toEqual([]);
  expect(first.success).toBe(true);
  expect(settings(taskId)[0]).toBe(B.harnessId);
  // The plan is sent again, even with its status reset by the client.
  db.run("UPDATE tasks SET agent = ? WHERE id = ?", [A.harnessId, taskId]);
  const again = structuredClone(plan);
  again.status = "proposed";
  const replay = routerV2Service.applyPlan(again, again.planDigest, { recheck: true });
  expect(replay.success).toBe(false);
  expect(replay.errors.join(" ")).toContain("already applied");
  expect(settings(taskId)[0]).toBe(A.harnessId);
});

test("a stage that became ineligible, or a task that is running, refuses the whole plan: no partial apply", async () => {
  const first = await taskOn("Atomic first", A.harnessId);
  const second = await taskOn("Atomic second", A.harnessId);
  const plan = await issuedPlanFor([first, second], B.accountId);
  const before = fingerprint();
  // The second task is running now.
  db.run("UPDATE tasks SET \"column\" = 'running' WHERE id = ?", [second]);
  const live = routerV2Service.applyPlan(plan, plan.planDigest, { recheck: true });
  expect(live.success).toBe(false);
  expect(live.errors.join(" ")).toContain("running");
  db.run("UPDATE tasks SET \"column\" = 'ready' WHERE id = ?", [second]);
  expect(fingerprint()).toBe(before);
  // The account was disabled after review: every slot is refused, not just the affected one.
  writeExecutionMeta(db, B.accountId, { disabled: true });
  const gone = routerV2Service.applyPlan(plan, plan.planDigest, { recheck: true });
  writeExecutionMeta(db, B.accountId, { disabled: false });
  expect(gone.success).toBe(false);
  expect(gone.errors.join(" ")).toMatch(/no longer eligible|not eligible/);
  expect(settings(first)[0]).toBe(A.harnessId);
  expect(settings(second)[0]).toBe(A.harnessId);
});

test("a plan changed to a different still-eligible resource and re-signed was never issued, so it is refused", async () => {
  const taskId = await taskOn("Re-signed eligible", A.harnessId);
  const issued = await issuedPlanFor([taskId], B.accountId);
  expect(issued.slots[0]!.selectedCandidate?.accountId).toBe(B.accountId);
  const candidates = routerV2Service.gatherCandidatesSync("developer");
  const other = routerV2Service.evaluateTaskSync({ taskId, projectId: projectPath, role: "developer" }, { candidates })
    .eligible.find(row => row.accountId === A.accountId && row.modelId === model)!;
  expect(other).toBeTruthy();
  // Still eligible, different from what was issued, and the client recomputed the digest over the new contents.
  const altered = structuredClone(issued);
  altered.slots[0]!.selectedCandidate = other;
  altered.planDigest = computePlanDigest(altered);
  expect(altered.planDigest).not.toBe(issued.planDigest);
  const before = fingerprint();
  const refused = routerV2Service.applyPlan(altered, altered.planDigest, { recheck: true });
  expect(refused.success).toBe(false);
  expect(refused.errors.join(" ")).toContain("was not issued");
  expect(fingerprint()).toBe(before);
  // The issued plan itself is still applicable, and applies exactly what was issued.
  const ok = routerV2Service.applyPlan(issued, issued.planDigest, { recheck: true });
  expect(ok.errors).toEqual([]);
  expect(settings(taskId)[0]).toBe(B.harnessId);
});

test("a plan the service never issued is refused at the boundary even when it is untouched and eligible", async () => {
  const taskId = await taskOn("Never issued", A.harnessId);
  const direct = planFor([taskId], B.accountId);
  const before = fingerprint();
  const result = routerV2Service.applyPlan(direct, direct.planDigest, { recheck: true });
  expect(result.success).toBe(false);
  expect(result.errors.join(" ")).toContain("was not issued");
  // The check is the default of the service, not something a caller has to remember to ask for.
  const byDefault = routerV2Service.applyPlan(direct, direct.planDigest);
  expect(byDefault.success).toBe(false);
  expect(byDefault.errors.join(" ")).toContain("was not issued");
  expect(fingerprint()).toBe(before);
});

test("a task whose resource belongs to a profile, a pipeline or an authorized mission is not changed by a plan", async () => {
  const bound = await taskOn("Profile-bound", A.harnessId);
  const inMission = await taskOn("Mission-managed", A.harnessId);
  db.run("UPDATE tasks SET agent_profile_id = ? WHERE id = ?", ["profile-1", bound]);
  const { missionStore } = await import("../orchestration/mission-store.ts");
  const { computeMissionPlanDigest } = await import("../../shared/orchestration/plan-digest.ts");
  const missionPlan = {
    clusters: [], projects: [projectPath], concurrencyLimits: { globalMax: 1, perProjectMax: 1, perAccountMax: 1 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: [{ taskId: inMission, taskTitle: "Mission-managed", projectPath, specialistRole: "developer" as const, phase: "authorized" as const, priority: "normal" as const,
      dependencies: [], harnessId: A.harnessId, modelId: model, accountId: A.accountId, mode: "auto", qcRequired: false }],
  };
  missionStore.createMission({ title: "Holds a task", goal: "x", status: "authorized", projects: [projectPath], clusters: [], plan: missionPlan, planDigest: computeMissionPlanDigest(missionPlan) });
  for (const [label, id, needle] of [["profile", bound, "agent"], ["mission", inMission, "mission"]] as const) {
    const plan = await issuedPlanFor([id], B.accountId);
    const before = fingerprint();
    const result = routerV2Service.applyPlan(plan, plan.planDigest, { recheck: true });
    expect(result.success, label).toBe(false);
    expect(result.errors.join(" ").toLowerCase(), label).toContain(needle);
    expect(fingerprint(), label).toBe(before);
  }
});

test("no production code applies a plan without the checks: the only caller is the HTTP route and nothing opts out", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const repo = path.resolve(import.meta.dir, "../../..");
  const sources = walk(path.join(repo, "src")).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.(test|suite)\.tsx?$/.test(file));
  const callers = sources.filter((file) => /\.applyPlan\(/.test(readFileSync(file, "utf8")));
  expect(callers.map((file) => path.relative(repo, file)).sort()).toEqual(["src/bun/router-v2/router-v2-http.ts"]);
  // The service documents the option; every other production file must not use it.
  for (const file of sources.filter((file) => !file.endsWith("router-v2-service.ts"))) expect(readFileSync(file, "utf8"), file).not.toMatch(/recheck:\s*false/);
});
