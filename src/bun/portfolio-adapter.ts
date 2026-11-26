import { sanitizedLegacySnapshot, LEGACY_USAGE_FRESHNESS_MS } from "./account-usage-bridge.ts";
import { AccountCore } from "./account-core.ts";
import { accountPortfolioView, extendPortfolioResources } from "./account-portfolio.ts";
/**
 * Read-only portfolio snapshot (FO-008B).
 *
 * Assembles `PortfolioSnapshotInput` from the project registry, board rows,
 * structured dependencies, declared priorities, runs, batches, pipeline run
 * state, stored environment phases, saved estimates, and stored harness
 * rows. It does not spawn a CLI, probe a binary, read credentials, start
 * Docker, or write SQLite.
 *
 * A missing priority row stays unknown. A percent-used quota meter stays a
 * percent. A failed section is omitted with coverage false, which the core
 * reports as unknown rather than zero.
 *
 * Tasks belong to a project by `project-ownership.ts` (FO-008C/D, the same
 * contract project managers, scheduling and batches use): the exact
 * registered path, a subfolder of it on whole path segments, or a proven
 * linked Git worktree of it. An ambiguous folder is counted nowhere.
 */

import { realpathSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { classifyWorkdirs, type WorkdirOwnership } from "./project-ownership.ts";

import { ESTIMATION_LIMITS } from "../shared/estimation/types.ts";
import type { ExchangeRate, ScenarioId } from "../shared/estimation/types.ts";
import { estimate } from "../shared/estimation/estimate.ts";
import { adaptProject, type ProjectTaskFact, type StructuredDependency } from "../shared/estimation/project-adapter.ts";
import { parseEstimationSettings, type EstimationSettings } from "../shared/estimation/settings.ts";
import type { EnvironmentPhase } from "../shared/environment/types.ts";
import {
  AGENT_KINDS,
  BATCH_STATUSES,
  COLUMN_IDS,
  ENVIRONMENT_PHASES,
  PIPELINE_STATUSES,
  PORTFOLIO_LIMITS,
  RUN_STATUSES,
  TASK_PRIORITY_IDS,
  type Fact,
  type ObservationCoverage,
  type PortfolioSnapshotInput,
  type ProjectEstimateFactInput,
  type ProjectSnapshotInput,
  type QuotaKnowledge,
  type ResourceSnapshotInput,
  type TaskFactInput,
} from "../shared/portfolio/types.ts";
import type { BatchStatus, TaskPriority } from "../shared/task-scheduling.ts";
import type { PipelineRunStatus } from "../shared/types.ts";
import {
  agentProfiles,
  db,
  harnessUsage,
  harnesses,
  projectEstimation,
  projectManagers,
  projects,
  taskScheduling,
} from "./db.ts";

/** A snapshot read at request time is current inside this window. */
export const PORTFOLIO_STALENESS_MS = 5 * 60 * 1000;

const SCENARIO: ScenarioId = "expected";
const STACK_MARKERS: readonly [string, string][] = [
  ["package.json", "JavaScript"],
  ["tsconfig.json", "TypeScript"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["pyproject.toml", "Python"],
  ["composer.json", "PHP"],
  ["Package.swift", "Swift"],
];

export interface PortfolioBuild {
  snapshot: PortfolioSnapshotInput;
  warnings: string[];
  accountResources: ReturnType<typeof accountPortfolioView>;
}

interface TaskRow {
  id: string;
  title: string;
  column: string;
  archived_at: number | null;
  pipeline_parent_id: string | null;
  agent: string;
  model: string | null;
  agent_profile_id: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  agent: string;
  status: string;
  model: string | null;
  agent_profile_id: string | null;
}

export function buildPortfolioSnapshot(now = Date.now()): PortfolioBuild {
  const warnings: string[] = [];
  const registered = projects.list();
  const priorities = loadPriorities(warnings);
  const environments = loadEnvironments(warnings);
  const batches = loadBatches(warnings);
  const ownership = loadOwnership(registered.map((project) => project.path), warnings);
  const settingsByPath = new Map<string, EstimationSettings | null>();
  const projectSnapshots: ProjectSnapshotInput[] = [];
  let taskBudget: number = PORTFOLIO_LIMITS.maxTasks;
  let runBudget: number = PORTFOLIO_LIMITS.maxRuns;
  let dependencyBudget: number = PORTFOLIO_LIMITS.maxDependencies;
  let batchBudget: number = PORTFOLIO_LIMITS.maxBatches;
  let pipelineBudget: number = PORTFOLIO_LIMITS.maxPipelines;

  for (const project of registered) {
    if (project.path.length > PORTFOLIO_LIMITS.maxTextLength) {
      warn(warnings, `Project path is longer than the snapshot limit and was left out.`);
      continue;
    }
    try {
      const built = buildProject({
        path: project.path,
        name: project.name,
        workdirs: ownership.byProject.get(project.path) ?? [project.path],
        now,
        priorities,
        environments,
        batches,
        warnings,
        budgets: {
          tasks: taskBudget,
          runs: runBudget,
          dependencies: dependencyBudget,
          batches: batchBudget,
          pipelines: pipelineBudget,
        },
      });
      settingsByPath.set(project.path, built.settings);
      taskBudget = built.budgets.tasks;
      runBudget = built.budgets.runs;
      dependencyBudget = built.budgets.dependencies;
      batchBudget = built.budgets.batches;
      pipelineBudget = built.budgets.pipelines;
      projectSnapshots.push(built.project);
    } catch (err) {
      warn(warnings, `Project ${labelOf(project.name, project.path)} could not be read. Its counts are unknown.`);
      projectSnapshots.push(unreadableProject(project.path, project.name, now));
      settingsByPath.set(project.path, null);
      void err;
    }
  }

  const report = reportCurrencyOf([...settingsByPath.values()], warnings);
  const snapshot: PortfolioSnapshotInput = {
    capturedAtMs: now,
    stalenessAfterMs: PORTFOLIO_STALENESS_MS,
    reportCurrency: report.currency,
    exchangeRates: report.rates,
    projects: projectSnapshots,
    resources: loadResources(projectSnapshots, now, warnings),
    projectPriorities: [],
    deadlines: [],
    policy: {
      allowWorkWithUnknownLimits: true,
      enforceSafetyForAutomaticExecution: true,
      calendarCombination: null,
    },
  };
  return { snapshot, warnings, accountResources: accountPortfolioView(new AccountCore(db, () => now)) };
}

function buildProject(input: {
  path: string;
  name: string;
  /** The project path plus every task workdir attributed to it. */
  workdirs: string[];
  now: number;
  priorities: Map<string, string> | null;
  environments: EnvIndex | null;
  batches: Map<string, BatchRow[] | null> | null;
  warnings: string[];
  budgets: Budgets;
}): { project: ProjectSnapshotInput; settings: EstimationSettings | null; budgets: Budgets } {
  const label = labelOf(input.name, input.path);
  const board = loadBoard(input.workdirs, input.priorities, input.warnings, label);
  const runs = loadRuns(input.workdirs, input.warnings, label);
  const dependencies = loadDependencies(input.workdirs, input.warnings, label);
  const pipelines = loadPipelines(input.workdirs, input.warnings, label);
  const batchRead = readProjectBatches(input.path, input.batches);
  const budgets = { ...input.budgets };
  const coverage: ObservationCoverage = {
    board: board.ok,
    runs: runs.ok,
    batches: batchRead.ok,
    pipelines: pipelines.ok,
    dependencies: dependencies.ok,
  };

  const tasks = take(board.tasks, budgets.tasks, coverage, "board", label, input.warnings);
  budgets.tasks -= coverage.board ? tasks.length : 0;
  const runFacts = take(runs.runs, budgets.runs, coverage, "runs", label, input.warnings);
  budgets.runs -= coverage.runs ? runFacts.length : 0;
  const dependencyFacts = take(dependencies.edges, budgets.dependencies, coverage, "dependencies", label, input.warnings);
  budgets.dependencies -= coverage.dependencies ? dependencyFacts.length : 0;
  const pipelineFacts = take(pipelines.pipelines, budgets.pipelines, coverage, "pipelines", label, input.warnings);
  budgets.pipelines -= coverage.pipelines ? pipelineFacts.length : 0;
  const batchFacts = take(
    batchRead.rows.map((batch) => ({ id: batch.id, status: batch.status, taskIds: batch.taskIds })),
    budgets.batches,
    coverage,
    "batches",
    label,
    input.warnings,
  );
  budgets.batches -= coverage.batches ? batchFacts.length : 0;

  const identity = projectIdentity(input.path, input.name, input.now, input.warnings);
  const environment = environmentFact(input.path, input.environments, input.now);
  const estimated = loadEstimate(input.path, input.workdirs, input.now, input.warnings, label);

  return {
    settings: estimated.settings,
    budgets,
    project: {
      id: input.path,
      path: input.path,
      name: { value: clip(input.name, PORTFOLIO_LIMITS.maxTextLength), origin: "user-provided", observedAtMs: input.now },
      description: identity.description,
      stack: identity.stack,
      managerConfigured: managerConfigured(input.path, input.now),
      managerAvailable: {
        value: null,
        origin: "unknown",
        observedAtMs: null,
        detail: "Project manager availability is not probed while reading the portfolio.",
      },
      observedAtMs: input.now,
      coverage,
      tasks: coverage.board ? tasks : [],
      dependencies: coverage.dependencies ? dependencyFacts : [],
      runs: coverage.runs ? runFacts : [],
      pipelines: coverage.pipelines ? pipelineFacts : [],
      batches: coverage.batches ? batchFacts : [],
      environment,
      estimate: estimated.estimate,
    },
  };
}

interface Budgets {
  tasks: number;
  runs: number;
  dependencies: number;
  batches: number;
  pipelines: number;
}

function take<T>(rows: T[], budget: number, coverage: ObservationCoverage, key: keyof ObservationCoverage, label: string, warnings: string[]): T[] {
  if (!coverage[key]) return [];
  if (rows.length <= budget) return rows;
  coverage[key] = false;
  warn(warnings, `${label} was not fully included because the portfolio limit was reached. Its ${key} count is unknown.`);
  return [];
}

function unreadableProject(path: string, name: string, now: number): ProjectSnapshotInput {
  const unknown = <T,>(): Fact<T> => ({ value: null, origin: "unknown", observedAtMs: null });
  return {
    id: path,
    path,
    name: { value: clip(name, PORTFOLIO_LIMITS.maxTextLength), origin: "user-provided", observedAtMs: now },
    description: unknown(),
    stack: unknown(),
    managerConfigured: unknown(),
    managerAvailable: unknown(),
    observedAtMs: now,
    coverage: { board: false, runs: false, batches: false, pipelines: false, dependencies: false },
    tasks: [],
    dependencies: [],
    runs: [],
    pipelines: [],
    batches: [],
    environment: { configured: unknown(), phase: unknown() },
    estimate: null,
  };
}

function loadBoard(workdirs: readonly string[], priorities: Map<string, string> | null, warnings: string[], label: string): { ok: boolean; tasks: TaskFactInput[] } {
  if (priorities == null) {
    warn(warnings, `${label}: task priorities could not be read, so the board was not counted.`);
    return { ok: false, tasks: [] };
  }
  let rows: TaskRow[];
  try {
    rows = db.query<TaskRow, string[]>(
      `SELECT id, title, column, archived_at, pipeline_parent_id, agent, model, agent_profile_id
         FROM tasks WHERE workdir IN (${placeholders(workdirs.length)})`,
    ).all(...workdirs);
  } catch {
    warn(warnings, `${label}: the board could not be read.`);
    return { ok: false, tasks: [] };
  }
  const tasks: TaskFactInput[] = [];
  for (const row of rows) {
    const column = asMember(row.column, COLUMN_IDS);
    if (!row.id || !column) {
      warn(warnings, `${label}: a board row was unreadable, so the board was not counted.`);
      return { ok: false, tasks: [] };
    }
    const declared = priorities.get(row.id);
    tasks.push({
      id: row.id,
      title: clip(row.title || row.id, PORTFOLIO_LIMITS.maxTextLength),
      column,
      archived: row.archived_at != null,
      pipelineParentId: row.pipeline_parent_id,
      priority: priorityFact(declared),
      harnessId: row.agent.trim() ? row.agent : null,
      accountId: ["backlog", "ready", "blocked"].includes(column) ? new AccountCore(db).resolveIdentity(row.agent, row.agent_profile_id).accountId : null,
      modelId: row.model && row.model.trim() ? row.model : null,
      agentProfileId: row.agent_profile_id,
      requiredPermissions: [],
      spending: null,
    });
  }
  return { ok: true, tasks };
}

function priorityFact(declared: string | undefined): Fact<TaskPriority | null> {
  if (declared == null) return { value: null, origin: "unknown", observedAtMs: null, detail: "No task_priorities row." };
  const priority = asMember(declared, TASK_PRIORITY_IDS);
  if (!priority) return { value: null, origin: "unknown", observedAtMs: null, detail: "Stored priority was not a known value." };
  return { value: priority, origin: "user-provided", observedAtMs: null };
}

function loadPriorities(warnings: string[]): Map<string, string> | null {
  try {
    const rows = db.query<{ task_id: string; priority: string }, []>(
      `SELECT task_id, priority FROM task_priorities`,
    ).all();
    return new Map(rows.map((row) => [row.task_id, row.priority]));
  } catch {
    warn(warnings, "Task priorities could not be read. Missing rows were not treated as Normal.");
    return null;
  }
}

function loadRuns(workdirs: readonly string[], warnings: string[], label: string): { ok: boolean; runs: ProjectSnapshotInput["runs"] } {
  let rows: RunRow[];
  try {
    rows = db.query<RunRow, string[]>(
      `SELECT r.id, r.task_id, r.agent, r.status, t.model, t.agent_profile_id
         FROM runs r JOIN tasks t ON t.id = r.task_id
        WHERE t.workdir IN (${placeholders(workdirs.length)})`,
    ).all(...workdirs);
  } catch {
    warn(warnings, `${label}: runs could not be read.`);
    return { ok: false, runs: [] };
  }
  const runs: ProjectSnapshotInput["runs"] = [];
  for (const row of rows) {
    const status = asMember(row.status, RUN_STATUSES);
    if (!row.id || !row.task_id || !row.agent || !status) {
      warn(warnings, `${label}: a run row was unreadable, so runs were not counted.`);
      return { ok: false, runs: [] };
    }
    runs.push({
      id: row.id,
      taskId: row.task_id,
      harnessId: row.agent,
      accountId: null,
      status,
      modelId: row.model && row.model.trim() ? row.model : null,
      agentProfileId: row.agent_profile_id,
    });
  }
  return { ok: true, runs };
}

function loadDependencies(workdirs: readonly string[], warnings: string[], label: string): { ok: boolean; edges: ProjectSnapshotInput["dependencies"] } {
  try {
    return {
      ok: true,
      edges: taskScheduling.edgesForProject(workdirs).map((edge) => ({ taskId: edge.taskId, dependsOn: edge.dependsOn })),
    };
  } catch {
    warn(warnings, `${label}: dependencies could not be read.`);
    return { ok: false, edges: [] };
  }
}

function loadPipelines(workdirs: readonly string[], warnings: string[], label: string): { ok: boolean; pipelines: ProjectSnapshotInput["pipelines"] } {
  let rows: { id: string; pipeline_run: string }[];
  try {
    rows = db.query<{ id: string; pipeline_run: string }, string[]>(
      `SELECT id, pipeline_run FROM tasks
        WHERE workdir IN (${placeholders(workdirs.length)}) AND pipeline_parent_id IS NULL AND pipeline_run IS NOT NULL`,
    ).all(...workdirs);
  } catch {
    warn(warnings, `${label}: pipelines could not be read.`);
    return { ok: false, pipelines: [] };
  }
  const pipelines: ProjectSnapshotInput["pipelines"] = [];
  for (const row of rows) {
    let status: PipelineRunStatus | null = null;
    try {
      const parsed = JSON.parse(row.pipeline_run) as { status?: unknown };
      status = typeof parsed.status === "string" ? asMember(parsed.status, PIPELINE_STATUSES) : null;
    } catch {
      status = null;
    }
    if (!status) {
      warn(warnings, `${label}: a pipeline run was unreadable, so pipelines were not counted.`);
      return { ok: false, pipelines: [] };
    }
    pipelines.push({ id: row.id, status, parentTaskId: row.id });
  }
  return { ok: true, pipelines };
}

interface BatchRow {
  id: string;
  status: BatchStatus;
  taskIds: string[];
}

function loadBatches(warnings: string[]): Map<string, BatchRow[] | null> | null {
  try {
    const rows = db.query<{ project_path: string; data: string }, []>(
      `SELECT project_path, data FROM project_execution_batches`,
    ).all();
    const byPath = new Map<string, BatchRow[] | null>();
    for (const row of rows) {
      if (byPath.get(row.project_path) === null) continue;
      const parsed = parseBatch(row.data);
      if (!parsed) {
        warn(warnings, "An execution batch could not be read. That project's batches were not counted.");
        byPath.set(row.project_path, null);
        continue;
      }
      const list = byPath.get(row.project_path) ?? [];
      list.push(parsed);
      byPath.set(row.project_path, list);
    }
    return byPath;
  } catch {
    warn(warnings, "Execution batches could not be read. Batch counts are unknown.");
    return null;
  }
}

function readProjectBatches(projectPath: string, index: Map<string, BatchRow[] | null> | null): { ok: boolean; rows: BatchRow[] } {
  if (index == null) return { ok: false, rows: [] };
  if (!index.has(projectPath)) return { ok: true, rows: [] };
  const rows = index.get(projectPath);
  if (rows == null) return { ok: false, rows: [] };
  return { ok: true, rows };
}

function parseBatch(data: string): BatchRow | null {
  try {
    const parsed = JSON.parse(data) as { id?: unknown; status?: unknown; entries?: unknown };
    const status = typeof parsed.status === "string" ? asMember(parsed.status, BATCH_STATUSES) : null;
    if (typeof parsed.id !== "string" || !parsed.id || !status || !Array.isArray(parsed.entries)) return null;
    const taskIds: string[] = [];
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== "object") return null;
      const taskId = (entry as { taskId?: unknown }).taskId;
      if (typeof taskId !== "string" || !taskId) return null;
      taskIds.push(taskId);
    }
    return { id: parsed.id, status, taskIds };
  } catch {
    return null;
  }
}

type EnvIndex = Map<string, { phases: EnvironmentPhase[]; updatedAt: number } | "unreadable">;

function loadEnvironments(warnings: string[]): EnvIndex | null {
  try {
    const rows = db.query<{ project_path: string; data: string }, []>(
      `SELECT project_path, data FROM environment_profiles`,
    ).all();
    const index: EnvIndex = new Map();
    for (const row of rows) {
      if (index.get(row.project_path) === "unreadable") continue;
      const phase = readStoredPhase(row.data);
      if (!phase) {
        warn(warnings, "An environment profile could not be read. That project's phase is unknown.");
        index.set(row.project_path, "unreadable");
        continue;
      }
      const current = index.get(row.project_path);
      const phases = current && current !== "unreadable" ? current.phases : [];
      const updatedAt = current && current !== "unreadable" ? Math.max(current.updatedAt, phase.updatedAt) : phase.updatedAt;
      phases.push(phase.phase);
      index.set(row.project_path, { phases, updatedAt });
    }
    return index;
  } catch {
    warn(warnings, "Environment profiles could not be read. Phases are unknown.");
    return null;
  }
}

function readStoredPhase(data: string): { phase: EnvironmentPhase; updatedAt: number } | null {
  try {
    const parsed = JSON.parse(data) as { runtime?: { phase?: unknown; updatedAt?: unknown } };
    const phase = typeof parsed.runtime?.phase === "string" ? asMember(parsed.runtime.phase, ENVIRONMENT_PHASES) : null;
    const updatedAt = typeof parsed.runtime?.updatedAt === "number" && Number.isSafeInteger(parsed.runtime.updatedAt)
      ? parsed.runtime.updatedAt
      : null;
    if (!phase || updatedAt == null) return null;
    return { phase, updatedAt };
  } catch {
    return null;
  }
}

function environmentFact(projectPath: string, index: EnvIndex | null, now: number): ProjectSnapshotInput["environment"] {
  if (index == null) {
    return {
      configured: { value: null, origin: "unknown", observedAtMs: null },
      phase: { value: null, origin: "unknown", observedAtMs: null, detail: "Environment profiles could not be read." },
    };
  }
  const row = index.get(projectPath);
  if (!row) {
    return {
      configured: { value: false, origin: "observed", observedAtMs: now, detail: "No environment profile is stored." },
      phase: { value: null, origin: "unknown", observedAtMs: null, detail: "No stored phase, and none was probed." },
    };
  }
  if (row === "unreadable") {
    return {
      configured: { value: null, origin: "unknown", observedAtMs: null },
      phase: { value: null, origin: "unknown", observedAtMs: null, detail: "The stored environment profile was unreadable." },
    };
  }
  const unique = [...new Set(row.phases)];
  if (unique.length !== 1) {
    return {
      configured: { value: true, origin: "observed", observedAtMs: now },
      phase: { value: null, origin: "unknown", observedAtMs: row.updatedAt, detail: "Stored profiles disagree on the phase." },
    };
  }
  return {
    configured: { value: true, origin: "observed", observedAtMs: now },
    phase: {
      value: unique[0] ?? null,
      origin: "observed",
      observedAtMs: row.updatedAt,
      detail: "Last recorded phase. The portfolio read did not probe the process.",
    },
  };
}

function managerConfigured(projectPath: string, now: number): Fact<boolean | null> {
  try {
    const row = projectManagers.getConfig(projectPath);
    return { value: row != null, origin: "observed", observedAtMs: now };
  } catch {
    return { value: null, origin: "unknown", observedAtMs: null, detail: "Project manager configuration could not be read." };
  }
}

function loadEstimate(
  projectPath: string,
  workdirs: readonly string[],
  now: number,
  warnings: string[],
  label: string,
): { estimate: ProjectEstimateFactInput | null; settings: EstimationSettings | null } {
  let stored: { settings: string } | null;
  try {
    stored = projectEstimation.get(projectPath);
  } catch {
    warn(warnings, `${label}: saved estimation inputs could not be read.`);
    return { estimate: null, settings: null };
  }
  if (!stored) return { estimate: null, settings: null };
  let decoded: unknown;
  try {
    decoded = JSON.parse(stored.settings);
  } catch {
    warn(warnings, `${label}: saved estimation inputs were not valid JSON.`);
    return { estimate: null, settings: null };
  }
  const parsed = parseEstimationSettings(decoded);
  if (!parsed.ok) {
    warn(warnings, `${label}: saved estimation inputs were rejected. No estimate was invented.`);
    return { estimate: null, settings: null };
  }
  try {
    const facts = loadFacts(workdirs);
    const edges = taskScheduling.edgesForProject(workdirs).map((edge): StructuredDependency => ({ taskId: edge.taskId, dependsOn: edge.dependsOn }));
    const adapted = adaptProject({
      projectPath,
      projectLabel: label,
      facts,
      settings: parsed.settings,
      structuredDependencies: edges,
    });
    const result = estimate(adapted.request);
    const scenario = result.scenarios?.[SCENARIO] ?? null;
    if (!result.ok || !scenario) {
      warn(warnings, `${label}: the estimation engine did not return a forecast.`);
      return { estimate: null, settings: parsed.settings };
    }
    return {
      settings: parsed.settings,
      estimate: {
        scenario: SCENARIO,
        agent: scenario.agent,
        calendar: scenario.calendar,
        additionalCash: scenario.additionalCash,
        apiEquivalent: scenario.apiEquivalent,
        subscriptionFees: scenario.subscriptionFees,
        subscriptions: parsed.settings.subscriptions.map((subscription) => ({
          id: subscription.id,
          commitment: subscription.commitment,
          recurringFee: subscription.recurringFee,
          priceOrigin: subscription.recurringFee ? "user-provided" : "unknown",
        })),
        confidence: result.confidence.level,
        missing: result.missing.map((item) => item.message).slice(0, 40),
        coverageStatus: scenario.coverage.status,
        observedAtMs: now,
      },
    };
  } catch {
    warn(warnings, `${label}: estimation failed. The project total was not filled with zero.`);
    return { estimate: null, settings: parsed.settings };
  }
}

function loadFacts(workdirs: readonly string[]): ProjectTaskFact[] {
  const observed = new Map<string, ProjectTaskFact["observedRuns"]>();
  const history = projectEstimation.observations(workdirs, ESTIMATION_LIMITS.maxHistory);
  for (const run of history) {
    const list = observed.get(run.taskId) ?? [];
    list.push({
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      agentMs: run.endedAt - run.startedAt,
      status: run.status,
    });
    observed.set(run.taskId, list);
  }
  return projectEstimation.facts(workdirs).map((row) => ({
    id: row.id,
    title: row.title,
    column: row.column,
    taskType: row.taskType,
    harnessId: row.harnessId.trim() ? row.harnessId : null,
    modelId: row.modelId && row.modelId.trim() ? row.modelId : null,
    updatedAt: row.updatedAt,
    archived: row.archived,
    pipelineParentId: row.pipelineParentId,
    observedRuns: observed.get(row.id) ?? [],
  }));
}

function loadResources(projectSnapshots: readonly ProjectSnapshotInput[], now: number, warnings: string[]): ResourceSnapshotInput[] {
  let harnessRows;
  try {
    harnessRows = harnesses.list();
  } catch {
    warn(warnings, "Harnesses could not be read. Resource capacity is unknown.");
    return [];
  }
  const quotas = new Map(safeQuotas(warnings).map((quota) => [quota.harnessId, quota]));
  const profilesByHarness = new Map<string, string[]>();
  try {
    for (const profile of agentProfiles.list()) {
      const list = profilesByHarness.get(profile.harness) ?? [];
      list.push(profile.id);
      profilesByHarness.set(profile.harness, list);
    }
  } catch {
    warn(warnings, "Agent profiles could not be listed.");
  }
  const runsComplete = projectSnapshots.every((project) => project.coverage.runs);
  const runningByHarness = new Map<string, number>();
  if (runsComplete) {
    for (const project of projectSnapshots) {
      for (const run of project.runs) {
        if (run.status !== "running") continue;
        runningByHarness.set(run.harnessId, (runningByHarness.get(run.harnessId) ?? 0) + 1);
      }
    }
  }
  const base: ResourceSnapshotInput[] = harnessRows.slice(0, PORTFOLIO_LIMITS.maxResources).map((harness) => {
    const quota = quotas.get(harness.id) ?? null;
    const knowledge = quotaKnowledge(quota, now);
    const kind = asMember(harness.kind, AGENT_KINDS);
    return {
      id: `harness:${harness.id}`,
      harnessId: harness.id,
      harnessKind: kind,
      accountId: null,
      agentProfileIds: profilesByHarness.get(harness.id) ?? [],
      supportedModels: { value: null, origin: "unknown", observedAtMs: null, detail: "Model discovery was not run." },
      availability: harness.enabled
        ? { value: null, origin: "unknown", observedAtMs: null, detail: "The harness binary was not probed." }
        : { value: "unavailable", origin: "user-provided", observedAtMs: now, detail: "The harness is disabled in settings." },
      concurrencyLimit: { value: null, origin: "unknown", observedAtMs: null, detail: "No concurrency cap is stored for this harness." },
      occupiedSlots: runsComplete
        ? { value: runningByHarness.get(harness.id) ?? 0, origin: "observed", observedAtMs: now }
        : { value: null, origin: "unknown", observedAtMs: null, detail: "Run coverage is incomplete, so occupied slots were not counted." },
      exclusive: false,
      quota: knowledge.quota,
      quotaOrigin: knowledge.origin,
      extraSpending: { value: null, origin: "unknown", observedAtMs: null },
      permissions: { value: null, origin: "unknown", observedAtMs: null },
      subscriptionId: null,
    };
  });
  return extendPortfolioResources(new AccountCore(db, () => now), base, now, warnings);
}

function safeQuotas(warnings: string[]) {
  try {
    return harnessUsage.getAll();
  } catch {
    warn(warnings, "Stored quota snapshots could not be read.");
    return [];
  }
}

function quotaKnowledge(snapshot: ReturnType<typeof harnessUsage.get>, now: number): { quota: QuotaKnowledge; origin: Fact<unknown>["origin"] } {
  const unknown = (reason: string) => ({ quota: { kind: "unknown" as const, reason }, origin: "unknown" as const });
  const stored = sanitizedLegacySnapshot(snapshot);
  if (!stored) return unknown("No valid stored quota snapshot.");
  if (stored.status !== "ok" || stored.fetchedAtMs > now || now - stored.fetchedAtMs >= LEGACY_USAGE_FRESHNESS_MS) {
    return unknown("Stored quota evidence is stale, unsuccessful or has an invalid observation time.");
  }
  if (stored.meters.length !== 1) return unknown("Independent stored quota meters cannot be represented as one shared capacity; inspect the usage history.");
  const meter = stored.meters[0]!;
  if (meter.resetsAtMs !== null && meter.resetsAtMs <= now) return unknown("The observation predates a reset; replenishment has not been observed.");
  return { quota: { kind: "percent-used", usedPercent: meter.usedPercent, resetsAtMs: meter.resetsAtMs }, origin: "observed" };
}

function reportCurrencyOf(settings: Array<EstimationSettings | null>, warnings: string[]): { currency: string | null; rates: ExchangeRate[] } {
  const present = settings.filter((item): item is EstimationSettings => item != null);
  const currencies = present.map((item) => item.reportCurrency);
  const named = [...new Set(currencies.filter((item): item is string => item != null))];
  if (named.length > 1 || currencies.some((item) => item == null) && named.length > 0) {
    warn(warnings, "Report currencies do not agree, or a project estimate has no report currency. Amounts were not converted.");
    return { currency: null, rates: [] };
  }
  const currency = named[0] ?? null;
  if (!currency) return { currency: null, rates: [] };
  const rates: ExchangeRate[] = [];
  const seen = new Map<string, number>();
  for (const item of present) {
    for (const rate of item.exchangeRates) {
      const key = `${rate.from}->${rate.to}`;
      const prior = seen.get(key);
      if (prior == null) {
        seen.set(key, rate.rate);
        rates.push({ from: rate.from, to: rate.to, rate: rate.rate, origin: "user-provided" });
      } else if (prior !== rate.rate) {
        warn(warnings, `Exchange rate ${key} disagrees across projects and was not applied.`);
        seen.set(key, Number.NaN);
      }
    }
  }
  return { currency, rates: rates.filter((rate) => seen.get(`${rate.from}->${rate.to}`) === rate.rate) };
}

function projectIdentity(projectPath: string, _name: string, now: number, warnings: string[]): { description: Fact<string | null>; stack: Fact<string[] | null> } {
  let root: string;
  try {
    const stat = statSync(projectPath);
    if (!stat.isDirectory()) throw new Error("not a directory");
    root = realpathSync(projectPath);
  } catch {
    return {
      description: { value: null, origin: "unknown", observedAtMs: null, detail: "The project directory was not available, so no description was inferred." },
      stack: { value: null, origin: "unknown", observedAtMs: null, detail: "The project directory was not available, so the stack was not inferred." },
    };
  }
  const stack: string[] = [];
  for (const [rel, token] of STACK_MARKERS) {
    if (markerExists(root, rel)) stack.push(token);
  }
  const description = packageDescription(root);
  if (description === "unreadable") {
    warn(warnings, "package.json could not be read. No description was inferred.");
  }
  return {
    description: typeof description === "string"
      ? { value: clip(description, 500), origin: "observed", observedAtMs: now }
      : { value: null, origin: "unknown", observedAtMs: null, detail: "No package description was stored." },
    stack: { value: stack, origin: "observed", observedAtMs: now, detail: "Detected from manifest filenames. No toolchain was executed." },
  };
}

function markerExists(root: string, rel: string): boolean {
  try {
    const target = realpathSync(`${root}/${rel}`);
    if (!(target === root || target.startsWith(`${root}/`))) return false;
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function packageDescription(root: string): string | null | "unreadable" {
  const joined = `${root}/package.json`;
  try {
    if (!statSync(joined).isFile()) return null;
  } catch {
    return null;
  }
  try {
    const target = realpathSync(joined);
    if (!(target === root || target.startsWith(`${root}/`))) return null;
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > 65_536) return null;
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { description?: unknown };
    return typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : null;
  } catch {
    return "unreadable";
  }
}

/**
 * Attribute every distinct task workdir to at most one registered project.
 * Failing to read the workdirs falls back to exact matches only.
 */
function loadOwnership(projectPaths: string[], warnings: string[]): WorkdirOwnership {
  let workdirs: string[];
  try {
    workdirs = db.query<{ workdir: string }, []>(`SELECT DISTINCT workdir FROM tasks`).all().map((row) => row.workdir);
  } catch {
    warn(warnings, "Task folders could not be listed. Only tasks in a project's exact folder were counted.");
    return classifyWorkdirs(projectPaths, []);
  }
  const ownership = classifyWorkdirs(projectPaths, workdirs);
  if (ownership.escapes.length > 0) {
    warn(warnings, `${ownership.escapes.length} task folder(s) inside a project resolve outside it through a symlink and were not counted.`);
  }
  if (ownership.ambiguous.length > 0) {
    warn(
      warnings,
      `${ownership.ambiguous.length} task folder(s) could not be attributed to a single project and were left out of every project's counts.`,
    );
  }
  return ownership;
}

function placeholders(count: number): string {
  return Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
}

function asMember<T extends string>(value: string, allowed: readonly T[]): T | null {
  return (allowed as readonly string[]).includes(value) ? value as T : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function labelOf(name: string, projectPath: string): string {
  const trimmed = name.trim();
  return trimmed || projectPath;
}

function warn(warnings: string[], message: string): void {
  if (warnings.length >= PORTFOLIO_LIMITS.maxIssues) return;
  warnings.push(message);
}
