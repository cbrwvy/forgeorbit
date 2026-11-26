/**
 * Overlapping health signals. There is no numeric score. A project that
 * was not observed, or whose snapshot is stale, is unknown rather than idle.
 * Idle is not "finished": an empty observed board is an empty board.
 */

import { environmentPhaseNote, type IndexedProject } from "./snapshot.ts";
import type { HealthFinding, HealthSignal, ProjectHealth } from "./types.ts";

export function assessHealth(projects: readonly IndexedProject[]): ProjectHealth[] {
  return projects.map(assessProject);
}

function assessProject(project: IndexedProject): ProjectHealth {
  const historical = findingsFor(project).map((finding) => ({ ...finding, current: false }));
  if (project.freshness !== "current") {
    const explanation = project.freshness === "stale"
      ? `The snapshot was observed at ${project.project.observedAtMs}, outside the staleness window ending at the capture instant. It is not the current state.`
      : "No staleness window proved this snapshot is current, so it is not reported as the live state.";
    return {
      projectId: project.project.id,
      freshness: project.freshness,
      signals: ["unknown"],
      findings: [finding("unknown", "warning", "freshness", [project.freshness], explanation, true)],
      historicalFindings: historical,
    };
  }
  const findings = findingsFor(project);
  // A recorded phase outside the window is history, not the current state.
  const historicalFindings = project.environmentFreshness != null && project.environmentFreshness !== "current"
    ? environmentFindings(project).map((item) => ({ ...item, current: false }))
    : [];
  return {
    projectId: project.project.id,
    freshness: "current",
    signals: uniqueSignals(findings),
    findings,
    historicalFindings,
  };
}

function environmentFindings(project: IndexedProject): HealthFinding[] {
  const phase = project.project.environment.phase;
  if (phase.origin === "unknown" || phase.value == null) return [];
  if (phase.value === "degraded") {
    return [
      finding("degraded", "warning", "environment", ["degraded"], "The environment phase is degraded.", true),
      finding("needs-attention", "warning", "environment", ["degraded"], "A degraded environment needs the owner.", true),
    ];
  }
  if (phase.value === "error") {
    return [
      finding("degraded", "critical", "environment", ["error"], "The environment phase is error.", true),
      finding("needs-attention", "critical", "environment", ["error"], "An environment error needs the owner.", true),
    ];
  }
  return [];
}

function findingsFor(project: IndexedProject): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const source = project.project;
  if (!source.coverage.board) {
    findings.push(finding("unknown", "warning", "board", [], "The board was not observed, so task counts and activity are unknown.", true));
  }
  if (source.managerAvailable.origin === "unknown") {
    findings.push(finding("unknown", "info", "manager", [], "Project manager availability was not observed.", true));
  } else if (source.managerAvailable.value === false) {
    findings.push(finding("needs-attention", "warning", "manager", ["unavailable"], "The project manager is not available.", true));
  }
  if (source.environment.phase.origin === "unknown" || source.environment.phase.value == null) {
    findings.push(finding("unknown", "info", "environment", [], "The environment phase was not observed.", true));
  } else if (project.environmentFreshness !== "current") {
    const evidence = [source.environment.phase.value, project.environmentFreshness ?? "unproven"];
    findings.push(finding("unknown", "info", "environment", evidence, environmentPhaseNote(project) ?? "The environment phase is not current.", true));
  } else {
    findings.push(...environmentFindings(project));
  }

  if (source.coverage.board) {
    const activeTasks = project.boardTasks.filter((task) => !task.archived);
    const running = activeTasks.filter((task) => task.column === "running");
    const blocked = activeTasks.filter((task) => task.column === "blocked");
    const review = activeTasks.filter((task) => task.column === "review");
    if (running.length > 0) {
      findings.push(finding("active", "info", "column", running.map((task) => task.id), `${running.length} board task(s) are in the running column.`, true));
    }
    if (blocked.length > 0) {
      findings.push(finding("blocked", "warning", "column", blocked.map((task) => task.id), `${blocked.length} board task(s) are in the blocked column. Review is not counted here.`, true));
    }
    if (review.length > 0) {
      findings.push(finding("waiting-for-owner", "warning", "column", review.map((task) => task.id), `${review.length} board task(s) are in review. A finished run is not Done until the owner moves the card.`, true));
    }
  }

  if (source.coverage.runs) {
    const running = source.runs.filter((run) => run.status === "running");
    const failed = source.runs.filter((run) => run.status === "failed");
    const orphaned = source.runs.filter((run) => run.status === "orphaned");
    if (running.length > 0) {
      findings.push(finding("active", "info", "run", running.map((run) => run.id), `${running.length} run(s) have status running.`, true));
    }
    if (failed.length > 0) {
      findings.push(finding("needs-attention", "warning", "run", failed.map((run) => run.id), `${failed.length} run(s) failed. They are not counted as done.`, true));
    }
    if (orphaned.length > 0) {
      findings.push(finding("needs-attention", "warning", "run", orphaned.map((run) => run.id), `${orphaned.length} run(s) were orphaned and were not reconciled into a result.`, true));
    }
  } else {
    findings.push(finding("unknown", "info", "runs", [], "Runs were not observed.", true));
  }

  if (source.coverage.pipelines) {
    const running = source.pipelines.filter((pipeline) => pipeline.status === "running");
    const blocked = source.pipelines.filter((pipeline) => pipeline.status === "blocked");
    if (running.length > 0) {
      findings.push(finding("active", "info", "pipeline", running.map((pipeline) => pipeline.id), `${running.length} pipeline run(s) are running.`, true));
    }
    if (blocked.length > 0) {
      findings.push(finding("blocked", "warning", "pipeline", blocked.map((pipeline) => pipeline.id), `${blocked.length} pipeline run(s) are blocked.`, true));
    }
  }

  if (source.coverage.batches) {
    const running = source.batches.filter((batch) => batch.status === "running");
    const paused = source.batches.filter((batch) => batch.status === "paused");
    const approved = source.batches.filter((batch) => batch.status === "approved");
    const stopped = source.batches.filter((batch) => batch.status === "stopped");
    if (running.length > 0) {
      findings.push(finding("active", "info", "batch", running.map((batch) => batch.id), `${running.length} execution batch(es) are running.`, true));
    }
    if (paused.length > 0) {
      findings.push(finding("waiting-for-owner", "warning", "batch", paused.map((batch) => batch.id), `${paused.length} execution batch(es) are paused. The owner resumes them.`, true));
    }
    if (approved.length > 0) {
      findings.push(finding("waiting-for-owner", "info", "batch", approved.map((batch) => batch.id), `${approved.length} execution batch(es) are approved and have not been started. Only the owner starts a batch.`, true));
    }
    if (stopped.length > 0) {
      findings.push(finding("needs-attention", "warning", "batch", stopped.map((batch) => batch.id), `${stopped.length} execution batch(es) stopped on a limit.`, true));
    }
  }

  const signals = uniqueSignals(findings);
  const quiet = !signals.some((signal) => signal === "active" || signal === "blocked" || signal === "waiting-for-owner" || signal === "needs-attention" || signal === "unknown");
  if (source.coverage.board && quiet) {
    const taskCount = project.boardTasks.filter((task) => !task.archived).length;
    const explanation = taskCount === 0
      ? "The board was observed and has no tasks. That is an empty project, not a completed one."
      : "No board task is running, blocked, or waiting for review, and no run or batch is in motion. The project is idle, not finished.";
    findings.push(finding("idle", "info", "board", [], explanation, true));
  }
  return findings;
}

function finding(
  signal: HealthSignal,
  severity: HealthFinding["severity"],
  source: string,
  evidence: string[],
  explanation: string,
  current: boolean,
): HealthFinding {
  return { signal, severity, source, evidence, explanation, current };
}

function uniqueSignals(findings: readonly HealthFinding[]): HealthSignal[] {
  const out: HealthSignal[] = [];
  for (const item of findings) {
    if (!out.includes(item.signal)) out.push(item.signal);
  }
  return out;
}
