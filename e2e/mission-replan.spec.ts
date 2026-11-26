import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { gotoApp, openExecutionPlans } from "./helpers";
import { seedAtomicReplanFixture, seedMissionReplanFixture } from "../scripts/qa-forecast-replan01-fixture";
import { writeCodexProfileFixture } from "./codex-profile-fixture";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "fo-mission-replan-e2e-")));
const profileHome = join(scratch, "home");
mkdirSync(profileHome);
test.use({ backendEnv: { HOME: profileHome, AGETOR_CODEX_BIN: writeCodexProfileFixture(scratch, process.execPath) } });

test("Owner rejects and approves exact Reviewer revisions in Mission Control", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(60_000);
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const call = async (method: string, route: string, data?: unknown, status = 200) => {
    const response = await request.fetch(backend.apiBase + route, { method, headers, data });
    expect(response.status(), await response.text()).toBe(status);
    return status === 204 ? null : await response.json();
  };
  await call("PUT", "/preferences/locale", { value: "en" }, 204);
  const { task, mission, replacement: b, model } = await seedMissionReplanFixture(call, backend.dataDir, profileHome);
  using db = new Database(join(backend.dataDir, "agetor.sqlite"), { readonly: true });

  await gotoApp(page, backend.bootBase);
  await openExecutionPlans(page);
  const panel = page.getByTestId("mission-replan");
  await expect(panel).toContainText("Mission resource replanning · #1");
  await panel.getByTestId("mission-replan-task").selectOption(task.id);
  const replacement = panel.getByTestId("mission-replan-resource");
  await expect(replacement.getByRole("option", { name: /Replacement fixture/ })).toHaveCount(1);
  await replacement.selectOption(await replacement.getByRole("option", { name: /Replacement fixture/ }).getAttribute("value") ?? "");
  await panel.getByRole("textbox", { name: "Reason for reauthorization" }).fill("Keep the recorded implementation");
  await panel.getByRole("button", { name: "Prepare resource proposal" }).click();
  await expect(panel.getByTestId("mission-resource-review")).toContainText("reviewer-fixture-dev");
  await panel.getByRole("button", { name: "Reject resource proposal" }).click();
  await expect(panel.getByText("Resource proposal · #2 · Rejected")).toBeVisible();
  expect((await call("GET", `/api/orchestration/missions/${mission.id}`)).mission.planDigest).toBe(mission.planDigest);
  await panel.getByRole("button", { name: "Prepare resource proposal" }).click();
  await panel.getByRole("button", { name: "Approve exact revision" }).click();
  await expect(panel).toContainText("Mission resource replanning · #2");
  const { mission: updated } = await call("GET", `/api/orchestration/missions/${mission.id}`);
  expect(updated.plan.tasks[0].reviewerBinding).toMatchObject({ accountId: b.accountId, modelId: model, mode: "ask" });
  expect(updated.plan.tasks[0].runId).toBe("reviewer-fixture-dev");
  expect(db.query("SELECT id FROM runs").all()).toEqual([{ id: "reviewer-fixture-dev" }]);
  await panel.getByRole("button", { name: "Stage schedule" }).click();
  await expect(panel.getByTestId("usage-stage-schedule")).toBeVisible();
  await call("PUT", "/preferences/locale", { value: "ru" }, 204);
  await page.reload();
  await openExecutionPlans(page);
  await expect(panel).toContainText("Перепланирование ресурсов миссии · #2");
  await page.getByTestId("resume-mission-button").click();
  await expect.poll(() => db.query<{ agent: string }, []>("SELECT agent FROM runs WHERE qc_review_id IS NOT NULL").all(),
    { timeout: 20_000 }).toEqual([{ agent: b.harnessId }]);
  await expect.poll(() => db.query<{ status: string }, []>("SELECT status FROM runs WHERE qc_review_id IS NOT NULL").get()?.status)
    .not.toBe("running");
  expect(db.query("SELECT id FROM runs WHERE qc_review_id IS NULL").all()).toEqual([{ id: "reviewer-fixture-dev" }]);
  const reviewRun = db.query<{ id: string; status: string }, []>("SELECT id,status FROM runs WHERE qc_review_id IS NOT NULL").get()!;
  expect(reviewRun.status, JSON.stringify(db.query<{ data: string }, [string]>(
    "SELECT data FROM run_events WHERE run_id = ? AND stream IN ('stderr', 'status') ORDER BY id DESC LIMIT 6",
  ).all(reviewRun.id))).toBe("succeeded");
  const identity = db.query<{ data: string }, [string]>(
    `SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%"kind":"execution-identity"%'`,
  ).get(reviewRun.id);
  expect(JSON.parse(identity!.data)).toMatchObject({ executionType: "synthetic", accountProfile: { id: b.accountId }, mode: "ask" });
  await expect.poll(async () => (await call("GET", `/api/orchestration/missions/${mission.id}`)).mission.plan.tasks[0].phase)
    .toBe("awaiting_owner");
  await call("PATCH", `/tasks/${task.id}`, { column: "done" });
  await expect.poll(async () => (await call("GET", `/api/orchestration/missions/${mission.id}`)).mission.status).toBe("completed");
});

test("Owner approves one Head proposal that amends two remaining Developer stages", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(60_000);
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const call = async (method: string, route: string, data?: unknown, status = 200) => {
    const response = await request.fetch(backend.apiBase + route, { method, headers, data });
    expect(response.status(), await response.text()).toBe(status);
    return status === 204 ? null : await response.json();
  };
  await call("PUT", "/preferences/locale", { value: "en" }, 204);
  const { tasks, mission, replacement, model, projectPath } = await seedAtomicReplanFixture(call, backend.dataDir, profileHome);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey },
  });
  const changes = [];
  for (const task of tasks) {
    const options = await call("GET", `/api/orchestration/missions/${mission.id}/resource-options?role=developer&taskId=${task.id}`);
    const option = options.options.find((row: { accountId: string; modelId: string }) => row.accountId === replacement.accountId && row.modelId === model);
    expect(option?.resource).toBeTruthy();
    changes.push({ taskId: task.id, role: "developer", resource: option.resource });
  }
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("head-pm-orb").click();
  const composer = page.getByTestId("head-pm-composer");
  await composer.fill(`__fake_head_board__ ${JSON.stringify({
    kind: "replan_mission", missionId: mission.id, projectPath, taskId: tasks[0]!.id,
    role: "developer", ...changes[0]!.resource, reason: "Move both remaining Developer stages together", changes,
  })}`);
  await page.getByTestId("head-pm-send").click();
  const card = page.getByTestId("head-pm-board-proposal");
  await expect(card).toHaveAttribute("data-status", "pending");
  await expect(card.getByTestId("mission-replan-stage")).toHaveCount(2);
  await expect(card).toContainText(replacement.accountId);
  await expect(card).toContainText("project-bound");
  await card.getByTestId("head-pm-board-approve").click();
  await expect(card).toHaveAttribute("data-status", "applied");
  const { mission: updated } = await call("GET", `/api/orchestration/missions/${mission.id}`);
  expect(updated.revision).toBe(2);
  for (const row of updated.plan.tasks) {
    expect(row.developerBinding).toMatchObject({ accountId: replacement.accountId, modelId: model, mode: "auto" });
  }
  const board = await call("GET", "/tasks");
  const listed = Array.isArray(board) ? board : board.tasks;
  expect(listed).toEqual(expect.arrayContaining(tasks.map(task => expect.objectContaining({ id: task.id, column: "ready" }))));
  await openExecutionPlans(page);
  await expect(page.getByTestId("mission-replan")).toContainText("Mission resource replanning · #2");
  await page.getByRole("button", { name: "Stage schedule" }).click();
  await expect(page.getByTestId("usage-stage-schedule")).toBeVisible();
  await call("PUT", "/preferences/locale", { value: "ru" }, 204);
  await page.reload();
  await page.getByTestId("head-pm-orb").click();
  await expect(page.getByTestId("head-pm-board-proposal")).toContainText("Одно одобрение применяет все этапы ниже");
});
