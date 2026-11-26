import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { EmployeeCore } from "./employee-core.ts";

const isolated = mkdtempSync(path.join(tmpdir(), "fo010c-http-db-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo010c-cli";
}

let assignmentHttp: typeof import("./assignment-http.ts").assignmentHttp;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let classifyWorkdir: typeof import("./project-ownership.ts").classifyWorkdir;

beforeAll(async () => {
  ({ assignmentHttp } = await import("./assignment-http.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ classifyWorkdir } = await import("./project-ownership.ts"));
});

const A = "/registry/alpha";
const B = "/registry/beta";

function harness() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, 'Alpha', 5), (?, 'Beta', 5)`, [A, B]);
  const employees = new EmployeeCore(db, { now: () => 20, random: () => 0.2, pathExists: () => true, realpath: (value) => value });
  const ada = employees.createWorker({ name: "Ada", jobTitle: "QA Engineer", projectPath: A });
  const taskId = randomUUID();
  const otherId = randomUUID();
  db.run(
    `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, 'Alpha task', 'prompt', 'ready', 'codex', ?, 5, 5), (?, 'Beta task', 'prompt', 'ready', 'codex', ?, 5, 5)`,
    [taskId, A, otherId, B],
  );
  const core = new AssignmentCore(db, {
    now: () => 30,
    classify: (workdir) => classifyWorkdir([A, B], workdir),
  });
  return { db, ada, taskId, otherId, core };
}

async function call(core: InstanceType<typeof AssignmentCore>, method: string, route: string, body?: unknown, authorized = true) {
  const response = await assignmentHttp(new Request(`http://127.0.0.1${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), authorized, { core });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) as Record<string, unknown> : null };
}

test("the server mounts task assignments behind the bearer header, not a query token", () => {
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  expect(source).toContain('url.pathname === "/task-assignments" || url.pathname.startsWith("/task-assignments/")');
  expect(source).toContain("assignmentHttp(req, authorized)");
  expect(source).toContain('header?.startsWith("Bearer ")');
});

test("every assignment route rejects a missing bearer before it reads the body", async () => {
  const { core } = harness();
  const routes: [string, string, unknown][] = [
    ["GET", `/task-assignments?employeeId=${randomUUID()}`, undefined],
    ["POST", "/task-assignments", { taskId: randomUUID(), employeeId: randomUUID() }],
    ["POST", "/task-assignments/reassign", { taskId: randomUUID(), employeeId: randomUUID(), expectedRevision: 1 }],
    ["POST", "/task-assignments/unassign", { taskId: randomUUID(), expectedRevision: 1 }],
    ["GET", `/task-assignments/task?taskId=${randomUUID()}`, undefined],
    ["GET", `/task-assignments/history?taskId=${randomUUID()}`, undefined],
    ["GET", "/task-assignments/project?projectPath=%2Fregistry%2Falpha", undefined],
    ["GET", `/task-assignments/candidates?employeeId=${randomUUID()}`, undefined],
  ];
  for (const [method, route, body] of routes) {
    expect((await call(core, method, route, body, false)).status).toBe(401);
  }
});

test("writes accept only the assignment fields and do not start a router preview", async () => {
  const { db, core, ada, taskId, otherId } = harness();
  expect((await call(core, "POST", "/task-assignments", { taskId, employeeId: ada.id, model: "gpt-6" })).status).toBe(400);
  expect((await call(core, "POST", "/task-assignments", { taskId, employeeId: ada.id, command: "rm -rf /" })).status).toBe(400);
  expect((await call(core, "POST", "/task-assignments", { taskId, employeeId: ada.id, accountId: "acc" })).status).toBe(400);
  expect((await call(core, "POST", "/task-assignments", { taskId, employeeId: ada.id, projectPath: B })).status).toBe(400);
  expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 0 });
  expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });

  const created = await call(core, "POST", "/task-assignments", { taskId, employeeId: ada.id });
  expect(created.status).toBe(201);
  expect(created.json).toMatchObject({ created: true, routerHandoff: { status: "not-invoked" } });
  const again = await call(core, "POST", "/task-assignments", { taskId, employeeId: ada.id });
  expect(again.status).toBe(200);
  expect(again.json).toMatchObject({ created: false });

  const leaked = await call(core, "GET", `/task-assignments/project?projectPath=${encodeURIComponent(A)}&taskId=${otherId}`);
  expect(leaked.status).toBe(400);
  const listed = await call(core, "GET", `/task-assignments/project?projectPath=${encodeURIComponent(A)}`);
  expect(JSON.stringify(listed.json)).toContain(taskId);
  expect(JSON.stringify(listed.json)).not.toContain(otherId);
  const other = await call(core, "GET", `/task-assignments/project?projectPath=${encodeURIComponent(B)}`);
  expect(JSON.stringify(other.json)).not.toContain(taskId);

  const stale = await call(core, "POST", "/task-assignments/reassign", { taskId, employeeId: randomUUID(), expectedRevision: 9 });
  expect(stale.status).toBe(409);
  expect(db.query(`SELECT agent, model FROM tasks WHERE id = ?`).get(taskId)).toEqual({ agent: "codex", model: null });
});
