import { expect, test } from "bun:test";
import { trustedCodexQuotaProof } from "./codex-quota-failure.ts";
import { effectiveLaunchesRemaining, ordinaryLaunchesRemaining, runStderrProvesQuotaExhausted, type ProviderRecoveryAuthorization } from "./pm-provider-recovery.ts";

const LEGACY = "You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:50 PM.";
const LEGACY_ASCII = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 10:22 PM.";
const CODEX_AGENT = "codex-profile-22222222-2222-4222-8222-222222222222";
const CODEX_SESSION = "11111111-1111-4111-8111-111111111111";

test("usage_limit_exceeded in persisted stderr is recognized", () => {
  expect(runStderrProvesQuotaExhausted("provider failed: usage_limit_exceeded")).toBe(true);
  expect(runStderrProvesQuotaExhausted("model rejected")).toBe(false);
});

test("the exact legacy Codex usage-limit sentence is recognized", () => {
  expect(runStderrProvesQuotaExhausted(LEGACY)).toBe(true);
  expect(runStderrProvesQuotaExhausted(LEGACY_ASCII)).toBe(true);
  expect(runStderrProvesQuotaExhausted(`${LEGACY}\n${LEGACY}`)).toBe(true);
  expect(runStderrProvesQuotaExhausted("You've hit your usage limit")).toBe(false);
  expect(runStderrProvesQuotaExhausted("quota exceeded")).toBe(false);
  expect(runStderrProvesQuotaExhausted("rate limit exceeded")).toBe(false);
  expect(runStderrProvesQuotaExhausted("Authentication failed")).toBe(false);
  expect(runStderrProvesQuotaExhausted("context window exceeded")).toBe(false);
  expect(runStderrProvesQuotaExhausted(`The reviewer said: ${LEGACY}`)).toBe(false);
});

test("legacy proof requires a failed Codex process event, and model text does not", () => {
  const run = { status: "failed", agent: CODEX_AGENT, codexSessionId: CODEX_SESSION };
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: LEGACY, lineUuid: "error:0" }])?.detail).toBe("codex-cli-usage-limit");
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: LEGACY, lineUuid: "turn.failed:1" }])?.detail).toBe("codex-cli-usage-limit");
  expect(trustedCodexQuotaProof(
    { status: "failed", agent: "claude-code", codexSessionId: null },
    [{ stream: "stderr", data: "provider failed: usage_limit_exceeded" }],
  )?.detail).toBe("usage_limit_exceeded");
  expect(trustedCodexQuotaProof(run, [{ stream: "assistant", data: LEGACY, lineUuid: "item.completed:1" }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "user", data: LEGACY }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "status", data: LEGACY }])).toBeNull();
  expect(trustedCodexQuotaProof({ ...run, status: "succeeded" }, [{ stream: "stderr", data: LEGACY, lineUuid: "error:0" }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: LEGACY }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: LEGACY, lineUuid: "item.completed:9" }])).toBeNull();
  expect(trustedCodexQuotaProof({ ...run, codexSessionId: null }, [{ stream: "stderr", data: LEGACY, lineUuid: "error:0" }])).toBeNull();
  expect(trustedCodexQuotaProof({ ...run, codexSessionId: "not-a-session" }, [{ stream: "stderr", data: LEGACY, lineUuid: "error:0" }])).toBeNull();
  expect(trustedCodexQuotaProof({ ...run, agent: "claude-code" }, [{ stream: "stderr", data: LEGACY, lineUuid: "error:0" }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: "Not logged in", lineUuid: "error:0" }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: "rate limit exceeded", lineUuid: "error:0" }])).toBeNull();
  expect(trustedCodexQuotaProof(run, [{ stream: "stderr", data: LEGACY, lineUuid: "error:0", subagentId: "side" }])).toBeNull();
});

test("supplemental allowance only applies after the frozen budget is exhausted", () => {
  const grant = {
    taskId: "t",
    projectPath: "/p",
    implementerEmployeeId: "e",
    implementerHarnessId: "claude-code",
    implementerModel: "opus",
    implementerEffort: null,
    reviewerEmployeeId: null,
    reviewerHarness: "claude-code",
    reviewerModel: "haiku",
    autoReviewAfterImplementation: true,
    autoReworkOnChanges: false,
    maxReworkIterations: 0,
    maxLaunches: 2,
    expiresAt: null,
    approvedAt: 0,
    approvedBy: "owner" as const,
    grantEpoch: 1,
  };
  const counters = { launchesUsed: 1, implementationRuns: 1, reviewRuns: 0, reworkCount: 0 };
  expect(ordinaryLaunchesRemaining(grant, counters)).toBe(1);
  expect(effectiveLaunchesRemaining(grant, counters, null)).toBe(1);
  counters.launchesUsed = 2;
  expect(ordinaryLaunchesRemaining(grant, counters)).toBe(0);
  const auth: ProviderRecoveryAuthorization = {
    id: "r",
    batchId: "b",
    taskId: "t",
    projectPath: "/p",
    status: "applied" as const,
    failedReviewerRunId: "fr",
    failedReviewerPhaseGrantId: "fg",
    failedQcReviewId: "fq",
    developerRunId: "dr",
    evidenceBundleDigest: "d",
    sourceFingerprint: "f",
    reviewerHarnessId: "claude-code",
    reviewerModel: "haiku",
    failureClass: "quota-exhausted" as const,
    failureDetail: "usage_limit_exceeded",
    reason: "ok",
    approvedAt: Date.now() - 10_000,
    approvedBy: "owner" as const,
    expiresAt: Date.now() + 60_000,
    supplementalMaxLaunches: 1 as const,
    supplementalLaunchesConsumed: 0,
    recoveryPhaseGrantId: null,
    appliedAt: Date.now(),
    audit: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  expect(effectiveLaunchesRemaining(grant, counters, auth)).toBe(1);
  auth.supplementalLaunchesConsumed = 1;
  expect(effectiveLaunchesRemaining(grant, counters, auth)).toBe(0);
  auth.supplementalLaunchesConsumed = 0;
  auth.status = "expired";
  auth.expiresAt = Date.now() - 1_000;
  expect(effectiveLaunchesRemaining(grant, counters, auth)).toBe(0);
  auth.prelaunchReauthorization = {
    id: "re",
    status: "applied",
    approvedAt: Date.now(),
    approvedBy: "owner",
    expiresAt: Date.now() + 60_000,
    reason: "prelaunch",
    failedGrantId: "g",
    classification: "proven-prelaunch-failure",
    replacementPhaseGrantId: "new",
    appliedAt: Date.now(),
  };
  expect(effectiveLaunchesRemaining(grant, counters, auth)).toBe(1);
  auth.prelaunchReauthorization.status = "approved";
  expect(effectiveLaunchesRemaining(grant, counters, auth)).toBe(0);
});
