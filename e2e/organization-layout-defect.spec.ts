import { test, expect, api, registerProject, projectPage } from "./organization-acceptance-fixture";
import { gotoApp } from "./helpers";

test("FO012C-P2-01: expanded Router must not place Prepare Execution outside the scrollable viewport", async ({ page, request, companyBackend: b }, info) => {
  await page.route("**/*", route => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  await page.setViewportSize({ width: 1280, height: 720 });
  const dir = await registerProject(request, b, "Layout defect");
  const employee = await api(request, b, "POST", "/employees", { name: "Layout worker", jobTitle: "Engineer", projectPath: dir }, 201);
  const task = await api(request, b, "POST", "/tasks", { title: "Layout reproduction", prompt: "Do not launch", workdir: dir, column: "ready", isolation: "none", agent: "claude-code" });
  await api(request, b, "POST", "/task-assignments", { taskId: task.id, employeeId: employee.id }, 201);
  await gotoApp(page, b.bootBase);
  await projectPage(page, dir, "board");
  // Click the title: since M5 the card's centre is its action row (Run / Delete), not its body.
  await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).getByText(task.title, { exact: true }).click();
  const router = page.getByTestId("ai-resource-recommendation"); await router.locator(":scope > summary").click();
  await router.getByTestId("find-ai-resource").click(); await expect(router.getByTestId("router-no-verified")).toBeVisible();
  await page.getByTestId("employee-execution").locator(":scope > summary").click();
  const prepare = page.getByTestId("employee-execution-prepare");
  await expect(page.getByTestId("employee-execution-worker-name")).toHaveText("Layout worker");
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await prepare.scrollIntoViewIfNeeded();
  await info.attach("scroll-ancestors", { body: JSON.stringify(await prepare.evaluate(el => {
    const rows = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const r = node.getBoundingClientRect();
      rows.push({ tag: node.tagName, testId: node.dataset.testid, height: r.height, top: r.top, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflow: getComputedStyle(node).overflowY });
    }
    return rows;
  }), null, 2), contentType: "application/json" });
  await info.attach("layout-bounds", { body: JSON.stringify({ viewport: page.viewportSize(), prepare: await prepare.boundingBox(), router: await router.boundingBox() }, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("FO012C-P2-01.png") });
  await expect(prepare).toBeInViewport();
  await expect(router).toHaveAttribute("open", "");
  await expect(page.getByTestId("employee-execution")).toHaveAttribute("open", "");
  await prepare.focus();
  await expect(prepare).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(router).toHaveAttribute("open", "");
});
