import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compareEstimateToActual, estimate, estimateWhatIf } from "./index.ts";
import type {
  AccountInput,
  EffortRange,
  EstimationRequest,
  Money,
  QuotaInput,
  StageInput,
  SubscriptionInput,
  WorkItemInput,
} from "./index.ts";

function range(optimisticMs: number, expectedMs = optimisticMs, conservativeMs = expectedMs): EffortRange {
  return { optimisticMs, expectedMs, conservativeMs, origin: "user-provided" };
}

function money(minor: number, currency = "USD"): Money {
  return { currency, minor };
}

function task(
  id: string,
  effort: number | EffortRange | null,
  extra?: Partial<WorkItemInput> & { stage?: Partial<StageInput> },
): WorkItemInput {
  const stage: StageInput = {
    id: "do",
    kind: "implementation",
    effort: effort === null ? null : typeof effort === "number" ? range(effort) : effort,
    ...extra?.stage,
  };
  if (extra?.stage && !("effort" in extra.stage)) stage.effort = effort === null ? null : typeof effort === "number" ? range(effort) : effort;
  return {
    id,
    projectId: extra?.projectId ?? "proj",
    groupId: extra?.groupId ?? null,
    title: extra?.title,
    complexity: extra?.complexity ?? null,
    workType: extra?.workType ?? null,
    dependsOn: extra?.dependsOn,
    blockers: extra?.blockers,
    pipelineId: extra?.pipelineId,
    requiresReview: extra?.requiresReview,
    requiresValidation: extra?.requiresValidation,
    stages: extra?.stages ?? [stage],
  };
}

function subscription(extra?: Partial<SubscriptionInput>): SubscriptionInput {
  return {
    id: "sub",
    provider: "openai",
    commitment: "existing",
    planLabel: "Pro",
    recurringFee: money(2_000),
    purchasePrice: null,
    priceOrigin: "user-provided",
    billingPeriod: "monthly",
    renewalAtMs: null,
    supportedModels: null,
    quotas: [],
    overage: { enabled: true, prices: null },
    allowedAdditionalSpend: null,
    ...extra,
  };
}

function account(extra?: Partial<AccountInput>): AccountInput {
  return { id: "acc", provider: "openai", subscriptionId: "sub", maxConcurrent: "unbounded", ...extra };
}

function tokenQuota(remaining: number, id = "tokens"): QuotaInput {
  return {
    id,
    label: "Included tokens",
    origin: "known",
    modelIds: null,
    unit: { kind: "count", unit: "tokens", remaining, limit: null, resetsAtMs: null },
  };
}

function request(items: WorkItemInput[], extra?: Partial<EstimationRequest>): EstimationRequest {
  return {
    scope: extra?.scope ?? { kind: "backlog", id: "backlog" },
    items,
    subscriptions: extra?.subscriptions ?? [],
    accounts: extra?.accounts ?? [],
    reportCurrency: extra?.reportCurrency ?? "USD",
    exchangeRates: extra?.exchangeRates ?? [],
    allocation: extra?.allocation ?? { mode: "none" },
    budget: extra?.budget ?? {
      maxAdditionalSpend: money(100_000),
      allowedPaidServices: ["openai", "anthropic", "cursor"],
      paidOverageEnabled: true,
      subscriptionUpgradeAllowed: false,
    },
    parallelism: extra?.parallelism ?? { maxConcurrentItems: "unbounded" },
    machine: extra?.machine ?? { dutyCycle: 1, plannedPauseMs: 0 },
    startAtMs: extra && "startAtMs" in extra ? (extra.startAtMs ?? null) : 1_700_000_000_000,
    apiRates: extra && "apiRates" in extra ? (extra.apiRates ?? null) : null,
    history: extra && "history" in extra ? (extra.history ?? null) : null,
  };
}

function covered(consumption = 100, remaining = 1_000, fee = 2_000): EstimationRequest {
  return request(
    [
      task("t", 10_000, {
        workType: "feature",
        complexity: "low",
        stage: {
          accountId: "acc",
          modelId: "model-a",
          harnessId: "codex",
          consumption: { unit: "tokens", amount: consumption, origin: "user-provided" },
        },
      }),
    ],
    {
      accounts: [account()],
      subscriptions: [
        subscription({
          recurringFee: money(fee),
          quotas: [tokenQuota(remaining)],
          overage: {
            enabled: true,
            prices: [{ unit: "tokens", per: 100, money: money(200), origin: "user-provided" }],
          },
        }),
      ],
    },
  );
}

describe("estimation core", () => {
  test("estimates one simple task from its effort range", () => {
    const result = estimate(request([task("only", range(1_000, 2_000, 4_000))], { scope: { kind: "task", id: "only" } }));
    expect(result.ok).toBe(true);
    expect(result.scenarios?.expected.agent).toMatchObject({ status: "known", ms: 2_000, origin: "user-provided" });
    expect(result.scenarios?.optimistic.agent.ms).toBe(1_000);
    expect(result.scenarios?.conservative.agent.ms).toBe(4_000);
    expect(result.scenarios?.expected.calendar).toMatchObject({
      status: "known",
      ms: 2_000,
      exact: true,
      method: "critical-path",
      finishAtMs: 1_700_000_000_000 + 2_000,
    });
    expect(result.scenarios?.expected.additionalCash.status).toBe("unknown");
    expect(result.scenarios?.expected.additionalCash.money).toBeNull();
    expect(result.confidence.level).toBe("low");
  });

  test("runs independent tasks in parallel when concurrency is unbounded", () => {
    const result = estimate(request([task("a", 1_000), task("b", 3_000)]));
    expect(result.scenarios?.expected.agent.ms).toBe(4_000);
    expect(result.scenarios?.expected.calendar.ms).toBe(3_000);
    expect(result.scenarios?.expected.calendar.exact).toBe(true);
  });

  test("puts dependent tasks on the critical path", () => {
    const result = estimate(request([task("a", 1_000), task("b", 3_000, { dependsOn: ["a"] })]));
    expect(result.scenarios?.expected.calendar).toMatchObject({
      status: "known",
      ms: 4_000,
      criticalPathMs: 4_000,
      serialUpperBoundMs: 4_000,
      exact: true,
    });
  });

  test("rejects a dependency cycle as a calendar forecast", () => {
    const result = estimate(request([task("a", 1_000, { dependsOn: ["b"] }), task("b", 2_000, { dependsOn: ["a"] })]));
    expect(result.ok).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.cycles[0]?.[0]).toBe(result.cycles[0]?.at(-1));
    expect(result.scenarios?.expected.agent.ms).toBe(3_000);
    expect(result.scenarios?.expected.calendar.status).toBe("invalid");
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
    expect(result.scenarios?.expected.calendar.finishAtMs).toBeNull();
    expect(result.issues.some((issue) => issue.code === "cycle")).toBe(true);
  });

  test("does not turn complexity labels into hours", () => {
    const result = estimate(
      request([
        task("small", 1_000, { complexity: "low" }),
        task("large", 9_000, { complexity: "very-high" }),
        task("unspecified", null, { complexity: "high" }),
      ]),
    );
    expect(result.scenarios?.expected.items.find((item) => item.itemId === "small")?.agentMs).toBe(1_000);
    expect(result.scenarios?.expected.items.find((item) => item.itemId === "large")?.agentMs).toBe(9_000);
    expect(result.scenarios?.expected.agent.status).toBe("incomplete");
    expect(result.scenarios?.expected.agent.ms).toBeNull();
    expect(result.scenarios?.expected.agent.knownMs).toBe(10_000);
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
  });

  test("sums several agent stages", () => {
    const result = estimate(
      request([
        task("t", null, {
          stages: [
            { id: "plan", kind: "planning", effort: range(1_000) },
            { id: "build", kind: "implementation", effort: range(2_000) },
            { id: "test", kind: "testing", effort: range(3_000) },
          ],
        }),
      ]),
    );
    expect(result.scenarios?.expected.agent.ms).toBe(6_000);
    expect(result.scenarios?.expected.agentRuns).toBe(3);
    expect(result.scenarios?.expected.calendar.ms).toBe(6_000);
  });

  test("sums planning, implementation, and review in order", () => {
    const result = estimate(
      request([
        task("t", null, {
          requiresReview: true,
          stages: [
            { id: "plan", kind: "planning", effort: range(1_000) },
            { id: "build", kind: "implementation", effort: range(4_000) },
            { id: "review", kind: "review", effort: range(2_000) },
          ],
        }),
      ]),
    );
    expect(result.scenarios?.expected.agent.ms).toBe(7_000);
    expect(result.scenarios?.expected.calendar.ms).toBe(7_000);
    expect(result.scenarios?.expected.items[0]?.unknownStageIds).toEqual([]);
  });

  test("applies a rework repetition range", () => {
    const result = estimate(
      request([
        task("t", null, {
          stages: [
            { id: "build", kind: "implementation", effort: range(5_000) },
            {
              id: "fix",
              kind: "fixes",
              effort: range(2_000),
              repetitions: { optimistic: 0, expected: 1, conservative: 2 },
            },
          ],
        }),
      ]),
    );
    expect(result.scenarios?.optimistic.agent.ms).toBe(5_000);
    expect(result.scenarios?.expected.agent.ms).toBe(7_000);
    expect(result.scenarios?.conservative.agent.ms).toBe(9_000);
    expect(result.scenarios?.optimistic.reworkRuns).toBe(0);
    expect(result.scenarios?.expected.reworkRuns).toBe(1);
    expect(result.scenarios?.conservative.reworkRuns).toBe(2);
  });

  test("respects a concurrency cap", () => {
    const result = estimate(
      request([task("a", 10_000), task("b", 10_000), task("c", 10_000)], {
        parallelism: { maxConcurrentItems: 2 },
      }),
    );
    expect(result.scenarios?.expected.agent.ms).toBe(30_000);
    expect(result.scenarios?.expected.calendar).toMatchObject({
      status: "estimated",
      ms: 20_000,
      exact: false,
      method: "list-scheduling",
      finishAtMs: null,
    });
    expect(result.scenarios?.expected.calendar.simplifications.join(" ")).toContain("list scheduling");
  });

  test("leaves duration unknown when effort is missing", () => {
    const withHistory = request([task("t", null, { workType: "bug" })], {
      history: [{ projectId: null, workType: "bug", complexity: null, stageKind: null, agentMs: 50_000, sampleCount: 4, origin: "observed" }],
    });
    const result = estimate(withHistory);
    expect(result.scenarios?.expected.agent.status).toBe("unknown");
    expect(result.scenarios?.expected.agent.ms).toBeNull();
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
    expect(result.missing.some((entry) => entry.code === "missing-effort")).toBe(true);
    expect(result.scenarios?.expected.agent.knownMs).toBeNull();
  });

  test("keeps an existing subscription fee out of additional cash", () => {
    const result = estimate(covered());
    expect(result.scenarios?.expected.subscriptionFees.money).toEqual(money(2_000));
    expect(result.scenarios?.expected.subscriptionFees.countsAsAdditionalCash).toBe(false);
    expect(result.scenarios?.expected.additionalCash).toMatchObject({
      status: "known",
      basis: "capacity",
      money: money(0),
    });
    expect(result.scenarios?.expected.allocation.status).toBe("not-requested");
    expect(result.scenarios?.expected.additionalCash.money?.minor).not.toBe(2_000);
  });

  test("proves zero additional cash when a measured quota covers the work", () => {
    const result = estimate(covered(100, 1_000));
    expect(result.scenarios?.expected.coverage.status).toBe("sufficient");
    expect(result.scenarios?.expected.additionalCash.basis).toBe("capacity");
    expect(result.scenarios?.expected.additionalCash.money).toEqual(money(0));
    expect(result.scenarios?.expected.calendar.status).toBe("known");
  });

  test("does not treat an unknown quota as free", () => {
    const result = estimate(
      request(
        [
          task("t", 8_000, {
            stage: {
              accountId: "acc",
              consumption: { unit: "tokens", amount: 100, origin: "user-provided" },
            },
          }),
        ],
        {
          accounts: [account()],
          subscriptions: [
            subscription({
              quotas: [{ id: "window", label: "5-hour", origin: "observed", unit: { kind: "percent-used", usedPercent: 40, resetsAtMs: null } }],
            }),
          ],
        },
      ),
    );
    expect(result.scenarios?.expected.coverage.status).toBe("unknown");
    expect(result.scenarios?.expected.additionalCash.status).toBe("unknown");
    expect(result.scenarios?.expected.additionalCash.money).toBeNull();
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
    expect(result.scenarios?.expected.calendar.scheduleMs).toBe(8_000);
    expect(result.warnings.join(" ")).toContain("percent-used");
    expect(result.confidence.summary.startsWith("Low confidence")).toBe(true);
  });

  test("prices token overage from the supplied rate", () => {
    const result = estimate(covered(500, 100));
    expect(result.scenarios?.expected.coverage.status).toBe("insufficient");
    expect(result.scenarios?.expected.additionalCash).toMatchObject({ status: "known", basis: "priced", money: money(800) });
    expect(result.scenarios?.expected.budget.verdict).toBe("within-budget");
    expect(result.scenarios?.expected.subscriptionFees.money).toEqual(money(2_000));
  });

  test("leaves overage unknown when the token price is missing", () => {
    const result = estimate(
      request(covered(500, 100).items, {
        ...covered(500, 100),
        subscriptions: [subscription({ quotas: [tokenQuota(100)], overage: { enabled: true, prices: null } })],
      }),
    );
    expect(result.scenarios?.expected.additionalCash.status).toBe("unknown");
    expect(result.scenarios?.expected.additionalCash.money).toBeNull();
    expect(result.scenarios?.expected.budget.verdict).toBe("insufficient-data");
  });

  test("accepts a zero budget only when additional cash is proven zero", () => {
    const result = estimate(
      request(covered().items, {
        ...covered(),
        budget: {
          maxAdditionalSpend: money(0),
          allowedPaidServices: ["openai"],
          paidOverageEnabled: true,
          subscriptionUpgradeAllowed: false,
        },
      }),
    );
    expect(result.scenarios?.expected.additionalCash.money).toEqual(money(0));
    expect(result.scenarios?.expected.additionalCash.basis).toBe("capacity");
    expect(result.scenarios?.expected.budget.verdict).toBe("within-budget");
  });

  test("flags a priced scenario that exceeds the budget", () => {
    const base = covered(500, 100);
    const result = estimate(
      request(base.items, {
        ...base,
        budget: {
          maxAdditionalSpend: money(100),
          allowedPaidServices: ["openai"],
          paidOverageEnabled: true,
          subscriptionUpgradeAllowed: false,
        },
      }),
    );
    expect(result.scenarios?.expected.additionalCash.money).toEqual(money(800));
    expect(result.scenarios?.expected.budget.verdict).toBe("over-budget");
  });

  test("does not treat an unknown cost as within budget", () => {
    const result = estimate(
      request(
        [
          task("t", 1_000, {
            stage: { accountId: "acc", consumption: { unit: "tokens", amount: 10, origin: "user-provided" } },
          }),
        ],
        {
          accounts: [account()],
          subscriptions: [
            subscription({
              quotas: [{ id: "window", label: "window", origin: "observed", unit: { kind: "percent-used", usedPercent: 10, resetsAtMs: null } }],
            }),
          ],
          budget: {
            maxAdditionalSpend: money(0),
            allowedPaidServices: ["openai"],
            paidOverageEnabled: true,
            subscriptionUpgradeAllowed: false,
          },
        },
      ),
    );
    expect(result.scenarios?.expected.additionalCash.status).toBe("unknown");
    expect(result.scenarios?.expected.budget.verdict).toBe("insufficient-data");
    expect(result.scenarios?.expected.budget.verdict).not.toBe("within-budget");
  });

  test("reads the three scenarios from supplied ranges", () => {
    const result = estimate(request([task("t", range(1_000, 5_000, 5_000))]));
    expect(result.scenarios?.optimistic.agent.ms).toBe(1_000);
    expect(result.scenarios?.expected.agent.ms).toBe(5_000);
    expect(result.scenarios?.conservative.agent.ms).toBe(5_000);
    expect(result.assumptions.join(" ")).toContain("not a statistical confidence interval");
    expect(result.assumptions.join(" ")).toContain("not a percentage");
  });

  test("recomputes a what-if with a different account without changing effort", () => {
    const initial = request(
      [
        task("t", 5_000, {
          stage: {
            accountId: "slow",
            modelId: "model-a",
            consumption: { unit: "tokens", amount: 100, origin: "user-provided" },
          },
        }),
      ],
      {
        accounts: [account({ id: "slow", subscriptionId: "slow-sub" }), account({ id: "fast", subscriptionId: "fast-sub" })],
        subscriptions: [
          subscription({
            id: "slow-sub",
            quotas: [{ id: "window", label: "window", origin: "observed", unit: { kind: "percent-used", usedPercent: 40, resetsAtMs: null } }],
          }),
          subscription({ id: "fast-sub", quotas: [tokenQuota(1_000)] }),
        ],
      },
    );
    const before = estimate(initial);
    const after = estimateWhatIf(initial, {
      stageAssignments: [{ itemId: "t", stageId: "do", accountId: "fast" }],
    });
    expect(before.scenarios?.expected.additionalCash.status).toBe("unknown");
    expect(before.scenarios?.expected.agent.ms).toBe(5_000);
    expect(after.scenarios?.expected.agent.ms).toBe(5_000);
    expect(after.scenarios?.expected.additionalCash).toMatchObject({ status: "known", basis: "capacity", money: money(0) });
    expect(initial.items[0]?.stages[0]?.accountId).toBe("slow");
  });

  test("recomputes a what-if that adds an account", () => {
    const initial = request(
      [
        task("t", 4_000, {
          stage: {
            accountId: "new",
            consumption: { unit: "tokens", amount: 100, origin: "user-provided" },
          },
        }),
      ],
    );
    const before = estimate(initial);
    const after = estimateWhatIf(initial, {
      upsertAccounts: [account({ id: "new", subscriptionId: "new-sub" })],
      upsertSubscriptions: [subscription({ id: "new-sub", quotas: [tokenQuota(500)] })],
    });
    expect(before.scenarios?.expected.additionalCash.status).toBe("unknown");
    expect(before.scenarios?.expected.calendar.ms).toBeNull();
    expect(after.ok).toBe(true);
    expect(after.scenarios?.expected.additionalCash).toMatchObject({ basis: "capacity", money: money(0) });
    expect(after.scenarios?.expected.calendar.status).toBe("known");
    expect(after.scenarios?.expected.agent.ms).toBe(4_000);
    expect(initial.accounts).toEqual([]);
  });

  test("recomputes a what-if that changes a subscription", () => {
    const initial = covered(100, 1_000);
    const after = estimateWhatIf(initial, {
      upsertSubscriptions: [
        subscription({
          quotas: [tokenQuota(10)],
          overage: { enabled: true, prices: [{ unit: "tokens", per: 1, money: money(5), origin: "user-provided" }] },
        }),
      ],
    });
    expect(estimate(initial).scenarios?.expected.additionalCash.money).toEqual(money(0));
    expect(after.scenarios?.expected.additionalCash.money).toEqual(money(450));
    expect(after.scenarios?.expected.agent.ms).toBe(10_000);
    expect(initial.subscriptions[0]?.quotas[0]?.unit).toMatchObject({ kind: "count", remaining: 1_000 });
  });

  test("allocates a fixed subscription share without calling it extra spend", () => {
    const base = covered();
    const result = estimate(
      request(base.items, {
        ...base,
        allocation: { mode: "fixed-share", shares: [{ subscriptionId: "sub", share: 0.25 }] },
      }),
    );
    expect(result.scenarios?.expected.allocation).toMatchObject({
      mode: "fixed-share",
      status: "known",
      money: money(500),
      countsAsAdditionalCash: false,
    });
    expect(result.scenarios?.expected.additionalCash.money).toEqual(money(0));
  });

  test("leaves API-equivalent cost unknown when no rate is supplied", () => {
    const result = estimate(request([task("t", 5_000, { stage: { modelId: "model-a" } })], { apiRates: [] }));
    expect(result.scenarios?.expected.apiEquivalent.status).toBe("unknown");
    expect(result.scenarios?.expected.apiEquivalent.money).toBeNull();
    expect(result.scenarios?.expected.apiEquivalent.countsAsAdditionalCash).toBe(false);
    const omitted = estimate(request([task("t", 5_000)]));
    expect(omitted.scenarios?.expected.apiEquivalent.status).toBe("not-requested");
  });

  test("does not mix currencies without an exchange rate", () => {
    const items = [
      task("t", 1_000, {
        stage: { accountId: "acc", consumption: { unit: "tokens", amount: 100, origin: "user-provided" } },
      }),
    ];
    const resources = {
      accounts: [account()],
      subscriptions: [
        subscription({
          recurringFee: money(2_000, "EUR"),
          quotas: [tokenQuota(0)],
          overage: { enabled: true, prices: [{ unit: "tokens", per: 100, money: money(1_000, "EUR"), origin: "user-provided" }] },
        }),
      ],
      budget: {
        maxAdditionalSpend: money(1_000),
        allowedPaidServices: ["openai"],
        paidOverageEnabled: true,
        subscriptionUpgradeAllowed: false,
      },
    };
    const unrated = estimate(request(items, resources));
    expect(unrated.scenarios?.expected.additionalCash.status).toBe("mixed-currency");
    expect(unrated.scenarios?.expected.additionalCash.money).toBeNull();
    expect(unrated.scenarios?.expected.budget.verdict).toBe("insufficient-data");

    const rated = estimate(
      request(items, {
        ...resources,
        exchangeRates: [{ from: "EUR", to: "USD", rate: 1.5, origin: "user-provided" }],
      }),
    );
    expect(rated.scenarios?.expected.additionalCash).toMatchObject({ status: "known", money: money(1_500) });
    expect(rated.scenarios?.expected.budget.verdict).toBe("over-budget");
  });

  test("compares an estimate with an actual", () => {
    const compared = compareEstimateToActual({
      id: "cmp-1",
      scopeId: "backlog",
      estimate: {
        scenario: "expected",
        agentMs: 10_000,
        calendarMs: 12_000,
        additionalCash: money(100),
        agentRuns: 3,
        reworkRuns: 1,
      },
      actual: {
        agentMs: 15_000,
        calendarMs: 12_000,
        additionalCash: money(80),
        agentRuns: 4,
        reviewReworkCount: 2,
        observedAtMs: 1_700_000_100_000,
      },
    });
    expect(compared.durationVariance).toMatchObject({ status: "known", absolute: 5_000, relative: 0.5 });
    expect(compared.calendarVariance).toMatchObject({ status: "known", absolute: 0, relative: 0 });
    expect(compared.cashVariance).toMatchObject({ status: "known", absolute: -20, relative: -0.2 });
    expect(compared.runsVariance).toMatchObject({ status: "known", absolute: 1 });
    expect(compared.reworkVariance).toMatchObject({ status: "known", absolute: 1, relative: 1 });
    expect(compared.reviewReworkCount).toBe(2);
    expect(JSON.parse(JSON.stringify(compared))).toEqual(compared);
  });

  test("reports missing data when no actuals or history exist", () => {
    const compared = compareEstimateToActual({
      id: "cmp-empty",
      scopeId: "backlog",
      estimate: { scenario: "expected", agentMs: null, calendarMs: null, additionalCash: null, agentRuns: null, reworkRuns: null },
      actual: { agentMs: null, calendarMs: null, additionalCash: null, agentRuns: null, reviewReworkCount: null, observedAtMs: null },
    });
    expect(compared.missing).toContain("No actual observations were provided.");
    expect(compared.durationVariance.status).toBe("unknown");
    expect(compared.cashVariance.status).toBe("unknown");
    expect(compared.reviewReworkCount).toBeNull();

    const forecast = estimate(request([task("t", null)]));
    expect(forecast.missing.some((entry) => entry.code === "history-matches")).toBe(true);
    expect(forecast.scenarios?.expected.agent.ms).toBeNull();
  });

  test("rejects malformed numbers", () => {
    const negative = estimate(request([task("t", range(-1, 1, 1))]));
    expect(negative.ok).toBe(false);
    expect(negative.scenarios).toBeNull();
    expect(negative.issues.some((issue) => issue.code === "bad-effort")).toBe(true);

    const inverted = estimate(request([task("t", range(5, 4, 9))]));
    expect(inverted.ok).toBe(false);
    expect(inverted.issues.some((issue) => issue.code === "inverted-range")).toBe(true);

    const duplicate = estimate(request([task("t", 1), task("t", 2)]));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.issues.some((issue) => issue.code === "duplicate-id")).toBe(true);

    const share = estimate(
      request([task("t", 1)], {
        subscriptions: [subscription()],
        allocation: { mode: "fixed-share", shares: [{ subscriptionId: "sub", share: 1.5 }] },
      }),
    );
    expect(share.ok).toBe(false);
    expect(share.issues.some((issue) => issue.code === "bad-share")).toBe(true);

    const duty = estimate(request([task("t", 1)], { machine: { dutyCycle: 2, plannedPauseMs: 0 } }));
    expect(duty.ok).toBe(false);
    expect(duty.issues.some((issue) => issue.code === "bad-duty-cycle")).toBe(true);

    const missing = estimate(request([task("t", 1, { dependsOn: ["nope"] })]));
    expect(missing.ok).toBe(false);
    expect(missing.issues.some((issue) => issue.code === "unknown-dependency")).toBe(true);

    const fractional = estimate(
      request([task("t", 1)], {
        subscriptions: [subscription({ recurringFee: { currency: "USD", minor: 10.5 } })],
      }),
    );
    expect(fractional.ok).toBe(false);
    expect(fractional.issues.some((issue) => issue.code === "bad-money")).toBe(true);

    const nan = estimate(request([task("t", range(Number.NaN, 1, 1))]));
    expect(nan.ok).toBe(false);
    expect(nan.scenarios).toBeNull();
  });

  test("estimates a few hundred tasks quickly", () => {
    const many = Array.from({ length: 300 }, (_, index) => task(`t${index}`, 2_000));
    const started = performance.now();
    const wide = estimate(request(many));
    const wideMs = performance.now() - started;
    expect(wide.ok).toBe(true);
    expect(wide.scenarios?.expected.agent.ms).toBe(600_000);
    expect(wide.scenarios?.expected.calendar.ms).toBe(2_000);

    const chain = Array.from({ length: 200 }, (_, index) =>
      task(`c${index}`, 1_000, { dependsOn: index === 0 ? [] : [`c${index - 1}`] }),
    );
    const chainStarted = performance.now();
    const deep = estimate(request(chain));
    const chainMs = performance.now() - chainStarted;
    expect(deep.scenarios?.expected.calendar.ms).toBe(200_000);
    expect(deep.scenarios?.expected.agent.ms).toBe(200_000);
    expect(wideMs).toBeLessThan(1_000);
    expect(chainMs).toBeLessThan(1_000);
  });

  test("does not mutate its input", () => {
    const original = request([task("a", 1_000), task("b", 2_000)]);
    const before = structuredClone(original);
    const first = estimate(original);
    const second = estimate(original);
    expect(original).toEqual(before);
    expect(second).toEqual(first);
    const changed = estimateWhatIf(original, { dropItemIds: ["b"] });
    expect(original).toEqual(before);
    expect(changed.scenarios?.expected.agent.ms).toBe(1_000);
    expect(estimate(original).scenarios?.expected.agent.ms).toBe(3_000);
  });

  test("a feature scope and a project scope only include matching items", () => {
    const items = [
      task("f1", 2_000, { groupId: "feature-a", projectId: "alpha" }),
      task("f2", 4_000, { groupId: "feature-b", projectId: "alpha" }),
      task("other", 8_000, { groupId: "feature-a", projectId: "beta" }),
    ];
    const feature = estimate(request(items, { scope: { kind: "feature", id: "feature-a", groupIds: ["feature-a"] } }));
    expect(feature.scenarios?.expected.agent.ms).toBe(10_000);
    const project = estimate(request(items, { scope: { kind: "project", id: "alpha", projectIds: ["alpha"] } }));
    expect(project.scenarios?.expected.agent.ms).toBe(6_000);
    const portfolio = estimate(
      request(items, { scope: { kind: "portfolio", id: "both", projectIds: ["alpha", "beta"] } }),
    );
    expect(portfolio.scenarios?.expected.agent.ms).toBe(14_000);
  });

  test("a required review without a stage does not invent time", () => {
    const result = estimate(request([task("t", 3_000, { requiresReview: true })]));
    expect(result.scenarios?.expected.agent.ms).toBeNull();
    expect(result.scenarios?.expected.agent.knownMs).toBe(3_000);
    expect(result.missing.some((entry) => entry.code === "missing-review")).toBe(true);
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
  });

  test("an unknown blocker wait blocks the calendar and not the agent total", () => {
    const result = estimate(
      request([
        task("t", 3_000, {
          blockers: [{ id: "design", wait: null }],
        }),
      ]),
    );
    expect(result.scenarios?.expected.agent).toMatchObject({ status: "known", ms: 3_000 });
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
  });

  test("usage-weighted allocation refuses unmeasured weights", () => {
    const base = covered();
    const result = estimate(
      request(base.items, {
        ...base,
        allocation: {
          mode: "usage-weighted",
          weights: [
            { projectId: "proj", weight: 1, origin: "user-provided" },
            { projectId: "other", weight: 1, origin: "observed" },
          ],
        },
      }),
    );
    expect(result.scenarios?.expected.allocation.status).toBe("unknown");
    expect(result.scenarios?.expected.allocation.money).toBeNull();
    expect(result.scenarios?.expected.additionalCash.money).toEqual(money(0));
  });

  test("a partial price is potentially over budget and not within it", () => {
    const result = estimate(
      request(
        [
          task("priced", null, {
            stages: [
              {
                id: "build",
                kind: "implementation",
                effort: range(1_000),
                accountId: "acc",
                consumption: { unit: "tokens", amount: 500, origin: "user-provided" },
              },
            ],
          }),
          task("unmeasured", null, {
            stages: [
              {
                id: "build",
                kind: "implementation",
                effort: range(1_000),
                accountId: "acc",
              },
            ],
          }),
        ],
        {
          accounts: [account()],
          subscriptions: [
            subscription({
              quotas: [tokenQuota(100)],
              overage: { enabled: true, prices: [{ unit: "tokens", per: 100, money: money(200), origin: "user-provided" }] },
            }),
          ],
          budget: {
            maxAdditionalSpend: money(10_000),
            allowedPaidServices: ["openai"],
            paidOverageEnabled: true,
            subscriptionUpgradeAllowed: false,
          },
        },
      ),
    );
    expect(result.scenarios?.expected.additionalCash.status).toBe("incomplete");
    expect(result.scenarios?.expected.additionalCash.money).toBeNull();
    expect(result.scenarios?.expected.additionalCash.knownPortion).toEqual(money(800));
    expect(result.scenarios?.expected.budget.verdict).toBe("potentially-over-budget");
  });

  test("complete measured inputs reach high confidence", () => {
    const result = estimate(
      request(covered().items, {
        ...covered(),
        history: [
          {
            projectId: "proj",
            workType: "feature",
            complexity: "low",
            stageKind: "implementation",
            agentMs: 9_000,
            sampleCount: 3,
            origin: "observed",
          },
        ],
      }),
    );
    expect(result.confidence.level).toBe("high");
    expect(result.confidence.inputCompleteness).toBe(1);
    expect(result.scenarios?.expected.calendar.finishAtMs).toBe(1_700_000_000_000 + 10_000);
  });

  test("turning extra spend off is not proof of coverage", () => {
    const result = estimate(
      request(
        [
          task("t", 6_000, {
            stage: { accountId: "acc", consumption: { unit: "tokens", amount: 50, origin: "user-provided" } },
          }),
        ],
        {
          accounts: [account()],
          subscriptions: [
            subscription({
              quotas: [{ id: "window", label: "window", origin: "observed", unit: { kind: "percent-used", usedPercent: 80, resetsAtMs: null } }],
              overage: { enabled: false, prices: null },
            }),
          ],
          budget: {
            maxAdditionalSpend: money(0),
            allowedPaidServices: [],
            paidOverageEnabled: false,
            subscriptionUpgradeAllowed: false,
          },
        },
      ),
    );
    expect(result.scenarios?.expected.additionalCash).toMatchObject({ status: "known", basis: "policy", money: money(0) });
    expect(result.scenarios?.expected.calendar.ms).toBeNull();
    expect(result.scenarios?.expected.calendar.scheduleMs).toBe(6_000);
    expect(result.warnings.join(" ")).toContain("not proof");
    expect(result.confidence.level).not.toBe("high");
    expect(result.scenarios?.expected.budget.verdict).toBe("within-budget");
  });

  test("a known duty cycle stretches calendar time", () => {
    const result = estimate(request([task("t", 10_000)], { machine: { dutyCycle: 0.5, plannedPauseMs: 0 } }));
    expect(result.scenarios?.expected.calendar).toMatchObject({ status: "known", ms: 20_000, exact: true, scheduleMs: 10_000 });
  });

  test("estimation sources do not reach the network, a clock, or a price table", () => {
    const directory = import.meta.dir;
    const files = readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const banned = [/Date\.now\s*\(/, /\bfetch\s*\(/, /\bBun\./, /child_process/, /process\.env/, /from ["']node:/, /priceUsd|USD_PER|tokensPerDollar/i];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(directory, file), "utf8");
      for (const pattern of banned) expect(text).not.toMatch(pattern);
    }
  });
});
