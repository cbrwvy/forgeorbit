import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { makeTask } from "../cli/test-fixtures.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-routing03-unit-")));
process.env.HOME = path.join(root, "owner");
mkdirSync(process.env.HOME);
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_USAGE_OFFLINE = "1";

const { db, tasks, projects, harnesses } = await import("./db.ts");
const { CodexProfiles } = await import("./codex-profiles.ts");
const { AccountCore } = await import("./account-core.ts");
const { EmployeeCore } = await import("./employee-core.ts");
const { AssignmentCore } = await import("./assignment-core.ts");
const plans = await import("./allocation-plans.ts");
const { allocationPlanHttp } = await import("./allocation-http.ts");

const core = new AccountCore(db);
const profiles = new CodexProfiles(core);
const project = path.join(root, "project");
mkdirSync(project);
projects.upsert(project, "Allocation fixture");
const dev = new EmployeeCore(db).createWorker({ name: "Dev A", jobTitle: "Developer", projectPath: project });
let seq = 0;
function addProfile() {
  const directory = path.join(process.env.HOME!, `profile-${++seq}`);
  writeSyntheticCodexProfile(directory, `fixture-${seq}`);
  const p = profiles.register({ displayName: `Profile ${seq}`, directory });
  db.run("INSERT INTO account_model_capabilities VALUES (?, ?, ?, ?)", [
    p.accountId,
    p.harnessId,
    "gpt-6.1-sol",
    JSON.stringify({
      accountId: p.accountId,
      harnessId: p.harnessId,
      modelId: "gpt-6.1-sol",
      support: "supported",
      verification: "verified",
      provenance: "verified",
      source: "offline:fo-routing03",
      observedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    }),
  ]);
  return p;
}

const deps = { layout: async () => ({ layout: "non-git" as const, predicted: false }), cli: () => ({ available: true, loggedIn: null }) };

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test.serial("proposal creates no runs or grants; two Codex profiles stay distinct", async () => {
  const a = addProfile();
  const b = addProfile();
  await profiles.check(a.accountId);
  await profiles.check(b.accountId);
  const t1 = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: a.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  const t2 = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: b.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  new AssignmentCore(db).assign(t1.id, dev.id);
  new AssignmentCore(db).assign(t2.id, dev.id);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw Error("No probes");
  });
  try {
    const beforeRuns = db.query("SELECT count(*) AS n FROM runs").get() as { n: number };
    const view = await plans.createAllocationPlanProject({ projectPath: project, taskIds: [t1.id, t2.id], deps });
    expect(view.record.status).toBe("proposed");
    expect(view.record.plan.projects[0]!.tasks).toHaveLength(2);
    const accounts = view.record.plan.projects[0]!.tasks.map((row) => row.developer?.accountId);
    expect(new Set(accounts)).toEqual(new Set([a.accountId, b.accountId]));
    expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual(beforeRuns);
    expect(db.query("SELECT count(*) AS n FROM pm_orchestrated_workflows").get()).toEqual({ n: 0 });
  } finally {
    spawn.mockRestore();
  }
});

test.serial("approve bound to digest; apply updates tasks without starting runs", async () => {
  const a = addProfile();
  await profiles.check(a.accountId);
  const task = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: a.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  new AssignmentCore(db).assign(task.id, dev.id);
  const proposed = await plans.createAllocationPlanProject({ projectPath: project, taskIds: [task.id], deps });
  const recalc = await plans.recalculateAllocationPlan(proposed.record.id, deps);
  const approved = plans.approveAllocationPlan(recalc.record.id, recalc.planDigest);
  expect(approved.record.status).toBe("approved");
  await plans.applyAllocationPlan(approved.record.id, approved.record.approvedDigest!);
  const updated = tasks.get(task.id)!;
  expect(updated.agent).toBe(a.harnessId);
  expect(updated.model).toBe("gpt-6.1-sol");
  expect(updated.mode).toBe("auto");
  const harness = harnesses.get(updated.agent)!;
  expect(harness.env?.CODEX_HOME).toBe(a.directory);
  const { resourceKey } = await import("./orchestrated-resources.ts");
  expect(recalc.record.plan.projects[0]!.tasks[0]!.developer!.resourceFingerprint).toBe(resourceKey(harness));
  expect(recalc.record.plan.projects[0]!.tasks[0]!.developer!.accountId).toBe(a.accountId);
  expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM pm_orchestrated_workflows").get()).toEqual({ n: 0 });
});

test.serial("changed fingerprint blocks stale apply", async () => {
  const a = addProfile();
  await profiles.check(a.accountId);
  const task = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: a.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  const view = await plans.createAllocationPlanProject({ projectPath: project, taskIds: [task.id], deps });
  const approved = plans.approveAllocationPlan(view.record.id, view.planDigest);
  harnesses.update(a.harnessId, { env: { CODEX_HOME: path.join(process.env.HOME!, "other") } });
  const stale = plans.getAllocationPlan(approved.record.id)!;
  expect(stale.canApply).toBe(false);
  expect(() => plans.applyAllocationPlan(approved.record.id, approved.record.approvedDigest!)).toThrow();
});

test.serial("HTTP routes require auth and reject wrong digest", async () => {
  expect((await allocationPlanHttp(new Request("http://localhost/allocation-plans/policy"), false)).status).toBe(401);
  const ok = await allocationPlanHttp(
    new Request("http://localhost/allocation-plans/project", {
      method: "POST",
      body: JSON.stringify({ projectPath: project, taskIds: [] }),
    }),
    true,
  );
  expect(ok.status).toBe(400);
});

test.serial("recalculate keeps an Owner resource replacement", async () => {
  const a = addProfile();
  const b = addProfile();
  await profiles.check(a.accountId);
  await profiles.check(b.accountId);
  const task = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: a.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  const view = await plans.createAllocationPlanProject({ projectPath: project, taskIds: [task.id], deps });
  const replacement = Object.values((await (await import("./executor-recommendations.ts")).recommendExecutors({ taskId: task.id, harnessId: b.harnessId, model: "gpt-6.1-sol", role: "developer", mode: "auto" }, deps)).recommendations.groups).flat().find((o) => o.harnessId === b.harnessId && o.modelId === "gpt-6.1-sol");
  if (!replacement) throw new Error("missing replacement");
  plans.patchAllocationTaskResource(view.record.id, task.id, replacement);
  const again = await plans.recalculateAllocationPlan(view.record.id, deps);
  expect(again.record.plan.projects[0]!.tasks[0]!.developer?.accountId).toBe(b.accountId);
  expect(again.record.status).toBe("proposed");
  expect(again.record.approvedDigest).toBeNull();
});

test.serial("digest mismatch, duplicate approval, partial apply and frozen batch stay explicit", async () => {
  const a = addProfile();
  await profiles.check(a.accountId);
  const task = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: a.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  const view = await plans.createAllocationPlanProject({ projectPath: project, taskIds: [task.id], deps });
  expect(() => plans.approveAllocationPlan(view.record.id, "0".repeat(64))).toThrow(/digest/i);
  const approved = plans.approveAllocationPlan(view.record.id, view.planDigest);
  expect(() => plans.approveAllocationPlan(view.record.id, view.planDigest)).toThrow(/not awaiting/i);
  const row = db.query<{ data_json: string }, [string]>("SELECT data_json FROM allocation_plans WHERE id = ?").get(approved.record.id)!;
  const parsed = JSON.parse(row.data_json);
  parsed.plan.projects[0].tasks[0].developer.selectable = false;
  parsed.plan.projects[0].tasks[0].blockers = ["blocked-for-test"];
  const { allocationPlanDigest } = await import("../shared/allocation/digest.ts");
  const digest = allocationPlanDigest(parsed.plan);
  parsed.planDigest = digest;
  parsed.approvedDigest = digest;
  db.run("UPDATE allocation_plans SET data_json = ?, plan_digest = ?, approved_digest = ? WHERE id = ?", [JSON.stringify(parsed), digest, digest, approved.record.id]);
  await expect(plans.applyAllocationPlan(approved.record.id, digest)).rejects.toThrow(/blocked/);
  const partial = plans.getAllocationPlan(approved.record.id)!;
  expect(partial.record.status).toBe("partial");
  parsed.plan.projects[0].batchFrozen = true;
  parsed.status = "approved";
  parsed.planDigest = allocationPlanDigest(parsed.plan);
  parsed.approvedDigest = parsed.planDigest;
  db.run("UPDATE allocation_plans SET data_json = ?, status = 'approved', plan_digest = ?, approved_digest = ? WHERE id = ?", [JSON.stringify(parsed), parsed.planDigest, parsed.approvedDigest, approved.record.id]);
  expect(plans.getAllocationPlan(approved.record.id)!.canApply).toBe(false);
});

test.serial("requested reviewer model is the proposed model, and changing it drops the approval", async () => {
  const a = addProfile();
  const b = addProfile();
  const task = tasks.insert(makeTask({ id: crypto.randomUUID(), workdir: project, column: "ready", agent: a.harnessId, model: "gpt-6.1-sol", mode: "auto", isolation: "none" }));
  new AssignmentCore(db).assign(task.id, dev.id);
  const view = await plans.createAllocationPlanProject({
    projectPath: project,
    taskIds: [task.id],
    reviewerHarnessId: b.harnessId,
    reviewerModel: "gpt-6.1-sol",
    reviewerMode: "ask",
    deps,
  });
  const reviewer = view.record.plan.projects[0]!.reviewer.reviewer;
  expect(reviewer?.modelId).toBe("gpt-6.1-sol");
  expect(reviewer?.harnessId).toBe(b.harnessId);
  expect(reviewer?.accountId).toBe(b.accountId);
  expect(reviewer?.accountId).not.toBe(a.accountId);
  const approved = plans.approveAllocationPlan(view.record.id, view.planDigest);
  expect(approved.record.approvedDigest).toBe(view.planDigest);
  const recalculated = await plans.recalculateAllocationPlan(view.record.id, deps, {
    reviewerHarnessId: b.harnessId,
    reviewerModel: "gpt-5",
    reviewerMode: "ask",
  });
  expect(recalculated.record.status).toBe("proposed");
  expect(recalculated.record.approvedDigest).toBeNull();
  expect(recalculated.record.plan.projects[0]!.reviewer.reviewer?.modelId).toBe("gpt-5");
  expect(recalculated.record.plan.projects[0]!.reviewer.reviewer?.accountId).toBe(b.accountId);
  expect(() => plans.approveAllocationPlan(view.record.id, view.planDigest)).toThrow(/digest/i);
});
