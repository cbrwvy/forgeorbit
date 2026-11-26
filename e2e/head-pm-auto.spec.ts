import { expect } from "@playwright/test";
import { test, api } from "./head-auto-fixture";
import { gotoApp } from "./helpers";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Task, Run, TaskQcReview } from "../src/shared/types";
import type { HeadAutoView } from "../src/shared/head-pm-auto";
import type { HeadPmInitiativeView } from "../src/shared/head-pm-initiative";

for (const recovery of [false, true]) {
test.describe(recovery ? "active restart" : "completed restart", () => {
  test.use({productEnv: recovery ? {AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS:"30000"} : {}});
test("FO-HEAD-AUTO01 Owner initiative → delegations → approved batches → A/QC → automatic B/QC → restart → explicit Done", async ({ page, request, product: b }, info) => {
  test.setTimeout(240000);
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => {if (r.url().startsWith(b.apiBase) && !["GET","HEAD","OPTIONS"].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);});
  const call = <T>(method: "get"|"post"|"put"|"patch",route: string,data?: unknown,status=200) => api<T>(request,b,method,route,data,status);
  const dirs = [path.join(b.dataDir,"alpha"), path.join(b.dataDir,"beta")];
  const devs: {id:string;name:string}[]=[];
  for (const [n,dir] of dirs.entries()) {
    await mkdir(dir,{recursive:true}); await writeFile(path.join(dir,"README.md"),`# Project ${n}`);
    execFileSync("git",["init","-q",dir]); execFileSync("git",["-C",dir,"add","README.md"]);
    execFileSync("git",["-C",dir,"-c","user.name=QA","-c","user.email=qa@invalid","commit","-qm","Synthetic baseline"]);
    // Deterministic infrastructure only. No tasks, assignments, approvals, grants or outcomes.
    await call("post","/projects",{path:dir,name:n===0?"Project Alpha":"Project Beta"});
    await call("post","/employees/project-managers",{projectPath:dir},201);
    devs.push(await call("post","/employees",{name:n===0?"Alpha Developer":"Beta Developer",jobTitle:"Engineer",projectPath:dir},201));
    await call("post","/projects/rules",{path:dir,name:`Rule ${n}`,body:`PROJECT_${n}_RULE: keep this project separate.`});
    await call("post","/knowledge/documents",{ownerKind:"project",ownerId:dir,title:`Knowledge ${n}`,content:`PROJECT_${n}_KNOWLEDGE`},201);
  }
  await call("patch","/harnesses/codex",{enabled:true});
  const pre = await call<{isolation:{consentKey:string}}>("post","/project-interviews/preflight",{harness:"codex",model:"gpt-6.1-sol"});
  const config={harness:"codex",model:"gpt-6.1-sol",effort:"low",consentKey:pre.isolation.consentKey};
  await call("put","/portfolio-manager/config",{config});
  for (const dir of dirs) await call("put","/project-manager/config",{path:dir,config});
  await gotoApp(page,b.bootBase);
  await page.getByTestId("head-pm-orb").click(); await page.getByTestId("head-pm-context-all").click();
  await page.getByTestId("head-pm-composer").fill("Coordinate authentication improvements across Project Alpha and Project Beta. Assign preparation to their project managers.");
  await page.getByTestId("head-pm-send").click();
  const proposal=page.getByTestId("head-pm-initiative-proposal"); await expect(proposal).toHaveAttribute("data-status","proposed");
  expect(await call("get","/head-pm/initiatives")).toEqual([]);
  await proposal.getByTestId("head-pm-initiative-proposal-approve").click(); await expect(proposal).toHaveAttribute("data-status","approved");
  for (const dir of dirs) await page.locator(`[data-testid="head-pm-initiative-prepare"][data-path="${dir}"]`).click();
  const detail=page.getByTestId("head-pm-initiative-detail");
  for (let n=0;n<2;n++) {
    const delegation=detail.getByTestId("portfolio-delegation").nth(n);
    await delegation.getByTestId("portfolio-delegation-approve").click();
    await page.getByRole("dialog").getByRole("button",{name:"Send request"}).click();
    await expect(delegation).toHaveAttribute("data-status","answered",{timeout:20000});
  }
  const initiative=(await call<HeadPmInitiativeView[]>("get","/head-pm/initiatives"))[0]!;
  await page.getByTestId("head-pm-orb").click();
  const closeRun=async()=>{await page.getByRole("button",{name:"Close task details",exact:true}).click();};
  const taskIds:string[]=[];
  for (const [n,dir] of dirs.entries()) {
    await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click(); await page.getByTestId("project-page-manager").click();
    const plan=page.getByTestId("manager-proposal"); await expect(plan).toHaveCount(1);
    const includes=plan.getByTestId("manager-item-include");
    for (let j=1;j<await includes.count();j++) await includes.nth(j).uncheck();
    await plan.getByTestId("manager-proposal-approve").click(); await expect(plan).toHaveAttribute("data-status","approved");
    const task=(await call<Task[]>("get","/tasks")).find(t=>t.workdir===dir)!; taskIds.push(task.id);
    await plan.getByTestId("manager-item-open-task").first().click(); await page.getByTestId("supervised-live-admit").click(); await closeRun();
    await plan.getByTestId("manager-item-open-task").first().click(); await page.getByTestId("supervised-live-ready").click();
    const assignment=page.getByTestId("task-assignment-panel"); await assignment.getByTestId("task-assignment-pick").selectOption({label:devs[n]!.name}); await assignment.getByTestId("task-assignment-save").click(); await expect(assignment.getByTestId("task-assignment-current")).toContainText(devs[n]!.name); await closeRun();
    await page.getByTestId("manager-tab-autonomy").click();
    await page.getByTestId(`orchestrated-batch-pick-${task.id}`).check(); await page.getByTestId("orchestrated-batch-create").click();
    await expect(page.getByTestId("batch-plan-summary")).toContainText(devs[n]!.name);
    if (recovery) {
      await page.getByTestId("batch-resource").selectOption("codex");
      await page.getByTestId("batch-mode").selectOption("ask"); // Read-only synthetic Run for crash recovery; preserves existing Codex Git/acknowledgement gates.
    }
    await page.getByTestId("orchestrated-batch-approve").click(); await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("approved");
  }
  await page.getByTestId("head-pm-orb").click(); await page.getByTestId("head-pm-context-all").click();
  await page.getByTestId("head-auto-prepare").click();
  await expect(page.getByTestId("head-auto-plan")).toContainText("Project Alpha"); await expect(page.getByTestId("head-auto-plan")).toContainText("Project Beta");
  await page.getByTestId("head-auto-authorize").click(); await expect(page.getByTestId("head-auto-panel")).toHaveAttribute("data-status","approved");
  await page.getByTestId("head-auto-digest").scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("approved-plan.png")});
  await page.getByTestId("head-auto-start").click();
  const coord=()=>call<HeadAutoView>("get",`/head-pm/initiatives/${initiative.id}/coordination`);
  if (recovery) {
    await expect.poll(async () => (await call<Run[]>("get",`/tasks/${taskIds[0]}/runs`)).some(r => r.status === "running"), {timeout:20000}).toBe(true);
    const before = await coord();
    await b.restart(); await page.reload();
    await expect.poll(async () => (await coord()).record?.status, {timeout:20000}).toBe("blocked");
    expect((await call<Task>("get",`/tasks/${taskIds[1]}`)).column).toBe("ready");
    expect(await call<Run[]>("get",`/tasks/${taskIds[1]}/runs`)).toHaveLength(0);
    const history = await call<Run[]>("get",`/tasks/${taskIds[0]}/runs`);
    expect(history).toHaveLength(1);
    await b.restart();
    expect(await call<Run[]>("get",`/tasks/${taskIds[0]}/runs`)).toHaveLength(1);
    expect((await coord()).record?.status).toBe("blocked");
    expect(errors).toEqual([]);
    await writeFile(info.outputPath("active-restart-evidence.json"),JSON.stringify({before,after:await coord(),history},null,2));
    await writeFile(info.outputPath("owner-ui-writes.json"),JSON.stringify(writes,null,2));
    return;
  }
  await expect.poll(async()=> (await coord()).record?.status,{timeout:60000}).toBe("completed");
  await expect(page.getByTestId("head-auto-panel")).toHaveAttribute("data-status","completed");
  const before=await coord();
  await expect(page.getByTestId("head-auto-fake")).toBeVisible();
  for (const [n,id] of taskIds.entries()) {
    const t=await call<Task>("get",`/tasks/${id}`); expect(t.workdir).toBe(dirs[n]!); expect(t.column).toBe("review"); expect(t.qcState?.latestVerdict).toBe("PASS");
    const runs=await call<Run[]>("get",`/tasks/${id}/runs`); expect(runs).toHaveLength(2); expect(runs.every(r=>r.taskId===id)).toBe(true);
    const qc=await call<{reviews:TaskQcReview[]}>("get",`/tasks/${id}/qc`); expect(qc.reviews).toHaveLength(1);
    expect(qc.reviews[0]).toMatchObject({taskId:id,projectPath:dirs[n],verdict:"PASS"});
    expect(runs.map(r=>r.id)).toContain(qc.reviews[0]!.implementationRunId!); expect(runs.map(r=>r.id)).toContain(qc.reviews[0]!.reviewRunId!);
    expect(qc.reviews[0]!.implementationRunId).not.toBe(qc.reviews[0]!.reviewRunId);
    for (const run of runs) {
      expect(JSON.stringify(run.projectRulesSnapshot)).toContain(`PROJECT_${n}_RULE`);
      expect(JSON.stringify(run.projectRulesSnapshot)).not.toContain(`PROJECT_${1-n}_RULE`);
      expect(run.knowledgeSnapshot?.projectPath).toBe(dirs[n]!);
      expect(JSON.stringify(run.knowledgeSnapshot)).toContain(`Knowledge ${n}`);
      expect(JSON.stringify(run.knowledgeSnapshot)).not.toContain(`Knowledge ${1-n}`);
    }
  }
  expect(before.record?.reservations.map(r=>r.state)).toEqual(["completed","completed"]);
  await page.getByTestId("head-auto-status").scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("both-qc-pass.png")});
  await b.restart(); await page.reload();
  await expect.poll(async()=> (await coord()).record?.status).toBe("completed");
  expect((await coord()).record?.history).toEqual(before.record?.history);
  await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
  for (const [n,id] of taskIds.entries()) {
    // Projects propose the same title; open each task through its own project board.
    await page.locator(`[data-testid="project-nav-item"][data-path="${dirs[n]}"]`).click(); await page.getByTestId("project-page-board").click();
    await page.getByRole("button",{name:(await call<Task>("get",`/tasks/${id}`)).title,exact:true}).click();
    await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
    await page.getByTestId("supervised-live-done").click(); await closeRun();
    expect((await call<Task>("get",`/tasks/${id}`)).column).toBe("done");
  }
  await page.getByTestId("head-pm-orb").click(); await page.getByTestId("head-pm-context-all").click();
  await expect(page.getByTestId("head-pm-initiative-detail")).toHaveAttribute("data-status","completed");
  for (const id of taskIds) expect(await call<Run[]>("get",`/tasks/${id}/runs`)).toHaveLength(2);
  await page.getByTestId("head-pm-initiative-row").scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("initiative-completed.png")});
  expect(writes.filter(s=>s.endsWith("/start"))).toEqual([`POST /head-pm/initiatives/${initiative.id}/coordination/start`]);
  expect(errors).toEqual([]);
  await writeFile(info.outputPath("owner-ui-writes.json"),JSON.stringify(writes,null,2));
  await writeFile(info.outputPath("coordination-evidence.json"),JSON.stringify({beforeRestart:before,afterAcceptance:await coord()},null,2));
});

});
}
