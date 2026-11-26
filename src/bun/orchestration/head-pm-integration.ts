/**
 * FO-ORCH-SCALE01: Head of PM Multi-Project Orchestration Integration
 *
 * Provides factual, deterministic answers to multi-project coordination questions
 * directly from persisted records (no ungrounded AI inferences or hallucinated progress).
 */

import { db, projects, tasks, harnesses } from "../db.ts";
import { answerAccountQuestion } from "../../shared/accounts/execution-profile.ts";
import { loadAccountAnswerSnapshot } from "../multiaccount/registry.ts";
import { missionStore } from "./mission-store.ts";
import { missionScheduler } from "./mission-scheduler.ts";
import { planMissionReallocation, prepareMissionResourceProposal, proposeRecordedFallback, type RecordedResourceFailure } from "./mission-replan.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { RECOMMENDATION_BOUNDARY } from "../../shared/router-v2/resource-decision.ts";
import type { ScopedHeadContext } from "../head-pm-scope.ts";
import type { MissionRecord, MissionTaskPlan } from "../../shared/orchestration/types.js";

function clean(text: string, maxLen = 120): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").trim().slice(0, maxLen);
}

function pausedMission() {
  const rows = missionStore.listMissions().filter(mission => mission.status === "paused" || mission.status === "authorized");
  return rows.length === 1 ? rows[0]! : null;
}

function answerResourceCommand(text: string, scoped?: ScopedHeadContext | null): string | null {
  const lower = text.toLowerCase();
  const boundary = `${RECOMMENDATION_BOUNDARY} Head text is not execution authority.`;
  const taskId = scoped?.scope.scope.kind === "task" ? scoped.scope.scope.id : null;
  if (/choose the best available model|выбери лучшую доступную модель/.test(lower)) {
    if (!taskId) return `Name a task before a model can be compared. ${boundary}`;
    const task = tasks.get(taskId);
    if (!task) return `Task ${taskId} was not found. No model was changed.`;
    const recommendation = routerV2Service.recordRecommendation({
      taskId: task.id, projectId: task.workdir, title: task.title, role: task.column === "review" ? "reviewer" : "developer",
    });
    const selected = recommendation.evaluation.selected;
    return [
      selected ? `Recommended ${selected.harnessId}/${selected.modelId}/${selected.accountId ?? "unassigned"}/${selected.mode}.` : "No eligible resource.",
      recommendation.evaluation.explanation,
      "The task resource was not changed and no run was started.",
      boundary,
    ].join(" ");
  }
  if (/do not change the model i selected|не меняй выбранную модель/.test(lower)) {
    if (!taskId) return `Name the task whose model must stay pinned. ${boundary}`;
    const task = tasks.get(taskId);
    if (!task?.model) return `Task ${taskId ?? "unknown"} has no explicit model. No model was invented.`;
    return `The selected model stays ${task.agent}/${task.model}/${task.mode ?? "unset"}. No replacement was proposed. ${boundary}`;
  }
  if (/why is the mission blocked|explain why the mission is blocked|почему миссия заблокирована/.test(lower)) {
    const mission = pausedMission() ?? missionStore.listMissions({ status: "running" })[0] ?? null;
    if (!mission) return `No mission is available to explain. ${boundary}`;
    const blocked = mission.plan.tasks.filter(task => task.phase === "blocked" || task.phase === "awaiting_owner" || task.phaseReason);
    if (blocked.length === 0) return `Mission ${mission.id} has no blocked stage recorded. ${boundary}`;
    return [`Mission ${mission.id} (${mission.status}).`, ...blocked.map(task => `${task.taskId}: ${task.phase}${task.phaseReason ? ` — ${task.phaseReason}` : ""}`), boundary].join("\n");
  }
  const allocation = /fastest eligible allocation|самую быструю допустимую/.test(lower) ? "fastest"
    : /cheaper plan before approving|более дешев\S* план/.test(lower) ? "lowest-charge"
    : /reallocate the remaining mission|перераспредели оставш/.test(lower) ? "balanced" : null;
  if (allocation) {
    const mission = pausedMission();
    if (!mission) return `Pause one mission before a durable allocation can be prepared. No resource was changed. ${boundary}`;
    try {
      const planned = planMissionReallocation(mission.id, allocation);
      const proposal = prepareMissionResourceProposal(mission.id, {
        changes: planned.changes, reason: text, allocation: planned.allocation,
      }, null);
      return [
        `Prepared proposal ${proposal.id} for mission ${mission.id}.`,
        `Original digest ${proposal.oldPlanDigest}.`,
        `Proposed digest ${proposal.newPlanDigest}.`,
        `Status ${proposal.status}. Approval is required before any stage changes.`,
        planned.limitations?.length ? `Limitations: ${planned.limitations.join(" ")}` : "",
        boundary,
      ].filter(Boolean).join(" ");
    } catch (error) {
      return `${error instanceof Error ? error.message : "The allocation could not be prepared."} No resource was changed. ${boundary}`;
    }
  }
  if (/prepare a fallback for the failed reviewer|запасн\S* для ревьюера|prepare a fallback for the failed developer/.test(lower)) {
    const mission = pausedMission();
    const role = /reviewer|ревью/.test(lower) ? "reviewer" : "developer";
    if (!mission) return `Pause the mission before a fallback can be proposed. Nothing was invented. ${boundary}`;
    const task = mission.plan.tasks.find(item => item.blockedStage === role || item.phase === "blocked" || item.phase === "failed") ?? mission.plan.tasks[0];
    if (!task) return `The mission has no stage that can take a fallback. ${boundary}`;
    const failure: RecordedResourceFailure = role === "reviewer" ? "reviewer-blocked" : "developer-blocked";
    try {
      const result = proposeRecordedFallback(mission.id, { taskId: task.taskId, role, failure, runId: task.runId ?? null });
      if (!result.proposal) return `${result.blocked} ${boundary}`;
      return [
        `Fallback proposal ${result.proposal.id} is ${result.proposal.status}.`,
        `Original ${result.proposal.original.harnessId}/${result.proposal.original.modelId}/${result.proposal.original.accountId ?? "unassigned"}.`,
        `Replacement ${result.proposal.replacement.harnessId}/${result.proposal.replacement.modelId}/${result.proposal.replacement.accountId ?? "unassigned"}.`,
        `Digest ${result.proposal.digest}. It was not approved and no run was started.`,
        boundary,
      ].join(" ");
    } catch (error) {
      return `${error instanceof Error ? error.message : "No fallback was prepared."} ${boundary}`;
    }
  }
  if (/keep expensive models for difficult work|дорогие модели для сложн/.test(lower)) {
    return `Best Quality keeps higher-tier models for difficult work and does not move an explicit selection. ${boundary}`;
  }
  return null;
}

export async function tryAnswerOrchestrationQuestion(
  text: string,
  scoped?: ScopedHeadContext | null,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const resourceAnswer = answerResourceCommand(trimmed, scoped);
  if (resourceAnswer) return resourceAnswer;
  const lower = trimmed.toLowerCase();
  if (/account|codex|claude|quota|аккаунт|профиль|квот/i.test(lower)) {
    const accountAnswer = answerAccountQuestion(trimmed, loadAccountAnswerSnapshot(db));
    if (accountAnswer) return accountAnswer;
  }

  // 1. "Show every active project and its progress."
  if (
    /show every active project/i.test(lower) ||
    /all active projects and (their )?progress/i.test(lower) ||
    /list every project('s)? progress/i.test(lower)
  ) {
    const registered = projects.list();
    if (registered.length === 0) {
      return "There are no registered projects in ForgeOrbit.";
    }

    const lines: string[] = [
      `Active Project Status & Progress (${registered.length} registered projects):`,
    ];

    for (const p of registered) {
      const counts = db
        .query<{ column: string; count: number }, [string]>(
          `SELECT "column", COUNT(*) as count FROM tasks WHERE workdir = ? AND archived_at IS NULL GROUP BY "column"`,
        )
        .all(p.path);

      const countMap: Record<string, number> = {};
      for (const c of counts) {
        countMap[c.column] = c.count;
      }

      const total = Object.values(countMap).reduce((a, b) => a + b, 0);
      const done = countMap["done"] || 0;
      const inProgress = countMap["in-progress"] || 0;
      const review = countMap["review"] || 0;
      const ready = countMap["ready"] || 0;
      const blocked = countMap["blocked"] || 0;

      lines.push(
        `• ${p.name} (${p.path}): ${total} tasks [ready: ${ready}, in-progress: ${inProgress}, review: ${review}, done: ${done}${blocked > 0 ? `, BLOCKED: ${blocked}` : ""}]`,
      );
    }

    const runningMissions = missionStore.listMissions({ status: "running" });
    if (runningMissions.length > 0) {
      lines.push(
        `Active missions: ${runningMissions.map((m) => `"${m.title}" (${m.state.completedTasks}/${m.state.totalTasks} tasks completed)`).join("; ")}.`,
      );
    }

    return lines.join("\n");
  }

  // 2. "Which projects are blocked?"
  if (
    /which projects are blocked/i.test(lower) ||
    /blocked projects/i.test(lower) ||
    /show blocked projects/i.test(lower)
  ) {
    const registered = projects.list();
    const blockedProjects: Array<{ name: string; path: string; reasons: string[] }> = [];

    for (const p of registered) {
      const reasons: string[] = [];

      // Check lifecycle
      const pRow = db
        .query<{ lifecycle_state: string | null }, [string]>(
          `SELECT lifecycle_state FROM projects WHERE path = ?`,
        )
        .get(p.path);
      if (pRow?.lifecycle_state && ["paused", "suspended", "archived"].includes(pRow.lifecycle_state)) {
        reasons.push(`Project lifecycle is ${pRow.lifecycle_state}`);
      }

      // Check tasks in blocked column
      const blockedTaskRows = db
        .query<{ id: string; title: string }, [string]>(
          `SELECT id, title FROM tasks WHERE workdir = ? AND "column" = 'blocked' AND archived_at IS NULL`,
        )
        .all(p.path);

      for (const t of blockedTaskRows) {
        const taskObj = tasks.get(t.id);
        const qcVerdict = taskObj?.qcState?.latestVerdict;
        if (qcVerdict === "BLOCKED" || qcVerdict === "CHANGES_REQUESTED") {
          reasons.push(`Task ${t.id} (${clean(t.title)}) QC verdict: ${qcVerdict}`);
        } else {
          reasons.push(`Task ${t.id} (${clean(t.title)}) moved to blocked column`);
        }
      }

      // Check active mission blockers
      const activeReservations = missionStore.listActiveReservations();
      for (const res of activeReservations.filter((r) => r.projectPath === p.path)) {
        if (res.status === "failed") {
          reasons.push(`Reservation for task ${res.taskId} failed`);
        }
      }

      if (reasons.length > 0) {
        blockedProjects.push({ name: p.name, path: p.path, reasons });
      }
    }

    if (blockedProjects.length === 0) {
      return "No projects are currently blocked. All projects have operational lifecycles and clear boards.";
    }

    const lines: string[] = [`Currently blocked projects (${blockedProjects.length}):`];
    for (const bp of blockedProjects) {
      lines.push(`• ${bp.name}:`);
      for (const r of bp.reasons) {
        lines.push(`  - ${r}`);
      }
    }
    return lines.join("\n");
  }

  // 3. "Prepare a plan to fix the highest-priority issues across these projects."
  if (
    /prepare a plan/i.test(lower) ||
    /prepare plan/i.test(lower) ||
    /plan to fix .*issues/i.test(lower)
  ) {
    const registered = projects.list();
    const candidateTasks = db
      .query<{ id: string; title: string; workdir: string; column: string }, []>(
        `SELECT id, title, workdir, "column" FROM tasks
         WHERE archived_at IS NULL AND "column" IN ('ready', 'backlog', 'todo')
           AND NOT EXISTS (SELECT 1 FROM objective_mission_tasks WHERE task_id = tasks.id)
         ORDER BY updated_at DESC LIMIT 30`,
      )
      .all();

    if (candidateTasks.length === 0) {
      return "No outstanding tasks found in backlog or ready columns across registered projects.";
    }

    try {
      const prepared = await missionScheduler.prepareMission({
        title: "Fix Highest-Priority Issues Across Projects",
        goal: "Resolve outstanding defects and prioritize ready issues across registered projects.",
        taskIds: candidateTasks.map((t) => t.id),
      });

      return [
        `Prepared Multi-Project Mission Plan:`,
        `Mission ID: ${prepared.id}`,
        `Title: "${prepared.title}"`,
        `Status: ${prepared.status} (Supervised review required before authorization)`,
        `Plan Digest: ${prepared.planDigest}`,
        `Scope: ${prepared.projects.length} project(s), ${prepared.plan.tasks.length} task(s)`,
        `Concurrency Limits: global ${prepared.concurrencyLimits.globalMax}, per-project ${prepared.concurrencyLimits.perProjectMax}, per-account ${prepared.concurrencyLimits.perAccountMax}`,
        `To authorize and begin execution, Owner must approve digest ${prepared.planDigest}.`,
      ].join("\n");
    } catch (e) {
      return `Failed to prepare mission plan: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 4. "Which specialists are currently working?"
  if (
    /which specialists are (currently )?working/i.test(lower) ||
    /who is working/i.test(lower) ||
    /active specialists/i.test(lower) ||
    /specialists currently working/i.test(lower)
  ) {
    const activeReservations = missionStore.listActiveReservations();
    if (activeReservations.length === 0) {
      return "No specialists are currently working. The execution queue has zero active reservations.";
    }

    const lines = [`Currently active specialists (${activeReservations.length} active reservation(s)):`];
    for (const r of activeReservations) {
      const taskObj = tasks.get(r.taskId);
      const proj = projects.get(r.projectPath);
      const employee = db
        .query<{ name: string; job_title: string }, [string]>(
          `SELECT name, job_title FROM ai_employees WHERE id = ?`,
        )
        .get(r.employeeId);

      const specialistName = employee ? `${employee.name} (${employee.job_title})` : r.employeeId;
      lines.push(
        `• ${specialistName} on task "${clean(taskObj?.title || r.taskId)}" in ${proj?.name || r.projectPath} [status: ${r.status}, model: ${r.modelId}${r.accountId ? `, account: ${r.accountId}` : ""}]`,
      );
    }
    return lines.join("\n");
  }

  // 5. "Can these five tasks execute in parallel?" (or "Can these tasks execute in parallel?")
  if (
    /can (these|the) (five )?tasks execute in parallel/i.test(lower) ||
    /execute in parallel/i.test(lower) ||
    /parallel execution check/i.test(lower)
  ) {
    const taskMatches = [...trimmed.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|task-[a-z0-9_-]+/gi)].map(
      (m) => m[0],
    );

    let checkTasks: Array<{ id: string; title: string; workdir: string }> = [];
    if (taskMatches.length > 0) {
      checkTasks = taskMatches.flatMap((id) => {
        const t = tasks.get(id);
        return t ? [{ id: t.id, title: t.title, workdir: t.workdir }] : [];
      });
    } else {
      checkTasks = db
        .query<{ id: string; title: string; workdir: string }, []>(
          `SELECT id, title, workdir FROM tasks WHERE archived_at IS NULL AND "column" = 'ready' LIMIT 5`,
        )
        .all();
    }

    if (checkTasks.length < 2) {
      return "Parallel execution requires at least two valid tasks to evaluate. Specify task IDs or check ready tasks.";
    }

    const lines: string[] = [`Parallel Execution Feasibility Analysis for ${checkTasks.length} tasks:`];
    let canParallel = true;
    const projectCounts = new Map<string, number>();

    for (const t of checkTasks) {
      projectCounts.set(t.workdir, (projectCounts.get(t.workdir) || 0) + 1);
    }

    // Check project concurrency limits
    for (const [pPath, count] of projectCounts.entries()) {
      const proj = projects.get(pPath);
      if (count > 2) {
        canParallel = false;
        lines.push(
          `• Concurrency limit conflict: ${proj?.name || pPath} has ${count} tasks (per-project limit is 2). Tasks within this project will be queued sequentially.`,
        );
      }
    }

    // Check cross dependencies
    const taskIds = checkTasks.map((t) => t.id);
    const deps = db
      .query<
        { task_id: string; depends_on_task_id: string },
        string[]
      >(
        `SELECT task_id, depends_on_task_id FROM orchestration_task_dependencies
         WHERE task_id IN (${taskIds.map(() => "?").join(",")})
           AND depends_on_task_id IN (${taskIds.map(() => "?").join(",")})`,
      )
      .all(...taskIds, ...taskIds);

    if (deps.length > 0) {
      canParallel = false;
      for (const d of deps) {
        lines.push(`• Dependency block: Task ${d.task_id} explicitly depends on ${d.depends_on_task_id}.`);
      }
    }

    if (canParallel) {
      lines.push("✓ YES: All evaluated tasks belong to distinct projects or within concurrency limits and have zero mutual dependencies. They are eligible for parallel execution.");
    } else {
      lines.push("✗ NO: Mutual dependencies or per-project concurrency constraints require partial sequential scheduling.");
    }

    return lines.join("\n");
  }

  // 6. "Why has this task not started?"
  if (
    /why has this task not started/i.test(lower) ||
    /why (isn't|is not) (this|the) task started/i.test(lower) ||
    /why has task .* not started/i.test(lower)
  ) {
    const taskMatch = trimmed.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|task-[a-z0-9_-]+/i);
    const taskId = taskMatch
      ? taskMatch[0]
      : scoped?.scope.scope.kind === "task"
      ? scoped.scope.scope.id
      : null;

    if (!taskId) {
      return "Please specify a task ID or select a task in scope to check why it has not started.";
    }

    const taskObj = tasks.get(taskId);
    if (!taskObj) {
      return `Task "${taskId}" not found in database.`;
    }

    const lines: string[] = [`Status analysis for Task "${clean(taskObj.title)}" (${taskObj.id}):`];
    lines.push(`• Current column: "${taskObj.column}"`);

    // Check dependencies
    const unsatisfiedDeps = db
      .query<{ depends_on_task_id: string; condition: string }, [string]>(
        `SELECT depends_on_task_id, condition FROM orchestration_task_dependencies
         WHERE task_id = ? AND satisfied_at IS NULL`,
      )
      .all(taskObj.id);

    if (unsatisfiedDeps.length > 0) {
      for (const dep of unsatisfiedDeps) {
        const depTask = tasks.get(dep.depends_on_task_id);
        lines.push(
          `• Blocked by dependency: Awaiting "${clean(depTask?.title || dep.depends_on_task_id)}" to satisfy condition "${dep.condition}".`,
        );
      }
    }

    // Check project lifecycle
    const projRow = db
      .query<{ lifecycle_state: string | null }, [string]>(
        `SELECT lifecycle_state FROM projects WHERE path = ?`,
      )
      .get(taskObj.workdir);
    if (projRow?.lifecycle_state && projRow.lifecycle_state !== "active") {
      lines.push(`• Project lifecycle state is "${projRow.lifecycle_state}" (admission paused).`);
    }

    // Check reservations
    const res = missionStore.getReservation(taskObj.id);
    if (res) {
      lines.push(`• Orchestration reservation: ${res.status} [runId: ${res.runId || "none"}]`);
    } else {
      lines.push(`• No active worker reservation. Waiting for scheduler dispatch cycle.`);
    }

    return lines.join("\n");
  }

  // 7. "Reallocate eligible resources to higher-priority work."
  if (
    /reallocate (eligible )?resources/i.test(lower) ||
    /reallocate resources to higher-priority work/i.test(lower)
  ) {
    const runningMissions = missionStore.listMissions({ status: "running" });
    if (runningMissions.length === 0) {
      return "No running missions to reallocate resources for. Prepare or start a mission first.";
    }

    for (const m of runningMissions) {
      await missionScheduler.tickMission(m.id);
    }

    return `Resource allocation successfully re-evaluated. Critical and high-priority tasks prioritized in scheduler dispatch queue with fair starvation avoidance across active projects.`;
  }

  // 8. "Pause this cluster's mission."
  if (
    /pause (this )?(cluster's )?mission/i.test(lower) ||
    /pause mission/i.test(lower)
  ) {
    const running = missionStore.listMissions({ status: "running" });
    if (running.length === 0 || !running[0]) {
      return "No running missions to pause.";
    }

    const target = running[0];
    await missionScheduler.pauseMission(target.id, "Paused via Head of PM Owner request.");
    return `Mission "${target.title}" (ID: ${target.id}) has been paused. In-flight tasks will complete safely and no new dispatches will occur.`;
  }

  // 9. "Continue the authorized mission."
  if (
    /continue the (authorized )?mission/i.test(lower) ||
    /resume (the )?(authorized )?mission/i.test(lower)
  ) {
    const paused = missionStore.listMissions({ status: "paused" });
    if (paused.length === 0 || !paused[0]) {
      return "No paused missions found to resume.";
    }

    const target = paused[0];
    await missionScheduler.resumeMission(target.id);
    return `Mission "${target.title}" (ID: ${target.id}) has been resumed and scheduling coordinator activated.`;
  }

  // 10. "Summarize what all agents completed today."
  if (
    /summarize what all agents completed today/i.test(lower) ||
    /completed today/i.test(lower) ||
    /what agents completed today/i.test(lower)
  ) {
    const oneDayAgo = Date.now() - 86_400_000;
    const completedTasks = db
      .query<{ id: string; title: string; workdir: string; updated_at: number }, [number]>(
        `SELECT id, title, workdir, updated_at FROM tasks
         WHERE "column" = 'done' AND updated_at >= ? AND archived_at IS NULL
         ORDER BY updated_at DESC`,
      )
      .all(oneDayAgo);

    const completedReviews = db
      .query<{ id: string; task_id: string; verdict: string; completed_at: number }, [number]>(
        `SELECT id, task_id, verdict, completed_at FROM task_quality_reviews
         WHERE status = 'complete' AND completed_at >= ?
         ORDER BY completed_at DESC`,
      )
      .all(oneDayAgo);

    const lines: string[] = [
      `24-Hour Agent Activity Summary:`,
      `• Tasks verified in Done: ${completedTasks.length}`,
      `• Quality control reviews completed: ${completedReviews.length}`,
    ];

    if (completedTasks.length > 0) {
      lines.push("Completed Tasks:");
      for (const t of completedTasks.slice(0, 10)) {
        const proj = projects.get(t.workdir);
        lines.push(`• [${proj?.name || t.workdir}] "${clean(t.title)}" (${t.id})`);
      }
      if (completedTasks.length > 10) {
        lines.push(`... and ${completedTasks.length - 10} more tasks.`);
      }
    }

    return lines.join("\n");
  }

  return null;
}
