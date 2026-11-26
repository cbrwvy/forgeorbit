import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = mkdtempSync(path.join(tmpdir(), "fo010a-api-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_API_PORT = "47110";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo010a-cli";
}

let server: ReturnType<typeof import("./server.ts")["startApiServer"]>;
let token: string;
let db: typeof import("./db.ts");
let spawn: ReturnType<typeof spyOn>;
let spawnSync: ReturnType<typeof spyOn>;
let fetchGuard: ReturnType<typeof spyOn>;
let externalCalls = 0;
const base = "http://127.0.0.1:47110";
const root = mkdtempSync(path.join(tmpdir(), "fo010a-projects-"));
const projectA = path.join(root, "alpha");
const projectB = path.join(root, "beta");
const unregistered = path.join(root, "stranger");

beforeAll(async () => {
  spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected process");
  });
  spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Unexpected process");
  });
  const fetchOriginal = globalThis.fetch;
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/`)) {
      externalCalls += 1;
      throw new Error("Unexpected external request");
    }
    return fetchOriginal(input, init);
  }) as typeof fetch);
  for (const dir of [projectA, projectB, unregistered]) mkdirSync(dir);
  db = await import("./db.ts");
  const backend = await import("./server.ts");
  token = backend.API_TOKEN;
  server = backend.startApiServer();
});

afterAll(() => {
  server?.stop(true);
  spawn?.mockRestore();
  spawnSync?.mockRestore();
  fetchGuard?.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, route: string, value?: unknown, authorization: string | null = `Bearer ${token}`) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) as any : null };
}

const encoded = (value: string) => encodeURIComponent(value);

test("employee routes require an exact bearer token before reading anything", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const routes: [string, string][] = [
    ["GET", "/employees"],
    ["POST", "/employees"],
    ["GET", "/employees/organization"],
    ["GET", "/employees/head"],
    ["PUT", "/employees/head"],
    ["GET", "/employees/project-team?projectPath=%2Ftmp"],
    ["GET", "/employees/project-managers?projectPath=%2Ftmp"],
    ["POST", "/employees/project-managers"],
    ["POST", "/employees/project-managers/initialize-existing"],
    ["GET", `/employees/${id}`],
    ["PATCH", `/employees/${id}`],
    ["DELETE", `/employees/${id}`],
    ["GET", `/employees/${id}/history`],
    ["POST", `/employees/${id}/regenerate-name`],
    ["POST", `/employees/${id}/assign`],
    ["POST", `/employees/${id}/unassign`],
    ["POST", `/employees/${id}/unarchive`],
  ];
  for (const [method, route] of routes) {
    for (const authorization of [null, "Bearer wrong", `bearer ${token}`]) {
      expect((await call(method, route, undefined, authorization)).status).toBe(401);
    }
    expect((await call(method, `${route}${route.includes("?") ? "&" : "?"}token=${token}`, undefined, null)).status).toBe(401);
  }
  expect((await call("GET", "/employees")).json).toEqual({ employees: [] });
});

test("the API runs the whole identity lifecycle without starting a process or touching other tables", async () => {
  db.projects.upsert(projectA, "Alpha");
  db.projects.upsert(projectB, "Beta");
  db.db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES (?, '{"language":"en"}', 1)`, [projectA]);
  db.db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('ta', 'A', 'prompt', 'running', 'codex', ?, 1, 1)`, [projectA]);
  const beforeTasks = db.db.query(`SELECT * FROM tasks ORDER BY id`).all();
  const beforeRuns = db.db.query(`SELECT * FROM runs`).all();
  const beforeProfiles = db.db.query(`SELECT * FROM agent_profiles`).all();
  const beforeManagers = db.db.query(`SELECT * FROM project_managers`).all();
  const beforeManagerState = await call("GET", `/project-manager?path=${encoded(projectA)}`);

  // Head: owner-named, one global position.
  expect((await call("PUT", "/employees/head", {})).status).toBe(400);
  expect((await call("PUT", "/employees/head", { name: "Ilse", jobTitle: "God" })).status).toBe(400);
  const head = await call("PUT", "/employees/head", { name: "Ilse" });
  expect(head.status).toBe(201);
  expect(head.json.employee).toMatchObject({ kind: "head", name: "Ilse", nameSource: "owner" });
  const headAgain = await call("PUT", "/employees/head", { name: "Ilse Marek" });
  expect(headAgain.status).toBe(200);
  expect(headAgain.json.employee.id).toBe(head.json.employee.id);
  expect((await call("GET", "/employees/head")).json.head.name).toBe("Ilse Marek");
  expect((await call("POST", `/employees/${head.json.employee.id}/regenerate-name`)).status).toBe(409);

  // Project manager: GET never creates; initialize-existing is idempotent.
  expect((await call("GET", `/employees/project-managers?projectPath=${encoded(projectA)}`)).json).toMatchObject({ projectPath: projectA, projectManager: null });
  expect((await call("GET", `/employees/project-managers?projectPath=${encoded(unregistered)}`)).status).toBe(404);
  expect((await call("POST", "/employees/project-managers", { projectPath: unregistered })).status).toBe(404);
  expect((await call("POST", "/employees/project-managers", { projectPath: "relative" })).status).toBe(400);
  expect((await call("POST", "/employees/project-managers", { projectPath: projectA, model: "x" })).status).toBe(400);
  const init = await call("POST", "/employees/project-managers/initialize-existing");
  expect(init.status).toBe(200);
  expect(init.json.created).toHaveLength(1);
  const manager = init.json.created[0];
  expect(manager).toMatchObject({ kind: "project-manager", projectPath: projectA, projectName: "Alpha" });
  expect((await call("POST", "/employees/project-managers/initialize-existing", {})).json).toMatchObject({ created: [], alreadyInitialized: 1 });
  const ensured = await call("POST", "/employees/project-managers", { projectPath: projectA });
  expect(ensured.status).toBe(200);
  expect(ensured.json).toMatchObject({ created: false, employee: { id: manager.id, name: manager.name } });
  const second = await call("POST", "/employees/project-managers", { projectPath: projectB, name: "Robin" });
  expect(second.status).toBe(201);
  expect(second.json.employee).toMatchObject({ name: "Robin", nameSource: "owner" });
  const read = (await call("GET", `/employees/${manager.id}`)).json;
  expect(read.name).toBe(manager.name);
  expect(read.history.map((event: any) => event.action)).toEqual(["initialize"]);

  // Workers: create, patch, rename, regenerate, assign, reassign, archive.
  expect((await call("POST", "/employees", { jobTitle: "QA Engineer", projectPath: unregistered })).status).toBe(404);
  expect((await call("POST", "/employees", { jobTitle: "QA Engineer", agentProfileId: "p" })).status).toBe(400);
  expect((await call("POST", "/employees", { jobTitle: "QA Engineer", model: "gpt" })).status).toBe(400);
  const created = await call("POST", "/employees", { jobTitle: "Senior Backend Engineer", specializations: ["APIs"], projectPath: projectA });
  expect(created.status).toBe(201);
  const worker = created.json;
  expect(worker).toMatchObject({ kind: "worker", nameSource: "generated", projectPath: projectA, runtimeBinding: { status: "none" }, authority: { grantsPermissions: false } });
  expect((await call("GET", `/employees/${worker.id}`)).json.name).toBe(worker.name);
  expect((await call("PATCH", `/employees/${worker.id}`, { name: "Ada", jobTitle: "Principal Engineer" })).json).toMatchObject({ id: worker.id, name: "Ada", nameSource: "owner", jobTitle: "Principal Engineer" });
  expect((await call("PATCH", `/employees/${worker.id}`, { projectPath: projectB })).status).toBe(400);
  expect((await call("PATCH", `/employees/${worker.id}`, {})).status).toBe(400);
  const redrawn = await call("POST", `/employees/${worker.id}/regenerate-name`);
  expect(redrawn.json).toMatchObject({ id: worker.id, nameSource: "generated" });
  expect(redrawn.json.name).not.toBe("Ada");
  expect((await call("POST", `/employees/${worker.id}/assign`, { projectPath: unregistered })).status).toBe(404);
  expect((await call("POST", `/employees/${worker.id}/assign`, { projectPath: projectB })).json.projectPath).toBe(projectB);
  expect((await call("POST", `/employees/${manager.id}/assign`, { projectPath: projectB })).status).toBe(409);
  expect((await call("GET", `/employees/${worker.id}/history`)).json.events.map((event: any) => event.action)).toEqual(["create", "update", "regenerate-name", "reassign"]);
  const team = await call("GET", `/employees/project-team?projectPath=${encoded(projectB)}`);
  expect(team.json).toMatchObject({ projectPath: projectB, projectManager: { name: "Robin" }, employees: [{ id: worker.id }] });
  expect((await call("GET", `/employees/project-team?projectPath=${encoded(projectA)}`)).json.employees).toEqual([]);
  expect((await call("GET", `/employees?projectPath=${encoded(projectB)}`)).json.employees.map((e: any) => e.kind)).toEqual(["project-manager", "worker"]);
  expect((await call("GET", "/employees?kind=wizard")).status).toBe(400);

  // Organization tree.
  const tree = (await call("GET", "/employees/organization")).json;
  expect(tree).toMatchObject({ company: { id: "company:forgeorbit" }, owner: { kind: "owner" }, head: { name: "Ilse Marek" } });
  expect(tree.unclusteredProjects.map((entry: any) => entry.projectPath).sort()).toEqual([projectA, projectB].sort());

  // Archive keeps everything.
  expect((await call("DELETE", `/employees/${worker.id}`)).json).toMatchObject({ status: "archived" });
  expect((await call("PATCH", `/employees/${worker.id}`, { name: "Nope" })).status).toBe(409);
  expect((await call("GET", `/employees/${worker.id}`)).status).toBe(200);
  expect((await call("GET", `/employees?projectPath=${encoded(projectB)}`)).json.employees.map((e: any) => e.id)).not.toContain(worker.id);
  expect((await call("GET", `/employees?projectPath=${encoded(projectB)}&archived=true`)).json.employees.map((e: any) => e.id)).toContain(worker.id);
  expect((await call("POST", `/employees/${worker.id}/unarchive`)).json.status).toBe("active");

  // Nothing outside the employee tables moved, and no process or network call happened.
  expect(db.db.query(`SELECT * FROM tasks ORDER BY id`).all()).toEqual(beforeTasks);
  expect(db.db.query(`SELECT * FROM runs`).all()).toEqual(beforeRuns);
  expect(db.db.query(`SELECT * FROM agent_profiles`).all()).toEqual(beforeProfiles);
  expect(db.db.query(`SELECT * FROM project_managers`).all()).toEqual(beforeManagers);
  expect((await call("GET", `/project-manager?path=${encoded(projectA)}`)).json).toEqual(beforeManagerState.json);
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
  expect(externalCalls).toBe(0);
});

test("there is no route that runs a model, binds a resource, or reaches outside /employees", async () => {
  const created = await call("POST", "/employees", { jobTitle: "DevOps Engineer" });
  const id = created.json.id as string;
  for (const [method, route] of [
    ["POST", `/employees/${id}/run`],
    ["POST", `/employees/${id}/start`],
    ["POST", `/employees/${id}/execute`],
    ["POST", `/employees/${id}/model`],
    ["PUT", `/employees/${id}/account`],
    ["GET", `/employees/${id}/runtime`],
    ["GET", `/employees/${id}/extra/segments`],
    ["PUT", "/employees"],
    ["DELETE", "/employees"],
    ["POST", "/employees/organization"],
    ["GET", "/employees/not-a-uuid"],
  ] as const) {
    const status = (await call(method, route, method === "GET" ? undefined : {})).status;
    expect([400, 404]).toContain(status);
  }
  expect(spawn).not.toHaveBeenCalled();
});

test("bodies are size-limited and JSON is validated", async () => {
  const big = await call("POST", "/employees", { jobTitle: "QA Engineer", description: "x".repeat(20_000) });
  expect(big.status).toBe(413);
  const response = await fetch(`${base}/employees`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{nope" });
  expect(response.status).toBe(400);
  const empty = await fetch(`${base}/employees`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(empty.status).toBe(400);
});
