/**
 * Portfolio domain (FO-008A).
 *
 * Pure input and result types. A later adapter (FO-008B) fills these from
 * the project registry, the board, runs, batches, pipelines, environment
 * probes, harness snapshots, and FO-006A estimate results. This module does
 * not read SQLite, spawn an agent, or invent a missing number.
 *
 * Vocabulary is ForgeOrbit's:
 * - board columns: backlog, ready, running, blocked, review, done
 * - a run that exited is not Done; Done is the done column only
 * - review waits for the owner
 * - batch statuses and pipeline statuses are the existing unions
 * - quota percent-used is not remaining capacity
 */

import type { AgentKind, ColumnId, PipelineRunStatus, RunStatus } from "../types.ts";
import type { BatchStatus, SpendingPolicy, TaskPriority } from "../task-scheduling.ts";
import type { EnvironmentPhase } from "../environment/types.ts";
import type {
  CalendarForecast,
  CashForecast,
  ConfidenceLevel,
  DataOrigin,
  DurationForecast,
  ExchangeRate,
  MissingDatum,
  Money,
  ProvenanceEntry,
  ScenarioId,
} from "../estimation/types.ts";

export const PORTFOLIO_LIMITS = {
  maxProjects: 80,
  maxTasks: 5_000,
  maxRuns: 2_000,
  maxDependencies: 20_000,
  maxBatches: 500,
  maxPipelines: 500,
  maxResources: 400,
  maxDeadlines: 2_000,
  maxIdLength: 500,
  maxTextLength: 2_000,
  maxProposals: 48,
  maxProvenance: 300,
  maxIssues: 80,
} as const;

export const COLUMN_IDS = ["backlog", "inbox", "ready", "running", "blocked", "review", "done"] as const;
export const RUN_STATUSES = ["running", "succeeded", "failed", "cancelled", "orphaned"] as const;
export const BATCH_STATUSES = ["draft", "approved", "running", "paused", "completed", "stopped", "cancelled"] as const;
export const PIPELINE_STATUSES = ["idle", "running", "blocked", "done", "cancelled"] as const;
export const ENVIRONMENT_PHASES = ["stopped", "starting", "running", "degraded", "stopping", "error", "unknown"] as const;
export const TASK_PRIORITY_IDS = ["critical", "high", "normal", "low"] as const;
export const AGENT_KINDS = ["claude-code", "codex", "cursor", "gemini", "fx", "antigravity", "custom"] as const;
export const DATA_ORIGINS = ["known", "user-provided", "observed", "estimated", "unknown"] as const;

type AssertNever<T extends never> = T;
type _columns = AssertNever<Exclude<ColumnId, (typeof COLUMN_IDS)[number]>>;
type _runs = AssertNever<Exclude<RunStatus, (typeof RUN_STATUSES)[number]>>;
type _batches = AssertNever<Exclude<BatchStatus, (typeof BATCH_STATUSES)[number]>>;
type _pipelines = AssertNever<Exclude<PipelineRunStatus, (typeof PIPELINE_STATUSES)[number]>>;
type _phases = AssertNever<Exclude<EnvironmentPhase, (typeof ENVIRONMENT_PHASES)[number]>>;
type _priorities = AssertNever<Exclude<TaskPriority, (typeof TASK_PRIORITY_IDS)[number]>>;
type _kinds = AssertNever<Exclude<AgentKind, (typeof AGENT_KINDS)[number]>>;
type _origins = AssertNever<Exclude<DataOrigin, (typeof DATA_ORIGINS)[number]>>;

void (0 as unknown as _columns | _runs | _batches | _pipelines | _phases | _priorities | _kinds | _origins);

/**
 * A value plus where it came from. `unknown` carries a null value: absence
 * is not zero and not a default priority.
 */
export interface Fact<T> {
  value: T | null;
  origin: DataOrigin;
  observedAtMs: number | null;
  detail?: string;
}

export interface ObservationCoverage {
  board: boolean;
  runs: boolean;
  batches: boolean;
  pipelines: boolean;
  dependencies: boolean;
}

export interface TaskFactInput {
  id: string;
  title: string;
  column: ColumnId;
  archived: boolean;
  /** Set on a pipeline step row. Those rows are not board tasks. */
  pipelineParentId: string | null;
  priority: Fact<TaskPriority | null>;
  harnessId: string | null;
  accountId: string | null;
  modelId: string | null;
  agentProfileId: string | null;
  requiredPermissions: string[];
  spending: SpendingPolicy | null;
}

export interface DependencyFactInput {
  /** The task that waits. */
  taskId: string;
  dependsOn: string;
}

export interface RunFactInput {
  id: string;
  taskId: string;
  harnessId: string;
  accountId: string | null;
  status: RunStatus;
  modelId: string | null;
  agentProfileId: string | null;
}

export interface BatchFactInput {
  id: string;
  status: BatchStatus;
  /** Board task ids. Membership is not a second copy of the task. */
  taskIds: string[];
}

export interface PipelineFactInput {
  id: string;
  status: PipelineRunStatus;
  parentTaskId: string | null;
}

export interface EnvironmentFactInput {
  configured: Fact<boolean | null>;
  phase: Fact<EnvironmentPhase | null>;
}

/**
 * Itemized subscription fee taken from the same inputs FO-006A used.
 * The rolled-up `subscriptionFees` forecast cannot be de-duplicated across
 * projects, so the portfolio total uses these rows.
 */
export interface SubscriptionRefInput {
  id: string;
  commitment: "existing" | "proposed";
  recurringFee: Money | null;
  priceOrigin: DataOrigin;
}

/**
 * One project's FO-006A forecast, already computed. This core does not
 * estimate. `coverageStatus` is the engine's coverage verdict, copied
 * through; null means the adapter did not supply one.
 */
export interface ProjectEstimateFactInput {
  scenario: ScenarioId;
  agent: DurationForecast;
  calendar: CalendarForecast;
  additionalCash: CashForecast;
  apiEquivalent: CashForecast;
  subscriptionFees: CashForecast;
  subscriptions: SubscriptionRefInput[];
  confidence: ConfidenceLevel;
  missing: string[];
  coverageStatus: "sufficient" | "insufficient" | "unknown" | "no-work" | "no-subscription" | null;
  observedAtMs: number;
}

export interface ProjectSnapshotInput {
  id: string;
  /** ForgeOrbit project path. The registry key is the path. */
  path: string;
  name: Fact<string | null>;
  description: Fact<string | null>;
  stack: Fact<string[] | null>;
  managerConfigured: Fact<boolean | null>;
  managerAvailable: Fact<boolean | null>;
  /** When these facts were assembled. Compared with `capturedAtMs`. */
  observedAtMs: number;
  coverage: ObservationCoverage;
  tasks: TaskFactInput[];
  dependencies: DependencyFactInput[];
  runs: RunFactInput[];
  pipelines: PipelineFactInput[];
  batches: BatchFactInput[];
  environment: EnvironmentFactInput;
  estimate: ProjectEstimateFactInput | null;
}

/**
 * Percent-used is recorded and then ignored as capacity. Remaining counts
 * and an explicit exhausted flag are the only quota facts that can confirm
 * exhaustion. Nothing here turns a percentage into tokens.
 */
export type QuotaKnowledge =
  | { kind: "unknown"; reason: string }
  | { kind: "percent-used"; usedPercent: number; resetsAtMs: number | null }
  | {
      kind: "remaining";
      unit: "requests" | "tokens" | "credits";
      remaining: number;
      limit: number | null;
      resetsAtMs: number | null;
      currency: string | null;
    }
  | { kind: "exhausted"; resetsAtMs: number | null; evidence: string }
  | { kind: "opaque"; label: string; note: string };

export interface ResourceSnapshotInput {
  id: string;
  harnessId: string;
  harnessKind: AgentKind | null;
  accountId: string | null;
  agentProfileIds: string[];
  /** Null value: the supported-model list was not provided. */
  supportedModels: Fact<string[] | null>;
  availability: Fact<"available" | "unavailable" | null>;
  /**
   * Null value: the cap is unknown. `unbounded` is an explicit claim.
   * A number is never inferred from a usage bar.
   */
  concurrencyLimit: Fact<number | "unbounded" | null>;
  occupiedSlots: Fact<number | null>;
  /** True only when the caller states the resource can be held by one task. */
  exclusive: boolean;
  quota: QuotaKnowledge;
  quotaOrigin: DataOrigin;
  extraSpending: Fact<"forbidden" | "allowed" | null>;
  /** Null value: permissions were not listed. */
  permissions: Fact<string[] | null>;
  subscriptionId: string | null;
}

export interface ProjectPriorityInput {
  projectId: string;
  priority: TaskPriority;
  origin: "user-provided" | "known";
}

export interface DeadlineInput {
  projectId: string;
  taskId: string;
  atMs: number;
  origin: "user-provided" | "known";
}

export interface PortfolioPolicyInput {
  /**
   * Unknown quota or unknown concurrency is a warning. It does not block a
   * plan the owner is willing to run by hand, and it does not block
   * automatic execution either. Mandatory safety conflicts still do.
   */
  allowWorkWithUnknownLimits: boolean;
  /**
   * Recorded for FO-008C. Mandatory conflicts block automatic execution
   * whether or not this is set. FO-008A never executes.
   */
  enforceSafetyForAutomaticExecution: boolean;
  /**
   * How to combine project calendars when no shared constrained account is
   * in the way. Null: do not invent a portfolio finish time.
   */
  calendarCombination: "concurrent-if-uncontended" | "serial" | null;
}

export interface PortfolioSnapshotInput {
  /** Caller-supplied instant. The core does not read a clock. */
  capturedAtMs: number;
  /** Null: freshness cannot be judged, so project facts are not "current". */
  stalenessAfterMs: number | null;
  /** Null: money totals that need a currency are unknown. */
  reportCurrency: string | null;
  exchangeRates: ExchangeRate[];
  projects: ProjectSnapshotInput[];
  resources: ResourceSnapshotInput[];
  projectPriorities: ProjectPriorityInput[];
  deadlines: DeadlineInput[];
  policy: PortfolioPolicyInput;
}

export interface PortfolioIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export type Freshness = "current" | "stale" | "unproven";

export interface CountFact {
  status: "known" | "incomplete" | "unknown";
  /** Set only when `status` is `known`. */
  value: number | null;
  /** Sum of the pieces that had a number. Not a total unless `status` is `known`. */
  knownValue: number | null;
  note: string | null;
}

export interface ColumnCounts {
  status: "known" | "incomplete" | "unknown";
  counts: Record<ColumnId, number> | null;
  knownCounts: Record<ColumnId, number>;
  note: string | null;
}

export interface ProjectSummary {
  projectId: string;
  path: string;
  name: string | null;
  nameOrigin: DataOrigin;
  description: Fact<string | null>;
  stack: Fact<string[] | null>;
  managerConfigured: Fact<boolean | null>;
  managerAvailable: Fact<boolean | null>;
  freshness: Freshness;
  /** False when the numbers below are history or were not observed. */
  countsAreCurrent: boolean;
  boardObserved: boolean;
  taskCount: number | null;
  columns: Record<ColumnId, number> | null;
  doneCount: number | null;
  reviewCount: number | null;
  blockedCount: number | null;
  archivedCount: number | null;
  pipelineStepCount: number | null;
  priorityCounts: Partial<Record<TaskPriority | "unknown", number>> | null;
  dependencyCount: number | null;
  activeRunCount: number | null;
  failedRunCount: number | null;
  orphanedRunCount: number | null;
  harnessIds: string[];
  agentProfileIds: string[];
  runningPipelineCount: number | null;
  pausedBatchCount: number | null;
  runningBatchCount: number | null;
  activeBatchCount: number | null;
  environmentConfigured: boolean | null;
  /** The phase only when its observation is inside the staleness window.
   *  An older recording leaves this null: the current state is unknown. */
  environmentPhase: EnvironmentPhase | null;
  environmentPhaseOrigin: DataOrigin;
  /** The last recorded phase, current or not, and when it was recorded. */
  environmentRecordedPhase: EnvironmentPhase | null;
  environmentPhaseObservedAtMs: number | null;
  /** Whether the recorded phase is the current state (FO-008C). */
  environmentPhaseFreshness: Freshness | null;
  /** Why the current phase is unknown, when it is. */
  environmentPhaseNote: string | null;
}

export interface PortfolioAggregate {
  projectCount: number;
  currentProjectCount: number;
  staleProjectCount: number;
  unprovenProjectCount: number;
  /** Projects whose current health includes the active signal. */
  activeProjectIds: string[];
  idleProjectIds: string[];
  /** Blocked, waiting, degraded, needs attention, unknown, or a confirmed conflict. */
  attentionProjectIds: string[];
  taskCount: CountFact;
  pipelineStepCount: CountFact;
  archivedCount: CountFact;
  columns: ColumnCounts;
  reviewCount: CountFact;
  blockedCount: CountFact;
  doneCount: CountFact;
  activeRunCount: CountFact;
  failedRunCount: CountFact;
  orphanedRunCount: CountFact;
  pausedBatchCount: CountFact;
  runningBatchCount: CountFact;
  activeBatchCount: CountFact;
  runningPipelineCount: CountFact;
  harnesses: {
    status: "known" | "incomplete" | "unknown";
    /** Active runs (`status === "running"`), one per run, keyed by harness id. */
    activeRuns: Record<string, number>;
    note: string | null;
  };
  environments: {
    status: "known" | "incomplete" | "unknown";
    counts: Record<string, number>;
    note: string | null;
  };
  duplicateTaskIds: string[];
  warnings: string[];
}

export type HealthSignal =
  | "active"
  | "idle"
  | "blocked"
  | "waiting-for-owner"
  | "degraded"
  | "needs-attention"
  | "unknown";

export const HEALTH_SIGNALS = [
  "active",
  "idle",
  "blocked",
  "waiting-for-owner",
  "degraded",
  "needs-attention",
  "unknown",
] as const;

export interface HealthFinding {
  signal: HealthSignal;
  severity: "info" | "warning" | "critical";
  source: string;
  evidence: string[];
  explanation: string;
  /** False on findings copied from a stale or unproven snapshot. */
  current: boolean;
}

export interface ProjectHealth {
  projectId: string;
  freshness: Freshness;
  /** Current signals. A stale project is `unknown` here. */
  signals: HealthSignal[];
  findings: HealthFinding[];
  /** What the snapshot showed at `observedAtMs`. Not a claim about now. */
  historicalFindings: HealthFinding[];
}

export type ConflictClass = "confirmed" | "potential" | "insufficient-data";

export interface ResourceConflict {
  id: string;
  class: ConflictClass;
  code: string;
  resourceId: string | null;
  projectIds: string[];
  taskIds: string[];
  severity: "warning" | "critical";
  /**
   * Automatic execution must not start. Existing agents are not stopped:
   * FO-008A only detects.
   */
  blocksAutomaticExecution: boolean;
  runningAgents: "unchanged";
  explanation: string;
  evidence: string[];
}

export interface ResourceView {
  id: string;
  harnessId: string;
  accountId: string | null;
  subscriptionId: string | null;
  projectIds: string[];
  capacity: "known" | "explicit-unbounded" | "unknown";
  concurrencyLimit: number | "unbounded" | null;
  /** Observed occupied slots when that fact was supplied. Not inferred. */
  occupiedSlots: number | null;
  quotaTreatment: string;
  warnings: string[];
}

export interface RankedTask {
  projectId: string;
  taskId: string;
  title: string;
  /** Null when the owner did not declare a project priority. */
  projectPriority: TaskPriority | null;
  /** Null when no priority row was supplied. Not defaulted to normal. */
  taskPriority: TaskPriority | null;
  /** Other not-done board tasks that transitively wait on this one. Null if dependencies were not observed. */
  unblockCount: number | null;
  deadlineAtMs: number | null;
  /** Direct dependencies that are not in the done column. */
  blockedBy: string[];
  executableNow: boolean;
  executableReason: string | null;
  reasons: string[];
}

export interface PriorityAnalysis {
  /**
   * Tasks in projects the owner prioritized. Ordered by declared project
   * priority, then declared task priority, then how many tasks they unblock.
   * A deadline orders two tasks only when both have one.
   */
  compared: RankedTask[];
  /** Tasks whose project has no declared priority. Not ranked against `compared`. */
  taskPriorityOnly: RankedTask[];
  /** Confirmed deadlines only, soonest first. */
  deadlines: Array<{ projectId: string; taskId: string; atMs: number; remainingMs: number }>;
  /** Not-done tasks with no confirmed deadline. They are not treated as overdue. */
  missingDeadlineTaskIds: string[];
  notes: string[];
}

export type ProposalActionKind =
  | "focus-project"
  | "prioritize-task"
  | "suggest-agent-assignment"
  | "suggest-execution-batch"
  | "request-owner-review"
  | "defer-project";

export interface ProposalAction {
  kind: ProposalActionKind;
  projectId: string;
  taskId: string | null;
  summary: string;
}

export interface ProposedAssignment {
  taskId: string;
  projectId: string;
  resourceId: string;
  harnessId: string;
  accountId: string | null;
}

export interface ExpectedEffect {
  kind: "unblocked-tasks" | "conflict-count";
  note: string;
  unblockedTaskCount: number | null;
  conflictCount: number | null;
}

export interface OwnerApproval {
  id: string;
  reason: string;
  /** What a later stage would change. FO-008A does not change it. */
  wouldChange: string;
}

export interface PortfolioProposal {
  id: string;
  targetProjectIds: string[];
  actions: ProposalAction[];
  resourceAssignments: ProposedAssignment[];
  rationale: string[];
  /** Null when no number can be calculated without inventing one. */
  expectedEffect: ExpectedEffect | null;
  conflictIds: string[];
  risks: string[];
  unknowns: string[];
  requiredApprovals: OwnerApproval[];
  readOnly: true;
  execution: "proposal-only";
}

export interface PortfolioMoney {
  status: "known" | "incomplete" | "unknown" | "not-requested" | "mixed-currency";
  money: Money | null;
  knownPortion: Money | null;
  origin: DataOrigin;
  note: string | null;
}

export interface PortfolioDuration {
  status: "known" | "estimated" | "incomplete" | "unknown";
  ms: number | null;
  knownMs: number | null;
  origin: DataOrigin;
  note: string | null;
}

export interface PortfolioCalendar {
  status: "known" | "estimated" | "incomplete" | "unknown";
  ms: number | null;
  method: "none" | "slowest-project" | "serial-sum";
  /** True only when there is nothing to finish, or a caller rule produced a bound. Never a schedule. */
  exact: boolean;
  note: string | null;
}

export interface ProjectEstimationSlice {
  projectId: string;
  current: boolean;
  scenario: ScenarioId | null;
  agent: DurationForecast | null;
  calendar: CalendarForecast | null;
  additionalCash: CashForecast | null;
  apiEquivalent: CashForecast | null;
  subscriptionFees: CashForecast | null;
  confidence: ConfidenceLevel | null;
  missing: string[];
}

export interface ClosestProject {
  status: "known" | "unknown";
  projectId: string | null;
  calendarMs: number | null;
  note: string;
}

export interface PortfolioEstimation {
  scenarioNote: string;
  agent: PortfolioDuration;
  calendar: PortfolioCalendar;
  additionalCash: PortfolioMoney;
  apiEquivalent: PortfolioMoney;
  /** Existing subscription fees, each subscription id once. */
  subscriptions: PortfolioMoney;
  /** Proposed purchases are not added again on top of additional cash. */
  proposedSubscriptionIds: string[];
  confidence: ConfidenceLevel;
  confidenceNote: string;
  closestProject: ClosestProject;
  /**
   * "What fits in the time left today" needs per-task durations and a
   * caller-supplied window. Those are not on this snapshot.
   */
  remainingWindow: { status: "unknown"; note: string };
  projects: ProjectEstimationSlice[];
  simplifications: string[];
}

export interface CompletenessReport {
  status: "complete" | "partial" | "unknown";
  missing: MissingDatum[];
  warnings: string[];
  staleProjectIds: string[];
  unprovenProjectIds: string[];
  provenance: ProvenanceEntry[];
}

export interface PortfolioAnalysis {
  ok: boolean;
  issues: PortfolioIssue[];
  projects: ProjectSummary[];
  aggregate: PortfolioAggregate | null;
  health: ProjectHealth[];
  resources: ResourceView[];
  conflicts: ResourceConflict[];
  priorities: PriorityAnalysis | null;
  proposals: PortfolioProposal[];
  estimation: PortfolioEstimation | null;
  completeness: CompletenessReport | null;
  execution: "proposal-only";
  /** Detection never stops a live agent. */
  runningAgents: "unchanged";
}

export interface PortfolioWhatIfPatch {
  projectPriorities?: ProjectPriorityInput[];
  dropResourceIds?: string[];
  upsertResources?: ResourceSnapshotInput[];
  concurrency?: Array<{ resourceId: string; limit: number | "unbounded" | null; origin: DataOrigin }>;
  /** Keep only these board task ids. Omitted tasks disappear from the copy. */
  selectedTaskIds?: string[];
  excludeProjectIds?: string[];
  policy?: Partial<PortfolioPolicyInput>;
  /** Hypothetical harness/account placement. Applied only to the copy. */
  allocations?: Array<{ taskId: string; resourceId: string }>;
}

export interface PortfolioQuestionContract {
  id: string;
  prompt: string;
  answeredBy: string;
}

/** Questions the future manager may ask, and the field that is allowed to answer. */
export const PORTFOLIO_QUESTION_CONTRACTS: readonly PortfolioQuestionContract[] = [
  {
    id: "status",
    prompt: "What is happening across my projects?",
    answeredBy: "aggregate and health.signals, with unknown left unknown",
  },
  {
    id: "closest",
    prompt: "Which project is closest to finishing?",
    answeredBy: "estimation.closestProject, and only when each current project's own calendar is known and they do not share a constrained account",
  },
  {
    id: "focus",
    prompt: "Where should agents focus?",
    answeredBy: "priorities.compared and a focus-project proposal. Project priority stays the owner's declaration",
  },
  {
    id: "blockers",
    prompt: "Which tasks block the others?",
    answeredBy: "priorities.entries blockedBy and unblockCount, from structured dependencies only",
  },
  {
    id: "accounts",
    prompt: "How should accounts be split across projects?",
    answeredBy: "conflicts and suggest-agent-assignment. The suggestion is not applied",
  },
  {
    id: "today",
    prompt: "What can be done in the time left today?",
    answeredBy: "estimation.remainingWindow, which stays unknown until a caller supplies a window and per-task durations",
  },
] as const;

/**
 * FO-008B integration notes. Listed here so the adapter does not grow inside
 * the forbidden files during FO-008A. See docs/plans/portfolio-manager-core.md.
 */
export const FO008B_INTEGRATION = {
  version: "fo-008a",
  readsSqlite: false,
  callsModels: false,
  mutatesProjects: false,
  execution: "proposal-only",
  forbiddenInThisChange: [
    "src/bun/db.ts",
    "src/bun/server.ts",
    "src/bun/project-manager.ts",
    "src/bun/execution-batches.ts",
    "src/mainview/App.tsx",
    "src/shared/types.ts",
    "src/mainview/components/",
    "src/bun/migrations/",
  ],
  /**
   * `task_priorities` has no row for a task the owner never set.
   * `priorityOf` in db.ts returns "normal" for that gap. The adapter must
   * pass origin `unknown` and a null value instead of copying that default.
   */
  priorityDefaultIsNotAFact: true,
} as const;

export function emptyColumns(): Record<ColumnId, number> {
  return { backlog: 0, inbox: 0, ready: 0, running: 0, blocked: 0, review: 0, done: 0 };
}

export function priorityRank(priority: TaskPriority): number {
  return TASK_PRIORITY_IDS.indexOf(priority);
}
