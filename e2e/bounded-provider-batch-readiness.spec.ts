import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "./fixtures";
import { gotoBoard } from "./helpers";

test.use({ viewport: {width:1600,height:1200}, backendEnv: { AGETOR_CLAUDE_DRIVER: "offline-executable-fixture" } });
test("FO-LIVE-READY01 Owner selects bounded fixture resource and sees truthful batch pause and usage", async ({ page, request, freshBackend: b }) => {
  const headers = { authorization: `Bearer ${b.apiToken}` };
  const project = path.join(b.dataDir, "bounded-project"); await mkdir(project);
  const bin = path.join(b.dataDir, "claude-bounded-fixture");
  const fixture = await readFile(path.resolve("src/bun/claude-bounded-print.fixture.ts"), "utf8");
  const bun = execFileSync("/usr/bin/which", ["bun"], {encoding:"utf8"}).trim();
  await writeFile(bin, `#!${bun}\n${fixture}`, {mode:0o700});
  async function post(url:string, data:unknown) {
    const r = await request.post(b.apiBase+url,{headers,data}); expect(r.ok(),await r.text()).toBeTruthy(); return r.json();
  }
  await post("/projects",{path:project,name:"Bounded Ready"});
  await post("/harnesses",{id:"bounded-fixture",kind:"claude-code",label:"Offline bounded fixture",home:path.join(b.dataDir,"fixture-config"),bin});
  const dev = await post("/employees",{name:"Offline Developer",jobTitle:"Developer",projectPath:project});
  const ids:string[]=[];
  for (const [title,prompt] of [["Task A","fixture-case:success"],["Task B","fixture-case:changes"],["Task C","fixture-case:success"]]) {
    const created = await post("/tasks",{title,prompt,workdir:project,agent:"bounded-fixture",model:"haiku-5.5",mode:"auto",column:"ready",isolation:"none"});
    const id = (created.task??created).id;ids.push(id);
    await post("/task-assignments",{taskId:id,employeeId:dev.id});
  }
  await gotoBoard(page,b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${project}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-tab-autonomy").click();
  for(const id of ids) await page.getByTestId(`orchestrated-batch-pick-${id}`).check();
  await page.getByTestId("orchestrated-batch-create").click();
  await page.getByTestId("batch-resource").selectOption("bounded-fixture");
  await page.getByTestId("batch-mode").selectOption("bounded-print");
  await page.getByTestId("batch-developer-model").fill("haiku-5.5");
  await expect(page.getByTestId("batch-bounded-policy")).toContainText("0.25");
  await expect(page.getByTestId("batch-bounded-policy")).toContainText("Read, Glob, Grep");
  await page.getByTestId("orchestrated-batch-approve").click();
  await page.getByTestId("orchestrated-batch-start").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("paused",{timeout:30_000});
  await expect(page.getByTestId("orchestrated-batch-blocker")).toContainText("Review requested changes");
  const rows=page.getByTestId("orchestrated-batch-task-list").locator("li");
  await expect(rows.nth(0)).toContainText("awaiting_owner");
  await expect(rows.nth(2)).toContainText("queued");
  await expect(rows.nth(0).getByTestId("run-execution").first()).toHaveAttribute("data-execution-type","fixture");
  await expect(rows.nth(0)).toContainText("0.001");
  await expect(rows.nth(0)).toContainText("Unknown");
  await expect(page.getByTestId("orchestrated-batch-fake-badge")).toHaveCount(0);
  for(const [index,id] of ids.entries()) {
    const runs = await request.get(`${b.apiBase}/tasks/${id}/runs`,{headers});expect((await runs.json()).length).toBe(index===2?0:2);
  }
  await page.getByTestId("orchestrated-batch-section").scrollIntoViewIfNeeded();
  await page.getByTestId("orchestrated-batch-section").screenshot({path:test.info().outputPath("bounded-batch-paused.png")});
  await page.getByTestId("orchestrated-batch-cancel").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("cancelled");
});
