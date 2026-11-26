import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, putPreference, openAllTasks, openPortfolio } from "./helpers";
import { analyzeTaskRequirements } from "../src/shared/model-router/requirements";
import { UNKNOWN_OWNER_CONSTRAINTS } from "../src/shared/model-router/route";
import type { CandidateAssessment, RoutingPreview } from "../src/shared/model-router/types";
import type { TaskPreviewRequest } from "../src/mainview/lib/model-router-preview";

/**
 * FO-009E model-router preview. The headless backend uses fake harness
 * homes. This spec only opens preview UI and checks that Find/Compare do
 * not call a launch, refresh, or account-switch route.
 */

test.describe.configure({ mode: "serial" });

function auth(backend: E2EBackend) {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo009e-${name}-`));
  const response = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return dir;
}

async function createTask(request: APIRequestContext, backend: E2EBackend, title: string, workdir: string): Promise<{ id: string }> {
  const response = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: "Preview this task.", isolation: "none", workdir, column: "ready" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function fakeCard(id: string, status: CandidateAssessment["status"] = "verified"): CandidateAssessment {
  return {
    candidate: { id, harnessId: "fixture-harness", accountId: "fixture-account", modelId: "fixture-model", profileIds: [] },
    status, reasons: ["All required eligibility, quota and concurrency checks have current verified evidence."], unknowns: [], conflicts: [],
    provenance: ["fake:verified-evidence"], requiredOwnerApproval: ["Owner execution approval"],
    expectedCost: { taskId: "fixture-task", money: { currency: "USD", minor: 123 }, basis: "fixture-task-cost", source: "fake:cost" },
    ranking: { quality: { benchmark: "fake:benchmark", score: 8 }, duration: { basis: "fake:duration", ms: 3000 }, reserve: 0.8 },
    thinkingEffort: { value: "fixture-thorough", status: "verified", reason: "Confirmed vocabulary for the fixture harness/model." },
    quotaEvidence: [],
  };
}

function fakePreview(body: TaskPreviewRequest, patch: Partial<RoutingPreview> = {}): RoutingPreview {
  return {
    status: "no-verified-candidate", requirements: analyzeTaskRequirements({ ...body.requirements, taskId: body.taskId, projectId: body.path }),
    policy: body.policy, ownerConstraints: { ...UNKNOWN_OWNER_CONSTRAINTS }, recommendedCandidate: null, conditionalCandidates: [], excludedCandidates: [], alternativeCandidates: [],
    unknownInformation: ["No configured resource candidates were supplied."], requiredOwnerApproval: [], capturedAt: Date.now(), readOnly: true, execution: "preview-only",
    revalidation: { requiredBeforeExecution: true, reservesResources: false, checks: ["Recheck evidence before execution."] }, ...patch,
  };
}

async function openTask(page: Page, title: string): Promise<void> {
  await openAllTasks(page);
  await page.getByRole("button", { name: title }).click();
  await expect(page.getByTestId("ai-resource-recommendation")).toBeVisible();
}

/** The recommendation sits in the task panel above the transcript scroller,
 * so its own section scrolls. Playwright's action scroll does not move that box. */
async function reveal(locator: Locator): Promise<void> {
  await locator.evaluate((node) => {
    let parent = node.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      const scrollable = /(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1;
      if (scrollable) {
        parent.scrollTop += node.getBoundingClientRect().top - parent.getBoundingClientRect().top - 24;
        return;
      }
      parent = parent.parentElement;
    }
    node.scrollIntoView({ block: "center" });
  });
  await expect(locator).toBeInViewport();
}

test("task recommendation, policy, candidates, and no execution", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(60_000);
  const posts: string[] = [];
  const previewBodies: string[] = [];
  page.on("request", (call) => {
    if (call.method() !== "POST") return;
    const pathname = new URL(call.url()).pathname;
    posts.push(pathname);
    if (pathname === "/model-router/preview") previewBodies.push(call.postData() ?? "");
  });
  const dir = await registerProject(request, backend, "Media");
  const title = `example-project-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, title, dir);
  // Fixture setup only: make one explicitly allowed harness eligible for conditional evidence.
  const enable = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  expect(enable.ok(), await enable.text()).toBe(true);
  await gotoApp(page, backend.bootBase);
  await openTask(page, title);

  const section = page.getByTestId("ai-resource-recommendation");
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-preview-banner")).toHaveText("Preview only — no resources reserved, no agents started.");
  await expect(section.getByTestId("router-complexity")).toHaveValue("unknown");
  await expect(section.getByTestId("router-employee")).toContainText("No employee is assigned");
  await section.getByTestId("router-type").selectOption("backend");
  await section.getByTestId("router-complexity").selectOption("high");
  await section.getByTestId("router-capabilities").fill("backend");
  await section.getByTestId("router-policy").selectOption("quality-first");
  await expect(section.getByTestId("router-policy-explanation")).toContainText("same benchmark");
  await section.getByTestId("router-policy").focus();
  await expect(section.getByTestId("router-policy")).toBeFocused();
  await section.getByTestId("find-ai-resource").focus();
  await page.keyboard.press("Enter");
  await expect(section.getByTestId("router-no-verified")).toBeVisible();
  await expect(section.getByTestId("router-unknown-reasons")).toBeVisible();
  await expect(section.getByTestId("router-verified")).toHaveCount(0);
  const candidate = section.getByTestId("router-conditional").getByTestId("router-candidate").first();
  await expect(candidate).toBeVisible();
  const candidateSummary = candidate.locator("summary");
  await reveal(candidateSummary);
  await candidateSummary.click();
  await expect(section.getByTestId("router-effort").first()).toContainText("Not verified for this model");
  await expect(section.getByTestId("router-quota").first()).toContainText("Unknown");

  const constraints = section.getByTestId("router-owner-constraints").locator("summary");
  await reveal(constraints);
  await constraints.click();
  await section.getByTestId("router-limit-harnesses").check();
  await section.getByTestId("router-harness-codex").check();
  await section.getByTestId("router-spending").selectOption("no-extra");
  const previewResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/model-router/preview");
  await section.getByTestId("find-ai-resource").click();
  const previewText = await (await previewResponse).text();
  await expect(section.getByTestId("router-excluded").getByTestId("router-candidate").first()).toBeVisible();
  await expect(section.getByTestId("router-conditional").getByTestId("router-candidate").first(), `${previewBodies.at(-1) ?? ""}\n${previewText.slice(0, 4000)}`).toBeVisible();
  await expect(section.getByRole("button", { name: /start|launch|switch account/i })).toHaveCount(0);

  const forbidden = posts.filter((pathname) => /\/start|usage\/refresh|open-terminal|quota-refresh|harnesses$/.test(pathname));
  expect(forbidden).toEqual([]);
  expect(posts).toContain("/model-router/preview");
});

test("verified fixture, assigned employee and local quota expiry without a refresh", async ({ page, request, freshBackend: backend }, testInfo) => {
  const dir = await registerProject(request, backend, "Verified fixture");
  const title = `verified-${randomUUID().slice(0, 8)}`;
  const task = await createTask(request, backend, title, dir);
  const personResponse = await request.post(`${backend.apiBase}/employees`, { headers: auth(backend), data: { name: "Ada Fixture", jobTitle: "QA Engineer", projectPath: dir } });
  expect(personResponse.ok()).toBe(true);
  const person = await personResponse.json();
  const assigned = await request.post(`${backend.apiBase}/task-assignments`, { headers: auth(backend), data: { taskId: task.id, employeeId: person.id } });
  expect(assigned.ok(), await assigned.text()).toBe(true);
  let previews = 0;
  let refreshes = 0;
  page.on("request", req => { if (/quota-refresh|usage\/refresh/.test(new URL(req.url()).pathname)) refreshes++; });
  await page.route("**/model-router/preview", async route => {
    previews++;
    const body = route.request().postDataJSON() as TaskPreviewRequest;
    const card = fakeCard("verified-fixture");
    card.expectedCost!.taskId = body.taskId;
    const now = Date.now();
    card.quotaEvidence = [{
      definition: { id: "fixture-quota", accountId: "fixture-account", subscriptionId: null, scope: "account", window: "week", unit: { kind: "requests" }, createdAt: now, archivedAt: null },
      status: "current", warnings: [],
      current: { id: "fixture-observation", quotaId: "fixture-quota", observedAt: now - 1000, expiresAt: now + 60_000, resetAt: null, source: "fake:quota", provenance: "verified", verification: "verified", limit: 10, used: 2, remaining: 8, indicator: null, confidence: "high" }, observations: [],
    }];
    card.quotaEvidence[0]!.observations = [card.quotaEvidence[0]!.current!];
    await route.fulfill({ json: { preview: fakePreview(body, { status: "recommended", recommendedCandidate: card, unknownInformation: [] }), planningEstimate: null } });
  });
  await gotoApp(page, backend.bootBase);
  await page.clock.install();
  await openTask(page, title);
  const section = page.getByTestId("ai-resource-recommendation");
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-employee")).toContainText("Ada Fixture");
  await expect(section.getByTestId("router-employee")).toContainText("QA Engineer");
  await expect(section.getByTestId("router-employee")).toContainText("Assignment revision");
  await section.getByTestId("router-add-quota").click();
  await section.getByTestId("router-quota-id").fill("fixture-quota");
  await section.getByTestId("router-quota-amount").fill("2");
  await section.getByTestId("find-ai-resource").click();
  const card = section.getByTestId("router-verified").getByTestId("router-candidate");
  await reveal(card.locator("summary"));
  await card.locator("summary").click();
  await expect(card.getByTestId("router-effort")).toContainText("fixture-thorough");
  await expect(card.getByTestId("router-quota")).toContainText("Current — remaining 8");
  await expect(card).toContainText("fake:benchmark");
  await expect(card).toContainText("fake:cost");
  await expect(card.getByTestId("router-concurrency")).not.toContainText("0.8");
  await page.clock.fastForward(61_000);
  await expect(section.getByTestId("router-expired-recommendation")).toHaveCount(1);
  await expect(section.getByTestId("router-expired-recommendation").getByTestId("router-quota")).toContainText("Expired — not current");
  expect(previews).toBe(1);
  expect(refreshes).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("task-expired-evidence.png") });
});

test("loading, cancellation, unauthorized, empty and many candidates fit task detail", async ({ page, request, freshBackend: backend }, testInfo) => {
  const dir = await registerProject(request, backend, "States");
  const title = `states-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, title, dir);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/task-assignments/task?*", route => route.fulfill({ status: 503, json: { error: "Assignment unavailable" } }));
  await page.route("**/model-router/preview", async route => {
    const call = ++calls;
    const body = route.request().postDataJSON() as TaskPreviewRequest;
    if (call === 1) await held;
    if (call === 2) { await route.fulfill({ status: 401, json: { error: "unauthorized" } }); return; }
    const alternatives = call >= 4 ? Array.from({ length: 40 }, (_, index) => {
      const card = fakeCard(`conditional-${index}`, "conditional");
      card.expectedCost!.taskId = body.taskId;
      card.candidate.modelId = `fixture-${"long-identifier".repeat(25)}-${index}`;
      card.thinkingEffort = { status: index % 2 ? "conditional" : "not-applicable", value: null, reason: "Fixture evidence." };
      card.unknowns = ["Quota availability is unknown."];
      return card;
    }) : [];
    await route.fulfill({ json: { preview: fakePreview(body, { conditionalCandidates: alternatives }), planningEstimate: null } }).catch(() => undefined);
  });
  await gotoApp(page, backend.bootBase);
  await openTask(page, title);
  const section = page.getByTestId("ai-resource-recommendation");
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-employee")).toContainText("Assignment unknown");
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-loading")).toBeVisible();
  await section.getByTestId("router-complexity").selectOption("high");
  await expect(section.getByTestId("router-loading")).toHaveCount(0);
  release();
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-error")).toContainText("unauthorized");
  expect(calls).toBe(2);
  await expect(section.getByTestId("router-result")).toHaveCount(0);
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-no-verified")).toBeVisible();
  await expect(section.getByTestId("router-unknown-reasons")).toContainText("No configured resource candidates");
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-candidate")).toHaveCount(40);
  await section.getByTestId("router-candidate").first().locator("summary").click();
  await expect(section.getByTestId("router-effort").first()).toContainText("No effort parameter");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await section.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await section.getByTestId("router-candidate").first().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`task-${theme}-${width}.png`) });
    }
  }
  await section.getByTestId("router-policy").selectOption("fastest-eligible");
  await expect(section.getByTestId("router-result")).toHaveCount(0);
  expect(calls).toBe(4);
});

test("portfolio comparison, unknown priority, themes, and viewports", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(60_000);
  const alpha = await registerProject(request, backend, "Alpha");
  const beta = await registerProject(request, backend, "Beta");
  const alphaTitle = `alpha-${randomUUID().slice(0, 8)}`;
  const betaTitle = `beta-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, alphaTitle, alpha);
  await createTask(request, backend, betaTitle, beta);
  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  const comparison = page.getByTestId("portfolio-router");
  await expect(comparison).toBeVisible();
  await expect(comparison.getByTestId("portfolio-router-banner")).toContainText("Preview only");
  await comparison.getByRole("checkbox", { name: alphaTitle }).check();
  await comparison.getByRole("checkbox", { name: betaTitle }).check();
  await comparison.getByTestId("portfolio-router-policy").selectOption("preserve-limited-resources");
  await comparison.getByTestId("portfolio-router-compare").focus();
  await expect(comparison.getByTestId("portfolio-router-compare")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(comparison.getByTestId("portfolio-router-priority-withheld")).toBeVisible();
  await expect(comparison.getByTestId("portfolio-router-task-result")).toHaveCount(2);
  await expect(comparison.getByText("No verified candidate").first()).toBeVisible();
  await comparison.locator("li").filter({ has: page.getByRole("checkbox", { name: alphaTitle }) }).getByTestId("portfolio-router-priority").selectOption("high");
  await comparison.locator("li").filter({ has: page.getByRole("checkbox", { name: betaTitle }) }).getByTestId("portfolio-router-priority").selectOption("normal");
  await comparison.getByTestId("portfolio-router-compare").click();
  await expect(comparison.getByTestId("portfolio-router-priority-withheld")).toHaveCount(0);
  await expect(comparison.getByRole("button", { name: /start|launch|reserve/i })).toHaveCount(0);

  for (const theme of ["light", "dark"] as const) {
    await putPreference(request, backend, "theme", theme);
    await page.reload();
    await openPortfolio(page);
    await expect(page.getByTestId("portfolio-router")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  await expect(page.getByTestId("portfolio-router")).toHaveCSS("backdrop-filter", "none");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByTestId("portfolio-router").scrollIntoViewIfNeeded();
    const box = await page.getByTestId("portfolio-router").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    const overflow = await page.getByTestId("portfolio-router").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    expect(overflow).toBe(true);
  }
});
