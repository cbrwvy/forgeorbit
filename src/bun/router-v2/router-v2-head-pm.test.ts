import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { db, tasks, projects } from "../db.ts";
import { gatherScopedHeadContext, resolveHeadScope } from "../head-pm-scope.ts";
import { saveHeadBoardDraft, resolveHeadBoardProposal } from "../head-board-proposals.ts";
import { EmployeeCore } from "../employee-core.ts";
import { AssignmentCore } from "../assignment-core.ts";
import { routerV2Service } from "./router-v2-service.ts";
import type { HeadScopeSnapshot } from "../../shared/head-pm-scope.ts";

describe("Router 2.0 — Head of PM Integration", () => {
  const testProject = "/tmp/forgeorbit-test-project-head";

  beforeEach(() => {
    fs.mkdirSync(testProject, { recursive: true });
    // Ensure test project exists in db
    db.run("INSERT OR IGNORE INTO projects (path, name, added_at, lifecycle_state) VALUES (?, ?, ?, 'running')", [
      testProject,
      "Test Project Head",
      Date.now(),
    ]);

    // Ensure codex harness is enabled
    db.run("INSERT OR IGNORE INTO harnesses (id, kind, label, enabled) VALUES ('codex', 'codex', 'Codex', 1)");
    db.run("UPDATE harnesses SET enabled = 1 WHERE id = 'codex'");
  });

  afterEach(() => {
    fs.rmSync(testProject, { recursive: true, force: true });
  });

  test("gatherScopedHeadContext includes Router 2.0 active policy and task recommendations", () => {
    // Insert a test task
    const taskId = "task-head-route-1";
    db.run(
      "INSERT OR REPLACE INTO tasks (id, title, prompt, column, agent, workdir, created_at, updated_at) VALUES (?, ?, 'Prompt text', 'ready', 'codex', ?, ?, ?)",
      [taskId, "Implement Secure Auth Module", testProject, Date.now(), Date.now()],
    );

    const resolved = resolveHeadScope({ kind: "task", id: taskId });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const scope = resolved.value;

    const ctx = gatherScopedHeadContext(scope);
    expect(ctx.context.projects.length).toBeGreaterThan(0);
    const pLines = ctx.context.projects[0]!.lines;

    // Verify Router 2.0 policy is disclosed
    expect(pLines.some((l) => l.includes("Router 2.0 policy:"))).toBe(true);

    // Verify recommendations for Developer and Reviewer are present
    expect(pLines.some((l) => l.includes("Router 2.0 recommended developer:"))).toBe(true);
    expect(pLines.some((l) => l.includes("Router 2.0 recommended reviewer:"))).toBe(true);
  });

  test("Applying plan_execution board proposal records router decision without starting worker", async () => {
    const taskId = crypto.randomUUID();
    const now = Date.now();
    db.run("INSERT OR REPLACE INTO tasks (id, title, prompt, workdir, agent, column, isolation, created_at, updated_at) VALUES (?, ?, 'Prompt text', ?, 'codex', 'ready', 'none', ?, ?)", [
      taskId,
      "Architecture Review Task",
      testProject,
      now,
      now,
    ]);

    const dev = new EmployeeCore(db).createWorker({ name: "Dev Specialist", jobTitle: "Developer", projectPath: testProject });
    new AssignmentCore(db).assign(taskId, dev.id);

    const messageId = "msg-plan-1";
    const resolved = resolveHeadScope({ kind: "project", path: testProject });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const scope = resolved.value;

    saveHeadBoardDraft(messageId, scope, {
      kind: "plan_execution",
      taskId,
      title: "Architecture Review Task",
      employeeId: dev.id,
      employeeName: dev.name,
      harnessId: "codex",
      model: "gpt-6.1-sol",
      mode: "auto",
    });

    const applyRes = await resolveHeadBoardProposal(messageId, { confirm: true }, "approve");
    expect(applyRes.ok).toBe(true);
    if (applyRes.ok) {
      expect(applyRes.value.status).toBe("applied");
    }

    // Verify decision was recorded in router_v2_decisions
    const decisions = routerV2Service.listDecisions(10);
    const found = decisions.find((d) => d.taskId === taskId);
    expect(found).toBeDefined();
    expect(found?.selectedHarnessId).toBe("codex");
    expect(found?.selectedModelId).toBe("gpt-6.1-sol");

    // Verify no worker was started (task remains in ready column or review attempt in awaiting-approval)
    const task = tasks.get(taskId);
    expect(task?.column).toBe("ready");
  });
});
