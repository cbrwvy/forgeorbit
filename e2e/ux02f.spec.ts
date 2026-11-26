import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-UX02-F: final complex-screen polish. Pipeline editor toolbar keeps Save
 * on the first row and warns at a narrow width; Environment's single primary
 * action; Batch/Autonomy shows Manual vs Bounded, the Run count vs the
 * provider quota (Unknown is never "exhausted"). No AI turn is started here.
 */
const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}`, "content-type": "application/json" });
test.use({ backendEnv: { AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo", AGETOR_CURSOR_BIN: "/nonexistent/cursor-agent" } });
test.describe.configure({ mode: "serial" });

async function seed(request: import("@playwright/test").APIRequestContext, b: E2EBackend) {
  const post = async (p: string, data: unknown) => {
    const r = await request.post(`${b.apiBase}${p}`, { headers: auth(b), data });
    if (!r.ok()) throw new Error(`${p} ${r.status()} ${await r.text()}`);
    return r.json();
  };
  await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
  const dir = await mkdtemp(path.join(tmpdir(), "ux02f-e2e-"));
  await writeFile(path.join(dir, "README.md"), "# Orbit\n");
  await post("/projects", { path: dir, name: "Orbit Notes" });
  const task = async (title: string) =>
    (await post("/tasks", { title, prompt: `${title}.\n\n## Acceptance criteria\n- It works`, workdir: dir, agent: "codex", model: "gpt-6.1-sol", isolation: "none", column: "backlog" })).id as string;
  const t1 = await task("Write the schema");
  const t2 = await task("Build the service");
  const batch = await post("/project-manager/batches", { path: dir, taskIds: [t1, t2], title: "Release batch", policy: { noOverageHarnessIds: ["codex"] } });
  await post(`/project-manager/batches/${batch.id}/approve`, { path: dir, revision: batch.revision, previewKey: batch.preview.key, acknowledgedHarnessIds: batch.preview.spendingHarnessIds });
  const p1 = (await post("/agent-profiles", { name: "Planner", harness: "claude-code", model: "opus-5", instructions: "", skills: [] })).id;
  const mk = (id: string, name: string, x: number) => ({ id, name, instructions: "", agentProfileId: p1, position: { x, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any" });
  await post("/pipelines", { name: "Plan then build", description: "d", maxSteps: 25, graph: { steps: [mk("s1", "Plan", 0), mk("s2", "Build", 320)], edges: [{ id: randomUUID(), from: "s1", to: "s2", label: "" }], startStepId: "s1" } });
  return dir;
}

test("pipeline editor: Save stays on the first toolbar row; narrow width shows a notice, wide does not", async ({ page, request, freshBackend: b }) => {
  await seed(request, b);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  await page.getByTestId("pipelines-button").click();
  await page.getByTestId("pipelines-edit").first().click();
  await expect(page.getByTestId("pipeline-editor")).toBeVisible();

  const main = page.getByTestId("pipeline-editor-toolbar-main");
  await expect(main.getByTestId("pipeline-save")).toBeVisible();
  await expect(main.getByTestId("pipeline-back")).toBeVisible();
  await expect(page.getByTestId("pipeline-editor-toolbar-tools").getByTestId("pipeline-add-step")).toBeVisible();
  const saveBox = await page.getByTestId("pipeline-save").boundingBox();
  const backBox = await page.getByTestId("pipeline-back").boundingBox();
  expect(Math.abs(saveBox!.y - backBox!.y)).toBeLessThan(8);
  await expect(page.getByTestId("pipeline-narrow-notice")).toBeHidden();

  await page.setViewportSize({ width: 760, height: 800 });
  await expect(page.getByTestId("pipeline-narrow-notice")).toBeVisible();
  // The page itself never scrolls horizontally.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // Nodes and edge text are at least 12px.
  const tiny = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="pipeline-step-node"] *')].filter((e) => e.childNodes.length && parseFloat(getComputedStyle(e).fontSize) < 12 && (e.textContent ?? "").trim() !== "").length);
  expect(tiny).toBe(0);
});

test("environment without a profile has one primary action", async ({ page, request, freshBackend: b }) => {
  const dir = await seed(request, b);
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  const create = page.getByTestId("environment-configure");
  await expect(create).toHaveText(/Create profile/);
  const bg = await create.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
});

test("batch and grant: status hint, Manual vs Bounded, provider quota is separate from run count", async ({ page, request, freshBackend: b }) => {
  const dir = await seed(request, b);
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-tab-autonomy").click();
  await page.getByText("Release batch", { exact: true }).first().click();
  await expect(page.getByTestId("batch-status")).toHaveText(/Approved/);
  await expect(page.getByTestId("batch-not-started")).toBeVisible();
  await expect(page.getByTestId("autonomy-section").getByTestId("autonomy-mode")).toHaveAttribute("data-mode", "manual");

  await page.getByTestId("autonomy-enable").first().click();
  await expect(page.getByTestId("autonomy-review")).toBeVisible();
  await page.getByTestId("autonomy-confirm").check();
  const ack = page.getByTestId("autonomy-ack-unknown");
  if (await ack.count()) await ack.check();
  await page.getByTestId("autonomy-grant").click();

  await expect(page.getByTestId("autonomy-section").getByTestId("autonomy-mode")).toHaveAttribute("data-mode", "bounded");
  await expect(page.getByTestId("autonomy-runs")).toContainText("/");
  await expect(page.getByTestId("autonomy-provider-quota")).toContainText(/Unknown|Not measured/);
  await expect(page.getByTestId("autonomy-runs-note")).toContainText(/own limit/);
  await expect(page.getByTestId("autonomy-revoke")).toBeVisible();
  // Nothing was started by granting.
  await expect(page.getByTestId("autonomy-current")).toHaveText(/nothing|Nothing/);
});
