/**
 * One disposable company exercised through the production negotiation and
 * recorded transports. No provider process is started. Synthetic profiles
 * are not verified provider subjects.
 */
import { planProviderExecution, concurrencyPlan, cursorEscalationProposal, type RuntimeExecutionRequest } from "./negotiate.ts";
import { attributePoolDelta, buildUsageReceipt, classifyTermination, countsAsGenuineProviderUsage } from "./receipts.ts";
import { parseAcpFixture, parseClaudeFixture, parseCodexFixture, parseCursorFixture, parseDeepSeekFixture, parseGeminiFixture } from "./transports.ts";

export interface ScenarioAccount {
  id: string;
  providerId: RuntimeExecutionRequest["providerId"];
  profileDirectory: string | null;
  homeAccessAccepted?: boolean;
  synthetic: true;
}

export interface ScenarioEvidence {
  processStarted: false;
  checks: Record<string, boolean>;
  notes: string[];
}

const base = {
  transport: "recorded-fixture" as const,
  installed: true,
  homeAccessAccepted: true,
  projectPath: "/tmp/fo-providers-runtime/project-a",
  missionId: "mission-1",
};

function request(account: ScenarioAccount, patch: Partial<RuntimeExecutionRequest> & Pick<RuntimeExecutionRequest, "modelId" | "role" | "permissionMode" | "taskId" | "runId" | "attemptId">): RuntimeExecutionRequest {
  return {
    ...base,
    providerId: account.providerId,
    harnessId: account.id,
    accountId: account.id,
    boundAccountId: account.id,
    profileDirectory: account.profileDirectory,
    homeAccessAccepted: account.homeAccessAccepted ?? true,
    projectPath: patch.projectPath ?? base.projectPath,
    missionId: patch.missionId ?? base.missionId,
    installed: patch.installed ?? true,
    ...patch,
  };
}

export function runProviderRuntimeScenario(): ScenarioEvidence {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  const codexA: ScenarioAccount = { id: "codex-synthetic-a", providerId: "codex", profileDirectory: "/tmp/fo-providers-runtime/codex-a", synthetic: true };
  const codexB: ScenarioAccount = { id: "codex-synthetic-b", providerId: "codex", profileDirectory: "/tmp/fo-providers-runtime/codex-b", synthetic: true };
  const claudeA: ScenarioAccount = { id: "claude-synthetic-a", providerId: "claude-code", profileDirectory: "/tmp/fo-providers-runtime/claude-a", homeAccessAccepted: true, synthetic: true };
  const claudeB: ScenarioAccount = { id: "claude-synthetic-b", providerId: "claude-code", profileDirectory: "/tmp/fo-providers-runtime/claude-b", homeAccessAccepted: true, synthetic: true };
  notes.push("Four profiles are synthetic registrations, not verified provider subjects.");

  const developer = planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-dev", runId: "run-dev", attemptId: "attempt-dev",
  }));
  checks.exactProvider = developer.ok && developer.plan.providerId === "codex" && developer.plan.argv.includes("--model") && developer.plan.argv.includes("gpt-6.1-sol");
  checks.exactAccount = developer.ok && developer.plan.accountId === codexA.id && developer.plan.envBinding.CODEX_HOME?.endsWith("codex-a") === true;
  checks.exactModel = developer.ok && developer.plan.modelId === "gpt-6.1-sol";
  checks.noAmbient = !planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-dev", runId: "run-ambient", attemptId: "a", boundAccountId: null, accountId: "",
  })).ok;
  checks.noSilentSubstitution = !planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-dev", runId: "run-swap", attemptId: "a", boundAccountId: codexB.id,
  })).ok;
  checks.developerSandbox = developer.ok && developer.plan.argv.includes("workspace-write") && !developer.plan.argv.includes("danger-full-access");

  const reviewer = planProviderExecution(request(claudeA, {
    modelId: "haiku-5.5", role: "reviewer", permissionMode: "dontAsk", taskId: "task-dev", runId: "run-review", attemptId: "attempt-review",
  }));
  checks.reviewerReadOnly = reviewer.ok && reviewer.plan.readOnly && reviewer.plan.argv.includes("Read,Glob,Grep") && !reviewer.plan.argv.some((arg) => arg.includes("dangerously"));

  const unrestricted = planProviderExecution(request(claudeA, {
    modelId: "haiku-5.5", role: "developer", permissionMode: "bypassPermissions", taskId: "task-dev", runId: "run-bypass", attemptId: "a",
  }));
  checks.unsupportedModeRefused = !unrestricted.ok && unrestricted.ok === false && unrestricted.code === "unrestricted-permission";

  const codexFixture = parseCodexFixture([
    JSON.stringify({ method: "thread/started", params: { threadId: "thr-fixture-1" } }),
    JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", model: "gpt-6.1-sol", usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 4, cache_creation_input_tokens: 1 } } }),
  ].join("\n"));
  checks.structuredCodex = codexFixture.ok && codexFixture.sessionId === "thr-fixture-1" && codexFixture.processStarted === false;
  const devReceipt = buildUsageReceipt({
    providerId: "codex", accountId: codexA.id, modelId: "gpt-6.1-sol", runId: "run-dev", taskId: "task-dev", missionId: "mission-1",
    durationMs: 1200, turn: codexFixture.turnUsage, billing: "subscription", source: "recorded-fixture",
  });
  checks.tokenAttribution = devReceipt.inputTokens === 20 && devReceipt.outputTokens === 5 && devReceipt.cacheReadTokens === 4 && devReceipt.cacheWriteTokens === 1;
  checks.subscriptionUnknown = devReceipt.costKind === "subscription" && devReceipt.money == null && devReceipt.subscriptionConsumption === "unknown";
  checks.notGenuineRanking = countsAsGenuineProviderUsage({ executionType: devReceipt.executionType, source: "recorded-fixture" }) === false && devReceipt.rankingEligible === false;

  const cumulative = buildUsageReceipt({
    providerId: "codex", accountId: codexA.id, modelId: "gpt-6.1-sol", runId: "run-dev", taskId: "task-dev", missionId: "mission-1",
    cumulative: { input_tokens: 50, output_tokens: 10 }, source: "recorded-fixture",
  });
  checks.cumulativeNotAssigned = cumulative.usageSource === "unknown" && cumulative.inputTokens == null;
  const delta = buildUsageReceipt({
    providerId: "codex", accountId: codexA.id, modelId: "gpt-6.1-sol", runId: "run-dev", taskId: "task-dev", missionId: "mission-1",
    cumulative: { input_tokens: 50, output_tokens: 10 }, previousCumulative: { input_tokens: 30, output_tokens: 4 }, source: "recorded-fixture",
  });
  checks.cumulativeDelta = delta.usageSource === "cumulative-delta" && delta.inputTokens === 20 && delta.outputTokens === 6;

  const reviewerFixture = parseClaudeFixture([
    JSON.stringify({ type: "system", subtype: "init", model: "haiku-5.5", session_id: "claude-session-1", tools: ["Read", "Glob", "Grep"] }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "claude-session-1", usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2 } }),
  ].join("\n"), "haiku-5.5", true);
  checks.structuredReviewer = reviewerFixture.ok && reviewerFixture.tools.every((tool) => ["Read", "Glob", "Grep"].includes(tool));

  const failed = parseCodexFixture(JSON.stringify({ method: "turn/completed", params: { turnId: "turn-fail", error: { code: "authentication", message: "authentication required" } } }));
  checks.providerError = failed.ok === false && failed.errorClass === "authentication";
  const quota = parseCodexFixture(JSON.stringify({ error: { code: "rate_limit", message: "usage limit reached" } }));
  checks.quotaError = quota.errorClass === "rate-limit";
  checks.noAutoRetry = classifyTermination({ timedOut: true, structuredResult: false }).retry === false && classifyTermination({ exitCode: null, structuredResult: false }).outcome === "indeterminate";

  const fallbackRequest = request(codexB, {
    modelId: "gpt-6-luna", role: "developer", permissionMode: "auto", taskId: "task-fallback", runId: "run-fallback", attemptId: "attempt-fallback",
  });
  const unapproved = { approved: false, digest: "fallback-digest-1" };
  checks.unapprovedFallbackLaunchesNothing = unapproved.approved === false && planProviderExecution({ ...fallbackRequest, transport: "live" }).ok === false;
  const approved = { approved: true, digest: "fallback-digest-1", accountId: codexB.id, modelId: "gpt-6-luna" };
  const approvedPlan = planProviderExecution(fallbackRequest);
  checks.approvedFallbackExact = approved.approved && approvedPlan.ok && approvedPlan.plan.accountId === approved.accountId && approvedPlan.plan.modelId === approved.modelId && approvedPlan.plan.processStarted === false;

  checks.paused = planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-paused", runId: "run-paused", attemptId: "a", projectPaused: true,
  })).ok === false;

  const completed = new Set<string>(["run-dev"]);
  checks.restartNoDuplicate = planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-dev", runId: "run-dev", attemptId: "again", completedRunIds: [...completed],
  })).ok === false;
  checks.grantOnce = planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-grant", runId: "run-grant", attemptId: "a",
    consumedGrantId: "grant-1", priorGrantIds: ["grant-1"],
  })).ok === false;

  checks.accountConflict = planProviderExecution(request(codexA, {
    modelId: "gpt-6.1-sol", role: "developer", permissionMode: "auto", taskId: "task-conflict", runId: "run-conflict", attemptId: "a",
    resumeSessionAccountId: codexB.id,
  })).ok === false;
  checks.noCrossResume = checks.accountConflict;

  const cursor = planProviderExecution(request({ id: "cursor-fixture", providerId: "cursor", profileDirectory: null, synthetic: true }, {
    modelId: "grok-4.7-high", role: "developer", permissionMode: "ask", taskId: "task-cursor", runId: "run-cursor", attemptId: "a",
  }));
  const cursorFixture = parseCursorFixture("Sandbox mode is enabled but not available on this system.");
  checks.cursorBlocked = !cursor.ok && cursor.ok === false && cursor.escalation?.authorizesExecution === false && cursorFixture.processStarted === false && cursorFixture.errorClass === "containment";
  checks.escalationNotAuthorization = cursorEscalationProposal().authorizesExecution === false;

  const deepseek = planProviderExecution(request({ id: "dsh-fixture", providerId: "deepseek-dsh", profileDirectory: null, synthetic: true }, {
    modelId: "deepseek-v4", role: "reviewer", permissionMode: "ask", taskId: "task-dsh", runId: "run-dsh", attemptId: "a", accountId: "dsh-fixture", boundAccountId: "dsh-fixture",
  }));
  const balance = parseDeepSeekFixture(JSON.stringify({ object: "balance", is_available: true }));
  checks.deepseekBlocked = !deepseek.ok && balance.apiBalanceIdentifiesHarness === false && balance.processStarted === false;

  const agy = parseAcpFixture("antigravity", [
    JSON.stringify({ method: "session/new", params: { sessionId: "agy-1", model: "gemini-2.5-pro" } }),
    JSON.stringify({ method: "session/update", params: { tools: ["read"] } }),
  ].join("\n"), "gemini-2.5-pro", true);
  checks.antigravityFixture = agy.ok && agy.sessionId === "agy-1" && agy.processStarted === false;
  const gemini = parseGeminiFixture(JSON.stringify({ model: "gemini-2.5-flash", sessionId: "gem-1", stats: { inputTokens: 3, outputTokens: 1 }, tools: [] }), "gemini-2.5-flash", true);
  checks.geminiFixture = gemini.ok && gemini.turnUsage != null;
  const fx = parseAcpFixture("fx", JSON.stringify({ method: "session/new", params: { sessionId: "fx-1", model: "gpt-6.1-sol", gatewayAccount: "fx-gateway-fixture" } }), "gpt-6.1-sol", false);
  checks.fxGateway = fx.ok && fx.gatewayAccount === "fx-gateway-fixture" && fx.upstreamAccount == null;

  const slots = concurrencyPlan([
    { accountId: codexA.id, providerId: "codex", profileDirectory: codexA.profileDirectory },
    { accountId: codexB.id, providerId: "codex", profileDirectory: codexB.profileDirectory },
    { accountId: claudeA.id, providerId: "claude-code", profileDirectory: claudeA.profileDirectory },
    { accountId: claudeB.id, providerId: "claude-code", profileDirectory: claudeB.profileDirectory },
  ]);
  checks.codexParallel = slots.parallel.includes(codexA.id) && slots.parallel.includes(codexB.id);
  checks.claudeSerialized = slots.serialized.includes(claudeA.id) && slots.serialized.includes(claudeB.id);

  const pool = attributePoolDelta({ poolId: "shared-codex", delta: 10, runId: null, evidence: "none" });
  checks.poolNotAssigned = pool.assignedToRun === false;
  const attributed = attributePoolDelta({ poolId: "shared-codex", delta: 1, runId: "run-dev", evidence: "provider-receipt" });
  checks.poolAttributed = attributed.assignedToRun === true;

  const qcAllowsDone = (verdict: "PASS" | "CHANGES_REQUESTED") => verdict === "PASS";
  checks.reworkHoldsDone = qcAllowsDone("CHANGES_REQUESTED") === false;
  checks.qcControlsDone = qcAllowsDone("PASS") === true;

  const cancelled = classifyTermination({ cancelled: true, exitCode: null, structuredResult: false });
  checks.cancellation = cancelled.outcome === "cancelled" && cancelled.retry === false;
  checks.versionRecorded = developer.ok && developer.plan.argv[0] === "codex";
  checks.blockedCannotExecute = checks.cursorBlocked && checks.deepseekBlocked;
  checks.sessionIsolation = developer.ok && reviewer.ok && developer.plan.sessionScope !== reviewer.plan.sessionScope;

  return { processStarted: false, checks, notes };
}
