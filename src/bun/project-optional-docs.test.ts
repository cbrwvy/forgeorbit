import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-002.1: IDEA.md and PRD.md are optional. A project registered without
 * them must be a full workspace project, and nothing on the skip path may
 * write a document, start an agent, or call a model. Any process other than
 * git and any request outside this server fails the test.
 */

const isolated = mkdtempSync(path.join(tmpdir(), "fo0021-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "0";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo0021-cli";
}

let server: ReturnType<typeof import("./server.ts")["startApiServer"]>;
let token = "";
let base = "";
let db: typeof import("./db.ts");
let spawn: ReturnType<typeof spyOn>;
let spawnSync: ReturnType<typeof spyOn>;
let fetchGuard: ReturnType<typeof spyOn>;
let blockedProcesses: string[] = [];
let externalCalls = 0;
const root = mkdtempSync(path.join(tmpdir(), "fo0021-projects-"));

const argv0 = (command: unknown): string => {
  const list = Array.isArray(command) ? command : (command as { cmd?: unknown })?.cmd;
  return Array.isArray(list) ? String(list[0]) : String(command);
};

beforeAll(async () => {
  const realSpawn = Bun.spawn.bind(Bun);
  const realSpawnSync = Bun.spawnSync.bind(Bun);
  spawn = spyOn(Bun, "spawn").mockImplementation(((command: never, ...rest: never[]) => {
    const head = argv0(command);
    if (path.basename(head) !== "git") {
      blockedProcesses.push(head);
      throw new Error(`Unexpected process: ${head}`);
    }
    return (realSpawn as (...args: unknown[]) => unknown)(command, ...rest);
  }) as never);
  spawnSync = spyOn(Bun, "spawnSync").mockImplementation(((command: never, ...rest: never[]) => {
    const head = argv0(command);
    if (path.basename(head) !== "git") {
      blockedProcesses.push(head);
      throw new Error(`Unexpected process: ${head}`);
    }
    return (realSpawnSync as (...args: unknown[]) => unknown)(command, ...rest);
  }) as never);
  const original = globalThis.fetch;
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/`)) {
      externalCalls += 1;
      throw new Error("Unexpected external request");
    }
    return original(input, init);
  }) as typeof fetch);
  db = await import("./db.ts");
  const backend = await import("./server.ts");
  token = backend.API_TOKEN;
  server = backend.startApiServer();
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  spawn?.mockRestore();
  spawnSync?.mockRestore();
  fetchGuard?.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, route: string, value?: unknown) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) as any : null };
}

const enc = encodeURIComponent;

function folder(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

async function registerWithoutDocs(name: string): Promise<string> {
  const dir = folder(name);
  const discovered = await call("POST", "/projects/discover", { path: dir });
  expect(discovered.status).toBe(200);
  expect(discovered.json.documentation.state).toBe("none");
  const registered = await call("POST", "/projects", { path: dir, name, rejectDuplicate: true });
  expect(registered.status).toBe(200);
  return registered.json.path as string;
}

test("a project can be registered with no IDEA and no PRD and no file is created", async () => {
  const dir = folder("management-only");
  writeFileSync(path.join(dir, "notes.txt"), "keep\n");
  const before = listing(dir);
  const projectPath = await registerWithoutDocs("management-only");
  expect(listing(dir)).toEqual(before);
  expect(existsSync(path.join(dir, "IDEA.md"))).toBe(false);
  expect(existsSync(path.join(dir, "PRD.md"))).toBe(false);
  expect(existsSync(path.join(dir, "docs"))).toBe(false);
  expect(db.projects.get(projectPath)?.name).toBe("management-only");
  // Skipping stores nothing about documents: no meta row, no interview draft.
  expect(db.preferences.list()[`projectMeta.${enc(projectPath)}`]).toBeUndefined();
  expect((await call("GET", `/project-interviews/draft?path=${enc(projectPath)}`)).json).toEqual({ state: null });
});

test("skipping makes no hidden model call, no process, no task and no assignment change", async () => {
  expect(blockedProcesses).toEqual([]);
  expect(externalCalls).toBe(0);
  expect(db.tasks.list()).toEqual([]);
  expect(db.db.query(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });
  expect(db.db.query(`SELECT COUNT(*) AS n FROM project_manager_messages`).get()).toEqual({ n: 0 });
});

test("the project manager works without documents and reports them as missing, not failed", async () => {
  const projectPath = await registerWithoutDocs("pm-without-docs");
  const state = await call("GET", `/project-manager?path=${enc(projectPath)}`);
  expect(state.status).toBe(200);
  const context = await call("GET", `/project-manager/context?path=${enc(projectPath)}`);
  expect(context.status).toBe(200);
  const sources = context.json.sources as { id: string; status: string }[];
  expect(sources.find((source) => source.id === "idea")?.status).toBe("missing");
  expect(sources.find((source) => source.id === "prd")?.status).toBe("missing");
  expect(blockedProcesses).toEqual([]);
});

test("portfolio, knowledge and employees accept a project without documents", async () => {
  const projectPath = await registerWithoutDocs("compat");
  const portfolio = await call("GET", "/portfolio/analysis");
  expect(portfolio.status).toBe(200);
  expect(JSON.stringify(portfolio.json)).toContain(projectPath);

  const note = await call("POST", "/knowledge/documents", {
    ownerKind: "project", ownerId: projectPath, title: "Operating notes", content: "How this project is run.",
  });
  expect(note.status).toBe(201);

  const manager = await call("POST", "/employees/project-managers", { projectPath });
  expect(manager.status).toBe(201);
  const worker = await call("POST", "/employees", { jobTitle: "Operations Lead", projectPath });
  expect(worker.status).toBe(201);
  expect(worker.json.projectPath).toBe(projectPath);
  const other = await registerWithoutDocs("compat-other");
  const assigned = await call("POST", `/employees/${worker.json.id}/assign`, { projectPath: other });
  expect(assigned.status).toBe(200);
  expect(assigned.json.projectPath).toBe(other);
  expect(blockedProcesses).toEqual([]);
  expect(externalCalls).toBe(0);
});

test("IDEA can be created later without touching PRD, and PRD later without IDEA", async () => {
  const projectPath = await registerWithoutDocs("later");
  const idea = await call("POST", "/project-interviews/write-docs", {
    projectPath, files: [{ kind: "idea", path: "docs/IDEA.md", content: "# Later\n\nReal idea.\n" }],
  });
  expect(idea.status).toBe(200);
  expect(idea.json.results[0]).toMatchObject({ kind: "idea", path: "docs/IDEA.md", status: "created" });
  expect(readFileSync(path.join(projectPath, "docs", "IDEA.md"), "utf8")).toBe("# Later\n\nReal idea.\n");
  expect(existsSync(path.join(projectPath, "docs", "PRD.md"))).toBe(false);
  const discovered = await call("POST", "/projects/discover", { path: projectPath });
  expect(discovered.json.documentation.state).toBe("idea-only");

  const prd = await call("POST", "/project-interviews/write-docs", {
    projectPath, files: [{ kind: "prd", path: "docs/PRD.md", content: "# PRD\n\nFR-1\n" }],
  });
  expect(prd.json.results[0].status).toBe("created");
  expect(readFileSync(path.join(projectPath, "docs", "IDEA.md"), "utf8")).toBe("# Later\n\nReal idea.\n");
  expect((await call("POST", "/projects/discover", { path: projectPath })).json.documentation.state).toBe("both");
});

test("creating a PRD alone leaves IDEA absent: nothing is invented", async () => {
  const projectPath = await registerWithoutDocs("prd-only");
  const prd = await call("POST", "/project-interviews/write-docs", {
    projectPath, files: [{ kind: "prd", path: "docs/PRD.md", content: "# PRD\n" }],
  });
  expect(prd.json.results[0].status).toBe("created");
  expect(existsSync(path.join(projectPath, "docs", "IDEA.md"))).toBe(false);
  expect((await call("POST", "/projects/discover", { path: projectPath })).json.documentation.state).toBe("prd-only");
});

test("an existing document is never overwritten when creating later", async () => {
  const dir = folder("existing");
  mkdirSync(path.join(dir, "docs"));
  writeFileSync(path.join(dir, "docs", "IDEA.md"), "# Mine\n");
  const registered = await call("POST", "/projects", { path: dir, name: "existing", rejectDuplicate: true });
  const projectPath = registered.json.path as string;
  const check = await call("POST", "/project-interviews/check-docs", {
    projectPath, files: [{ kind: "idea", path: "docs/IDEA.md" }],
  });
  expect(check.json.checks[0].state).toBe("exists");
  const write = await call("POST", "/project-interviews/write-docs", {
    projectPath, files: [{ kind: "idea", path: "docs/IDEA.md", content: "# Replaced\n" }],
  });
  expect(write.status).toBeGreaterThanOrEqual(400);
  expect(readFileSync(path.join(dir, "docs", "IDEA.md"), "utf8")).toBe("# Mine\n");
});

test("a project's recorded document paths survive a restart of the stores", async () => {
  const projectPath = await registerWithoutDocs("meta-persist");
  const key = `projectMeta.${enc(projectPath)}`;
  const value = JSON.stringify({ description: "Ops", idea: "docs/IDEA.md" });
  expect((await call("PUT", `/preferences/${enc(key)}`, { value })).status).toBe(204);
  expect((await call("GET", "/preferences")).json[key]).toBe(value);
});
