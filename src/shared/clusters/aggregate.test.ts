import { expect, test } from "bun:test";
import type { CashForecast, DataOrigin } from "../estimation/types.ts";
import type { TaskPriority } from "../task-scheduling.ts";
import { analyzePortfolio } from "../portfolio/index.ts";
import type {
  Fact,
  PortfolioSnapshotInput,
  ProjectEstimateFactInput,
  ProjectSnapshotInput,
  ResourceSnapshotInput,
  RunFactInput,
  TaskFactInput,
} from "../portfolio/types.ts";
import { aggregateCluster } from "./aggregate.ts";

const NOW = 1_000_000;

function fact<T>(value: T, origin: DataOrigin = "known", observedAtMs: number | null = NOW): Fact<T> {
  return { value, origin, observedAtMs };
}

function task(partial: Partial<TaskFactInput> & { id: string }): TaskFactInput {
  const priority = partial.priority ?? fact<TaskPriority | null>(null, "unknown");
  return {
    title: partial.id,
    column: "backlog",
    archived: false,
    pipelineParentId: null,
    harnessId: null,
    accountId: null,
    modelId: null,
    agentProfileId: null,
    requiredPermissions: [],
    spending: null,
    ...partial,
    priority,
  };
}

function run(partial: Partial<RunFactInput> & { id: string; taskId: string }): RunFactInput {
  return { harnessId: "codex", accountId: null, status: "succeeded", modelId: null, agentProfileId: null, ...partial };
}

function cash(minor: number | null, status: CashForecast["status"] = "known"): CashForecast {
  const money = minor == null ? null : { currency: "USD", minor };
  return {
    status,
    money: status === "known" ? money : null,
    knownPortion: money,
    origin: "user-provided",
    basis: "priced",
    countsAsAdditionalCash: true,
    note: null,
  };
}

function estimate(partial: Partial<ProjectEstimateFactInput> = {}): ProjectEstimateFactInput {
  return {
    scenario: "expected",
    agent: { status: "known", ms: 0, knownMs: 0, unknownStageIds: [], origin: "known", note: null },
    calendar: {
      status: "known",
      ms: 0,
      scheduleMs: 0,
      criticalPathMs: 0,
      serialUpperBoundMs: 0,
      method: "critical-path",
      exact: true,
      startAtMs: null,
      finishAtMs: null,
      simplifications: [],
      unknownItemIds: [],
      note: null,
    },
    additionalCash: cash(0),
    apiEquivalent: { ...cash(0), countsAsAdditionalCash: false },
    subscriptionFees: cash(0),
    subscriptions: [],
    confidence: "medium",
    missing: [],
    coverageStatus: null,
    observedAtMs: NOW,
    ...partial,
  };
}

function project(partial: Partial<ProjectSnapshotInput> & { id: string }): ProjectSnapshotInput {
  return {
    path: partial.path ?? partial.id,
    name: fact(partial.id, "user-provided"),
    description: fact<string | null>(null, "unknown"),
    stack: fact<string[] | null>(["TypeScript"]),
    managerConfigured: fact(true),
    managerAvailable: fact(true),
    observedAtMs: NOW,
    coverage: { board: true, runs: true, batches: true, pipelines: true, dependencies: true },
    tasks: [],
    dependencies: [],
    runs: [],
    pipelines: [],
    batches: [],
    environment: { configured: fact(true), phase: fact("stopped", "observed") },
    estimate: estimate(),
    ...partial,
  };
}

function resource(partial: Partial<ResourceSnapshotInput> & { id: string }): ResourceSnapshotInput {
  return {
    harnessId: "codex",
    harnessKind: "codex",
    accountId: "acc",
    agentProfileIds: [],
    supportedModels: fact<string[] | null>(null, "unknown"),
    availability: fact<"available" | "unavailable" | null>("available", "observed"),
    concurrencyLimit: fact<number | "unbounded" | null>(null, "unknown", null),
    occupiedSlots: fact<number | null>(null, "unknown", null),
    exclusive: false,
    quota: { kind: "unknown", reason: "not observed" },
    quotaOrigin: "unknown",
    extraSpending: fact<"forbidden" | "allowed" | null>(null, "unknown", null),
    permissions: fact<string[] | null>(null, "unknown", null),
    subscriptionId: null,
    ...partial,
  };
}

function snapshot(projects: ProjectSnapshotInput[], extra: Partial<PortfolioSnapshotInput> = {}): PortfolioSnapshotInput {
  return {
    capturedAtMs: NOW,
    stalenessAfterMs: 60_000,
    reportCurrency: "USD",
    exchangeRates: [],
    projects,
    resources: [],
    projectPriorities: [],
    deadlines: [],
    policy: { allowWorkWithUnknownLimits: false, enforceSafetyForAutomaticExecution: true, calendarCombination: null },
    ...extra,
  };
}

const sub = (id: string) => ({ id, commitment: "existing" as const, recurringFee: { currency: "USD", minor: 2000 }, priceOrigin: "known" as const });

test("empty cluster stays a known zero and ignores projects outside it", () => {
  const outside = project({ id: "/outside", tasks: [task({ id: "t-out", column: "running" })] });
  const result = aggregateCluster(snapshot([outside]), []);
  expect(result.completeness).toBe("complete");
  expect(result.counts.tasks).toEqual({ status: "known", value: 0, knownValue: 0, note: null });
  expect(result.counts.runningTasks.value).toBe(0);
  expect(result.exclusiveSubscriptionFees).toBe("none");
});

test("cluster counts each member project once and does not count a finished run as done", () => {
  const member = project({
    id: "/app",
    tasks: [
      task({ id: "board", column: "review" }),
      task({ id: "step", column: "done", pipelineParentId: "board" }),
    ],
    runs: [run({ id: "run-1", taskId: "board", status: "succeeded" })],
    batches: [{ id: "batch-1", status: "running", taskIds: ["board"] }],
  });
  const other = project({ id: "/other", tasks: [task({ id: "other-task", column: "blocked" })] });
  const full = snapshot([member, other]);
  const before = JSON.stringify(full);
  const result = aggregateCluster(full, ["/app"]);
  expect(JSON.stringify(full)).toBe(before);
  expect(result.counts.tasks).toMatchObject({ status: "known", value: 1 });
  expect(result.counts.pendingReviews).toMatchObject({ status: "known", value: 1 });
  expect(result.counts.doneTasks).toMatchObject({ status: "known", value: 0 });
  expect(result.counts.activeRuns).toMatchObject({ status: "known", value: 0 });
  expect(result.counts.blockers).toMatchObject({ status: "known", value: 0 });
  expect(result.counts.activeBatches).toMatchObject({ status: "known", value: 1 });
  expect(result.runNote).toContain("finished run is not a done task");
  const portfolio = analyzePortfolio(full);
  expect(portfolio.aggregate?.blockedCount).toMatchObject({ status: "known", value: 1 });
  expect(portfolio.aggregate?.taskCount.value).toBe(2);
});

test("a repeated task id is counted once", () => {
  const left = project({ id: "/left", tasks: [task({ id: "same", column: "running" })] });
  const right = project({ id: "/right", tasks: [task({ id: "same", column: "running" })] });
  const result = aggregateCluster(snapshot([left, right]), ["/left", "/right"]);
  expect(result.counts.tasks).toMatchObject({ status: "known", value: 1 });
  expect(result.counts.runningTasks.value).toBe(1);
  expect(result.duplicateTaskIds).toEqual(["same"]);
});

test("partial portfolio data stays partial and unknown counts stay unknown", () => {
  const partial = project({ id: "/partial", estimate: null });
  const partialResult = aggregateCluster(snapshot([partial]), ["/partial"]);
  expect(partialResult.completeness).toBe("partial");
  expect(partialResult.counts.tasks).toMatchObject({ status: "known", value: 0 });

  const unknown = project({
    id: "/unknown",
    coverage: { board: false, runs: false, batches: false, pipelines: false, dependencies: false },
    tasks: [task({ id: "hidden", column: "running" })],
  });
  const unknownResult = aggregateCluster(snapshot([unknown]), ["/unknown"]);
  expect(unknownResult.counts.tasks.status).toBe("unknown");
  expect(unknownResult.counts.tasks.value).toBeNull();
  expect(unknownResult.completeness).not.toBe("complete");
});

test("a missing snapshot and a missing member are not reported as zero", () => {
  const missing = aggregateCluster(null, ["/gone"]);
  expect(missing.completeness).toBe("unknown");
  expect(missing.counts.tasks.value).toBeNull();
  expect(missing.counts.tasks.status).toBe("unknown");

  const present = project({ id: "/present", tasks: [task({ id: "t", column: "running" })] });
  const omitted = aggregateCluster(snapshot([present]), ["/present", "/absent"]);
  expect(omitted.omittedPaths).toEqual(["/absent"]);
  expect(omitted.completeness).toBe("partial");
  expect(omitted.counts.tasks.status).toBe("incomplete");
  expect(omitted.counts.tasks.value).toBeNull();
  expect(omitted.counts.runningTasks.knownValue).toBe(1);
});

test("a stale environment phase is not the current phase", () => {
  const member = project({
    id: "/env",
    environment: {
      configured: fact(true),
      phase: fact("running", "observed", NOW - 1_000_000),
    },
  });
  const result = aggregateCluster(snapshot([member]), ["/env"]);
  expect(result.projectEnvironments[0]).toMatchObject({ phase: null, recordedPhase: "running", freshness: "stale" });
  expect(result.environments?.counts.running).toBeUndefined();
  expect(result.environments?.counts["phase-unknown"]).toBe(1);
  expect(result.completeness).toBe("partial");
});

test("an unknown environment phase stays unknown", () => {
  const member = project({
    id: "/env-unknown",
    environment: { configured: fact(true), phase: fact<null>(null, "unknown", null) },
  });
  const result = aggregateCluster(snapshot([member]), ["/env-unknown"]);
  expect(result.projectEnvironments[0]?.phase).toBeNull();
  expect(result.environments?.counts.running).toBeUndefined();
  expect(result.environments?.counts["phase-unknown"]).toBe(1);
});

test("shared subscriptions are counted once inside the cluster and are not exclusive when they continue outside", () => {
  const fee = estimate({ subscriptions: [sub("shared")], subscriptionFees: cash(2000) });
  const a = project({ id: "/a", estimate: fee });
  const b = project({ id: "/b", estimate: fee });
  const outside = project({ id: "/out", estimate: fee });
  const exclusive = aggregateCluster(snapshot([a, b]), ["/a", "/b"]);
  expect(exclusive.dedupedSubscriptionFees?.money).toEqual({ currency: "USD", minor: 2000 });
  expect(exclusive.exclusiveSubscriptionFees).toBe("exclusive");
  expect(exclusive.sharedSubscriptions[0]?.clusterProjectPaths).toEqual(["/a", "/b"]);

  const shared = aggregateCluster(snapshot([a, b, outside]), ["/a", "/b"]);
  expect(shared.dedupedSubscriptionFees?.money).toEqual({ currency: "USD", minor: 2000 });
  expect(shared.exclusiveSubscriptionFees).toBe("unknown");
  expect(shared.sharedSubscriptions[0]?.beyondClusterProjectPaths).toEqual(["/out"]);
  expect(shared.notes.some((note) => note.includes("not an exclusive cluster cost"))).toBe(true);
});

test("unknown quota is not unlimited, and an unrelated explicit-unbounded resource is not claimed by the cluster", () => {
  const member = project({ id: "/quota", tasks: [task({ id: "work", column: "ready", harnessId: "codex" })] });
  const input = snapshot([member], {
    resources: [
      resource({ id: "codex-unknown" }),
      resource({
        id: "other-unbounded",
        harnessId: "gemini",
        harnessKind: "gemini",
        concurrencyLimit: fact<number | "unbounded" | null>("unbounded", "user-provided"),
        quota: { kind: "unknown", reason: "not observed" },
      }),
    ],
  });
  const result = aggregateCluster(input, ["/quota"]);
  expect(result.resources.map((row) => row.id)).toEqual(["codex-unknown"]);
  expect(result.quotas[0]?.quota.kind).toBe("unknown");
  expect(result.quotas[0]?.capacity).toBe("unknown");
  expect(result.quotas[0]?.quotaTreatment).toBe("unknown");
  expect(result.resources[0]?.concurrencyLimit).toBeNull();
  expect(JSON.stringify(result.quotas)).not.toContain("unbounded");
});

test("active and blocked project counts follow current health and stay unknown when the snapshot is stale", () => {
  const running = project({ id: "/run", tasks: [task({ id: "r", column: "running" })] });
  const blocked = project({ id: "/blk", tasks: [task({ id: "b", column: "blocked" })] });
  const result = aggregateCluster(snapshot([running, blocked]), ["/run", "/blk"]);
  expect(result.activeProjects).toMatchObject({ status: "known", value: 1 });
  expect(result.blockedProjects).toMatchObject({ status: "known", value: 1 });

  const stale = project({
    id: "/old",
    observedAtMs: NOW - 120_000,
    tasks: [task({ id: "s", column: "running" })],
  });
  const staleResult = aggregateCluster(snapshot([stale]), ["/old"]);
  expect(staleResult.activeProjects.status).toBe("unknown");
  expect(staleResult.activeProjects.value).toBeNull();
  expect(staleResult.blockedProjects.value).toBeNull();
});
