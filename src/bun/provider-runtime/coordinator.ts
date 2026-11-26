/**
 * Recorded execution coordinator. It uses AccountCore binding when a database
 * is supplied and never spawns a provider CLI.
 */
import type { Database } from "bun:sqlite";
import { explainBinding, type BindingRequest } from "../multiaccount/binding.ts";
import { normalizeCodexQuotas } from "../codex-quota.ts";
import { planProviderExecution, type RuntimeExecutionRequest } from "../../shared/provider-runtime/negotiate.ts";
import { buildUsageReceipt, type ProviderUsageReceipt } from "../../shared/provider-runtime/receipts.ts";
import { interpretCodexRateLimit, parseAcpFixture, parseClaudeFixture, parseCodexFixture, parseCursorFixture, parseDeepSeekFixture, parseGeminiFixture, type ParsedTransport } from "../../shared/provider-runtime/transports.ts";

export interface RecordedRunInput {
  request: RuntimeExecutionRequest;
  fixture: string;
  binding?: BindingRequest;
  database?: Database;
  spawn?: () => void;
}

export interface RecordedRunResult {
  launched: false;
  processStarted: false;
  code: string;
  reason: string | null;
  receipt: ProviderUsageReceipt | null;
  transport: ParsedTransport | null;
  rateLimitRemainingRequests: null;
}

function transportFor(request: RuntimeExecutionRequest, fixture: string): ParsedTransport {
  if (request.providerId === "codex") return parseCodexFixture(fixture);
  if (request.providerId === "claude-code") return parseClaudeFixture(fixture, request.modelId, request.role === "reviewer");
  if (request.providerId === "cursor") return parseCursorFixture(fixture);
  if (request.providerId === "deepseek-dsh") return parseDeepSeekFixture(fixture);
  if (request.providerId === "gemini") return parseGeminiFixture(fixture, request.modelId, request.role === "reviewer");
  if (request.providerId === "antigravity" || request.providerId === "fx") return parseAcpFixture(request.providerId, fixture, request.modelId, request.role === "reviewer");
  return parseCursorFixture(fixture);
}

export function executeRecordedProviderRun(input: RecordedRunInput): RecordedRunResult {
  if (input.binding && input.database) {
    const bound = explainBinding(input.binding, input.database);
    if (!bound.ok) {
      return { launched: false, processStarted: false, code: "binding-refused", reason: bound.reason, receipt: null, transport: null, rateLimitRemainingRequests: null };
    }
  }
  const decision = planProviderExecution(input.request);
  if (!decision.ok) {
    return { launched: false, processStarted: false, code: decision.code, reason: decision.reason, receipt: null, transport: transportFor(input.request, input.fixture), rateLimitRemainingRequests: null };
  }
  const transport = transportFor(input.request, input.fixture);
  if (input.request.providerId === "codex" && transport.rateLimits) {
    const row = transport.rateLimits && typeof transport.rateLimits === "object" ? transport.rateLimits as Record<string, unknown> : null;
    const payload = row && (row.rateLimitsByLimitId || row.rateLimits) ? row : { rateLimitsByLimitId: row };
    try {
      const windows = normalizeCodexQuotas(payload, Date.now());
      for (const window of windows) {
        if (window.sample.remaining != null) {
          return { launched: false, processStarted: false, code: "quota-misread", reason: "A Codex percent window must not be stored as remaining requests.", receipt: null, transport, rateLimitRemainingRequests: null };
        }
      }
    } catch (error) {
      return { launched: false, processStarted: false, code: "quota-unreadable", reason: error instanceof Error ? error.message : "Codex rate-limit fixture could not be read.", receipt: null, transport, rateLimitRemainingRequests: null };
    }
    interpretCodexRateLimit(row);
  }
  if (!transport.ok) {
    return { launched: false, processStarted: false, code: transport.errorClass ?? "provider-error", reason: transport.message, receipt: null, transport, rateLimitRemainingRequests: null };
  }
  const receipt = buildUsageReceipt({
    providerId: input.request.providerId,
    accountId: input.request.accountId,
    modelId: input.request.modelId,
    runId: input.request.runId,
    taskId: input.request.taskId,
    missionId: input.request.missionId,
    turn: transport.turnUsage,
    cumulative: transport.cumulativeUsage,
    billing: "subscription",
    source: "recorded-fixture",
  });
  return { launched: false, processStarted: false, code: "fixture-parsed", reason: null, receipt, transport, rateLimitRemainingRequests: null };
}
