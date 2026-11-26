import { expect, test } from "bun:test";
import {
  accountError,
  accountMetrics,
  currencyDigits,
  currentQuotas,
  dateInput,
  moneyInput,
  moneyLabel,
  nullableNumber,
  observationFreshness,
  observationFreshnessStatus,
  parseDate,
  parseMoney,
  profileWarning,
  quantity,
  unitLabel,
} from "./accounts.ts";
import type { AccountResource } from "./account-api.ts";
import { dictionaries, localeStore, t } from "../i18n/core";
import type { AgentProfile } from "../../shared/types.ts";
import type {
  QuotaDefinition,
  QuotaObservation,
} from "../../shared/accounts/types.ts";

const now = 1_000_000;
const definition: QuotaDefinition = {
  id: "q",
  accountId: "a",
  subscriptionId: null,
  scope: "account",
  unit: { kind: "tokens" },
  window: "rolling",
  createdAt: 0,
  archivedAt: null,
};
const observation: QuotaObservation = {
  id: "o",
  quotaId: "q",
  limit: null,
  used: null,
  remaining: null,
  indicator: null,
  observedAt: now - 100,
  expiresAt: now + 100,
  resetAt: null,
  provenance: "user-provided",
  verification: "unverified",
  source: "manual",
  confidence: "high",
};
const resource = (observations: QuotaObservation[] = []): AccountResource => ({
  account: {
    id: "a",
    displayName: "Same",
    provider: "openai",
    externalIdentity: null,
    availability: "unknown",
    provenance: "user-provided",
    verification: "unverified",
    source: "manual",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  },
  bindings: [
    {
      accountId: "a",
      harnessId: "codex",
      createdAt: 0,
      source: "manual",
      provenance: "user-provided",
      verification: "unverified",
    },
  ],
  profiles: [],
  subscriptionIds: [],
  models: [],
  quotas: [
    {
      definition,
      observations,
      current: null,
      status: "unknown",
      warnings: [],
    },
  ],
});

for (const [currency, raw, minor] of [
  ["USD", "0.29", 29],
  ["USD", "90071992547409.91", Number.MAX_SAFE_INTEGER],
  ["JPY", "100", 100],
  ["KWD", "1.001", 1001],
  ["CLF", "1.0001", 10001],
  ["EUR", "0", 0],
] as const) {
  test(`exact minor unit roundtrip ${currency} ${raw}`, () => {
    expect(parseMoney(raw, currency)).toBe(minor);
    expect(parseMoney(moneyInput(minor, currency), currency)).toBe(minor);
  });
}
test("unknown cost stays Unknown; explicit zero is preserved", () => {
  expect(parseMoney("", "")).toBeNull();
  expect(moneyLabel(null, "USD")).toBe("Unknown");
  expect(moneyLabel(0, "USD")).toBe("USD 0.00");
  expect(quantity(null)).toBe("Unknown");
  expect(quantity(0)).toBe("0");
  expect(quantity(0.0000000000001)).not.toBe("0");
});
test("money rejects excess precision, unsafe ranges and ambiguous input without rounding", () => {
  for (const raw of [
    "0.001",
    "-1",
    "1e2",
    "1,000",
    "Infinity",
    "90071992547409.92",
  ])
    expect(() => parseMoney(raw, "USD")).toThrow();
  expect(() => parseMoney("1.1", "JPY")).toThrow();
  expect(() => currencyDigits("US")).toThrow();
  expect(() => parseMoney("1", "")).toThrow();
});
test("numeric form values preserve null and zero, reject non-finite and unsafe values", () => {
  expect(nullableNumber("")).toBeNull();
  expect(nullableNumber("0")).toBe(0);
  expect(nullableNumber("1.5")).toBe(1.5);
  for (const raw of ["-1", "NaN", "1e309", "9007199254740992"])
    expect(() => nullableNumber(raw)).toThrow();
  expect(() => nullableNumber("9007199254740991.1", true)).toThrow();
  expect(nullableNumber("9007199254740991", true)).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});
test("local date fields preserve seconds and handle empty values", () => {
  const value = new Date(2026, 9, 24, 10, 11, 12).getTime();
  expect(parseDate(dateInput(value))).toBe(value);
  expect(parseDate("")).toBeNull();
  expect(() => parseDate("invalid")).toThrow();
});
test("unknown, zero and percent directions are kept distinct without derived remaining", () => {
  const unknown = currentQuotas(resource(), [], now)[0]!;
  expect(unknown.status).toBe("unknown");
  expect(unknown.current).toBeNull();
  expect(
    currentQuotas(resource([{ ...observation, remaining: 0 }]), [], now)[0]!
      .current?.remaining,
  ).toBe(0);
  for (const kind of ["percent-used", "percent-remaining"] as const) {
    const q = currentQuotas(
      resource([
        {
          ...observation,
          limit: 100,
          used: 20,
          indicator: { kind, value: 20 },
        },
      ]),
      [],
      now,
    )[0]!;
    expect(q.current?.remaining).toBeNull();
    expect(q.current?.indicator?.kind).toBe(kind);
  }
});
test("local time invalidates capacity on expiry and reset; missing TTL stays stale", () => {
  expect(
    currentQuotas(
      resource([{ ...observation, remaining: 5 }]),
      [],
      now + 100,
    )[0]!.current,
  ).toBeNull();
  expect(observationFreshness({ ...observation, expiresAt: now }, now)).toBe(
    "Expired",
  );
  expect(observationFreshness({ ...observation, resetAt: now }, now)).toContain(
    "reset passed",
  );
  expect(
    observationFreshness({ ...observation, expiresAt: null }, now),
  ).toContain("freshness unknown");
});
test("conflicting sources expose no current capacity and retain supporting evidence", () => {
  const q = currentQuotas(
    resource([
      { ...observation, remaining: 5 },
      { ...observation, id: "o2", source: "provider", remaining: 0 },
    ]),
    [],
    now,
  )[0]!;
  expect(q.status).toBe("conflict");
  expect(q.current).toBeNull();
  expect(q.observations).toHaveLength(2);
});
test("archived account/subscription cannot become current through client recalculation", () => {
  const row = resource([{ ...observation, remaining: 10 }]);
  row.account.archivedAt = now;
  expect(currentQuotas(row, [], now)[0]!.current).toBeNull();
  row.account.archivedAt = null;
  row.quotas[0]!.definition = { ...definition, subscriptionId: "archived" };
  expect(currentQuotas(row, [], now)[0]!.status).toBe("unknown");
});
test("profile harness drift fails closed while unknown identity stays separate from conflicts", () => {
  const row = resource();
  row.profiles = [
    { accountId: "a", harnessId: "codex", profileId: "p", createdAt: 0 },
  ];
  const p = { id: "p", harness: "codex" } as AgentProfile;
  expect(profileWarning(row, p, "codex")).toBeNull();
  expect(profileWarning(row, { ...p, harness: "cursor" }, "codex")).toContain(
    "Unreliable",
  );
  row.account.provenance = "unknown";
  expect(profileWarning(row, p, "codex")).toContain("Unknown");
  expect(
    new Map(accountMetrics([row], [p], 2, 0, now)).get("Resource Conflicts"),
  ).toBe(0);
});
test("overview distinguishes current definitions, unknown balance and stale reports", () => {
  const row = resource([
    { ...observation, remaining: 0 },
    { ...observation, id: "old", source: "old-source", expiresAt: now - 1 },
  ]);
  row.quotas = currentQuotas(row, [], now);
  const metrics = new Map(accountMetrics([row], [], 2, 1, now));
  expect(metrics.get("Current Quotas")).toBe(1);
  expect(metrics.get("Unknown Quotas")).toBe(0);
  expect(metrics.get("Stale Observations")).toBe(1);
});
test.each(["en", "ru"] as const)("freshness metrics use canonical status independently of %s labels", async (locale) => {
  const observations = [
    { ...observation, observedAt: now, remaining: 0 },
    { ...observation, id: "unknown", expiresAt: null },
    { ...observation, id: "expired", expiresAt: now },
    { ...observation, id: "reset", resetAt: now },
    { ...observation, id: "future", observedAt: now + 1 },
  ];
  const row = resource(observations);
  const original = JSON.stringify(row);
  const dictionary = dictionaries[locale];
  const currentLabel = dictionary["common.current"];
  try {
    await localeStore.choose(locale, async () => {});
    expect(observations.map(o => observationFreshnessStatus(o, now))).toEqual([
      "current", "freshness-unknown", "expired", "reset-passed", "future",
    ]);
    const keys = ["common.current", "common.stale_freshness_unknown", "common.expired", "common.stale_reset_passed", "common.future_observation"] as const;
    expect(observations.map(o => observationFreshness(o, now))).toEqual(keys.map(key => t(key)));
    expect(new Map(accountMetrics([row], [], 2, 1, now)).get(t("common.stale_observations"))).toBe(4);
    // A copy edit creating identical UI labels must never change the metric.
    dictionary["common.current"] = t("common.expired");
    expect(observationFreshness(observations[0]!, now)).toBe(observationFreshness(observations[2]!, now));
    expect(new Map(accountMetrics([row], [], 2, 1, now)).get(t("common.stale_observations"))).toBe(4);
    expect(JSON.stringify(row)).toBe(original);
  } finally {
    dictionary["common.current"] = currentLabel;
    await localeStore.choose("en", async () => {});
  }
});
test("error messages never expose arbitrary backend text, SQLite or request secrets", () => {
  for (const status of [400, 401, 403, 404, 409, 413, 500, undefined]) {
    const message = accountError({
      status,
      message: "SQLite /home/SECRET Bearer SECRET",
      body: { secret: "SECRET" },
    });
    expect(message).not.toMatch(/SQLite|SECRET|Bearer|\/home/);
  }
  expect(
    accountError({ status: 400, message: "Invalid observation time range." }),
  ).toContain("Observed At");
});
test("typed units are explicit, including integer monetary minor units", () => {
  expect(unitLabel({ kind: "money", currency: "JPY" })).toBe("JPY minor units");
  expect(
    unitLabel({ kind: "provider-specific", name: "GPU credits" }),
  ).toContain("GPU credits");
  expect(unitLabel({ kind: "compute-time", name: "milliseconds" })).toContain(
    "milliseconds",
  );
});
