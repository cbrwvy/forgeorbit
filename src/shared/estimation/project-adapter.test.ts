import { describe, expect, test } from "bun:test";
import { estimate } from "./estimate.ts";
import { adaptProject, backlogFingerprint, estimateIsStale, type ProjectTaskFact } from "./project-adapter.ts";
import { compareResults, formatCash, formatDurationForecast, majorToMinor, runWhatIf } from "./present.ts";
import { emptyEstimationSettings, parseEstimationSettings, type EstimationSettings, type ManualStage } from "./settings.ts";

function fact(partial: Partial<ProjectTaskFact> & Pick<ProjectTaskFact, "id">): ProjectTaskFact {
  return {
    title: partial.title ?? partial.id,
    column: partial.column ?? "backlog",
    taskType: partial.taskType ?? "task",
    harnessId: partial.harnessId ?? "claude-code",
    modelId: partial.modelId ?? null,
    updatedAt: partial.updatedAt ?? 1,
    archived: partial.archived ?? false,
    pipelineParentId: partial.pipelineParentId ?? null,
    description: partial.description,
    observedRuns: partial.observedRuns ?? [],
    ...partial,
  };
}

function settings(patch: Partial<EstimationSettings> = {}): EstimationSettings {
  return { ...emptyEstimationSettings(), reportCurrency: "USD", ...patch };
}

function stage(patch: Partial<ManualStage> = {}): ManualStage {
  return {
    id: "implementation",
    kind: "implementation",
    effort: { optimisticMs: 60_000, expectedMs: 120_000, conservativeMs: 180_000 },
    repetitions: null,
    harnessFromTask: true,
    harnessId: null,
    modelFromTask: true,
    modelId: null,
    consumption: null,
    ...patch,
  };
}

describe("project adapter", () => {
  test("a description that mentions hours and dependencies is not interpreted", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings(),
      facts: [fact({
        id: "a",
        description: "depends on b and will take 40 hours. See @other.",
      })],
    });
    expect(adapted.request.items[0]?.dependsOn).toEqual([]);
    expect(adapted.request.items[0]?.stages[0]?.effort).toBeNull();
    expect(JSON.stringify(adapted.request)).not.toContain("40 hours");
    const result = estimate(adapted.request);
    expect(result.ok).toBe(true);
    expect(result.scenarios?.expected.agent.status).toBe("unknown");
    expect(formatDurationForecast(result.scenarios!.expected.agent).headline).toBe("Unknown");
  });

  test("observed run time is history and does not become the forecast", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings(),
      facts: [fact({
        id: "a",
        observedRuns: [{ runId: "run-1", startedAt: 1_000, endedAt: 61_000, agentMs: 60_000, status: "succeeded" }],
      })],
    });
    expect(adapted.request.history?.[0]).toMatchObject({ agentMs: 60_000, origin: "observed", stageKind: null });
    expect(adapted.request.items[0]?.stages[0]?.effort).toBeNull();
    const result = estimate(adapted.request);
    expect(result.scenarios?.expected.agent.status).toBe("unknown");
    expect(adapted.observed[0]?.agentMs).toBe(60_000);
    expect(adapted.notes.some((note) => note.includes("do not fill"))).toBe(true);
  });

  test("a typed duration is user-provided and drives the three scenarios", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({ stages: { a: [stage()] } }),
      facts: [fact({ id: "a" })],
    });
    expect(adapted.request.items[0]?.stages[0]?.effort?.origin).toBe("user-provided");
    const result = estimate(adapted.request);
    expect(result.scenarios?.optimistic.agent).toMatchObject({ status: "known", ms: 60_000 });
    expect(result.scenarios?.expected.agent).toMatchObject({ status: "known", ms: 120_000 });
    expect(result.scenarios?.conservative.agent).toMatchObject({ status: "known", ms: 180_000 });
  });

  test("an empty project is a real zero, and missing effort is not", () => {
    const empty = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings(),
      facts: [],
    }).request);
    expect(empty.scenarios?.expected.agent).toMatchObject({ status: "known", ms: 0 });
    expect(formatDurationForecast(empty.scenarios!.expected.agent).tone).toBe("zero");
    expect(empty.scenarios?.expected.additionalCash.basis).toBe("none");

    const missing = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings(),
      facts: [fact({ id: "a" })],
    }).request);
    expect(missing.scenarios?.expected.agent.status).toBe("unknown");
    expect(missing.scenarios?.expected.agent.ms).toBeNull();
    expect(formatCash(missing.scenarios!.expected.additionalCash).headline).toBe("Unknown");
    expect(formatCash(missing.scenarios!.expected.additionalCash).headline).not.toBe("0");
  });

  test("policy zero is labeled, and a measured cover is a different zero", () => {
    const policy = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        budgetMode: "overage-off",
        stages: { a: [stage()] },
      }),
      facts: [fact({ id: "a" })],
    }).request);
    expect(policy.scenarios?.expected.additionalCash.basis).toBe("policy");
    const policyFigure = formatCash(policy.scenarios!.expected.additionalCash);
    expect(policyFigure.headline).toBe("0 (policy)");
    expect(policyFigure.detail).toContain("not proof");

    const covered = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        budgetMode: "overage-on",
        pinnedSubscriptionId: "sub",
        stages: { a: [stage({ consumption: { unit: "tokens", amount: 10, currency: null } })] },
        subscriptions: [{
          id: "sub",
          provider: "Acme",
          commitment: "existing",
          planLabel: "Pro",
          recurringFee: { currency: "USD", minor: 2_000 },
          purchasePrice: null,
          billingPeriod: "monthly",
          capacity: { kind: "count", unit: "tokens", remaining: 100, limit: 100 },
          overageEnabled: false,
          overagePrices: null,
        }],
      }),
      facts: [fact({ id: "a", modelId: "opus" })],
    }).request);
    expect(covered.scenarios?.expected.additionalCash).toMatchObject({
      status: "known",
      basis: "capacity",
      money: { currency: "USD", minor: 0 },
    });
    expect(formatCash(covered.scenarios!.expected.additionalCash).tone).toBe("zero");
    expect(covered.scenarios?.expected.subscriptionFees.money).toEqual({ currency: "USD", minor: 2_000 });
    expect(covered.scenarios?.expected.subscriptionFees.countsAsAdditionalCash).toBe(false);
  });

  test("an unknown limit is not stored as zero remaining", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        pinnedSubscriptionId: "sub",
        subscriptions: [{
          id: "sub",
          provider: "Acme",
          commitment: "existing",
          planLabel: null,
          recurringFee: null,
          purchasePrice: null,
          billingPeriod: "unknown",
          capacity: null,
          overageEnabled: false,
          overagePrices: null,
        }],
      }),
      facts: [fact({ id: "a" })],
    });
    expect(adapted.request.subscriptions[0]?.quotas).toEqual([]);
    expect(adapted.request.subscriptions[0]?.recurringFee).toBeNull();
    const result = estimate(adapted.request);
    expect(result.scenarios?.expected.additionalCash.status).toBe("unknown");
  });

  test("percent-used capacity is not converted into tokens", () => {
    const result = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        pinnedSubscriptionId: "sub",
        subscriptions: [{
          id: "sub",
          provider: "Acme",
          commitment: "existing",
          planLabel: null,
          recurringFee: null,
          purchasePrice: null,
          billingPeriod: "monthly",
          capacity: { kind: "percent-used", usedPercent: 40 },
          overageEnabled: false,
          overagePrices: null,
        }],
      }),
      facts: [fact({ id: "a" })],
    }).request);
    expect(result.warnings.some((warning) => warning.toLowerCase().includes("percent"))).toBe(true);
    expect(result.scenarios?.expected.additionalCash.basis).not.toBe("capacity");
  });

  test("currencies are not mixed without a rate the user supplied", () => {
    const result = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        reportCurrency: "EUR",
        stages: { a: [stage({ modelFromTask: false, modelId: "opus" })] },
        apiRates: [{
          id: "rate",
          modelId: "opus",
          harnessId: null,
          perAgentMs: 60_000,
          money: { currency: "USD", minor: 100 },
        }],
      }),
      facts: [fact({ id: "a" })],
    }).request);
    expect(result.scenarios?.expected.apiEquivalent.status).toBe("mixed-currency");
    expect(formatCash(result.scenarios!.expected.apiEquivalent).headline).toBe("Mixed currencies");
    expect(result.scenarios?.expected.apiEquivalent.money).toBeNull();
  });

  test("a supplied rate converts and a budget cap can be exceeded", () => {
    const over = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        budgetMode: "overage-on",
        maxAdditionalSpend: { currency: "USD", minor: 50 },
        allowedPaidServices: ["Acme"],
        pinnedSubscriptionId: "sub",
        stages: { a: [stage({ consumption: { unit: "tokens", amount: 10, currency: null } })] },
        subscriptions: [{
          id: "sub",
          provider: "Acme",
          commitment: "existing",
          planLabel: null,
          recurringFee: { currency: "USD", minor: 2_000 },
          purchasePrice: null,
          billingPeriod: "monthly",
          capacity: { kind: "count", unit: "tokens", remaining: 0, limit: 10 },
          overageEnabled: true,
          overagePrices: [{ unit: "tokens", per: 1, money: { currency: "USD", minor: 20 }, currency: null }],
        }],
      }),
      facts: [fact({ id: "a" })],
    }).request);
    expect(over.scenarios?.expected.additionalCash.basis).toBe("priced");
    expect(over.scenarios?.expected.additionalCash.money?.minor).toBe(200);
    expect(over.scenarios?.expected.budget.verdict).toBe("over-budget");

    const open = estimate(adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({ stages: { a: [stage()] } }),
      facts: [fact({ id: "a" })],
    }).request);
    expect(open.scenarios?.expected.budget.verdict).toBe("insufficient-data");
  });

  test("what-if parallelism does not claim a speedup when a dependency is present", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        parallelism: { maxConcurrentItems: 1 },
        machine: { dutyCycle: 1, plannedPauseMs: 0 },
        stages: {
          a: [stage({ effort: { optimisticMs: 60_000, expectedMs: 60_000, conservativeMs: 60_000 } })],
          b: [stage({ effort: { optimisticMs: 60_000, expectedMs: 60_000, conservativeMs: 60_000 } })],
        },
        dependencies: { b: ["a"] },
      }),
      facts: [fact({ id: "a" }), fact({ id: "b", title: "Second" })],
    });
    const compared = runWhatIf(adapted.request, { parallelism: { maxConcurrentItems: 4 } });
    expect(compared.base.scenarios?.expected.calendar.ms).toBe(120_000);
    expect(compared.next.scenarios?.expected.calendar.ms).toBe(120_000);
    const view = compareResults(compared.base, compared.next, true);
    expect(view.caveat).toContain("not a guarantee");
    expect(view.rows.find((row) => row.scenario === "expected")?.calendarBase).toBe(
      view.rows.find((row) => row.scenario === "expected")?.calendarNext,
    );
  });

  test("what-if can drop a task without saving the base request", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        stages: {
          a: [stage()],
          b: [stage()],
        },
      }),
      facts: [fact({ id: "a" }), fact({ id: "b" })],
    });
    const before = adapted.request.items.length;
    const compared = runWhatIf(adapted.request, { dropItemIds: ["b"] });
    expect(adapted.request.items).toHaveLength(before);
    expect(compared.next.scenarios?.expected.agent.ms).toBe(120_000);
    expect(compared.base.scenarios?.expected.agent.ms).toBe(240_000);
  });

  test("archived tasks and pipeline steps are not estimated unless asked", () => {
    const facts = [
      fact({ id: "live" }),
      fact({ id: "old", archived: true }),
      fact({ id: "step", pipelineParentId: "live" }),
    ];
    const hidden = adaptProject({ projectPath: "/p", projectLabel: "P", settings: settings(), facts });
    expect(hidden.request.items.map((item) => item.id)).toEqual(["live"]);
    const withArchived = adaptProject({
      projectPath: "/p",
      projectLabel: "P",
      settings: settings({ includeArchived: true }),
      facts,
    });
    expect(withArchived.request.items.map((item) => item.id).sort()).toEqual(["live", "old"]);
  });

  test("selected scope and a missing feature grouping", () => {
    const adapted = adaptProject({
      projectPath: "/p",
      projectLabel: "P",
      settings: settings({ scope: { kind: "selected", itemIds: ["a"] } }),
      facts: [fact({ id: "a" }), fact({ id: "b" })],
    });
    expect(adapted.groupings).toEqual([]);
    expect(adapted.request.scope.itemIds).toEqual(["a"]);
    const result = estimate(adapted.request);
    expect(result.scenarios?.expected.items.map((item) => item.itemId)).toEqual(["a"]);
  });

  test("fingerprints change when the backlog changes and stay per the tasks given", () => {
    const base = [fact({ id: "a", title: "One", updatedAt: 5 })];
    const first = backlogFingerprint(base);
    expect(backlogFingerprint(base)).toBe(first);
    expect(backlogFingerprint([fact({ id: "a", title: "Two", updatedAt: 5 })])).not.toBe(first);
    expect(backlogFingerprint([...base, fact({ id: "step", pipelineParentId: "a" })])).toBe(first);
    expect(estimateIsStale(null, first)).toBe(false);
    expect(estimateIsStale(first, first)).toBe(false);
    expect(estimateIsStale(first, backlogFingerprint([fact({ id: "b" })]))).toBe(true);
  });

  test("projects are stamped separately and harness comes from the task until overridden", () => {
    const alpha = adaptProject({
      projectPath: "/alpha",
      projectLabel: "Alpha",
      settings: settings(),
      facts: [fact({ id: "a", harnessId: "codex", modelId: "gpt" })],
    });
    expect(alpha.request.items[0]?.projectId).toBe("/alpha");
    expect(alpha.request.items[0]?.stages[0]).toMatchObject({ harnessId: "codex", modelId: "gpt" });
    const overridden = adaptProject({
      projectPath: "/alpha",
      projectLabel: "Alpha",
      settings: settings({
        stages: { a: [stage({ harnessFromTask: false, harnessId: "cursor", modelFromTask: false, modelId: "other-model" })] },
      }),
      facts: [fact({ id: "a", harnessId: "codex", modelId: "gpt" })],
    });
    expect(overridden.request.items[0]?.stages[0]).toMatchObject({ harnessId: "cursor", modelId: "other-model" });
  });
});

describe("structured dependencies (FO-005C task_dependencies)", () => {
  const timed = (ms: number) => [stage({ effort: { optimisticMs: ms, expectedMs: ms, conservativeMs: ms } })];

  test("board links become confirmed edges and an empty manual list keeps them", () => {
    const adapted = adaptProject({
      projectPath: "/work/alpha",
      projectLabel: "Alpha",
      settings: settings({
        parallelism: { maxConcurrentItems: 4 },
        machine: { dutyCycle: 1, plannedPauseMs: 0 },
        stages: { a: timed(60_000), b: timed(60_000), c: timed(60_000) },
        dependencies: { b: [] },
      }),
      facts: [fact({ id: "a" }), fact({ id: "b" }), fact({ id: "c" })],
      structuredDependencies: [{ taskId: "b", dependsOn: "a" }],
    });
    expect(adapted.request.items.find((item) => item.id === "b")?.dependsOn).toEqual(["a"]);
    expect(adapted.request.items.find((item) => item.id === "c")?.dependsOn).toEqual([]);
    expect(adapted.notes.some((note) => note.includes("set on the board"))).toBe(true);
    // a → b is serial, c runs alongside: two minutes, not one.
    expect(estimate(adapted.request).scenarios?.expected.calendar.ms).toBe(120_000);
  });

  test("manual and board edges merge without duplicates, manual ones are kept", () => {
    const adapted = adaptProject({
      projectPath: "/p",
      projectLabel: "P",
      settings: settings({ dependencies: { c: ["a", "b"] } }),
      facts: [fact({ id: "a" }), fact({ id: "b" }), fact({ id: "c" })],
      structuredDependencies: [
        { taskId: "c", dependsOn: "a" },
        { taskId: "c", dependsOn: "a" },
      ],
    });
    expect(adapted.request.items.find((item) => item.id === "c")?.dependsOn).toEqual(["a", "b"]);
  });

  test("links to another project, a pipeline step, an archived task or itself are not used", () => {
    const adapted = adaptProject({
      projectPath: "/p",
      projectLabel: "P",
      settings: settings(),
      facts: [fact({ id: "a" }), fact({ id: "b" }), fact({ id: "old", archived: true }), fact({ id: "step", pipelineParentId: "a" })],
      structuredDependencies: [
        { taskId: "a", dependsOn: "foreign-task" },
        { taskId: "a", dependsOn: "step" },
        { taskId: "a", dependsOn: "old" },
        { taskId: "b", dependsOn: "b" },
      ],
    });
    for (const item of adapted.request.items) expect(item.dependsOn).toEqual([]);
    expect(adapted.notes.some((note) => note.includes("archived"))).toBe(true);
    expect(adapted.notes.some((note) => note.includes("outside this project"))).toBe(true);
  });

  test("the merged list is capped at the core's per-item limit, board links first", () => {
    const others = Array.from({ length: 70 }, (_, i) => fact({ id: `t${i}` }));
    const adapted = adaptProject({
      projectPath: "/p",
      projectLabel: "P",
      settings: settings({ dependencies: { z: others.slice(30, 70).map((row) => row.id) } }),
      facts: [...others, fact({ id: "z" })],
      structuredDependencies: others.slice(0, 30).map((row) => ({ taskId: "z", dependsOn: row.id })),
    });
    const deps = adapted.request.items.find((item) => item.id === "z")?.dependsOn ?? [];
    expect(deps).toHaveLength(64);
    expect(deps.slice(0, 30)).toEqual(others.slice(0, 30).map((row) => row.id));
    expect(estimate(adapted.request).ok).toBe(true);
  });

  test("the fingerprint follows board links and is unchanged without them", () => {
    const tasks = [fact({ id: "a" }), fact({ id: "b" }), fact({ id: "step", pipelineParentId: "a" })];
    const plain = backlogFingerprint(tasks);
    expect(backlogFingerprint(tasks, [])).toBe(plain);
    const linked = backlogFingerprint(tasks, [{ taskId: "b", dependsOn: "a" }]);
    expect(linked).not.toBe(plain);
    expect(estimateIsStale(plain, linked)).toBe(true);
    // Duplicates and ordering do not matter; links outside the board do not count.
    expect(backlogFingerprint(tasks, [
      { taskId: "b", dependsOn: "a" },
      { taskId: "b", dependsOn: "a" },
      { taskId: "a", dependsOn: "elsewhere" },
      { taskId: "a", dependsOn: "step" },
    ])).toBe(linked);
    expect(backlogFingerprint(tasks, [{ taskId: "a", dependsOn: "b" }])).not.toBe(linked);
  });
});

describe("estimation settings", () => {
  test("empty settings round-trip and reject secrets and inverted ranges", () => {
    const parsed = parseEstimationSettings(emptyEstimationSettings());
    expect(parsed.ok).toBe(true);
    const secret = parseEstimationSettings({ ...emptyEstimationSettings(), apiKey: "sk-test" });
    expect(secret.ok).toBe(false);
    const nested = parseEstimationSettings({
      ...emptyEstimationSettings(),
      subscriptions: [{ id: "s", accessToken: "secret" }],
    });
    expect(nested.ok).toBe(false);
    const inverted = parseEstimationSettings({
      ...emptyEstimationSettings(),
      stages: {
        a: [stage({ effort: { optimisticMs: 5, expectedMs: 1, conservativeMs: 9 } })],
      },
    });
    expect(inverted.ok).toBe(false);
  });

  test("money entry does not treat a blank as zero", () => {
    expect(majorToMinor("USD", "")).toBeNull();
    expect(majorToMinor("USD", "0")).toBe(0);
    expect(majorToMinor("USD", "12.50")).toBe(1_250);
    expect(majorToMinor("JPY", "500")).toBe(500);
    expect(majorToMinor("USD", "1.234")).toBeNull();
  });
});
