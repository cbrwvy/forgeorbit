import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type E2EBackend, type Page, type APIRequestContext } from "./fixtures";
import { gotoApp } from "./helpers";
import { ActivityJournalCore } from "../src/bun/activity-journal-core";
import { ACTIVITY_EVENT_TYPES, type ActivityEventInput } from "../src/shared/activity/types";

async function call(request: APIRequestContext, b: E2EBackend, route: string, data?: unknown) {
  const response = await request.fetch(b.apiBase + route, {method:data === undefined ? "GET" : "POST",headers:{authorization:`Bearer ${b.apiToken}`},data});
  expect(response.ok(),await response.text()).toBe(true); return response.json();
}
function seed(b: E2EBackend, inputs: ActivityEventInput[]) {
  // Only the fresh fixture's migrated SQLite. No application singleton imports.
  expect(b.dataDir).toContain("agetor-e2e-");
  const db = new Database(path.join(b.dataDir,"agetor.sqlite"));
  try { const core = new ActivityJournalCore(db,{notify:false}); return inputs.map(input => core.record(input).event); }
  finally { db.close(); }
}
function input(i: number, patch: Partial<ActivityEventInput> = {}): ActivityEventInput {
  return {eventType:ACTIVITY_EVENT_TYPES[i % 18]!,actorType:i % 2 ? "owner" : "employee",actorId:i % 2 ? null : "ada",targetType:"task",targetId:"missing-task",taskId:"missing-task",employeeId:"ada",createdAt: new Date(2026,9,i < 65 ? 26 : 27,12).getTime(),idempotencyKey:`fixture:${i}`,...patch};
}
async function open(page: Page, b: E2EBackend) {
  await page.route("**/*", route => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  await gotoApp(page,b.bootBase);
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-activity").click();
  await expect(page.getByTestId("activity-journal")).toBeVisible();
  await expect(page.getByTestId("activity-loading")).toHaveText("");
}
function writes(page: Page) {
  const got: string[] = [];
  page.on("request",r => { const p = new URL(r.url()).pathname; if (!["GET","HEAD","OPTIONS"].includes(r.method()) && !p.startsWith("/preferences")) got.push(`${r.method()} ${p}`); }); return got;
}
function audit(b: E2EBackend) {
  const db = new Database(path.join(b.dataDir,"agetor.sqlite"),{readonly:true});
  try { return ["assignment_proposals","employee_executions","runs","tasks"].map(table => db.query(`SELECT ${table === "tasks" ? "id,title,prompt,column,run_id,agent,workdir" : "*"} FROM ${table} ORDER BY id`).all()); }
  finally { db.close(); }
}

test("all events, EN/RU switch, date groups, attribution, precise statuses and read-only authority", async ({page,request,freshBackend:b}) => {
  const dir = path.join(b.dataDir,"project"); await mkdir(dir);
  await call(request,b,"/projects",{path:dir,name:"Untranslated Project"});
  const employee = await call(request,b,"/employees",{name:"Ada Original",jobTitle:"Engineer",projectPath:dir});
  seed(b,ACTIVITY_EVENT_TYPES.map((type,i) => input(i,{eventType:type,projectPath:dir,employeeId:employee.id,actorId:i % 2 ? null : employee.id,payload:{taskTitle:"Original задача <b>title</b>",prompt:"NEVER_RENDER_PROMPT",apiToken:"NEVER_RENDER_TOKEN"}})));
  const before = audit(b);
  await open(page,b); const observed = writes(page);
  for (const type of ACTIVITY_EVENT_TYPES) await expect(page.locator(`[data-event-type="${type}"]`).first()).toBeVisible();
  await expect(page.locator('[data-event-type="turn.submitted"] [data-status]')).toHaveAttribute("data-status","submitted");
  await expect(page.locator('[data-event-type="delivery.indeterminate"] [data-status]')).toHaveAttribute("data-status","indeterminate");
  await expect(page.getByTestId("activity-journal")).toContainText("Ada Original");
  await expect(page.getByTestId("activity-journal")).toContainText("Untranslated Project");
  await expect(page.getByTestId("activity-journal")).toContainText("Original задача <b>title</b>");
  await expect(page.getByTestId("activity-journal").locator("b")).toHaveCount(0);
  const ids = await page.getByTestId("activity-event").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-id")));
  let queries = 0; page.on("request",r => {if(new URL(r.url()).pathname === "/activity") queries++;});
  await page.keyboard.press("Alt+Shift+L");
  await expect(page.getByTestId("company-tab-activity")).toHaveText("Журнал активности");
  await expect(page.locator('[data-event-type="turn.submitted"]')).toContainText("завершение задачи не подтверждено");
  await expect(page.getByTestId("activity-journal")).toContainText("Ada Original");
  expect(await page.getByTestId("activity-event").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-id")))).toEqual(ids);
  expect(queries).toBe(0);
  await expect(page.getByTestId("activity-journal")).not.toContainText("NEVER_RENDER");
  await page.keyboard.press("Alt+Shift+L");
  expect(observed).toEqual([]); expect(audit(b)).toEqual(before);
});

test("long history, cursor retention, same timestamps, filters and date reset", async ({page,request,freshBackend:b}) => {
  const p = path.join(b.dataDir,"one"), q = path.join(b.dataDir,"two"); await mkdir(p); await mkdir(q);
  await call(request,b,"/projects",{path:p,name:"One"}); await call(request,b,"/projects",{path:q,name:"Two"});
  seed(b,Array.from({length:135},(_,i) => input(i,{projectPath:i % 2 ? p : q})));
  await open(page,b);
  await expect(page.getByTestId("activity-event")).toHaveCount(50);
  const first = await page.getByTestId("activity-event").first().getAttribute("data-id");
  await page.getByTestId("activity-more").click(); await expect(page.getByTestId("activity-event")).toHaveCount(100);
  await page.getByTestId("activity-more").click(); await expect(page.getByTestId("activity-event")).toHaveCount(135);
  expect(await page.getByTestId("activity-event").first().getAttribute("data-id")).toBe(first);
  const sequences = await page.getByTestId("activity-event").evaluateAll(nodes => nodes.map(n => Number(n.getAttribute("data-sequence"))));
  expect(new Set(sequences).size).toBe(135); expect(sequences).toEqual([...sequences].sort((a,b) => b-a));
  await expect(page.getByTestId("activity-day")).toHaveCount(2);
  const urls:string[]=[];page.on("request",r => {if(new URL(r.url()).pathname === "/activity") urls.push(r.url());});
  await page.getByTestId("activity-filter-project").selectOption(p);
  await expect(page.getByTestId("activity-event")).toHaveCount(50);
  expect(new URL(urls.at(-1)!).searchParams.has("cursor")).toBe(false);
  await page.getByTestId("activity-filter-actor").selectOption("employee");
  await expect(page.getByTestId("activity-empty")).toBeVisible(); // p contains owner-only events
  await page.getByTestId("activity-filter-project").selectOption("");
  await expect(page.getByTestId("activity-event")).toHaveCount(50);
  await page.getByTestId("activity-filter-actor-id").fill("ada");
  await expect.poll(() => new URL(urls.at(-1)!).searchParams.get("actorId")).toBe("ada");
  await page.getByTestId("activity-filter-type").selectOption("turn.submitted");
  await expect(page.getByTestId("activity-event")).toHaveCount(7);
  await page.getByTestId("activity-filter-from").fill("2026-10-27");
  await expect(page.getByTestId("activity-event")).toHaveCount(4);
  await page.getByTestId("activity-filter-to").fill("2026-10-26");
  await expect(page.getByRole("alert")).toContainText("start date");
  await expect(page.getByTestId("activity-event")).toHaveCount(0);
});

test("confirmed SSE update, duplicate notification, missed-page recovery, offline and unmount", async ({page,request,freshBackend:b}) => {
  // Observe the actual shared EventSource; injected lifecycle signals exercise App's recovery callbacks.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as any).__streams = [];
    window.EventSource = class extends Native { constructor(url:string | URL,options?:EventSourceInit) {super(url,options); (window as any).__streams.push(this);} };
  });
  await open(page,b); await expect(page.getByTestId("activity-empty")).toBeVisible();
  const live = await call(request,b,"/employees",{name:"Live Ada",jobTitle:"Engineer"});
  const archived = await request.delete(`${b.apiBase}/employees/${live.id}`, {headers:{authorization:`Bearer ${b.apiToken}`}});
  expect(archived.ok()).toBe(true);
  await expect(page.getByTestId("activity-event")).toHaveCount(1);
  const id = await page.getByTestId("activity-event").first().getAttribute("data-id");
  const original = page.locator(`[data-id="${id}"]`);
  await original.locator("summary").click();
  const focusedLink = original.getByRole("button",{name:/Open employee details/});
  await focusedLink.focus();
  await call(request,b,`/employees/${live.id}/unarchive`,{});
  await expect(page.getByTestId("activity-event")).toHaveCount(2);
  await expect(focusedLink).toBeFocused();
  await expect(original.locator("details")).toHaveAttribute("open", "");
  await page.evaluate(() => { const s=(window as any).__streams.findLast((s:any) => s.url.includes("/app/events") && s.readyState !== 2); s.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"activity_event",eventId:"not-in-sqlite",sequenceId:999999})})); });
  await expect(page.getByTestId("activity-event")).toHaveCount(2);
  await page.evaluate(() => (window as any).__streams.findLast((s:any) => s.url.includes("/app/events") && s.readyState !== 2).dispatchEvent(new Event("error")));
  await expect(page.getByTestId("activity-offline")).toBeVisible();
  seed(b,Array.from({length:115},(_,i)=> input(1000+i)));
  const catchups:string[]=[];page.on("request",r => {const u=new URL(r.url());if(u.pathname==="/activity" && u.searchParams.get("direction")==="forward")catchups.push(u.toString());});
  await page.evaluate(() => (window as any).__streams.findLast((s:any) => s.url.includes("/app/events") && s.readyState !== 2).dispatchEvent(new Event("open")));
  await expect(page.getByTestId("activity-event")).toHaveCount(117);
  await expect(page.getByTestId("activity-offline")).toHaveCount(0);
  expect(catchups.length).toBeGreaterThanOrEqual(3);
  expect(await page.getByTestId("activity-event").last().getAttribute("data-id")).toBe(id);
  expect(await page.evaluate(() => (window as any).__streams.filter((s:any) => s.url.includes("/app/events") && s.readyState !== 2).length)).toBe(1);
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByTestId("activity-offline")).toBeVisible();
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("activity-loading")).toHaveText("");
  await page.getByTestId("company-tab-dashboard").click();
  const after:string[]=[];page.on("request",r => {if(new URL(r.url()).pathname==="/activity")after.push(r.url());});
  await page.evaluate(() => (window as any).__streams.findLast((s:any) => s.url.includes("/app/events") && s.readyState !== 2).dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"activity_event"})})));
  await expect(page.getByTestId("company-dashboard")).toBeVisible();
  expect(after).toEqual([]);
});

test("missing entities and errors preserve history without sensitive error output", async ({page,freshBackend:b}) => {
  seed(b,[input(0)]);
  await open(page,b); const observed=writes(page);
  await page.getByTestId("activity-event").locator("summary").click();
  await page.getByRole("button",{name:"Open task details",exact:true}).click();
  await expect(page.getByTestId("activity-unavailable")).toBeVisible();
  await page.route("**/activity?*",route => route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"SENSITIVE_RAW_SERVER_ERROR"})}));
  await page.getByTestId("activity-refresh").click();
  await expect(page.getByTestId("activity-error")).toBeVisible();
  await expect(page.getByTestId("activity-event")).toHaveCount(1);
  await expect(page.getByTestId("activity-journal")).not.toContainText("SENSITIVE_RAW_SERVER_ERROR");
  await page.unroute("**/activity?*"); await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByTestId("activity-error")).toHaveCount(0);
  expect(observed).toEqual([]);
});

test("project entry stays scoped, existing employee/task navigation and employee filter", async ({page,request,freshBackend:b}) => {
  const p=path.join(b.dataDir,"project"); await mkdir(p);
  await call(request,b,"/projects",{path:p,name:"Scoped Project"});
  const employee=await call(request,b,"/employees",{name:"Scoped Ada",jobTitle:"Engineer",projectPath:p});
  const task=await call(request,b,"/tasks",{title:"Scoped Task",prompt:"NEVER_SHOW_PROMPT",workdir:p,isolation:"none",agent:"claude-code",column:"ready"});
  seed(b,[input(1,{projectPath:p,employeeId:employee.id,taskId:task.id,targetId:task.id}),input(2,{projectPath:"/foreign",payload:{taskTitle:"FOREIGN_PROJECT_MARKER"}})]);
  await open(page,b);
  await page.getByTestId("activity-filter-project").selectOption(p);
  await page.getByTestId("activity-filter-employee").selectOption(employee.id);
  await expect(page.getByTestId("activity-event")).toHaveCount(1);
  const row=page.locator('[data-event-type="employee.archived"]'); await row.locator("summary").click();
  await row.getByRole("button",{name:/Open employee details/}).click();
  await expect(page.getByTestId("employee-card")).toBeVisible();
  await page.getByTestId("company-tab-activity").click();
  const taskRow=page.locator('[data-event-type="employee.archived"]'); await taskRow.locator("summary").click();
  await taskRow.getByRole("button",{name:"Open project",exact:true}).click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
  await page.getByTestId("project-open-activity").click();
  await expect(page.getByTestId("activity-project-scope")).toContainText(p);
  await expect(page.getByTestId("activity-filter-project")).toBeDisabled();
  await expect(page.getByTestId("activity-event")).toHaveCount(1);
  await expect(page.getByTestId("activity-journal")).not.toContainText("FOREIGN_PROJECT_MARKER");
  await page.locator('[data-event-type="employee.archived"]').locator("summary").click();
  await page.getByRole("button",{name:"Open task details",exact:true}).click();
  await expect(page.getByRole("button",{name:"Close task details",exact:true})).toBeVisible();
  await expect(page.getByRole("complementary").last()).toContainText("Scoped Task");
});

test("keyboard, long Russian copy, themes, reduced motion/transparency and four widths", async ({page,freshBackend:b},info) => {
  seed(b,[input(0,{payload:{employeeName:"Длинное имя сотрудника ".repeat(6)}})]);
  await open(page,b);
  await page.keyboard.press("Alt+Shift+L");
  await page.emulateMedia({reducedMotion:"reduce"});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{name:"prefers-reduced-motion",value:"reduce"},{name:"prefers-reduced-transparency",value:"reduce"}] });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches)).toBe(true);
  expect(await page.getByTestId("company-page").evaluate(el => getComputedStyle(el).backdropFilter)).toBe("none");
  const tab=page.getByTestId("company-tab-activity"); await tab.focus(); await page.keyboard.press("Home");
  await expect(page.getByTestId("company-tab-dashboard")).toBeFocused();
  await page.keyboard.press("End"); await expect(tab).toBeFocused();
  for (const theme of ["light","dark"]) {
    await page.evaluate(theme => document.documentElement.classList.toggle("dark",theme==="dark"),theme);
    for (const width of [390,768,1024,1440]) {
      await page.setViewportSize({width,height:900});
      await expect(page.getByTestId("activity-journal")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
      const overflow=await page.getByTestId("activity-journal").evaluate(el=>el.scrollWidth>el.clientWidth+1); expect(overflow).toBe(false);
      await page.screenshot({path:info.outputPath(`journal-ru-${theme}-${width}.png`)});
    }
  }
  await page.getByTestId("activity-event").locator("summary").focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"Открыть задачу",exact:true})).toBeVisible();
});

test("filter races abort old requests and never restore foreign rows; pending requests abort on unmount", async ({page,freshBackend:b}) => {
  seed(b,[input(0),input(1)]);
  await open(page,b);
  let release: () => void = () => {};
  let seen: () => void = () => {};
  const held = new Promise<void>(r => { release=r; });
  const started = new Promise<void>(r => { seen=r; });
  const failures:string[]=[]; page.on("requestfailed",r => {if(new URL(r.url()).pathname==="/activity")failures.push(r.failure()?.errorText ?? "");});
  await page.route("**/activity?*",async route => {
    const url=new URL(route.request().url());
    if(url.searchParams.get("actorType")!=="owner") return route.continue();
    const result=await route.fetch(); seen(); await held;
    await route.fulfill({response:result}).catch(()=>{});
  });
  await page.getByTestId("activity-filter-actor").selectOption("owner"); await started;
  await page.getByTestId("activity-filter-actor").selectOption("employee");
  await expect(page.getByTestId("activity-event")).toHaveCount(1);
  await expect(page.getByTestId("activity-event")).toHaveAttribute("data-event-type","employee.hired");
  await expect.poll(()=>failures.length).toBeGreaterThan(0); release();
  await expect(page.getByTestId("activity-event")).toHaveAttribute("data-event-type","employee.hired");
  await page.unroute("**/activity?*");
  let unmountSeen: () => void = () => {};
  let finish: () => void = () => {};
  const unmountStarted=new Promise<void>(r => {unmountSeen=r;});
  const finishGate=new Promise<void>(r=>{finish=r;});
  await page.route("**/activity?*",async route => {unmountSeen();await finishGate; await route.abort().catch(()=>{});});
  await page.getByTestId("activity-filter-type").selectOption("run.completed"); await unmountStarted;
  const count=failures.length;await page.getByTestId("company-tab-dashboard").click();
  await expect.poll(()=>failures.length).toBeGreaterThan(count); finish();
  await expect(page.getByTestId("company-dashboard")).toBeVisible();
});

test("existing approval and Run history navigation preserve pending decisions and launch no Runtime", async ({page,request,freshBackend:b}) => {
  const p=path.join(b.dataDir,"approval-project");await mkdir(p);
  await call(request,b,"/projects",{path:p,name:"Approval Project"});
  const employee=await call(request,b,"/employees",{name:"Review Ada",jobTitle:"Engineer",projectPath:p});
  const task=await call(request,b,"/tasks",{title:"Review Task",prompt:"Owner prompt",workdir:p,isolation:"none",agent:"claude-code",column:"ready"});
  await call(request,b,"/assignment-proposals",{taskId:task.id,employeeId:employee.id,rationale:"Pending Owner decision"});
  const runId="fixture-completed-run";
  const db=new Database(path.join(b.dataDir,"agetor.sqlite"));
  try { db.run("INSERT INTO runs (id,task_id,agent,status,started_at,ended_at,exit_code) VALUES (?,?,'claude-code','succeeded',1000,2000,0)",[runId,task.id]); }
  finally {db.close();}
  seed(b,[input(800,{eventType:"run.completed",projectPath:p,taskId:task.id,targetId:task.id,employeeId:employee.id,runId})]);
  await open(page,b); const before=audit(b); const observed=writes(page);
  const proposed=page.locator('[data-event-type="task.assignment.proposed"]');
  await proposed.locator("summary").click();
  await proposed.getByRole("button",{name:"Open project approvals",exact:true}).click();
  await expect(page.getByTestId("assignment-proposal-approve")).toBeVisible();
  expect(audit(b)).toEqual(before);
  await page.getByTestId("project-open-activity").click();
  const completed=page.locator('[data-event-type="run.completed"]');await completed.locator("summary").click();
  await completed.getByRole("button",{name:"Open task / Run history",exact:true}).click();
  await expect(page.getByTestId("runs-list")).toBeVisible();
  await expect(page.getByTestId("runs-list")).toContainText("succeeded");
  // Destination screens already discover project docs and mark the task as read.
  // Only those exact existing navigation effects are allowed; approvals/Runtime are unchanged.
  expect(observed.filter(r => r !== "POST /projects/discover" && r !== `POST /tasks/${task.id}/seen`)).toEqual([]);
  expect(audit(b)).toEqual(before);
});

test("synthetic actors preserve subject links and Project Manager navigation; real actor UUIDs open separately", async ({page,request,freshBackend:b}) => {
  const p=path.join(b.dataDir,"manager-project"); await mkdir(p);
  await call(request,b,"/projects",{path:p,name:"Manager Project"});
  const subject=await call(request,b,"/employees",{name:"Subject Ada",jobTitle:"Engineer",projectPath:p});
  const manager=await call(request,b,"/employees",{name:"Manager Grace",jobTitle:"Manager",projectPath:p});
  const proposalId="fixture-manager-proposal";
  const db=new Database(path.join(b.dataDir,"agetor.sqlite"));
  try {
    db.run("INSERT INTO project_manager_proposals (id,project_path,status,data,created_at,updated_at) VALUES (?,?,'pending',?,1000,1000)",
      [proposalId,p,JSON.stringify({id:proposalId,projectPath:p,status:"pending",title:"Pending manager plan",items:[],createdAt:1000,updatedAt:1000})]);
  } finally {db.close();}
  const rows=seed(b,[
    input(900,{eventType:"task.proposal.created",actorType:"project-manager",actorId:"project-manager",projectPath:p,targetType:"proposal",targetId:proposalId,employeeId:subject.id,taskId:null,payload:{title:"Pending manager plan"}}),
    input(901,{eventType:"task.assignment.proposed",actorType:"project-manager",actorId:manager.id,projectPath:p,targetType:"proposal",targetId:"fixture-assignment",employeeId:subject.id,taskId:null}),
  ]);
  await open(page,b); const before=audit(b); const observed=writes(page);
  const synthetic=page.locator(`[data-id="${rows[0]!.id}"]`);
  await synthetic.locator("summary").click();
  await expect(synthetic.getByRole("button",{name:/Open employee details/})).toHaveCount(1);
  await expect(synthetic.getByRole("button",{name:"Open employee details · Subject Ada",exact:true})).toBeVisible();
  await expect(synthetic).not.toContainText(" · project-manager");
  const real=page.locator(`[data-id="${rows[1]!.id}"]`); await real.locator("summary").click();
  await expect(real.getByRole("button",{name:/Open employee details/})).toHaveCount(2);
  await real.getByRole("button",{name:"Open employee details · Manager Grace",exact:true}).click();
  await expect(page.getByTestId("employee-card")).toContainText("Manager Grace");
  await page.getByTestId("company-tab-activity").click();
  await synthetic.locator("summary").click();
  await synthetic.getByRole("button",{name:"Open project approvals",exact:true}).click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  expect(audit(b)).toEqual(before);
  expect(observed.filter(r=>r!=="POST /projects/discover")).toEqual([]);
});
