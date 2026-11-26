import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { makeTask } from "../cli/test-fixtures.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-kanban-order-")));
process.env.HOME = path.join(root, "owner"); mkdirSync(process.env.HOME);
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
const { db, tasks, projects } = await import("./db.ts");
const { reorderTask, KanbanOrderError } = await import("./kanban-order.ts");
const { stopProjectLifecycle, getProjectLifecycle } = await import("./project-lifecycle.ts");
const { sortBoardTasks } = await import("../shared/board-order.ts");
const { migrate } = await import("./migrate.ts");
const { migrations } = await import("./migrations/index.ts");

const projectA = path.join(root, "projectA"); mkdirSync(projectA); projects.upsert(projectA, "A");
const projectB = path.join(root, "projectB"); mkdirSync(projectB); projects.upsert(projectB, "B");
let seq = 0;
const add = (urgency: number | undefined, extra: Record<string, unknown> = {}) =>
  tasks.insert(makeTask({ id: `t-${String(++seq).padStart(3, "0")}`, workdir: projectA, column: "ready", createdAt: 1000 + seq, updatedAt: 1000 + seq, ...(urgency === undefined ? {} : { urgency: urgency as 1 }), ...extra } as never));
const shown = (column = "ready", project = projectA) =>
  sortBoardTasks(tasks.list().filter((x) => x.column === column && x.workdir === project)).map((x) => x.id);
const move = (id: string, placement: unknown, expectedUrgency?: number) => {
  const task = tasks.get(id)!;
  return reorderTask(id, { expectedColumn: task.column, expectedUrgency: expectedUrgency ?? task.urgency, placement });
};
const refused = (fn: () => unknown): InstanceType<typeof KanbanOrderError> => { try { fn(); } catch (e) { if (e instanceof KanbanOrderError) return e; throw e; } throw new Error("expected a refusal"); };
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("a task created without urgency is Normal (3); all five levels are stored; new tasks go to the end of their group", () => {
  const ids = [1, 2, 3, 4, 5].map((u) => add(u).id);
  expect(ids.map((id) => tasks.get(id)!.urgency)).toEqual([1, 2, 3, 4, 5]);
  const normal = add(undefined);
  expect(normal.urgency).toBe(3);
  const second = add(3);
  expect(shown()).toEqual([ids[4]!, ids[3]!, ids[2]!, normal.id, second.id, ids[1]!, ids[0]!]);
});

test("the displayed order is urgency descending then the saved order, and dragging inside a group moves only that group", () => {
  const a = add(4), b = add(4), c = add(4);
  const before = shown();
  const result = move(c.id, { before: a.id });
  expect(result.rowsWritten).toBe(1);
  const after = shown();
  expect(after.filter((id) => [a.id, b.id, c.id].includes(id))).toEqual([c.id, a.id, b.id]);
  expect(after.filter((id) => ![a.id, b.id, c.id].includes(id))).toEqual(before.filter((id) => ![a.id, b.id, c.id].includes(id)));
  // The save changed nothing but the rank.
  const row = tasks.get(c.id)!;
  expect(row.urgency).toBe(4);
  expect(row.column).toBe("ready");
  expect(row.updatedAt).toBe(c.updatedAt);
});

test("the server refuses a position outside the urgency group; the board keeps its order", () => {
  const low = add(1), high = add(5);
  const orderBefore = shown();
  const e1 = refused(() => move(low.id, { before: high.id }));
  expect([e1.status, e1.code]).toEqual([409, "outside-group"]);
  const e2 = refused(() => move(high.id, { after: low.id }));
  expect([e2.status, e2.code]).toEqual([409, "outside-group"]);
  expect(shown()).toEqual(orderBefore);
});

test("a stale request (urgency or column changed) is refused with the canonical order; unknown fields and bad bodies are refused", () => {
  const a = add(2), b = add(2);
  const e = refused(() => reorderTask(a.id, { expectedColumn: "ready", expectedUrgency: 5, placement: "first" }));
  expect([e.status, e.code]).toEqual([409, "stale"]);
  expect(e.order).toContain(a.id);
  expect(refused(() => reorderTask(a.id, { expectedColumn: "review", expectedUrgency: 2, placement: "first" })).code).toBe("stale");
  expect(refused(() => reorderTask(a.id, { expectedColumn: "ready", expectedUrgency: 2, placement: "middle" })).code).toBe("placement");
  expect(refused(() => reorderTask(a.id, { expectedColumn: "ready", expectedUrgency: 9, placement: "first" })).code).toBe("expected-urgency");
  expect(refused(() => reorderTask("nope", { expectedColumn: "ready", expectedUrgency: 2, placement: "first" })).code).toBe("not-found");
  expect(refused(() => move(a.id, { after: a.id })).code).toBe("self-anchor");
  expect(b.id).toBeTruthy();
});

test("changing urgency moves the task to the END of its new group and changes nothing else", () => {
  const a = add(5), b = add(4), c = add(3), d = add(2);
  const before = tasks.get(d.id)!;
  const updated = tasks.update(d.id, { urgency: 5 })!;
  expect(updated.urgency).toBe(5);
  expect(updated.title).toBe(before.title);
  expect(updated.prompt).toBe(before.prompt);
  expect(updated.column).toBe(before.column);
  const order = shown();
  const fives = order.filter((id) => tasks.get(id)!.urgency === 5);
  expect(fives.at(-1)).toBe(d.id);
  expect(fives).toContain(a.id);
  expect(order.indexOf(d.id)).toBeLessThan(order.indexOf(b.id));
  expect(order.indexOf(b.id)).toBeLessThan(order.indexOf(c.id));
  // It can then be dragged above the other level-5 tasks.
  move(d.id, "first");
  expect(shown().filter((id) => tasks.get(id)!.urgency === 5)[0]).toBe(d.id);
});

test("an edit that stays in the group never reorders the board", () => {
  const a = add(3), b = add(3);
  move(b.id, "first");
  const order = shown();
  tasks.update(a.id, { title: "renamed" });
  tasks.update(b.id, { prompt: "other" });
  expect(shown()).toEqual(order);
});

test("columns keep independent orders; a task that changes column keeps its urgency and lands at the end of that urgency in the destination", () => {
  const r1 = add(3), r2 = add(3);
  const b1 = add(3, { column: "backlog" }), b2 = add(3, { column: "backlog" });
  move(r2.id, "first");
  move(b2.id, "first");
  expect(shown("ready").indexOf(r2.id)).toBeLessThan(shown("ready").indexOf(r1.id));
  expect(shown("backlog").indexOf(b2.id)).toBeLessThan(shown("backlog").indexOf(b1.id));
  const moved = tasks.update(r2.id, { column: "backlog" })!;
  expect(moved.urgency).toBe(3);
  const backlogThrees = shown("backlog").filter((id) => tasks.get(id)!.urgency === 3);
  expect(backlogThrees.at(-1)).toBe(r2.id);
  expect(shown("ready")).not.toContain(r2.id);
  expect(shown("backlog")).toContain(b2.id);
});

test("projects are ordered separately: an anchor from another project is refused, and moving inside A never changes B", () => {
  const a1 = add(3), a2 = add(3);
  const b1 = add(3, { workdir: projectB }), b2 = add(3, { workdir: projectB });
  const bBefore = shown("ready", projectB);
  const e = refused(() => move(a1.id, { after: b1.id }));
  expect(e.code).toBe("outside-group");
  move(a2.id, "first");
  expect(shown("ready", projectB)).toEqual(bBefore);
  expect(b2.id).toBeTruthy();
});

test("a filtered view names its visible neighbour; hidden tasks keep their relative order", () => {
  const ids = [add(3), add(3), add(3), add(3), add(3)].map((x) => x.id);
  const base = shown().filter((id) => ids.includes(id));
  // The viewer sees only the 1st, 3rd and 5th of these; drags the 5th after the 1st.
  const visible = [base[0]!, base[2]!, base[4]!];
  move(visible[2]!, { after: visible[0]! });
  const next = shown().filter((id) => ids.includes(id));
  expect(next).toEqual([base[0]!, base[4]!, base[1]!, base[2]!, base[3]!]);
});

test("a paused project can be reordered without being resumed; lifecycle, runs and statuses are untouched", async () => {
  const a = add(3), b = add(3);
  await stopProjectLifecycle(projectA, "paused for the test");
  const state = getProjectLifecycle(projectA)!.state;
  expect(["paused", "draining"]).toContain(state);
  const columnBefore = tasks.get(b.id)!.column;
  const runsBefore = db.query("SELECT count(*) AS n FROM runs").get();
  move(b.id, { before: a.id });
  expect(getProjectLifecycle(projectA)!.state).toBe(state);
  expect(tasks.get(b.id)!.column).toBe(columnBefore);
  expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual(runsBefore);
});

test("an archived task cannot be reordered", () => {
  const a = add(3);
  tasks.update(a.id, { archivedAt: Date.now() });
  expect(refused(() => move(a.id, "first")).code).toBe("archived");
});

test("concurrent reorders never corrupt the order: every rank stays distinct and the group stays complete", async () => {
  const ids = Array.from({ length: 12 }, () => add(2).id);
  const all = () => shown().filter((id) => ids.includes(id));
  let seed = 11;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  await Promise.all(Array.from({ length: 400 }, (_, i) => Promise.resolve().then(() => {
    const id = ids[Math.floor(rand() * ids.length)]!;
    const other = ids.filter((x) => x !== id)[Math.floor(rand() * (ids.length - 1))]!;
    try { move(id, i % 2 ? { after: other } : { before: other }); } catch (e) { if (!(e instanceof KanbanOrderError)) throw e; }
  })));
  const order = all();
  expect(order.length).toBe(ids.length);
  expect(new Set(order).size).toBe(ids.length);
  const ranks = ids.map((id) => tasks.get(id)!.boardRank);
  expect(new Set(ranks).size).toBe(ids.length);
});

test("duplicate or corrupt stored ranks are repaired by the next reorder and read deterministically before", () => {
  const ids = [add(4), add(4), add(4)].map((x) => x.id);
  db.run(`UPDATE tasks SET board_rank = 7 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  const first = shown().filter((id) => ids.includes(id));
  expect(shown().filter((id) => ids.includes(id))).toEqual(first);
  move(ids[2]!, "first");
  const ranks = ids.map((id) => tasks.get(id)!.boardRank);
  expect(new Set(ranks).size).toBe(3);
  expect(shown().filter((id) => ids.includes(id))[0]).toBe(ids[2]);
});

test("creating a task with an invalid urgency is refused by the shared validator", async () => {
  const { isUrgency } = await import("../shared/board-order.ts");
  for (const bad of [0, 6, 2.5, "3", null, Number.NaN]) expect(isUrgency(bad)).toBe(false);
});

test("migration 152: existing tasks become Normal, keep their newest-first order per column, and keep every other field", () => {
  const legacy = new Database(":memory:");
  legacy.exec("PRAGMA foreign_keys = ON");
  const upTo151 = migrations.filter((m) => m.id < "152");
  migrate(legacy, upTo151);
  const insert = (id: string, column: string, createdAt: number) =>
    legacy.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, [id, `title ${id}`, "prompt", column, "claude-code", "/p", createdAt, createdAt]);
  insert("old", "ready", 100); insert("mid", "ready", 200); insert("new", "ready", 300); insert("other", "backlog", 50);
  migrate(legacy, migrations);
  const rows = legacy.query<{ id: string; urgency: number; board_rank: number; title: string }, []>(`SELECT id, urgency, board_rank, title FROM tasks ORDER BY id`).all();
  expect(rows.every((r) => r.urgency === 3)).toBe(true);
  expect(rows.find((r) => r.id === "old")!.title).toBe("title old");
  const readyOrder = legacy.query<{ id: string }, []>(`SELECT id FROM tasks WHERE "column"='ready' ORDER BY urgency DESC, board_rank ASC, created_at ASC, id ASC`).all().map((r) => r.id);
  expect(readyOrder).toEqual(["new", "mid", "old"]);
  expect(legacy.query(`SELECT board_rank AS r FROM tasks WHERE id = 'other'`).get()).toEqual({ r: 1024 });
  expect(() => legacy.run(`UPDATE tasks SET urgency = 6 WHERE id = 'old'`)).toThrow();
  legacy.close();
});

test("urgency and order never touch the scheduling priority or the dependency links the batch scheduler reads", () => {
  const a = add(3).id; const b = add(3).id; const c = add(5).id;
  db.run(`INSERT INTO task_priorities(task_id, priority, updated_at) VALUES (?, 'low', 1), (?, 'critical', 1)`, [a, b]);
  db.run(`INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, 1)`, [a, c]);
  const snapshot = () => JSON.stringify([
    db.query(`SELECT task_id, priority, updated_at FROM task_priorities ORDER BY task_id`).all(),
    db.query(`SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id`).all(),
  ]);
  const before = snapshot();
  move(a, { after: b });
  tasks.update(a, { urgency: 5 } as never);
  move(b, "last", 3);
  expect(snapshot()).toBe(before);
  expect(tasks.get(a)!.urgency).toBe(5);
});

test("the saved order survives a restart: a new process on the same data folder reads the same order", () => {
  const x = add(4).id; const y = add(4).id; const z = add(4).id;
  move(z, "first");
  const expected = shown().filter((id) => [x, y, z].includes(id));
  expect(expected[0]).toBe(z);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const script = `
    const { tasks } = await import(${JSON.stringify(path.join(import.meta.dir, "db.ts"))});
    const { sortBoardTasks } = await import(${JSON.stringify(path.join(import.meta.dir, "../shared/board-order.ts"))});
    const ids = sortBoardTasks(tasks.list().filter((t) => t.column === "ready" && t.workdir === ${JSON.stringify(projectA)})).map((t) => t.id);
    console.log(JSON.stringify(ids));
  `;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, AGETOR_DATA_DIR: path.join(root, "data") }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const lines = run.stdout.toString().trim().split("\n");
  const reread: string[] = JSON.parse(lines[lines.length - 1]!);
  expect(reread.filter((id) => [x, y, z].includes(id))).toEqual(expected);
  expect(reread).toEqual(shown());
});
