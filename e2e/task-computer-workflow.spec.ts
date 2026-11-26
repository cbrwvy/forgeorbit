import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type ProductBackend } from "./head-auto-fixture";
import { gotoBoard } from "./helpers";
import type { TaskComputerReview, TaskComputerRun, TaskComputerScope } from "../src/shared/task-computer-workflow";

test.use({ productEnv: {
  FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE: "1",
  FORGEORBIT_EMBEDDING_MODEL_ROOT: "/nonexistent/computer-workflow-model",
  ...(process.env.FORGEORBIT_TEST_TEXTEDIT_HELPER
    ? { FORGEORBIT_NATIVE_CU_HELPER: process.env.FORGEORBIT_TEST_TEXTEDIT_HELPER }
    : {}),
} });

async function setup(request: APIRequestContext, product: ProductBackend) {
  async function call<T>(method: string, path: string, data?: unknown, status = 200): Promise<T> {
    const response = await request.fetch(product.apiBase + path, { method, data, headers: { authorization: `Bearer ${product.apiToken}` } });
    const body = await response.text();
    expect(response.status(), `${method} ${path}: ${body}`).toBe(status);
    return (body ? JSON.parse(body) : null) as T;
  }
  const root = join(product.dataDir, "workflow-fixture");
  mkdirSync(root);
  await call("PUT", "/preferences/locale", { value: "en" }, 204);
  await call("POST", "/projects", { path: root, name: "Disposable workflows" });
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const employee = await call<{ id: string }>("POST", "/employees", {
    name: "Fixture specialist", jobTitle: "Developer", projectPath: root,
  }, 201);
  async function make(title: string, prompt: string) {
    const task = await call<{ id: string; title: string }>("POST", "/tasks", {
      title, prompt, workdir: root, isolation: "none", column: "ready", agent: "codex", model: "gpt-6.1-sol", effort: "low", mode: "ask",
    });
    await call("POST", "/task-assignments", { taskId: task.id, employeeId: employee.id }, 201);
    return task;
  }
  const view = (id: string) => call<{ review: TaskComputerReview; run: TaskComputerRun | null; used: boolean }>("GET", `/tasks/${id}/computer-workflow`);
  return { call, make, root, view };
}

function isolatedSite() {
  let outside = 0;
  let submissions = 0;
  let held = false;
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { outside++; return new Response("Unapproved"); } });
  const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });
  const local = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/outside") return html(`<button type="button" onclick="window.open('${foreign.url.href}')">Next</button>`);
      if (path === "/frame") return html(`<iframe src="${foreign.url.href}"></iframe>`);
      if (path === "/redirect") return html('<button type="button" onclick="location.href=\'/leave\'">Next</button>');
      if (path === "/leave") return Response.redirect(foreign.url.href);
      if (path === "/login") return html('<label>Password <input type="password"></label>');
      if (path === "/slow") return html('<button type="button" onclick="location.href=\'/held\'">Next</button>');
      if (path === "/held") { held = true; await hold; }
      if (path === "/form" || path === "/held") return html(
        '<form method="post" action="/confirm"><label>Email <input type="email" name="email" required></label>' +
        '<input type="hidden" name="secret" value="HIDDEN-FIXTURE-CANARY"><button type="submit">Send request</button></form>',
      );
      if (path === "/confirm" && request.method === "POST") {
        submissions++;
        const form = await request.formData();
        return form.get("email") === "bad@example.test"
          ? html('<p role="alert">The test address was rejected.</p>')
          : html(form.get("email") === "missing@example.test" ? "<main>Try again later</main>" : "<main><h1>Request received</h1></main>");
      }
      return html('<button type="button" onclick="location.href=\'/form\'">Next</button>');
    },
  });
  return {
    url: (path: string) => new URL(path, local.url).href,
    outside: () => outside, submissions: () => submissions, held: () => held, release,
    close: () => { release(); local.stop(true); foreign.stop(true); },
  };
}

async function openTask(page: Page, product: ProductBackend, title: string) {
  const close = page.getByRole("button", { name: "Close task details", exact: true });
  if (await close.isVisible()) await close.click();
  if (!(await page.getByRole("button", { name: title, exact: true }).isVisible())) await gotoBoard(page, product.bootBase);
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByTestId("manager-task-summary")).toBeVisible();
}

async function approveRun(page: Page, subject: string) {
  await page.getByTestId("manager-task-primary").click();
  const dialog = page.getByTestId("employee-run-dialog");
  await expect(dialog.getByTestId("task-computer-review")).toContainText(subject);
  const usage = dialog.getByTestId("employee-run-usage").locator("input");
  if (await usage.count()) await usage.check();
  await dialog.getByTestId("employee-run-confirm").click();
  await expect(dialog).toHaveCount(0);
}

test("browser workflow runs through task review and records rendered success and failure", async ({ page, request, product }) => {
  test.setTimeout(100_000);
  const site = isolatedSite();
  try {
    const { call, make, view } = await setup(request, product);
    const success = await make("Confirm staging request", "Click Next, fill Email with test data, and submit with Send request.");
    await openTask(page, product, success.title);
    await page.getByTestId("manager-task-details").click();
    const flow = page.getByTestId("task-computer-workflow");
    await flow.getByRole("button", { name: "Configure workflow" }).click();
    await flow.getByLabel("Approved staging URL").fill(site.url("/"));
    await flow.getByLabel("Exact visible confirmation text").fill("Request received");
    await flow.getByLabel("Allowed staging submit button (optional)").fill("Send request");
    await flow.getByLabel("Visible field label").fill("Email");
    await flow.getByLabel("Test value").fill("good@example.test");
    await flow.getByRole("button", { name: "Save workflow scope" }).click();
    await expect(flow.getByTestId("task-computer-review")).toContainText("Send request");
    await call("POST", `/tasks/${success.id}/start`, {}, 400);
    await approveRun(page, "Request received");
    await expect(page.getByTestId("task-computer-result")).toHaveAttribute("data-outcome", "verified", { timeout: 25_000 });
    const verified = (await view(success.id)).run!;
    expect(verified.steps.map(step => step.operation)).toEqual(["open", "next", "fill", "submit", "verify"]);
    expect(verified.steps.at(-1)?.observed).toBe("Request received");
    expect(site.submissions()).toBe(1);
    expect(JSON.stringify(verified)).not.toMatch(/good@example.test|HIDDEN-FIXTURE-CANARY/);

    const bad = await make("Find staging validation failure", "Run Next and Send request with the supplied example.");
    const scope: TaskComputerScope = { kind: "browser", url: site.url("/"), expected: "Request received",
      submitLabel: "Send request", fields: [{ label: "Email", value: "bad@example.test" }] };
    await call("PUT", `/tasks/${bad.id}/computer-workflow`, scope);
    await openTask(page, product, bad.title);
    await approveRun(page, "Request received");
    await expect(page.getByTestId("task-computer-result")).toHaveAttribute("data-outcome", "validation", { timeout: 25_000 });
    const failed = (await view(bad.id)).run!;
    expect(failed.steps.at(-1)?.observed).toBe("The test address was rejected.");
    expect(failed.screenshot).toBe(true);
    const screenshot = await call<{ image: string }>("GET", `/tasks/${bad.id}/computer-workflow/screenshot/${failed.runId}`);
    expect(screenshot.image.startsWith("iVBORw0KGgo")).toBe(true);
    expect(site.submissions()).toBe(2);

    const missing = await make("Catch a missing confirmation", "Run Next and Send request with the supplied example.");
    await call("PUT", `/tasks/${missing.id}/computer-workflow`, { ...scope, fields: [{ label: "Email", value: "missing@example.test" }] });
    await openTask(page, product, missing.title);
    await approveRun(page, "Request received");
    await expect(page.getByTestId("task-computer-result")).toHaveAttribute("data-outcome", "missing-confirmation", { timeout: 25_000 });
    expect(site.submissions()).toBe(3);

    using db = new Database(join(product.dataDir, "agetor.sqlite"), { readonly: true });
    const receipts = db.query<{ steps_json: string }, []>("SELECT steps_json FROM task_computer_runs").all();
    const audit = db.query<{ data: string }, []>("SELECT data FROM run_events").all();
    expect(JSON.stringify([receipts, audit])).not.toMatch(/bad@example.test|good@example.test|missing@example.test|HIDDEN-FIXTURE-CANARY/);
  } finally { site.close(); }
});

test("wrong-origin popup and redirects are denied and Stop drops queued actions", async ({ page, request, product }) => {
  test.setTimeout(140_000);
  const site = isolatedSite();
  const interruptedSite = isolatedSite();
  try {
    const { call, make, view } = await setup(request, product);
    for (const [route, outcome] of [["/outside", "scope"], ["/redirect", "scope"], ["/frame", "scope"], ["/login", "login"]] as const) {
      const task = await make(`Check ${route}`, "Continue with Next.");
      await call("PUT", `/tasks/${task.id}/computer-workflow`, {
        kind: "browser", url: site.url(route), expected: "Request received", submitLabel: null, fields: [],
      });
      await openTask(page, product, task.title);
      await approveRun(page, site.url(route));
      await expect(page.getByTestId("task-computer-result"), route).toHaveAttribute("data-outcome", outcome, { timeout: 25_000 });
    }
    expect(site.outside()).toBe(0);

    const slow = await make("Stop an active browser workflow", "Use Next, fill Email and Send request.");
    await call("PUT", `/tasks/${slow.id}/computer-workflow`, {
      kind: "browser", url: site.url("/slow"), expected: "Request received", submitLabel: "Send request", fields: [{ label: "Email", value: "stop@example.test" }],
    });
    await openTask(page, product, slow.title);
    await approveRun(page, site.url("/slow"));
    await expect.poll(site.held, { timeout: 12_000 }).toBe(true);
    await page.getByTestId("manager-task-stop").click();
    await expect(page.getByTestId("task-computer-result")).toHaveAttribute("data-outcome", "stopped");
    site.release();
    expect((await view(slow.id)).run?.steps.some(step => step.operation === "submit")).toBe(false);

    const interrupted = await make("Interrupt an active browser workflow", "Use Next, fill Email and Send request.");
    await call("PUT", `/tasks/${interrupted.id}/computer-workflow`, {
      kind: "browser", url: interruptedSite.url("/slow"), expected: "Request received", submitLabel: "Send request",
      fields: [{ label: "Email", value: "interrupt@example.test" }],
    });
    await openTask(page, product, interrupted.title);
    await approveRun(page, interruptedSite.url("/slow"));
    await expect.poll(interruptedSite.held, { timeout: 12_000 }).toBe(true);
    await product.restart();
    interruptedSite.release();
    const previous = await view(interrupted.id);
    expect(previous.used).toBe(true);
    expect(previous.run?.outcome).toBe("interrupted");
    expect(previous.run?.steps.some(step => step.operation === "submit")).toBe(false);
    expect(site.submissions()).toBe(0);
    expect(interruptedSite.submissions()).toBe(0);
    const repeated = await call<unknown>("POST", "/employee-execution/reviews", { taskId: interrupted.id, harnessId: "codex" });
    expect(repeated).toMatchObject({ preflight: { outcome: "blocked" }, attempt: null });
  } finally { site.close(); interruptedSite.close(); }
});

test("TextEdit workflow shows named document and enforces read-only even when the agent asks to edit", async ({ page, request, product }) => {
  const { call, make, root } = await setup(request, product);
  writeFileSync(join(root, "handoff.txt"), "Status: Draft\n");
  const task = await make("Inspect the TextEdit handoff", "__try_edit__");
  await openTask(page, product, task.title);
  await page.getByTestId("manager-task-details").click();
  const flow = page.getByTestId("task-computer-workflow");
  await flow.getByRole("button", { name: "Configure workflow" }).click();
  await flow.getByRole("combobox", { name: "Workflow", exact: true }).selectOption("textedit");
  await flow.getByLabel("Relative .txt document path").fill("handoff.txt");
  await flow.getByRole("button", { name: "Save workflow scope" }).click();
  await approveRun(page, "handoff.txt");
  await expect(page.getByTestId("task-computer-result")).toHaveAttribute("data-outcome", "read-only");
  expect(readFileSync(join(root, "handoff.txt"), "utf8")).toBe("Status: Draft\n");
  await call("PUT", `/tasks/${task.id}/computer-workflow`, { kind: "textedit", document: "../outside.txt", edit: null }, 409);
});

test("an approved task edits and saves the named document in real TextEdit", async ({ page, request, product }) => {
  test.skip(process.platform !== "darwin" || !process.env.FORGEORBIT_TEST_TEXTEDIT_HELPER, "Requires a development helper with macOS Accessibility permission.");
  test.setTimeout(60_000);
  const { make, root } = await setup(request, product);
  const filename = `task-handoff-${Date.now()}.txt`;
  writeFileSync(join(root, filename), "Status: Draft\n");
  writeFileSync(join(root, "untouched.txt"), "Other fixture\n");
  const task = await make("Update the TextEdit handoff", "Open the selected file in TextEdit, replace Draft with Reviewed, and save.");
  await openTask(page, product, task.title);
  await page.getByTestId("manager-task-details").click();
  const flow = page.getByTestId("task-computer-workflow");
  await flow.getByRole("button", { name: "Configure workflow" }).click();
  await flow.getByRole("combobox", { name: "Workflow", exact: true }).selectOption("textedit");
  await flow.getByLabel("Relative .txt document path").fill(filename);
  await flow.getByLabel("Allow one specified edit and save").check();
  await flow.getByLabel("Exact text to replace").fill("Draft");
  await flow.getByLabel("Replacement text").fill("Reviewed");
  await flow.getByRole("button", { name: "Save workflow scope" }).click();
  await expect(flow.getByTestId("task-computer-review")).toContainText("May apply the specified edit");
  await approveRun(page, filename);
  await expect(page.getByTestId("task-computer-result")).toHaveAttribute("data-outcome", "verified", { timeout: 20_000 });
  expect(readFileSync(join(root, filename), "utf8")).toBe("Status: Reviewed\n");
  expect(readFileSync(join(root, "untouched.txt"), "utf8")).toBe("Other fixture\n");
});
