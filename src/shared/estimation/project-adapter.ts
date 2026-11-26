/**
 * Project data adapter (FO-006B).
 *
 * Turns tasks that already exist, run durations that were actually recorded,
 * and values the user typed into an EstimationRequest. The FO-006A `estimate`
 * function is the only calculator. This module does not invent hours, prices,
 * quotas, or dependency edges.
 *
 * A task description is accepted on the fact and then ignored. A "depends on"
 * sentence in that text is not a dependency graph.
 *
 * Dependencies come from two confirmed sources only: the structured links in
 * `task_dependencies` (FO-005C, set on the board or by an approved proposal)
 * and the edges the user ticked on the Estimates page. The two are merged; an
 * empty manual list never removes a structured link. Priority is not read: it
 * orders execution, it is not effort.
 */

import type { EstimationSettings, ManualApiRate, ManualStage, ManualSubscription } from "./settings.ts";
import type {
  AccountInput,
  ApiRate,
  EstimationRequest,
  ExchangeRate,
  HistorySample,
  QuotaInput,
  StageInput,
  SubscriptionInput,
  WorkItemInput,
  WorkType,
} from "./types.ts";
import { ESTIMATION_LIMITS } from "./types.ts";

/** Placeholder report currency used only when the user has not chosen one. */
export const UNSET_REPORT_CURRENCY = "XXX";

export interface ObservedRunFact {
  runId: string;
  startedAt: number;
  endedAt: number;
  agentMs: number;
  status: string;
}

export interface ProjectTaskFact {
  id: string;
  title: string;
  column: string;
  taskType: string;
  harnessId: string | null;
  modelId: string | null;
  updatedAt: number;
  archived: boolean;
  pipelineParentId: string | null;
  /**
   * Display text held by the caller. The adapter does not read it, so a
   * markdown mention cannot become hours or a dependency.
   */
  description?: string;
  observedRuns: ObservedRunFact[];
}

export interface FingerprintTask {
  id: string;
  title: string;
  column: string;
  updatedAt: number;
  archived: boolean;
  pipelineParentId: string | null;
}

/** One structured link: `taskId` waits for `dependsOn` (migration 072). */
export interface StructuredDependency {
  taskId: string;
  dependsOn: string;
}

export interface ProjectEstimateInput {
  projectPath: string;
  projectLabel: string;
  facts: readonly ProjectTaskFact[];
  settings: EstimationSettings;
  /**
   * Links read from `task_dependencies` for this project. A link whose ends
   * are not both active tasks of this project is not used.
   */
  structuredDependencies?: readonly StructuredDependency[];
}

export interface AdaptedEstimate {
  request: EstimationRequest;
  notes: string[];
  /** No feature or milestone id is stored on a ForgeOrbit task. */
  groupings: readonly [];
  observed: Array<{ taskId: string; title: string; runId: string; agentMs: number; status: string }>;
}

/**
 * Changes when a board task or a structured dependency between two board
 * tasks changes. Without structured links the value is the same as before
 * they existed, so estimates saved earlier are not marked stale by the
 * upgrade alone.
 */
export function backlogFingerprint(
  tasks: readonly FingerprintTask[],
  dependencies: readonly StructuredDependency[] = [],
): string {
  const board = tasks.filter((task) => task.pipelineParentId == null);
  const ids = new Set(board.map((task) => task.id));
  const lines = board
    .map((task) => [task.id, String(task.updatedAt), task.column, task.archived ? "1" : "0", task.title.replaceAll("\n", " ")].join("\t"))
    .sort();
  const edges = new Set<string>();
  for (const edge of dependencies) {
    if (edge.taskId === edge.dependsOn || !ids.has(edge.taskId) || !ids.has(edge.dependsOn)) continue;
    edges.add(["dep", edge.taskId, edge.dependsOn].join("\t"));
  }
  lines.push(...[...edges].sort());
  let hash = 0x811c9dc5;
  const text = lines.join("\n");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1:${lines.length}:${(hash >>> 0).toString(16)}`;
}

export function estimateIsStale(savedFingerprint: string | null, currentFingerprint: string): boolean {
  return savedFingerprint != null && savedFingerprint !== currentFingerprint;
}

export function adaptProject(input: ProjectEstimateInput): AdaptedEstimate {
  const notes: string[] = [
    "Task titles and descriptions are shown for context. A description is not parsed into hours or into a dependency graph.",
    "No feature or milestone grouping is stored on these tasks, so that scope is unavailable.",
    "A column, including Done, does not set remaining effort.",
  ];
  const boardTasks = input.facts.filter((fact) => fact.pipelineParentId == null);
  const hiddenSteps = input.facts.length - boardTasks.length;
  if (hiddenSteps > 0) {
    notes.push("Pipeline step rows stay inside their parent task. They are not estimated as separate work, and their edges are not copied into this graph.");
  }
  const active = input.settings.includeArchived ? boardTasks : boardTasks.filter((fact) => !fact.archived);
  if (!input.settings.includeArchived && boardTasks.some((fact) => fact.archived)) {
    notes.push("Archived tasks are left out. They are not given a duration of zero.");
  }

  const byId = new Map(active.map((fact) => [fact.id, fact]));
  const structured = structuredByTask(input.structuredDependencies ?? [], byId, boardTasks, notes);
  const reportCurrency = input.settings.reportCurrency ?? UNSET_REPORT_CURRENCY;
  if (!input.settings.reportCurrency) {
    notes.push("Report currency is not set. No currency was assumed for missing prices.");
  }
  if (input.settings.budgetMode === "unset") {
    notes.push("Budget policy is not set. Extra spend was not turned off, so a policy zero is not produced.");
  } else if (input.settings.budgetMode === "overage-off") {
    notes.push("You turned extra spend off. A resulting zero is a policy figure, not a measured cover.");
  }

  const pinned = input.settings.pinnedSubscriptionId
    ? input.settings.subscriptions.find((row) => row.id === input.settings.pinnedSubscriptionId) ?? null
    : null;
  if (input.settings.pinnedSubscriptionId && !pinned) {
    notes.push("The pinned subscription is no longer in the list, so no task was attached to it.");
  }
  const accountId = pinned ? `account-${pinned.id}` : null;

  const items: WorkItemInput[] = [];
  const observed: AdaptedEstimate["observed"] = [];
  const history: HistorySample[] = [];
  for (const fact of active) {
    const dependsOn = confirmedDependencies(fact.id, input.settings, structured.get(fact.id) ?? [], byId, notes);
    items.push({
      id: fact.id,
      projectId: input.projectPath,
      projectPath: input.projectPath,
      title: fact.title,
      workType: workTypeFor(fact.taskType),
      dependsOn,
      stages: stagesFor(fact, input.settings.stages[fact.id], accountId),
    });
    for (const run of fact.observedRuns) {
      if (!Number.isSafeInteger(run.agentMs) || run.agentMs < 0) continue;
      observed.push({ taskId: fact.id, title: fact.title, runId: run.runId, agentMs: run.agentMs, status: run.status });
      if (history.length < ESTIMATION_LIMITS.maxHistory) {
        history.push({
          projectId: input.projectPath,
          workType: workTypeFor(fact.taskType),
          complexity: null,
          stageKind: null,
          agentMs: run.agentMs,
          sampleCount: 1,
          origin: "observed",
        });
      }
    }
  }
  if (observed.length > 0) {
    notes.push("Observed run durations are wall-clock measurements from run history. They do not fill a missing effort range.");
  }

  let itemIds: string[] | undefined;
  if (input.settings.scope.kind === "selected") {
    const known: string[] = [];
    const missing: string[] = [];
    for (const id of input.settings.scope.itemIds) {
      if (byId.has(id)) known.push(id);
      else missing.push(id);
    }
    if (missing.length > 0) notes.push("Some selected tasks are not in this project anymore and were left out of the scope.");
    itemIds = known;
  }

  const request: EstimationRequest = {
    scope: {
      kind: input.settings.scope.kind === "project" ? "project" : "task",
      id: input.settings.scope.kind === "project" ? input.projectPath : `${input.projectPath}:selected`,
      label: input.settings.scope.kind === "project" ? input.projectLabel : "Selected tasks",
      ...(itemIds ? { itemIds } : {}),
      projectIds: [input.projectPath],
    },
    items,
    subscriptions: input.settings.subscriptions.map(toSubscription),
    accounts: pinned
      ? [{
          id: accountId!,
          provider: pinned.provider,
          subscriptionId: pinned.id,
          maxConcurrent: input.settings.accountConcurrency,
        } satisfies AccountInput]
      : [],
    reportCurrency,
    exchangeRates: input.settings.exchangeRates.map((rate): ExchangeRate => ({ ...rate, origin: "user-provided" })),
    allocation: { mode: "none" },
    budget: {
      maxAdditionalSpend: input.settings.maxAdditionalSpend,
      allowedPaidServices: [...input.settings.allowedPaidServices],
      paidOverageEnabled: input.settings.budgetMode !== "overage-off",
      subscriptionUpgradeAllowed: input.settings.budgetMode === "overage-on" && input.settings.subscriptionUpgradeAllowed,
    },
    parallelism: { maxConcurrentItems: input.settings.parallelism.maxConcurrentItems },
    machine: {
      dutyCycle: input.settings.machine.dutyCycle,
      plannedPauseMs: input.settings.machine.plannedPauseMs,
    },
    startAtMs: null,
    apiRates: input.settings.apiRates === null ? null : input.settings.apiRates.map(toApiRate),
    history: history.length > 0 ? history : null,
  };

  return { request, notes, groupings: [], observed };
}

/**
 * Group structured links by dependent task, keeping only links between two
 * active tasks of this project. Duplicates collapse to one edge.
 */
function structuredByTask(
  edges: readonly StructuredDependency[],
  byId: ReadonlyMap<string, ProjectTaskFact>,
  boardTasks: readonly ProjectTaskFact[],
  notes: string[],
): Map<string, string[]> {
  const board = new Set(boardTasks.map((fact) => fact.id));
  const grouped = new Map<string, string[]>();
  let inactive = 0;
  let foreign = 0;
  let used = 0;
  for (const edge of edges) {
    if (edge.taskId === edge.dependsOn) continue;
    if (!board.has(edge.taskId) || !board.has(edge.dependsOn)) {
      foreign++;
      continue;
    }
    if (!byId.has(edge.taskId) || !byId.has(edge.dependsOn)) {
      inactive++;
      continue;
    }
    const list = grouped.get(edge.taskId) ?? [];
    if (list.includes(edge.dependsOn)) continue;
    list.push(edge.dependsOn);
    grouped.set(edge.taskId, list);
    used++;
  }
  if (used > 0) notes.push("Dependencies set on the board are used as confirmed edges, together with the ones you ticked here.");
  if (inactive > 0) notes.push("Some board dependencies involve archived tasks that are left out, so those edges were not used.");
  if (foreign > 0) notes.push("Some board dependencies point outside this project's tasks, so those edges were not used.");
  return grouped;
}

function confirmedDependencies(
  taskId: string,
  settings: EstimationSettings,
  structured: readonly string[],
  byId: ReadonlyMap<string, ProjectTaskFact>,
  notes: string[],
): string[] {
  const kept: string[] = [...structured];
  for (const id of settings.dependencies[taskId] ?? []) {
    if (id === taskId || kept.includes(id)) continue;
    if (byId.has(id)) kept.push(id);
    else notes.push(`A confirmed dependency from ${taskId} points at ${id}, which is not an active task in this project, so the edge was not used.`);
  }
  if (kept.length > ESTIMATION_LIMITS.maxDependenciesPerItem) {
    notes.push(`${taskId} has more than ${ESTIMATION_LIMITS.maxDependenciesPerItem} confirmed dependencies. Board links were kept first and the rest were not used.`);
    return kept.slice(0, ESTIMATION_LIMITS.maxDependenciesPerItem);
  }
  return kept;
}

function stagesFor(fact: ProjectTaskFact, manual: ManualStage[] | undefined, accountId: string | null): StageInput[] {
  const source = manual && manual.length > 0 ? manual : [defaultStage()];
  return source.map((stage) => {
    const input: StageInput = {
      id: stage.id,
      kind: stage.kind,
      label: stage.kind,
      harnessId: stage.harnessFromTask ? fact.harnessId : stage.harnessId,
      modelId: stage.modelFromTask ? fact.modelId : stage.modelId,
      accountId,
      effort: stage.effort ? { ...stage.effort, origin: "user-provided" } : null,
    };
    if (stage.repetitions) input.repetitions = { ...stage.repetitions };
    if (stage.consumption) {
      input.consumption = {
        unit: stage.consumption.unit,
        amount: stage.consumption.amount,
        currency: stage.consumption.unit === "credits" ? stage.consumption.currency : null,
        origin: "user-provided",
      };
    }
    return input;
  });
}

function defaultStage(): ManualStage {
  return {
    id: "implementation",
    kind: "implementation",
    effort: null,
    repetitions: null,
    harnessFromTask: true,
    harnessId: null,
    modelFromTask: true,
    modelId: null,
    consumption: null,
  };
}

function toSubscription(row: ManualSubscription): SubscriptionInput {
  const quotas: QuotaInput[] = [];
  const capacity = row.capacity;
  if (capacity?.kind === "count") {
    quotas.push({
      id: `${row.id}-capacity`,
      label: "Entered remaining capacity",
      origin: "user-provided",
      unit: { kind: "count", unit: capacity.unit, remaining: capacity.remaining, limit: capacity.limit, resetsAtMs: null },
    });
  } else if (capacity?.kind === "credits") {
    quotas.push({
      id: `${row.id}-capacity`,
      label: "Entered remaining credits",
      origin: "user-provided",
      unit: {
        kind: "credits",
        remainingMinor: capacity.remainingMinor,
        currency: capacity.currency,
        limitMinor: capacity.limitMinor,
        resetsAtMs: null,
      },
    });
  } else if (capacity?.kind === "percent-used") {
    quotas.push({
      id: `${row.id}-capacity`,
      label: "Entered percent used",
      origin: "user-provided",
      unit: { kind: "percent-used", usedPercent: capacity.usedPercent, resetsAtMs: null },
    });
  } else if (capacity?.kind === "opaque") {
    quotas.push({
      id: `${row.id}-capacity`,
      label: capacity.label,
      origin: "user-provided",
      unit: { kind: "opaque", label: capacity.label, note: capacity.note },
    });
  }
  const priced = row.recurringFee != null || row.purchasePrice != null || (row.overagePrices != null && row.overagePrices.length > 0);
  return {
    id: row.id,
    provider: row.provider,
    commitment: row.commitment,
    planLabel: row.planLabel,
    recurringFee: row.recurringFee,
    purchasePrice: row.purchasePrice,
    priceOrigin: priced ? "user-provided" : "unknown",
    billingPeriod: row.billingPeriod,
    renewalAtMs: null,
    supportedModels: null,
    quotas,
    overage: row.overageEnabled || row.overagePrices != null
      ? {
          enabled: row.overageEnabled,
          prices: row.overagePrices === null
            ? null
            : row.overagePrices.map((price) => ({
                unit: price.unit,
                per: price.per,
                money: price.money,
                origin: "user-provided" as const,
                currency: price.currency,
              })),
        }
      : null,
    allowedAdditionalSpend: null,
  };
}

function toApiRate(rate: ManualApiRate): ApiRate {
  return {
    id: rate.id,
    modelId: rate.modelId,
    harnessId: rate.harnessId,
    perAgentMs: rate.perAgentMs,
    money: rate.money,
    origin: "user-provided",
  };
}

function workTypeFor(taskType: string): WorkType {
  if (taskType === "bug") return "bug";
  if (taskType === "spike") return "spike";
  return "other";
}
