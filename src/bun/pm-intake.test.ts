import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "fo-pm-intake-"));

let db: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let pm: typeof import("./pm-intake.ts");
let grants: typeof import("./pm-intake-grants.ts");

beforeAll(async () => {
  db = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  pm = await import("./pm-intake.ts");
  grants = await import("./pm-intake-grants.ts");
});

async function backlogTask(projectPath: string, title: string) {
  db.projects.upsert(projectPath, "P");
  const result = await orchestrator.createTask({
    title,
    prompt: `${title}.\n\n## Acceptance criteria\n- ok`,
    workdir: projectPath,
    agent: "claude-code",
    isolation: "none",
    column: "backlog",
  } as never);
  if ("error" in result) throw new Error(result.error);
  return result.task;
}

describe("pm intake", () => {
  test("admitTaskToInbox moves backlog to inbox and blocks start", async () => {
    const projectPath = join(process.env.AGETOR_DATA_DIR!, "a");
    const task = await backlogTask(projectPath, "Draft");
    const result = pm.admitTaskToInbox(task.id, projectPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.column).toBe("inbox");
    expect(result.task.runId).toBeNull();
    const start = await orchestrator.startTask(task.id);
    expect(start).toMatchObject({ error: expect.stringMatching(/inbox|Ready/i) });
  });

  test("applyManagerIntakePromotions without grant is a no-op", async () => {
    const projectPath = join(process.env.AGETOR_DATA_DIR!, "b");
    const task = await backlogTask(projectPath, "Draft B");
    const lookup = new Map([[task.id.slice(0, 8), { id: task.id, title: task.title, column: task.column }]]);
    const text = `<intake_promotions>${JSON.stringify({ tasks: [`#${task.id.slice(0, 8)}`] })}</intake_promotions>`;
    const applied = pm.applyManagerIntakePromotions(projectPath, "m1", null, text, lookup);
    expect(applied.promoted).toEqual([]);
    expect(db.tasks.get(task.id)!.column).toBe("backlog");
  });

  test("applyManagerIntakePromotions with grant admits task", async () => {
    const projectPath = join(process.env.AGETOR_DATA_DIR!, "c");
    const task = await backlogTask(projectPath, "Draft C");
    const created = pm.createIntakeGrant(projectPath, null);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    grants.pmIntakeGrants.bindMessage(projectPath, created.grantId, "m2");
    const lookup = new Map([[task.id.slice(0, 8), { id: task.id, title: task.title, column: task.column }]]);
    const text = `<intake_promotions>${JSON.stringify({ tasks: [`#${task.id.slice(0, 8)}`] })}</intake_promotions>`;
    const applied = pm.applyManagerIntakePromotions(projectPath, "m2", created.grantId, text, lookup);
    expect(applied.promoted).toEqual([task.id]);
    expect(db.tasks.get(task.id)!.column).toBe("inbox");
  });
});
