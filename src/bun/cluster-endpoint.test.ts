import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = mkdtempSync(path.join(tmpdir(), "fo011a-api-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_API_PORT = "47011";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo011a-cli";
}

let server: ReturnType<typeof import("./server.ts")["startApiServer"]>;
let token: string;
let db: typeof import("./db.ts");
let spawn: ReturnType<typeof spyOn>;
let spawnSync: ReturnType<typeof spyOn>;
let fetchGuard: ReturnType<typeof spyOn>;
let externalCalls = 0;
const base = "http://127.0.0.1:47011";
const root = mkdtempSync(path.join(tmpdir(), "fo011a-projects-"));
const projectA = path.join(root, "example-project");
const projectB = path.join(root, "other");
const parent = path.join(root, "parent");
const child = path.join(parent, "child");
const main = path.join(root, "repo");
const worktree = path.join(root, "repo-wt");

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
  mkdirSync(projectA);
  mkdirSync(projectB);
  mkdirSync(path.join(child, "src"), { recursive: true });
  mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(worktree);
  writeFileSync(path.join(projectA, "keep.txt"), "a");
  writeFileSync(path.join(projectB, "keep.txt"), "b");
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  writeFileSync(path.join(main, ".git", "worktrees", "wt", "gitdir"), `${path.join(worktree, ".git")}\n`);
  writeFileSync(path.join(main, "keep.txt"), "repo");
  writeFileSync(path.join(worktree, "keep.txt"), "wt");
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
  // db.ts is cached across Bun test files. Release only this fixture's rows
  // after its no-write assertions, before another endpoint suite uses it.
  if (db) {
    db.db.run("DELETE FROM runs WHERE id = 'fo011a:run:a'");
    db.db.run("DELETE FROM tasks WHERE id IN ('fo011a:task:a', 'fo011a:task:b')");
    db.db.run("DELETE FROM project_managers WHERE project_path = ?", [projectB]);
    for (const projectPath of [projectA, projectB, parent, child, main]) db.projects.delete(projectPath);
  }
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

test("cluster routes require an exact bearer token", async () => {
  const routes: [string, string][] = [
    ["GET", "/clusters"],
    ["POST", "/clusters"],
    ["GET", "/clusters/00000000-0000-4000-8000-000000000001"],
    ["PATCH", "/clusters/00000000-0000-4000-8000-000000000001"],
    ["DELETE", "/clusters/00000000-0000-4000-8000-000000000001"],
    ["GET", "/clusters/unassigned-projects"],
    ["GET", "/clusters/membership?path=%2Ftmp"],
    ["POST", "/clusters/00000000-0000-4000-8000-000000000001/projects"],
    ["POST", "/clusters/00000000-0000-4000-8000-000000000001/projects/move"],
    ["DELETE", "/clusters/00000000-0000-4000-8000-000000000001/projects?path=%2Ftmp"],
    ["GET", "/clusters/00000000-0000-4000-8000-000000000001/summary"],
  ];
  for (const [method, route] of routes) {
    for (const authorization of [null, "Bearer wrong", `bearer ${token}`]) {
      expect((await call(method, route, undefined, authorization)).status).toBe(401);
    }
    expect((await call(method, `${route}${route.includes("?") ? "&" : "?"}token=${token}`, undefined, null)).status).toBe(401);
  }
  expect((await call("GET", "/clusters")).json).toMatchObject({ company: { id: "company:forgeorbit" }, clusters: [] });
});

test("API assigns, moves, and summarizes without changing projects, tasks, or files", async () => {
  db.projects.upsert(projectA, "ExampleApp");
  db.projects.upsert(projectB, "Other");
  db.projects.upsert(parent, "Parent");
  db.projects.upsert(child, "Child");
  db.projects.upsert(main, "Repo");
  db.db.run(
    `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('fo011a:task:a', 'A', 'prompt', 'running', 'codex', ?, 1, 1)`,
    [projectA],
  );
  db.db.run(
    `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('fo011a:task:b', 'B', 'prompt', 'review', 'codex', ?, 1, 1)`,
    [projectB],
  );
  db.db.run(`INSERT INTO runs (id, task_id, agent, status, started_at, ended_at) VALUES ('fo011a:run:a', 'fo011a:task:a', 'codex', 'succeeded', 1, 2)`);
  db.db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES (?, '{"name":"kept"}', 1)`, [projectB]);
  const files = () => ({
    a: readFileSync(path.join(projectA, "keep.txt"), "utf8"),
    b: readFileSync(path.join(projectB, "keep.txt"), "utf8"),
    repo: readFileSync(path.join(main, "keep.txt"), "utf8"),
    wt: readFileSync(path.join(worktree, "keep.txt"), "utf8"),
    aDir: readdirSync(projectA).sort(),
    repoDir: readdirSync(main).sort(),
  });
  const beforeFiles = files();
  const beforeTasks = db.db.query(`SELECT * FROM tasks ORDER BY id`).all();
  const beforeManagers = db.db.query(`SELECT * FROM project_managers`).all();
  const beforeProfiles = db.db.query(`SELECT * FROM agent_profiles`).all();

  expect((await call("POST", "/clusters", { name: "Lunarian Forge", secret: "nope" })).status).toBe(400);
  const created = await call("POST", "/clusters", { name: "Lunarian Forge", slug: "lunarian", priority: 1 });
  expect(created.status).toBe(201);
  const id = created.json?.id as string;
  const again = await call("POST", "/clusters", { name: "Lunarian Forge" });
  expect(again.status).toBe(201);
  expect(again.json?.id).not.toBe(id);
  expect((await call("PATCH", `/clusters/${id}`, { name: "Lunarian" })).json).toMatchObject({ id, name: "Lunarian" });
  expect((await call("POST", "/clusters", { name: "Clash", slug: "lunarian" })).status).toBe(409);
  expect((await call("POST", `/clusters/${id}/projects`, { projectPath: projectA })).status).toBe(201);
  expect((await call("POST", `/clusters/${id}/projects`, { projectPath: projectA })).status).toBe(409);
  expect((await call("POST", `/clusters/${id}/projects`, { projectPath: "/not/registered" })).status).toBe(404);
  expect((await call("POST", `/clusters/${id}/projects`, { projectPath: "relative" })).status).toBe(400);
  expect((await call("POST", `/clusters/${id}/projects`, { projectPath: worktree })).status).toBe(404);
  const beta = (await call("POST", "/clusters", { name: "Second" })).json?.id as string;
  expect((await call("POST", `/clusters/${beta}/projects/move`, { projectPath: projectA })).status).toBe(200);
  expect((await call("GET", `/clusters/${id}/projects`)).json).toEqual([]);
  expect((await call("DELETE", `/clusters/${beta}/projects?path=${encodeURIComponent(projectA)}`)).status).toBe(200);
  expect((await call("GET", "/clusters/unassigned-projects")).json).toEqual(
    expect.arrayContaining([expect.objectContaining({ projectPath: projectA, clusterId: null })]),
  );
  expect((await call("GET", `/clusters/membership?path=${encodeURIComponent(projectB)}`)).json).toMatchObject({ cluster: null, projectPath: projectB });
  expect((await call("GET", `/clusters/${id}`)).status).toBe(200);
  expect((await call("GET", "/clusters/not-a-uuid")).status).toBe(400);
  expect((await call("GET", "/clusters/00000000-0000-4000-8000-000000000099")).status).toBe(404);

  await call("POST", `/clusters/${id}/projects`, { projectPath: projectA });
  await call("POST", `/clusters/${id}/projects`, { projectPath: parent });
  const summary = await call("GET", `/clusters/${id}/summary`);
  expect(summary.status).toBe(200);
  const aggregate = summary.json?.aggregate as { memberPaths: string[]; counts: { tasks: { value: number | null }; pendingReviews: { value: number | null }; doneTasks: { value: number | null } } };
  expect(aggregate.memberPaths.sort()).toEqual([parent, projectA].sort());
  expect(aggregate.memberPaths).not.toContain(projectB);
  expect(aggregate.counts.tasks.value).toBe(1);
  expect(aggregate.counts.pendingReviews.value).toBe(0);
  expect(aggregate.counts.doneTasks.value).toBe(0);

  const portfolio = await call("GET", "/portfolio/analysis");
  expect(portfolio.status).toBe(200);
  const paths = ((portfolio.json?.snapshot as { projects: { path: string }[] }).projects).map((project) => project.path);
  for (const projectPath of [projectA, projectB, parent, child, main]) expect(paths).toContain(projectPath);

  const ownership = await import("./project-ownership.ts");
  const classified = ownership.classifyWorkdirs([main, parent, child], [worktree, path.join(child, "src")]);
  expect(classified.indirect).toContainEqual({ workdir: worktree, projectPath: main, via: "worktree" });
  expect(classified.byProject.get(child)).toContain(path.join(child, "src"));
  expect((await call("GET", `/clusters/membership?path=${encodeURIComponent(child)}`)).json).toMatchObject({ cluster: null });
  expect((await call("GET", `/clusters/membership?path=${encodeURIComponent(worktree)}`)).status).toBe(404);

  expect((await call("DELETE", `/clusters/${id}`)).json).toMatchObject({ id, archivedAt: expect.any(Number) });
  expect(db.projects.get(projectA)?.name).toBe("ExampleApp");
  expect(db.projects.get(projectB)?.name).toBe("Other");
  expect(db.db.query(`SELECT * FROM tasks ORDER BY id`).all()).toEqual(beforeTasks);
  expect(db.db.query(`SELECT * FROM project_managers`).all()).toEqual(beforeManagers);
  expect(db.db.query(`SELECT * FROM agent_profiles`).all()).toEqual(beforeProfiles);
  expect(files()).toEqual(beforeFiles);
  expect(spawn).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
  expect(externalCalls).toBe(0);
});
