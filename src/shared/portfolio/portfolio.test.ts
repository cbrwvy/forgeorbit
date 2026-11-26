import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CashForecast, DataOrigin } from "../estimation/types.ts";
import type { TaskPriority } from "../task-scheduling.ts";
import { analyzePortfolio, analyzeWhatIf } from "./index.ts";
import type {
  CountFact,
  Fact,
  PortfolioSnapshotInput,
  ProjectEstimateFactInput,
  ProjectSnapshotInput,
  ResourceSnapshotInput,
  RunFactInput,
  TaskFactInput,
} from "./index.ts";

const NOW = 1_000_000;

function fact<T>(value: T, origin: DataOrigin = "known"): Fact<T> {
  return { value, origin, observedAtMs: NOW };
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
  return {
    harnessId: "codex",
    accountId: null,
    status: "running",
    modelId: null,
    agentProfileId: null,
    ...partial,
  };
}

function project(partial: Partial<ProjectSnapshotInput> & { id: string }): ProjectSnapshotInput {
  return {
    path: partial.path ?? `/work/${partial.id}`,
    name: fact(partial.id, "user-provided"),
    description: fact<string | null>(null, "unknown"),
    stack: fact<string[] | null>(null, "unknown"),
    managerConfigured: fact(true, "known"),
    managerAvailable: fact(true, "known"),
    observedAtMs: NOW,
    coverage: { board: true, runs: true, batches: true, pipelines: true, dependencies: true },
    tasks: [],
    dependencies: [],
    runs: [],
    pipelines: [],
    batches: [],
    environment: {
      configured: fact(true, "known"),
      phase: fact("stopped", "observed"),
    },
    estimate: null,
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
    concurrencyLimit: fact<number | "unbounded" | null>("unbounded", "user-provided"),
    occupiedSlots: fact<number | null>(null, "unknown"),
    exclusive: false,
    quota: { kind: "remaining", unit: "requests", remaining: 10, limit: 10, resetsAtMs: null, currency: null },
    quotaOrigin: "known",
    extraSpending: fact<"forbidden" | "allowed" | null>("forbidden", "user-provided"),
    permissions: fact<string[] | null>(null, "unknown"),
    subscriptionId: null,
    ...partial,
  };
}

function duration(ms: number, status: "known" | "estimated" | "incomplete" | "unknown" = "known"): ProjectEstimateFactInput["agent"] {
  return {
    status,
    ms: status === "known" || status === "estimated" ? ms : null,
    knownMs: status === "unknown" ? null : ms,
    unknownStageIds: status === "incomplete" ? ["stage"] : [],
    origin: status === "known" ? "known" : "estimated",
    note: null,
  };
}

function calendar(ms: number, status: "known" | "estimated" | "incomplete" | "unknown" = "known"): ProjectEstimateFactInput["calendar"] {
  return {
    status,
    ms: status === "known" || status === "estimated" ? ms : null,
    scheduleMs: ms,
    criticalPathMs: ms,
    serialUpperBoundMs: ms,
    method: "critical-path",
    exact: status === "known",
    startAtMs: null,
    finishAtMs: null,
    simplifications: [],
    unknownItemIds: [],
    note: null,
  };
}

function cash(minor: number | null, currency = "USD", status: CashForecast["status"] = "known"): CashForecast {
  const money = minor == null ? null : { currency, minor };
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
    agent: duration(0),
    calendar: calendar(0),
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
    policy: {
      allowWorkWithUnknownLimits: false,
      enforceSafetyForAutomaticExecution: true,
      calendarCombination: null,
    },
    ...extra,
  };
}

function known(count: CountFact): number {
  expect(count.status).toBe("known");
  if (count.value == null) throw new Error(count.note ?? "count was not known");
  return count.value;
}

function signals(projectId: string, input: PortfolioSnapshotInput): string[] {
  const analysis = analyzePortfolio(input);
  return analysis.health.find((item) => item.projectId === projectId)?.signals ?? [];
}

describe("portfolio core", () => {
  test("1. empty portfolio", () => {
    const analysis = analyzePortfolio(snapshot([]));
    expect(analysis.ok).toBe(true);
    expect(analysis.aggregate?.projectCount).toBe(0);
    expect(known(analysis.aggregate!.taskCount)).toBe(0);
    expect(known(analysis.aggregate!.doneCount)).toBe(0);
    expect(known(analysis.aggregate!.activeRunCount)).toBe(0);
    expect(analysis.aggregate?.activeProjectIds).toEqual([]);
    expect(analysis.conflicts).toEqual([]);
    expect(analysis.proposals).toEqual([]);
    expect(analysis.estimation?.agent).toMatchObject({ status: "known", ms: 0 });
    expect(analysis.estimation?.calendar).toMatchObject({ status: "known", ms: 0 });
    expect(analysis.completeness?.status).toBe("complete");
    expect(analysis.execution).toBe("proposal-only");
    expect(analysis.runningAgents).toBe("unchanged");
  });

  test("2. one project", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [
          task({ id: "board", column: "ready" }),
          task({ id: "step", pipelineParentId: "board", column: "running" }),
        ],
      }),
    ]));
    expect(analysis.aggregate?.projectCount).toBe(1);
    expect(known(analysis.aggregate!.taskCount)).toBe(1);
    expect(known(analysis.aggregate!.pipelineStepCount)).toBe(1);
    expect(analysis.projects[0]?.path).toBe("/work/app");
    expect(analysis.projects[0]?.name).toBe("app");
  });

  test("3. several projects", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", tasks: [task({ id: "a1" }), task({ id: "a2", column: "done" })], batches: [{ id: "ba", status: "paused", taskIds: ["a1"] }] }),
      project({ id: "b", tasks: [task({ id: "b1", column: "backlog" }), task({ id: "b2", column: "ready" }), task({ id: "b3", column: "done" })] }),
    ]));
    expect(analysis.aggregate?.projectCount).toBe(2);
    expect(known(analysis.aggregate!.taskCount)).toBe(5);
    expect(known(analysis.aggregate!.doneCount)).toBe(2);
    expect(known(analysis.aggregate!.pausedBatchCount)).toBe(1);
    expect(analysis.aggregate?.columns.counts).toMatchObject({ backlog: 2, ready: 1, done: 2 });
  });

  test("4. active project", () => {
    const input = snapshot([project({ id: "app", tasks: [task({ id: "run", column: "running" })] })]);
    const found = signals("app", input);
    expect(found).toContain("active");
    expect(found).not.toContain("idle");
    expect(analyzePortfolio(input).aggregate?.activeProjectIds).toEqual(["app"]);
  });

  test("5. project without tasks is idle, not finished", () => {
    const analysis = analyzePortfolio(snapshot([project({ id: "empty" })]));
    const health = analysis.health[0];
    expect(health?.signals).toContain("idle");
    expect(health?.signals.join(" ")).not.toMatch(/complete|finished|done/);
    expect(known(analysis.aggregate!.taskCount)).toBe(0);
    expect(known(analysis.aggregate!.doneCount)).toBe(0);
    expect(analysis.aggregate?.activeProjectIds).toEqual([]);
    expect(health?.findings.find((item) => item.signal === "idle")?.explanation).toMatch(/not a completed/i);
  });

  test("6. waiting for review is not done", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [task({ id: "reviewed", column: "review" })],
        runs: [run({ id: "r", taskId: "reviewed", status: "succeeded" })],
      }),
    ]));
    expect(known(analysis.aggregate!.reviewCount)).toBe(1);
    expect(known(analysis.aggregate!.doneCount)).toBe(0);
    expect(analysis.aggregate?.columns.counts?.review).toBe(1);
    expect(analysis.aggregate?.columns.counts?.done).toBe(0);
    expect(known(analysis.aggregate!.activeRunCount)).toBe(0);
    expect(analysis.health[0]?.signals).toContain("waiting-for-owner");
    expect(analysis.health[0]?.signals).not.toContain("idle");
  });

  test("7. blocked project", () => {
    const analysis = analyzePortfolio(snapshot([project({ id: "app", tasks: [task({ id: "stuck", column: "blocked" })] })]));
    expect(known(analysis.aggregate!.blockedCount)).toBe(1);
    expect(known(analysis.aggregate!.doneCount)).toBe(0);
    expect(analysis.health[0]?.signals).toContain("blocked");
    expect(analysis.aggregate?.attentionProjectIds).toContain("app");
  });

  test("8. degraded environment overlaps with active work and review", () => {
    const input = snapshot([
      project({
        id: "app",
        tasks: [task({ id: "run", column: "running" }), task({ id: "look", column: "review" })],
        environment: { configured: fact(true), phase: fact("degraded", "observed") },
      }),
    ]);
    const found = signals("app", input);
    expect(found).toContain("active");
    expect(found).toContain("waiting-for-owner");
    expect(found).toContain("degraded");
    expect(new Set(found).size).toBeGreaterThan(1);
  });

  test("8b. a phase recorded outside the staleness window is not the current state (FO-008C)", () => {
    const old = { value: "degraded" as const, origin: "observed" as const, observedAtMs: NOW - 10 * 60_000 };
    const input = snapshot([
      project({ id: "app", environment: { configured: fact(true), phase: old } }),
      project({ id: "untimed", environment: { configured: fact(true), phase: { value: "error", origin: "observed", observedAtMs: null } } }),
    ]);
    const analysis = analyzePortfolio(input);
    for (const id of ["app", "untimed"]) {
      const summary = analysis.projects.find((item) => item.projectId === id)!;
      expect(summary.environmentPhase).toBeNull();
      expect(summary.environmentPhaseOrigin).toBe("unknown");
      expect(summary.environmentRecordedPhase).not.toBeNull();
      expect(summary.environmentPhaseNote).toContain("current state is unknown");
      const found = signals(id, input);
      expect(found).not.toContain("degraded");
      expect(found).toContain("unknown");
      const health = analysis.health.find((item) => item.projectId === id)!;
      expect(health.historicalFindings.some((item) => item.signal === "degraded" && item.current === false)).toBe(true);
    }
    expect(analysis.projects.find((item) => item.projectId === "app")!.environmentPhaseFreshness).toBe("stale");
    expect(analysis.projects.find((item) => item.projectId === "untimed")!.environmentPhaseFreshness).toBe("unproven");
    expect(analysis.completeness?.missing.some((item) => item.code === "environment-stale")).toBe(true);
  });

  test("9. unknown data stays unknown", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        coverage: { board: false, runs: false, batches: false, pipelines: false, dependencies: false },
        managerAvailable: fact<boolean | null>(null, "unknown"),
        environment: { configured: fact<boolean | null>(null, "unknown"), phase: fact(null, "unknown") },
      }),
    ]));
    expect(analysis.projects[0]?.taskCount).toBeNull();
    expect(analysis.aggregate?.taskCount.status).toBe("unknown");
    expect(analysis.aggregate?.taskCount.value).toBeNull();
    expect(analysis.health[0]?.signals).toContain("unknown");
    expect(analysis.health[0]?.signals).not.toContain("idle");
  });

  test("10. duplicate task ids are counted once", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "app", tasks: [task({ id: "same", column: "ready" }), task({ id: "same", column: "running" })] }),
      project({ id: "other", tasks: [task({ id: "same", column: "done" })] }),
    ]));
    expect(known(analysis.aggregate!.taskCount)).toBe(1);
    expect(analysis.aggregate?.duplicateTaskIds).toEqual(["same"]);
    expect(analysis.projects[0]?.columns?.ready).toBe(1);
    expect(analysis.projects[0]?.columns?.running).toBe(0);
    expect(analysis.ok).toBe(true);
  });

  test("11. a task in a batch and on the board is one task", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [task({ id: "only", column: "ready" })],
        batches: [{ id: "batch", status: "running", taskIds: ["only", "only"] }],
      }),
    ]));
    expect(known(analysis.aggregate!.taskCount)).toBe(1);
    expect(known(analysis.aggregate!.runningBatchCount)).toBe(1);
    expect(known(analysis.aggregate!.activeBatchCount)).toBe(1);
    expect(analysis.aggregate?.columns.counts?.ready).toBe(1);
  });

  test("12. several active runs", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [task({ id: "t", column: "running" })],
        runs: [
          run({ id: "r1", taskId: "t", harnessId: "codex", status: "running" }),
          run({ id: "r2", taskId: "t", harnessId: "cursor", status: "running" }),
          run({ id: "r3", taskId: "t", harnessId: "codex", status: "succeeded" }),
        ],
      }),
    ]));
    expect(known(analysis.aggregate!.activeRunCount)).toBe(2);
    expect(analysis.aggregate?.harnesses.activeRuns).toEqual({ codex: 1, cursor: 1 });
    expect(known(analysis.aggregate!.doneCount)).toBe(0);
  });

  test("13. one account shared by two projects", () => {
    const shared = resource({ id: "codex-main", subscriptionId: "sub" });
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", tasks: [task({ id: "a1", harnessId: "codex", accountId: "acc" })] }),
      project({ id: "b", tasks: [task({ id: "b1", harnessId: "codex", accountId: "acc" })] }),
    ], { resources: [shared] }));
    expect(analysis.resources.map((item) => item.projectIds)).toEqual([["a", "b"]]);
    expect(analysis.resources).toHaveLength(1);
    expect(analysis.conflicts.filter((item) => item.class === "confirmed")).toEqual([]);
  });

  test("14. concurrency limit", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", tasks: [task({ id: "a1", column: "running", harnessId: "codex", accountId: "acc" })] }),
      project({ id: "b", tasks: [task({ id: "b1", column: "running", harnessId: "codex", accountId: "acc" })] }),
    ], {
      resources: [resource({ id: "codex-main", concurrencyLimit: fact<number | "unbounded" | null>(1, "known") })],
    }));
    const conflict = analysis.conflicts.find((item) => item.code === "concurrency-exceeded");
    expect(conflict?.class).toBe("confirmed");
    expect(conflict?.blocksAutomaticExecution).toBe(true);
    expect(conflict?.runningAgents).toBe("unchanged");
    expect(conflict?.projectIds).toEqual(["a", "b"]);
  });

  test("15. exhausted quota is not inferred from a percent bar", () => {
    const using = (id: string) => project({
      id,
      tasks: [task({ id: `${id}-t`, column: "ready", harnessId: "codex", accountId: "acc" })],
    });
    const exhausted = analyzePortfolio(snapshot([using("app")], {
      resources: [resource({ id: "codex-main", quota: { kind: "exhausted", resetsAtMs: null, evidence: "provider reported remaining 0" }, quotaOrigin: "known" })],
    }));
    expect(exhausted.conflicts.some((item) => item.class === "confirmed" && item.code === "quota-exhausted")).toBe(true);

    const percent = analyzePortfolio(snapshot([using("app")], {
      policy: { allowWorkWithUnknownLimits: true, enforceSafetyForAutomaticExecution: true, calendarCombination: null },
      resources: [resource({
        id: "codex-main",
        quota: { kind: "percent-used", usedPercent: 100, resetsAtMs: null },
        quotaOrigin: "observed",
      })],
    }));
    expect(percent.conflicts.some((item) => item.code === "quota-exhausted" || item.class === "confirmed")).toBe(false);
    expect(percent.conflicts.some((item) => item.code === "quota-percent-not-capacity" && item.class === "insufficient-data")).toBe(true);
    expect(percent.resources[0]?.quotaTreatment).toBe("percent-used-not-capacity");
  });

  test("16. unknown quota is a warning, not a confirmed block", () => {
    const base = snapshot([
      project({ id: "app", tasks: [task({ id: "t", column: "ready", harnessId: "codex", accountId: "acc" })] }),
    ], {
      resources: [resource({ id: "codex-main", quota: { kind: "unknown", reason: "provider has no meter" }, quotaOrigin: "unknown" })],
    });
    const allowed = analyzePortfolio({
      ...base,
      policy: { ...base.policy, allowWorkWithUnknownLimits: true },
    });
    const unknown = allowed.conflicts.find((item) => item.code === "quota-unknown");
    expect(unknown?.class).toBe("insufficient-data");
    expect(unknown?.blocksAutomaticExecution).toBe(false);
    expect(unknown?.runningAgents).toBe("unchanged");

    const held = analyzePortfolio(base);
    const heldConflict = held.conflicts.find((item) => item.code === "quota-unknown");
    expect(heldConflict?.class).toBe("insufficient-data");
    expect(heldConflict?.blocksAutomaticExecution).toBe(true);
  });

  test("17. unavailable harness", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "app", tasks: [task({ id: "t", column: "ready", harnessId: "codex", accountId: "acc" })] }),
    ], {
      resources: [resource({ id: "codex-main", availability: fact("unavailable", "observed") })],
    }));
    const conflict = analysis.conflicts.find((item) => item.code === "harness-unavailable");
    expect(conflict?.class).toBe("confirmed");
    expect(conflict?.blocksAutomaticExecution).toBe(true);
    expect(conflict?.runningAgents).toBe("unchanged");
  });

  test("18. unsupported model", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "app", tasks: [task({ id: "t", column: "ready", harnessId: "codex", accountId: "acc", modelId: "opus" })] }),
    ], {
      resources: [resource({ id: "codex-main", supportedModels: fact<string[] | null>(["gpt-5"], "known") })],
    }));
    const conflict = analysis.conflicts.find((item) => item.code === "unsupported-model");
    expect(conflict?.class).toBe("confirmed");
    expect(conflict?.taskIds).toEqual(["t"]);
    expect(conflict?.blocksAutomaticExecution).toBe(true);
  });

  test("19. critical priority outranks low", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [
          task({ id: "low", priority: fact<TaskPriority | null>("low", "user-provided") }),
          task({ id: "crit", priority: fact<TaskPriority | null>("critical", "user-provided") }),
        ],
      }),
    ], { projectPriorities: [{ projectId: "app", priority: "normal", origin: "user-provided" }] }));
    expect(analysis.priorities?.compared.map((item) => item.taskId)).toEqual(["crit", "low"]);
    expect(analysis.priorities?.compared[0]?.reasons.join(" ")).toMatch(/critical/i);
  });

  test("20. declared project priority is explicit", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "low-proj", tasks: [task({ id: "l", priority: fact<TaskPriority | null>("critical", "user-provided") })] }),
      project({ id: "high-proj", tasks: [task({ id: "h", priority: fact<TaskPriority | null>("low", "user-provided") })] }),
    ], {
      projectPriorities: [
        { projectId: "high-proj", priority: "high", origin: "user-provided" },
        { projectId: "low-proj", priority: "low", origin: "user-provided" },
      ],
    }));
    expect(analysis.priorities?.compared[0]?.projectId).toBe("high-proj");
    expect(analysis.priorities?.compared[0]?.projectPriority).toBe("high");
    expect(analysis.priorities?.taskPriorityOnly).toEqual([]);
  });

  test("21. dependency blockers", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [
          task({ id: "later", column: "ready", priority: fact<TaskPriority | null>("critical", "user-provided") }),
          task({ id: "first", column: "backlog", priority: fact<TaskPriority | null>("low", "user-provided") }),
        ],
        dependencies: [{ taskId: "later", dependsOn: "first" }],
      }),
    ], { projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }] }));
    const later = analysis.priorities?.compared.find((item) => item.taskId === "later");
    const first = analysis.priorities?.compared.find((item) => item.taskId === "first");
    expect(later?.blockedBy).toEqual(["first"]);
    expect(later?.executableNow).toBe(false);
    expect(first?.unblockCount).toBe(1);
    expect(analysis.priorities?.compared.map((item) => item.taskId)).toEqual(["later", "first"]);
    const suggestion = analysis.proposals.find((item) => item.actions.some((action) => action.kind === "prioritize-task"));
    expect(suggestion?.actions[0]?.taskId).toBe("first");
    expect(suggestion?.readOnly).toBe(true);
  });

  test("22. a confirmed deadline orders two dated tasks", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [
          task({ id: "later", priority: fact<TaskPriority | null>("high", "user-provided") }),
          task({ id: "sooner", priority: fact<TaskPriority | null>("high", "user-provided") }),
        ],
      }),
    ], {
      projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }],
      deadlines: [
        { projectId: "app", taskId: "later", atMs: NOW + 50_000, origin: "user-provided" },
        { projectId: "app", taskId: "sooner", atMs: NOW + 1_000, origin: "user-provided" },
      ],
    }));
    expect(analysis.priorities?.compared.map((item) => item.taskId)).toEqual(["sooner", "later"]);
    expect(analysis.priorities?.deadlines[0]).toMatchObject({ taskId: "sooner", remainingMs: 1_000 });
  });

  test("23. a missing deadline is not overdue", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "app",
        tasks: [task({ id: "undated", priority: fact<TaskPriority | null>("high", "user-provided") })],
      }),
    ], { projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }] }));
    expect(analysis.priorities?.deadlines).toEqual([]);
    expect(analysis.priorities?.missingDeadlineTaskIds).toEqual(["undated"]);
    expect(analysis.priorities?.compared[0]?.deadlineAtMs).toBeNull();
    expect(analysis.priorities?.compared[0]?.reasons.join(" ")).toMatch(/No confirmed deadline/);
    expect(analysis.priorities?.notes.join(" ")).toMatch(/not treated as overdue/);
  });

  test("24. confirmed resource conflict does not stop agents", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", tasks: [task({ id: "a1", column: "running", harnessId: "codex", accountId: "local" })] }),
      project({ id: "b", tasks: [task({ id: "b1", column: "running", harnessId: "codex", accountId: "local" })] }),
    ], {
      resources: [resource({
        id: "gpu",
        accountId: "local",
        exclusive: true,
        concurrencyLimit: fact<number | "unbounded" | null>("unbounded", "user-provided"),
      })],
    }));
    const conflict = analysis.conflicts.find((item) => item.code === "exclusive-resource");
    expect(conflict?.class).toBe("confirmed");
    expect(conflict?.runningAgents).toBe("unchanged");
    expect(analysis.runningAgents).toBe("unchanged");
    expect(analysis.execution).toBe("proposal-only");
  });

  test("25. potential conflict", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", tasks: [task({ id: "a1", column: "ready", harnessId: "codex", accountId: "acc" })] }),
      project({ id: "b", tasks: [task({ id: "b1", column: "ready", harnessId: "codex", accountId: "acc" })] }),
    ], {
      resources: [resource({
        id: "codex-main",
        concurrencyLimit: fact<number | "unbounded" | null>(1, "known"),
        occupiedSlots: fact<number | null>(0, "observed"),
      })],
    }));
    const conflict = analysis.conflicts.find((item) => item.code === "plan-might-exceed");
    expect(conflict?.class).toBe("potential");
    expect(analysis.conflicts.some((item) => item.class === "confirmed" && item.code === "concurrency-exceeded")).toBe(false);
    expect(conflict?.runningAgents).toBe("unchanged");
  });

  test("26. portfolio proposal is read-only", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "app", tasks: [task({ id: "ready", column: "ready", priority: fact<TaskPriority | null>("high", "user-provided") })] }),
    ], { projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }] }));
    expect(analysis.proposals.length).toBeGreaterThan(0);
    for (const item of analysis.proposals) {
      expect(item.readOnly).toBe(true);
      expect(item.execution).toBe("proposal-only");
    }
    expect(analysis.proposals.some((item) => item.actions.some((action) => action.kind === "focus-project"))).toBe(true);
    expect(analysis.execution).toBe("proposal-only");
  });

  test("27. required approvals", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "app", tasks: [task({ id: "ready", column: "ready" })] }),
    ], { projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }] }));
    const batch = analysis.proposals.find((item) => item.actions.some((action) => action.kind === "suggest-execution-batch"));
    expect(batch?.requiredApprovals.length).toBeGreaterThan(0);
    expect(batch?.requiredApprovals[0]?.wouldChange).toMatch(/No batch was created/);
    expect(batch?.readOnly).toBe(true);
  });

  test("28. shared account makes the portfolio calendar unknown", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "a",
        tasks: [task({ id: "a1", harnessId: "codex", accountId: "acc" })],
        estimate: estimate({ calendar: calendar(1_000), agent: duration(1_000) }),
      }),
      project({
        id: "b",
        tasks: [task({ id: "b1", harnessId: "codex", accountId: "acc" })],
        estimate: estimate({ calendar: calendar(4_000), agent: duration(4_000) }),
      }),
    ], {
      resources: [resource({ id: "codex-main", concurrencyLimit: fact<number | "unbounded" | null>(1, "known") })],
    }));
    expect(analysis.estimation?.calendar.status).toBe("unknown");
    expect(analysis.estimation?.calendar.ms).toBeNull();
    expect(analysis.estimation?.calendar.ms).not.toBe(5_000);
    expect(analysis.estimation?.calendar.note).toMatch(/share/i);
    expect(analysis.estimation?.closestProject.status).toBe("unknown");
  });

  test("29. a shared subscription is counted once", () => {
    const fee = { id: "pro", commitment: "existing" as const, recurringFee: { currency: "USD", minor: 2_000 }, priceOrigin: "user-provided" as const };
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", estimate: estimate({ subscriptions: [fee], subscriptionFees: cash(2_000) }) }),
      project({ id: "b", estimate: estimate({ subscriptions: [fee], subscriptionFees: cash(2_000) }) }),
    ]));
    expect(analysis.estimation?.subscriptions).toMatchObject({ status: "known", money: { currency: "USD", minor: 2_000 } });
    expect(analysis.estimation?.subscriptions.money?.minor).not.toBe(4_000);
  });

  test("30. additional cash sums across disjoint subscriptions", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "a",
        estimate: estimate({
          additionalCash: cash(100),
          subscriptions: [{ id: "a-sub", commitment: "existing", recurringFee: { currency: "USD", minor: 1_000 }, priceOrigin: "user-provided" }],
        }),
      }),
      project({
        id: "b",
        estimate: estimate({
          additionalCash: cash(250),
          subscriptions: [{ id: "b-sub", commitment: "existing", recurringFee: { currency: "USD", minor: 1_000 }, priceOrigin: "user-provided" }],
        }),
      }),
    ]));
    expect(analysis.estimation?.additionalCash).toMatchObject({ status: "known", money: { currency: "USD", minor: 350 } });
  });

  test("31. api-equivalent stays out of additional cash", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", estimate: estimate({ additionalCash: cash(0), apiEquivalent: { ...cash(40), countsAsAdditionalCash: false } }) }),
      project({ id: "b", estimate: estimate({ additionalCash: cash(0), apiEquivalent: { ...cash(60), countsAsAdditionalCash: false } }) }),
    ]));
    expect(analysis.estimation?.apiEquivalent.money).toEqual({ currency: "USD", minor: 100 });
    expect(analysis.estimation?.additionalCash.money).toEqual({ currency: "USD", minor: 0 });
    expect(analysis.estimation?.apiEquivalent.note).toMatch(/not additional cash/i);
  });

  test("32. mixed currencies are not converted without a rate", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", estimate: estimate({ additionalCash: cash(100, "USD") }) }),
      project({ id: "b", estimate: estimate({ additionalCash: cash(100, "EUR") }) }),
    ]));
    expect(analysis.estimation?.additionalCash.status).toBe("mixed-currency");
    expect(analysis.estimation?.additionalCash.money).toBeNull();
  });

  test("33. an incomplete project estimate keeps the portfolio incomplete", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "a", estimate: estimate({ agent: duration(1_000) }) }),
      project({ id: "b", estimate: estimate({ agent: duration(500, "incomplete"), missing: ["effort"] }) }),
    ]));
    expect(analysis.estimation?.agent.status).toBe("incomplete");
    expect(analysis.estimation?.agent.ms).toBeNull();
    expect(analysis.estimation?.agent.knownMs).toBe(1_500);
    expect(analysis.estimation?.confidence).toBe("none");
  });

  test("34. what-if replans a copy", () => {
    const input = snapshot([
      project({ id: "a", tasks: [task({ id: "a1" })] }),
      project({ id: "b", tasks: [task({ id: "b1" })] }),
    ], {
      projectPriorities: [
        { projectId: "a", priority: "high", origin: "user-provided" },
        { projectId: "b", priority: "low", origin: "user-provided" },
      ],
    });
    const before = JSON.stringify(input);
    const first = analyzePortfolio(input);
    const replay = analyzeWhatIf(input, {
      projectPriorities: [
        { projectId: "a", priority: "low", origin: "user-provided" },
        { projectId: "b", priority: "high", origin: "user-provided" },
      ],
      excludeProjectIds: [],
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(first.priorities?.compared[0]?.projectId).toBe("a");
    expect(replay.analysis.priorities?.compared[0]?.projectId).toBe("b");
    expect(replay.snapshot).not.toBe(input);
    expect(replay.notes.join(" ")).toMatch(/copy/);

    const excluded = analyzeWhatIf(input, { excludeProjectIds: ["a"] });
    expect(JSON.stringify(input)).toBe(before);
    expect(known(excluded.analysis.aggregate!.taskCount)).toBe(1);
    expect(excluded.analysis.projects.map((item) => item.projectId)).toEqual(["b"]);
  });

  test("35. a stale snapshot is not the current state", () => {
    const analysis = analyzePortfolio(snapshot([
      project({
        id: "old",
        observedAtMs: NOW - 500_000,
        tasks: [task({ id: "t", column: "running" })],
      }),
    ]));
    expect(analysis.projects[0]?.freshness).toBe("stale");
    expect(analysis.projects[0]?.countsAreCurrent).toBe(false);
    expect(analysis.projects[0]?.taskCount).toBe(1);
    expect(analysis.aggregate?.taskCount.status).toBe("unknown");
    expect(analysis.aggregate?.taskCount.value).toBeNull();
    expect(analysis.aggregate?.activeProjectIds).toEqual([]);
    expect(analysis.health[0]?.signals).toEqual(["unknown"]);
    expect(analysis.health[0]?.historicalFindings.some((item) => item.signal === "active" && item.current === false)).toBe(true);
    expect(analysis.completeness?.staleProjectIds).toEqual(["old"]);
  });

  test("36. provenance records where a value came from", () => {
    const analysis = analyzePortfolio(snapshot([
      project({ id: "app", name: fact("Forge", "user-provided"), tasks: [task({ id: "t", priority: fact<TaskPriority | null>("high", "user-provided") })] }),
    ], { projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }] }));
    expect(analysis.completeness?.provenance).toContainEqual(expect.objectContaining({
      path: "projects.app.name",
      origin: "user-provided",
    }));
    expect(analysis.completeness?.provenance).toContainEqual(expect.objectContaining({
      path: "projectPriorities.app",
      origin: "user-provided",
    }));
    expect(analysis.completeness?.provenance).toContainEqual(expect.objectContaining({
      path: "tasks.t.priority",
      origin: "user-provided",
    }));
    expect(analysis.completeness?.status).toBe("partial");
  });

  test("37. invalid input is rejected", () => {
    expect(analyzePortfolio(null).ok).toBe(false);
    expect(analyzePortfolio({}).ok).toBe(false);
    const badColumn = analyzePortfolio({
      capturedAtMs: NOW,
      stalenessAfterMs: 1_000,
      reportCurrency: "USD",
      exchangeRates: [],
      resources: [],
      projectPriorities: [],
      deadlines: [],
      policy: { allowWorkWithUnknownLimits: false, enforceSafetyForAutomaticExecution: true, calendarCombination: null },
      projects: [{
        id: "app",
        path: "/work/app",
        name: fact("app"),
        description: fact<string | null>(null, "unknown"),
        stack: fact<string[] | null>(null, "unknown"),
        managerConfigured: fact(true),
        managerAvailable: fact(true),
        observedAtMs: NOW,
        coverage: { board: true, runs: true, batches: true, pipelines: true, dependencies: true },
        tasks: [{ ...task({ id: "t" }), column: "shipped" }],
        dependencies: [],
        runs: [],
        pipelines: [],
        batches: [],
        environment: { configured: fact(true), phase: fact("stopped", "observed") },
        estimate: null,
      }],
    });
    expect(badColumn.ok).toBe(false);
    expect(badColumn.aggregate).toBeNull();
    expect(badColumn.issues.some((issue) => issue.severity === "error" && issue.code === "enum")).toBe(true);
    expect(analyzePortfolio({ ...snapshot([]), capturedAtMs: -1 }).ok).toBe(false);
  });

  test("38. a large portfolio stays linear", () => {
    const projects: ProjectSnapshotInput[] = [];
    for (let projectIndex = 0; projectIndex < 30; projectIndex++) {
      const id = `p${projectIndex}`;
      const tasks: TaskFactInput[] = [];
      const dependencies: { taskId: string; dependsOn: string }[] = [];
      for (let taskIndex = 0; taskIndex < 80; taskIndex++) {
        const taskId = `${id}-t${taskIndex}`;
        tasks.push(task({ id: taskId, column: "backlog" }));
        if (taskIndex > 0) dependencies.push({ taskId, dependsOn: `${id}-t${taskIndex - 1}` });
      }
      projects.push(project({ id, tasks, dependencies }));
    }
    const started = performance.now();
    const analysis = analyzePortfolio(snapshot(projects));
    const elapsed = performance.now() - started;
    expect(analysis.ok).toBe(true);
    expect(known(analysis.aggregate!.taskCount)).toBe(2_400);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("39. analysis has no side effects", () => {
    const input = snapshot([
      project({ id: "app", tasks: [task({ id: "t", column: "ready" })] }),
    ], { projectPriorities: [{ projectId: "app", priority: "high", origin: "user-provided" }] });
    const before = JSON.stringify(input);
    const first = analyzePortfolio(input);
    const second = analyzePortfolio(input);
    analyzeWhatIf(input, { selectedTaskIds: ["missing"], concurrency: [{ resourceId: "nope", limit: 1, origin: "user-provided" }] });
    expect(JSON.stringify(input)).toBe(before);
    expect(first).toEqual(second);
    expect(first.execution).toBe("proposal-only");

    const dir = import.meta.dir;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      expect(text.includes("Date.now")).toBe(false);
      expect(text.includes("fetch(")).toBe(false);
      expect(text.includes("Bun.spawn")).toBe(false);
      expect(text.includes("sqlite")).toBe(false);
      expect(text.includes("child_process")).toBe(false);
      expect(/from ["'][^"']*bun\//.test(text)).toBe(false);
    }
  });
});
