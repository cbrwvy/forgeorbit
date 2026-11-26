import { expect, test } from "bun:test";
import type { QuotaRefreshAvailability } from "../accounts/quota-sources.ts";
import type { Account, QuotaDefinition, QuotaObservation, QuotaState } from "../accounts/types.ts";
import {
  buildModelRouterResourceContext,
  harnessResourceRow,
  mapQuotaState,
  quotaCapacityLabel,
} from "./resource-context.ts";

function account(id: string, provider: Account["provider"] = "openai"): Account {
  return {
    id,
    provider,
    displayName: "Acct",
    externalIdentity: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    availability: "unknown",
    provenance: "user-provided",
    source: "fixture",
    verification: "unverified",
  };
}

function definition(id: string, accountId: string): QuotaDefinition {
  return {
    id,
    accountId,
    subscriptionId: null,
    scope: "account",
    unit: { kind: "requests" },
    window: "day",
    createdAt: 1,
    archivedAt: null,
  };
}

function observation(patch: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    id: "obs-1",
    quotaId: "q1",
    source: "manual",
    provenance: "user-provided",
    verification: "verified",
    observedAt: 1_000,
    expiresAt: 2_000,
    resetAt: null,
    limit: 100,
    used: 40,
    remaining: 60,
    indicator: null,
    confidence: "high",
    ...patch,
  };
}

function state(status: QuotaState["status"], current: QuotaObservation | null): QuotaState {
  return {
    definition: definition("q1", "a1"),
    status,
    current,
    observations: current ? [current] : [],
    warnings: [],
  };
}

function source(patch: Partial<QuotaRefreshAvailability>): QuotaRefreshAvailability {
  return {
    id: "codex-app-server",
    provider: "openai",
    harnessKinds: ["codex"],
    label: "Codex",
    documentation: "documented",
    acquisition: "eligible-interface",
    officialUrl: "https://example.invalid",
    checkedAt: "2026-10-25",
    metrics: "",
    authorization: "",
    identity: "",
    windows: "",
    sharedPool: "",
    poolIdentity: "unknown",
    limitations: "",
    implemented: false,
    refreshAvailable: false,
    reason: "No production adapter.",
    ...patch,
  };
}

test("FO-009F-1 enabled and disabled harnesses map to distinct manual/automatic posture", () => {
  const enabled = harnessResourceRow({ id: "codex", label: "Codex", enabled: true });
  const disabled = harnessResourceRow({ id: "cursor", label: "Cursor", enabled: false });
  expect(enabled.manualSelection).toBe("allowed-with-warning");
  expect(enabled.automaticSelection).toBe("blocked-unverified");
  expect(disabled.manualSelection).toBe("blocked-disabled");
  expect(disabled.automaticSelection).toBe("blocked-disabled");
});

test("FO-009F-2 verified quota observation exposes timestamp without inventing reset time", () => {
  const row = mapQuotaState(state("current", observation()), 1_500);
  expect(row.lastObservedAt).toBe(1_000);
  expect(row.capacityLabel).toContain("Verified remaining: 60");
  expect(row.capacityLabel).not.toMatch(/reset/i);
});

test("FO-009F-3 unknown quota stays Unknown", () => {
  expect(quotaCapacityLabel(state("unknown", null), 1_000)).toBe("Unknown");
});

test("FO-009F-4 stale observation is not current capacity", () => {
  const stale = mapQuotaState(state("stale", observation({ expiresAt: 500 })), 1_000);
  expect(stale.capacityLabel).toBe("Stale — not current capacity");
});

test("FO-009F-5 failed refresh surfaces as unavailable trusted source, not verified capacity", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 1,
    harnesses: [{ id: "codex", label: "Codex", enabled: true }],
    accounts: [account("a1")],
    quotasByAccount: new Map([["a1", []]]),
    trustedSourcesByAccount: new Map([["a1", [source({ refreshAvailable: false, reason: "Quota refresh failed. Previous observations were retained." })]]]),
    now: 1_000,
  });
  expect(ctx.accounts[0]!.trustedSources[0]!.refreshAvailable).toBe(false);
  expect(ctx.automaticRouting.available).toBe(false);
});

test("FO-009F-6 unsupported provider sources remain unavailable in catalog rows", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 1,
    harnesses: [],
    accounts: [account("a1", "google")],
    quotasByAccount: new Map([["a1", []]]),
    trustedSourcesByAccount: new Map([["a1", [source({ id: "gemini-cli", provider: "google", label: "Gemini", refreshAvailable: false, reason: "Unsupported." })]]]),
    now: 1,
  });
  expect(ctx.accounts[0]!.trustedSources[0]!.sourceId).toBe("gemini-cli");
  expect(ctx.accounts[0]!.trustedSources[0]!.refreshAvailable).toBe(false);
});

test("FO-009F-7 multiple accounts of one provider stay separate rows", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 1,
    harnesses: [],
    accounts: [account("a1"), account("a2")],
    quotasByAccount: new Map([["a1", []], ["a2", []]]),
    trustedSourcesByAccount: new Map([
      ["a1", [source({ reason: "Account one" })]],
      ["a2", [source({ reason: "Account two" })]],
    ]),
    now: 1,
  });
  expect(ctx.accounts).toHaveLength(2);
  expect(ctx.accounts[0]!.trustedSources[0]!.reason).toBe("Account one");
  expect(ctx.accounts[1]!.trustedSources[0]!.reason).toBe("Account two");
});

test("FO-009F-8 no eligible automatic candidate: automaticRouting.available is false", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 1,
    harnesses: [{ id: "codex", label: "Codex", enabled: true }],
    accounts: [],
    quotasByAccount: new Map(),
    trustedSourcesByAccount: new Map(),
    now: 1,
  });
  expect(ctx.automaticRouting.available).toBe(false);
});

test("FO-009F-9 manual selection allowed with warning on enabled harness", () => {
  const row = harnessResourceRow({ id: "codex", label: "Codex", enabled: true });
  expect(row.manualSelection).toBe("allowed-with-warning");
  expect(row.manualReason).toContain("Manual harness");
});

test("FO-009F-10 percent-only verified meter never claims exact remaining tokens", () => {
  const label = quotaCapacityLabel(state("current", observation({
    remaining: null,
    used: null,
    limit: null,
    indicator: { kind: "percent-used", value: 42 },
  })), 1_500);
  expect(label).toContain("exact balance unknown");
  expect(label).not.toMatch(/remaining: \d+/);
});

test("FO-009F-11 conflict status surfaces honestly", () => {
  expect(mapQuotaState(state("conflict", observation()), 1_000).capacityLabel).toBe("Conflicting evidence");
});

test("FO-009F-12 policy notes forbid silent paid-provider fallback", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 1,
    harnesses: [],
    accounts: [],
    quotasByAccount: new Map(),
    trustedSourcesByAccount: new Map(),
    now: 1,
  });
  expect(ctx.policyNotes.some((note) => /FO-AUTO01|Owner routing policy/i.test(note))).toBe(true);
});

test("FO-009F-13 production context keeps automatic routing off without adapter", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 1,
    harnesses: [{ id: "codex", label: "Codex", enabled: true }],
    accounts: [account("a1")],
    quotasByAccount: new Map([["a1", [state("current", observation())]]]),
    trustedSourcesByAccount: new Map([["a1", [source({ implemented: false, refreshAvailable: false })]]]),
    now: 1_500,
  });
  expect(ctx.automaticRouting.available).toBe(false);
});

test("FO-009F-14 expired current observation reads stale at display time", () => {
  const label = quotaCapacityLabel(state("current", observation({ expiresAt: 900, resetAt: 950 })), 1_000);
  expect(label).toBe("Stale — not current capacity");
});

test("FO-009F-15 read-only contract on built context", () => {
  const ctx = buildModelRouterResourceContext({
    capturedAt: 42,
    harnesses: [],
    accounts: [],
    quotasByAccount: new Map(),
    trustedSourcesByAccount: new Map(),
    now: 1,
  });
  expect(ctx.readOnly).toBe(true);
  expect(ctx.capturedAt).toBe(42);
});
