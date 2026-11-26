import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore, AccountCoreError } from "./account-core.ts";
import {
  TrustedQuotaRefresh,
  type TrustedQuotaAdapter,
  type TrustedQuotaResult,
  type TrustedQuotaSample,
  type VerifiedQuotaBinding,
} from "./trusted-quota.ts";
import { QUOTA_SOURCES } from "../shared/accounts/quota-sources.ts";
import { accountHttp } from "./account-http.ts";
import { LegacyUsageBridge } from "./account-usage-bridge.ts";
import { CodexSource, type CodexConnectionFactory } from "./codex-source.ts";
import { normalizeCodexQuotas } from "./codex-quota.ts";
import { CodexEvidenceCollector, normalizeCodexEvidence } from "./codex-evidence.ts";
import { trustedCodexQuotaProof } from "../shared/codex-quota-failure.ts";
import {
  buildModelRouterResourceContext,
  harnessResourceRow,
  mapQuotaState,
  quotaCapacityLabel,
} from "../shared/model-router/resource-context.ts";
import { EMPTY_MODEL_EVIDENCE, routeTask } from "../shared/model-router/route.ts";
import type { RoutingSnapshot, TaskRequirements } from "../shared/model-router/types.ts";
import {
  buildExecutorRecommendations,
  EMPTY_EXECUTOR_PREFERENCES,
} from "../shared/execution/executor-routing.ts";
import type { Account, QuotaDefinition } from "../shared/accounts/types.ts";

let db: Database;
let core: AccountCore;
let now: number;
let primaryAccount: Account;
let secondaryAccount: Account;
let fiveHourDef: QuotaDefinition;
let weeklyDef: QuotaDefinition;
let binding: VerifiedQuotaBinding | null;
let acquireFn: () => Promise<TrustedQuotaResult>;
let adapterCalls: number;
let mockAdapter: TrustedQuotaAdapter;

const SOURCE_ID = "codex-app-server";

beforeEach(() => {
  now = 1_794_070_000_000;
  adapterCalls = 0;
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  migrate(db, migrations);
  core = new AccountCore(db, () => now);
  primaryAccount = core.createAccount({
    provider: "openai",
    displayName: "Owner OpenAI Profile A",
    externalIdentity: "owner-a@example.invalid",
  });
  secondaryAccount = core.createAccount({
    provider: "openai",
    displayName: "Owner OpenAI Profile B",
    externalIdentity: "owner-b@example.invalid",
  });
  fiveHourDef = core.createDefinition({
    accountId: primaryAccount.id,
    scope: "model-group:gpt-5",
    unit: { kind: "requests" },
    window: "rolling:5h",
  });
  weeklyDef = core.createDefinition({
    accountId: primaryAccount.id,
    scope: "model-group:gpt-5",
    unit: { kind: "requests" },
    window: "rolling:7d",
  });
  binding = {
    accountId: primaryAccount.id,
    provider: "openai",
    subject: "acct_verified_owner_a",
    verification: "verified",
    method: "provider-account",
  };
  acquireFn = async () => ({
    provider: "openai",
    sourceId: SOURCE_ID,
    attribution: binding!,
    samples: [makeSample(fiveHourDef, { limit: 100, used: 58, remaining: 42, resetAt: now + 18_000_000 })],
  });
  mockAdapter = {
    sourceId: SOURCE_ID,
    binding: (accountId: string) => (binding && binding.accountId === accountId ? binding : null),
    acquire: async () => {
      adapterCalls++;
      return acquireFn();
    },
  };
});

afterEach(() => {
  db.close();
});

function makeSample(def: QuotaDefinition, extra: Partial<TrustedQuotaSample> = {}): TrustedQuotaSample {
  return {
    quotaId: def.id,
    scope: def.scope,
    unit: def.unit,
    window: def.window,
    observedAt: now,
    expiresAt: now + 300_000,
    resetAt: null,
    limit: null,
    used: null,
    remaining: null,
    indicator: null,
    sharedPool: null,
    ...extra,
  };
}

function makeTaskRequirements(): TaskRequirements {
  return {
    taskId: "task-quota-fixture",
    projectId: "proj-quota-fixture",
    type: "backend",
    complexity: "low",
    priority: null,
    capabilities: [],
    tools: [],
    requiredPermissions: [],
    allowedPermissions: null,
    contextTokens: null,
    quotaDemands: [{ quotaId: fiveHourDef.id, amount: 1 }],
    provenance: ["fixture"],
  };
}

test("FO-009F-VQ01-01: valid verified quota fixture persists source, freshness and verified capacity", async () => {
  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  const refreshed = await coordinator.refresh(primaryAccount.id, SOURCE_ID);

  expect(adapterCalls).toBe(1);
  expect(refreshed.refreshedAt).toBe(now);
  expect(refreshed.observations).toHaveLength(1);

  const states = core.currentQuotas(primaryAccount.id);
  const fiveHourState = states.find((s) => s.definition.id === fiveHourDef.id)!;
  expect(fiveHourState.status).toBe("current");
  expect(fiveHourState.current).toMatchObject({
    source: `trusted:${SOURCE_ID}`,
    provenance: "verified",
    verification: "verified",
    observedAt: now,
    expiresAt: now + 300_000,
    resetAt: now + 18_000_000,
    limit: 100,
    used: 58,
    remaining: 42,
    confidence: "high",
    acquisition: {
      provider: "openai",
      accountId: primaryAccount.id,
      subject: "acct_verified_owner_a",
      method: "provider-account",
      sourceId: SOURCE_ID,
      receivedAt: now,
    },
  });

  const ctx = buildModelRouterResourceContext({
    capturedAt: now,
    harnesses: [{ id: "codex", label: "Codex", enabled: true }],
    accounts: [primaryAccount],
    quotasByAccount: new Map([[primaryAccount.id, states]]),
    trustedSourcesByAccount: new Map([[primaryAccount.id, coordinator.availability(primaryAccount.id)]]),
    now,
  });
  const mapped = ctx.accounts[0]!.quotas.find((q) => q.quotaId === fiveHourDef.id)!;
  expect(mapped.capacityLabel).toBe("Verified remaining: 42");
  expect(mapped.lastObservedAt).toBe(now);
});

test("FO-009F-VQ01-02: account binding isolates verified quota to exact AccountCore UUID without upgrading CLI identity", async () => {
  core.bindHarness(primaryAccount.id, "codex");
  core.bindHarness(secondaryAccount.id, "codex");
  const secondaryDef = core.createDefinition({
    accountId: secondaryAccount.id,
    scope: "model-group:gpt-5",
    unit: { kind: "requests" },
    window: "rolling:5h",
  });

  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  expect(coordinator.availability(primaryAccount.id).find((s) => s.id === SOURCE_ID)?.refreshAvailable).toBe(true);
  expect(coordinator.availability(secondaryAccount.id).find((s) => s.id === SOURCE_ID)?.refreshAvailable).toBe(false);

  await coordinator.refresh(primaryAccount.id, SOURCE_ID);
  await expect(coordinator.refresh(secondaryAccount.id, SOURCE_ID)).rejects.toMatchObject({ status: 409 });

  expect(core.currentQuotas(primaryAccount.id).find((s) => s.definition.id === fiveHourDef.id)?.status).toBe("current");
  expect(core.currentQuotas(secondaryAccount.id).find((s) => s.definition.id === secondaryDef.id)?.status).toBe("unknown");
  expect(core.resolveIdentity("codex").accountId).toBeNull();
  expect(core.getAccount(primaryAccount.id).verification).toBe("unverified");
});

test("FO-009F-VQ01-03: multiple quota windows keep 5h and weekly limits separate and 100% never implies unlimited", async () => {
  const pct5h = core.createDefinition({
    accountId: primaryAccount.id,
    scope: "model-group:gemini-pro",
    unit: { kind: "provider-specific", name: "window-allowance-percent" },
    window: "rolling:5h",
  });
  const pctWeekly = core.createDefinition({
    accountId: primaryAccount.id,
    scope: "model-group:claude-gpt",
    unit: { kind: "provider-specific", name: "window-allowance-percent" },
    window: "rolling:7d",
  });

  acquireFn = async () => ({
    provider: "openai",
    sourceId: SOURCE_ID,
    attribution: binding!,
    samples: [
      makeSample(pct5h, {
        indicator: { kind: "percent-remaining", value: 100 },
        resetAt: now + 5 * 3_600_000,
      }),
      makeSample(pctWeekly, {
        indicator: { kind: "percent-remaining", value: 35 },
        resetAt: now + 7 * 86_400_000,
      }),
    ],
  });

  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  await coordinator.refresh(primaryAccount.id, SOURCE_ID);

  const quotas = core.currentQuotas(primaryAccount.id);
  const q5h = quotas.find((q) => q.definition.id === pct5h.id)!;
  const q7d = quotas.find((q) => q.definition.id === pctWeekly.id)!;

  expect(q5h.definition.window).toBe("rolling:5h");
  expect(q7d.definition.window).toBe("rolling:7d");
  expect(q5h.current?.remaining).toBeNull();
  expect(q7d.current?.remaining).toBeNull();
  expect(q5h.current?.resetAt).not.toBe(q7d.current?.resetAt);

  const label5h = quotaCapacityLabel(q5h, now);
  const label7d = quotaCapacityLabel(q7d, now);
  expect(label5h).toContain("100%");
  expect(label5h).toContain("exact balance unknown");
  expect(label5h.toLowerCase()).not.toContain("unlimited");
  expect(label7d).toContain("35%");
  expect(label7d).toContain("exact balance unknown");
});

test("FO-009F-VQ01-04: expired TTL and elapsed resetAt resolve to stale and never imply replenishment", async () => {
  acquireFn = async () => ({
    provider: "openai",
    sourceId: SOURCE_ID,
    attribution: binding!,
    samples: [
      makeSample(fiveHourDef, { remaining: 15, expiresAt: now + 1_000, resetAt: now + 5_000 }),
      makeSample(weeklyDef, { remaining: 80, expiresAt: now + 10_000, resetAt: now + 2_000 }),
    ],
  });

  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  await coordinator.refresh(primaryAccount.id, SOURCE_ID);
  const capturedFresh = core.currentQuotas(primaryAccount.id);
  const captured5h = capturedFresh.find((s) => s.definition.id === fiveHourDef.id)!;
  const captured7d = capturedFresh.find((s) => s.definition.id === weeklyDef.id)!;
  expect(captured5h.status).toBe("current");
  expect(captured7d.status).toBe("current");

  // Advance past fiveHourDef expiresAt AND past weeklyDef resetAt
  now += 3_000;
  // Display-time check on a previously captured snapshot flags Stale
  expect(mapQuotaState(captured5h, now).capacityLabel).toBe("Stale — not current capacity");
  expect(mapQuotaState(captured7d, now).capacityLabel).toBe("Stale — not current capacity");

  // Re-resolved AccountCore state clears current to null, marks status stale and never implies replenishment
  const states = core.currentQuotas(primaryAccount.id);
  const s5h = states.find((s) => s.definition.id === fiveHourDef.id)!;
  const s7d = states.find((s) => s.definition.id === weeklyDef.id)!;

  expect(s5h.status).toBe("stale");
  expect(s5h.current).toBeNull();
  expect(s7d.status).toBe("stale");
  expect(s7d.current).toBeNull();
  expect(mapQuotaState(s5h, now).capacityLabel).toBe("Unknown");
  expect(mapQuotaState(s7d, now).capacityLabel).toBe("Unknown");
});

test("FO-009F-VQ01-05: authentication failure returns controlled error/unknown and retains prior observations", async () => {
  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  await coordinator.refresh(primaryAccount.id, SOURCE_ID);
  const priorHistory = core.history(fiveHourDef.id);

  // Adapter throws authentication failure on subsequent refresh
  now += 1_000;
  acquireFn = async () => {
    throw new Error("HTTP 401 Unauthorized: OAuth session expired");
  };
  await expect(coordinator.refresh(primaryAccount.id, SOURCE_ID)).rejects.toMatchObject({
    status: 502,
    message: "Quota refresh failed. Previous observations were retained.",
  });
  expect(core.history(fiveHourDef.id)).toEqual(priorHistory);

  // Unauthenticated Codex app-server read never queries rateLimits and reports authentication: "none"
  const calls: string[] = [];
  const unauthConnect: CodexConnectionFactory = () => ({
    timedOut: false,
    close() {},
    notify(method) {
      calls.push(method);
    },
    async call(method) {
      calls.push(method);
      if (method === "initialize") return { result: { userAgent: "fixture" } };
      return { result: { account: null, requiresOpenaiAuth: true } };
    },
  });
  const codexSource = new CodexSource(unauthConnect, () => now);
  const state = await codexSource.inspect(true);
  expect(state).toMatchObject({ authentication: "none", binding: "unverified", refreshAvailable: false });
  expect(calls).not.toContain("account/rateLimits/read");

  // Evidence normalization for unauthenticated account stays empty with explicit reason
  const normalized = normalizeCodexEvidence(
    { account: { account: null, requiresOpenaiAuth: true }, models: [], rateLimits: null },
    now,
  );
  expect(normalized.authMode).toBe("none");
  expect(normalized.windows).toEqual([]);
  expect(normalized.unknownReasons).toContain("Codex is not signed in.");
});

test("FO-009F-VQ01-06: missing quota metadata keeps capacity Unknown without inventing zero or unlimited", async () => {
  acquireFn = async () => ({
    provider: "openai",
    sourceId: SOURCE_ID,
    attribution: binding!,
    samples: [
      makeSample(fiveHourDef, {
        limit: null,
        used: null,
        remaining: null,
        indicator: null,
        expiresAt: null,
      }),
    ],
  });
  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  await coordinator.refresh(primaryAccount.id, SOURCE_ID);

  // Missing expiresAt means observation cannot be current capacity
  const qState = core.currentQuotas(primaryAccount.id).find((s) => s.definition.id === fiveHourDef.id)!;
  expect(qState.current).toBeNull();
  expect(quotaCapacityLabel(qState, now)).toBe("Unknown");

  // Empty rate-limit windows in Codex evidence record explicit Unknown reason
  const emptyEvidence = normalizeCodexEvidence(
    {
      account: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true },
      models: [{ id: "gpt-5" }],
      rateLimits: { rateLimits: null },
    },
    now,
  );
  expect(emptyEvidence.windows).toEqual([]);
  expect(emptyEvidence.unknownReasons).toContain("The provider reported no rate-limit window.");
});

test("FO-009F-VQ01-07: rate-limit responses and CLI usage_limit_exceeded proofs never fabricate numeric quota", async () => {
  // 1. Provider HTTP 429 during refresh fails closed without inventing remaining: 0
  acquireFn = async () => {
    throw new Error("HTTP 429 Too Many Requests: rate_limit_exceeded");
  };
  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  await expect(coordinator.refresh(primaryAccount.id, SOURCE_ID)).rejects.toMatchObject({ status: 502 });
  expect(core.history(fiveHourDef.id)).toEqual([]);

  // 2. Codex rate-limit payload with rateLimitReachedType and ordinaryUsageAllowed=false preserves null remaining
  const rlEvidence = normalizeCodexEvidence(
    {
      account: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true },
      models: [{ id: "gpt-5" }],
      rateLimits: {
        ordinaryUsageAllowed: false,
        rateLimits: {
          limitId: "codex",
          rateLimitReachedType: "usage_limit_exceeded",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
          secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86400 },
        },
      },
    },
    now,
  );
  expect(rlEvidence.ordinaryUsageAllowed).toBe(false);
  expect(rlEvidence.windows[0]!.reachedType).toBe("usage_limit_exceeded");
  expect(rlEvidence.windows[0]!.window.sample.remaining).toBeNull();
  expect(rlEvidence.windows[1]!.window.sample.remaining).toBeNull();

  // 3. Process-bound Codex failure proof accepts real stderr token and rejects assistant prose
  expect(
    trustedCodexQuotaProof(
      { status: "failed", agent: "codex", codexSessionId: "11111111-2222-3333-4444-555555555555" },
      [{ stream: "stderr", data: '{"error":"usage_limit_exceeded"}', lineUuid: "error:1" }],
    ),
  ).toEqual({ detail: "usage_limit_exceeded" });
  expect(
    trustedCodexQuotaProof(
      { status: "failed", agent: "codex", codexSessionId: "11111111-2222-3333-4444-555555555555" },
      [{ stream: "stdout", data: "usage_limit_exceeded", lineUuid: "msg:1" }],
    ),
  ).toBeNull();
});

test("FO-009F-VQ01-08: incorrect account subject or mismatched provider accountId fails closed with zero writes", async () => {
  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);

  // Wrong subject returned by provider
  acquireFn = async () => ({
    provider: "openai",
    sourceId: SOURCE_ID,
    attribution: { ...binding!, subject: "acct_wrong_foreign_subject" },
    samples: [makeSample(fiveHourDef, { remaining: 50 })],
  });
  await expect(coordinator.refresh(primaryAccount.id, SOURCE_ID)).rejects.toBeInstanceOf(AccountCoreError);
  expect(core.history(fiveHourDef.id)).toEqual([]);

  // Wrong AccountCore accountId in attribution
  acquireFn = async () => ({
    provider: "openai",
    sourceId: SOURCE_ID,
    attribution: { ...binding!, accountId: secondaryAccount.id },
    samples: [makeSample(fiveHourDef, { remaining: 50 })],
  });
  await expect(coordinator.refresh(primaryAccount.id, SOURCE_ID)).rejects.toBeInstanceOf(AccountCoreError);
  expect(core.history(fiveHourDef.id)).toEqual([]);

  // Mismatched experimental workspaceRouting.chatgptAccountId vs rateLimits.accountId in Codex evidence
  const mismatch = normalizeCodexEvidence(
    {
      account: {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
        workspaceRouting: { chatgptAccountId: "acct_alpha" },
      },
      models: [{ id: "gpt-5" }],
      rateLimits: {
        accountId: "acct_beta",
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
          secondary: null,
        },
      },
    },
    now,
  );
  expect(mismatch.identity.correlation).toBe("mismatch");
  expect(mismatch.windows).toEqual([]);
  expect(mismatch.unknownReasons).toContain(
    "Account identity differs between the account and rate-limit reads; no quota was recorded.",
  );
});

test("FO-009F-VQ01-09: provider API format change fails closed without crashing or corrupting observations", async () => {
  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  await coordinator.refresh(primaryAccount.id, SOURCE_ID);
  const validSnapshot = core.history(fiveHourDef.id);

  now += 1_000;
  const malformedPayloads: unknown[] = [
    { provider: "openai", sourceId: SOURCE_ID, attribution: binding, samples: "changed-to-string" },
    { provider: "openai", sourceId: SOURCE_ID, attribution: binding, samples: [] },
    {
      provider: "openai",
      sourceId: SOURCE_ID,
      attribution: binding,
      samples: [makeSample(fiveHourDef, { unit: { kind: "tokens" } })],
    },
    {
      provider: "openai",
      sourceId: SOURCE_ID,
      attribution: binding,
      samples: [makeSample(fiveHourDef, { indicator: { kind: "percent-used", value: 150 } })],
    },
  ];

  for (const payload of malformedPayloads) {
    acquireFn = async () => payload as TrustedQuotaResult;
    await expect(coordinator.refresh(primaryAccount.id, SOURCE_ID)).rejects.toBeInstanceOf(AccountCoreError);
    expect(core.history(fiveHourDef.id)).toEqual(validSnapshot);
  }

  expect(() => normalizeCodexQuotas({ unexpectedSchemaVersion: 2, buckets: [] }, now)).not.toThrow();
  expect(normalizeCodexQuotas({ unexpectedSchemaVersion: 2, buckets: [] }, now)).toEqual([]);
  const driftedEvidence = normalizeCodexEvidence(
    { account: "v3-string-account", models: null, rateLimits: ["unexpected-array"] },
    now,
  );
  expect(driftedEvidence.authMode).toBe("unknown");
  expect(driftedEvidence.windows).toEqual([]);
  expect(driftedEvidence.unknownReasons.length).toBeGreaterThan(0);
});

test("FO-009F-VQ01-10: manual routing fallback keeps manual selection available while automatic routing stays disabled", async () => {
  const googleAccount = core.createAccount({ provider: "google", displayName: "Owner Antigravity" });
  const productionRefresh = new TrustedQuotaRefresh(core);

  // Production registers zero TrustedQuotaAdapters: Antigravity is unsupported, Codex is unimplemented
  const agySource = QUOTA_SOURCES.find((s) => s.id === "antigravity")!;
  expect(agySource.documentation).toBe("unsupported");
  expect(agySource.acquisition).toBe("unsupported");
  expect(productionRefresh.availability(googleAccount.id).find((s) => s.id === "antigravity")?.refreshAvailable).toBe(false);
  expect(productionRefresh.availability(primaryAccount.id).find((s) => s.id === SOURCE_ID)).toMatchObject({
    implemented: false,
    refreshAvailable: false,
  });
  await expect(productionRefresh.refresh(googleAccount.id, "antigravity")).rejects.toMatchObject({ status: 409 });
  await expect(productionRefresh.refresh(primaryAccount.id, SOURCE_ID)).rejects.toMatchObject({ status: 409 });

  // Resource context communicates automatic routing unavailable + manual selection allowed with warning
  const harnesses = [
    { id: "antigravity", label: "Antigravity", enabled: true },
    { id: "codex", label: "Codex", enabled: true },
    { id: "claude-code", label: "Claude Code", enabled: true },
  ];
  const ctx = buildModelRouterResourceContext({
    capturedAt: now,
    harnesses,
    accounts: [googleAccount, primaryAccount],
    quotasByAccount: new Map([
      [googleAccount.id, core.currentQuotas(googleAccount.id)],
      [primaryAccount.id, core.currentQuotas(primaryAccount.id)],
    ]),
    trustedSourcesByAccount: new Map([
      [googleAccount.id, productionRefresh.availability(googleAccount.id)],
      [primaryAccount.id, productionRefresh.availability(primaryAccount.id)],
    ]),
    now,
  });
  expect(ctx.automaticRouting.available).toBe(false);
  for (const h of harnesses) {
    expect(harnessResourceRow(h).manualSelection).toBe("allowed-with-warning");
    expect(harnessResourceRow(h).automaticSelection).toBe("blocked-unverified");
  }

  // Pure router returns no-verified-candidate
  core.bindHarness(googleAccount.id, "antigravity");
  const snapshot: RoutingSnapshot = {
    capturedAt: now,
    candidates: [
      {
        id: "cand-agy",
        harnessId: "antigravity",
        accountId: googleAccount.id,
        modelId: "gemini-3.1-pro",
        profileIds: [],
        enabled: true,
        authorization: null,
        availability: null,
        support: null,
        billing: null,
        evidence: EMPTY_MODEL_EVIDENCE,
      },
    ],
    accounts: [googleAccount],
    bindings: core.bindings(googleAccount.id),
    subscriptions: [],
    subscriptionLinks: [],
    quotas: [],
    limits: [],
    occupancyComplete: false,
  };
  const routed = routeTask(makeTaskRequirements(), snapshot, "balanced");
  expect(routed.status).toBe("no-verified-candidate");
  expect(routed.recommendedCandidate).toBeNull();

  // Executor recommendations preserve manual selectability for potential-unknown options with Owner confirmation
  const recs = buildExecutorRecommendations({
    now,
    preferences: EMPTY_EXECUTOR_PREFERENCES,
    task: { harnessId: "antigravity", model: "gemini-3.1-pro" },
    requestedEffort: null,
    routerPick: { harnessId: null, modelId: null },
    selection: { harnessId: "antigravity", model: "gemini-3.1-pro" },
    sources: [
      {
        harness: { id: "antigravity", kind: "antigravity", label: "Antigravity", enabled: true },
        cli: { available: true, loggedIn: null },
        models: [{ id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" }],
        assessments: routed.conditionalCandidates,
        candidates: snapshot.candidates,
        modesFor: () => [{ id: "auto", label: "Auto" }],
        effortsFor: () => null,
        launchMode: () => "auto",
        permissionFor: () => null,
      },
    ],
  });
  expect(recs.automaticRouter.status).toBe("no-verified-candidate");
  expect(recs.automaticSelection).toBe("none");
  expect(recs.groups["potential-unknown"]).toHaveLength(1);
  expect(recs.groups["potential-unknown"][0]!.selectable).toBe(true);
  expect(recs.groups["potential-unknown"][0]!.requiresOwnerConfirmation).toBe(true);
});

test("FO-009F-VQ01-11: zero implicit AI or CLI execution during quota catalog, evidence view and router evaluation", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        throw new Error("Forbidden network fetch");
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Forbidden CLI spawn");
  });
  const spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Forbidden CLI spawnSync");
  });

  try {
    const refresh = new TrustedQuotaRefresh(core);
    const collector = new CodexEvidenceCollector(core, {
      harness: () => ({ id: "codex", kind: "codex", env: {} }),
      now: () => now,
    });

    expect(refresh.catalog().length).toBeGreaterThan(0);
    expect(refresh.availability(primaryAccount.id).every((s) => !s.refreshAvailable)).toBe(true);
    expect(collector.view(primaryAccount.id).items).toEqual([]);

    const res = await accountHttp(
      new Request(`http://localhost/account-core/accounts/${primaryAccount.id}/quotas`, { method: "GET" }),
      core,
      new LegacyUsageBridge(db),
      true,
      refresh,
    );
    expect(res.status).toBe(200);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    spawnSpy.mockRestore();
    spawnSyncSpy.mockRestore();
  }
});

test("FO-009F-VQ01-12: credentials, tokens, cookies and emails never leak into quota records, errors or views", async () => {
  const secretToken = "sk-ant-oat01-SUPER-SECRET-TOKEN-999";
  const secretJwt = "eyJhbGciOiJIUzI1NiJ9.SECRET_PAYLOAD.SIGNATURE";
  const secretCookie = "WorkosCursorSessionToken=SECRET_COOKIE_VALUE";
  const secretEmail = "private-owner-email@example.invalid";

  // 1. Secret-like strings in VerifiedQuotaBinding.subject are rejected before acquisition
  const poisonedSubjectCoordinator = new TrustedQuotaRefresh(
    core,
    [
      {
        sourceId: SOURCE_ID,
        binding: () => ({
          accountId: primaryAccount.id,
          provider: "openai",
          subject: `Bearer-${secretToken}`,
          verification: "verified",
          method: "provider-account",
        }),
        acquire: async () => {
          throw new Error("Should not be called");
        },
      },
    ],
    () => now,
  );
  expect(
    poisonedSubjectCoordinator.availability(primaryAccount.id).find((s) => s.id === SOURCE_ID)?.refreshAvailable,
  ).toBe(false);

  // 2. Extra credential fields on provider responses are stripped by allowlisted persistence
  acquireFn = async () =>
    ({
      provider: "openai",
      sourceId: SOURCE_ID,
      attribution: binding!,
      access_token: secretToken,
      id_token: secretJwt,
      cookie: secretCookie,
      samples: [
        {
          ...makeSample(fiveHourDef, { remaining: 25 }),
          rawHeaders: { authorization: `Bearer ${secretToken}`, cookie: secretCookie },
        },
      ],
    }) as unknown as TrustedQuotaResult;

  const coordinator = new TrustedQuotaRefresh(core, [mockAdapter], () => now);
  const okRes = await accountHttp(
    new Request(`http://localhost/account-core/accounts/${primaryAccount.id}/quota-refresh`, {
      method: "POST",
      body: JSON.stringify({ sourceId: SOURCE_ID }),
    }),
    core,
    new LegacyUsageBridge(db),
    true,
    coordinator,
  );
  expect(okRes.status).toBe(200);
  const okBody = await okRes.text();
  const storedJson = JSON.stringify(core.history(fiveHourDef.id));
  for (const forbidden of [secretToken, secretJwt, secretCookie, "SECRET"]) {
    expect(okBody).not.toContain(forbidden);
    expect(storedJson).not.toContain(forbidden);
  }

  // 3. Provider exception containing secrets/paths never leaks across HTTP boundary
  now += 1_000;
  acquireFn = async () => {
    throw new Error(`Auth failed for ${secretEmail}: Bearer ${secretToken} cookie=${secretCookie} /Users/owner/.codex/auth.json`);
  };
  const errRes = await accountHttp(
    new Request(`http://localhost/account-core/accounts/${primaryAccount.id}/quota-refresh`, {
      method: "POST",
      body: JSON.stringify({ sourceId: SOURCE_ID }),
    }),
    core,
    new LegacyUsageBridge(db),
    true,
    coordinator,
  );
  expect(errRes.status).toBe(502);
  const errText = await errRes.text();
  for (const forbidden of [secretToken, secretJwt, secretCookie, secretEmail, "auth.json"]) {
    expect(errText).not.toContain(forbidden);
  }

  // 4. Codex evidence normalization strips email, tokens and raw fields
  const ev = normalizeCodexEvidence(
    {
      account: {
        account: { type: "chatgpt", email: secretEmail, planType: "pro", accessToken: secretToken },
        requiresOpenaiAuth: true,
      },
      models: [{ id: "gpt-5", secretKey: secretToken }],
      rateLimits: {
        rateLimitUpsell: { token: secretJwt, cookie: secretCookie },
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
          secondary: null,
        },
      },
    },
    now,
  );
  const evJson = JSON.stringify(ev);
  for (const forbidden of [secretToken, secretJwt, secretCookie, secretEmail]) {
    expect(evJson).not.toContain(forbidden);
  }
});
