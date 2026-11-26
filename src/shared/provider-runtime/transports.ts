/**
 * Recorded protocol parsers. They do not open a socket, spawn a CLI, or
 * redeem credits. A fixture account is a synthetic registration.
 */
import { DEEPSEEK_SURFACES } from "./contract.ts";
import { classifyProviderError, tokensFromReport, type ProviderErrorClass } from "./receipts.ts";

export interface ParsedTransport {
  providerId: string;
  sessionId: string | null;
  turnId: string | null;
  modelId: string | null;
  ok: boolean;
  errorClass: ProviderErrorClass | null;
  message: string | null;
  turnUsage: unknown;
  cumulativeUsage: unknown;
  rateLimits: unknown;
  gatewayAccount: string | null;
  upstreamAccount: string | null;
  tools: string[];
  redeemedCredits: false;
  processStarted: false;
}

function linesOf(fixture: string): unknown[] {
  return fixture.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { parseError: true, raw: line.slice(0, 120) }; }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseCodexFixture(fixture: string): ParsedTransport {
  const parsed: ParsedTransport = {
    providerId: "codex", sessionId: null, turnId: null, modelId: null, ok: false, errorClass: null, message: null,
    turnUsage: null, cumulativeUsage: null, rateLimits: null, gatewayAccount: null, upstreamAccount: null, tools: [],
    redeemedCredits: false, processStarted: false,
  };
  for (const row of linesOf(fixture)) {
    const message = asRecord(row);
    if (!message) continue;
    if (message.method === "account/rateLimits/redeem" || message.method === "credits/redeem") {
      parsed.ok = false;
      parsed.errorClass = "permission-denied";
      parsed.message = "Earned reset credits are not redeemed.";
      return parsed;
    }
    const method = typeof message.method === "string" ? message.method : "";
    const params = asRecord(message.params) ?? asRecord(message.result) ?? {};
    if (method === "thread/started" || method === "thread/start") parsed.sessionId = typeof params.threadId === "string" ? params.threadId : parsed.sessionId;
    if (method === "turn/completed" || method === "turn/start") {
      parsed.turnId = typeof params.turnId === "string" ? params.turnId : parsed.turnId;
      parsed.modelId = typeof params.model === "string" ? params.model : parsed.modelId;
      if (params.usage) parsed.turnUsage = params.usage;
      if (params.cumulativeUsage) parsed.cumulativeUsage = params.cumulativeUsage;
      if (params.error) {
        const error = asRecord(params.error);
        parsed.errorClass = classifyProviderError({ code: String(error?.code ?? ""), message: String(error?.message ?? "") });
        parsed.message = typeof error?.message === "string" ? error.message : "Codex turn failed.";
      }
    }
    if (method === "account/rateLimits/read" || params.rateLimits || params.rateLimitsByLimitId) {
      parsed.rateLimits = params.rateLimitsByLimitId ?? params.rateLimits ?? message.result;
    }
    const error = asRecord(message.error);
    if (error) {
      parsed.errorClass = classifyProviderError({ code: String(error.code ?? ""), message: String(error.message ?? "") });
      parsed.message = typeof error.message === "string" ? error.message : parsed.message;
    }
  }
  const tokens = tokensFromReport({ turn: parsed.turnUsage, cumulative: parsed.cumulativeUsage });
  parsed.ok = parsed.errorClass == null && (parsed.turnId != null || tokens.usageSource === "provider-turn");
  if (!parsed.ok && !parsed.errorClass) parsed.errorClass = "unknown";
  return parsed;
}

/** usedPercent is not a remaining-request count. */
export function interpretCodexRateLimit(bucket: unknown): { limitId: string | null; usedPercent: number | null; windowMins: number | null; resetsAt: number | null; remainingRequests: null } {
  const row = asRecord(bucket);
  const primary = asRecord(row?.primary);
  const percent = primary && typeof primary.usedPercent === "number" ? primary.usedPercent : null;
  return {
    limitId: typeof row?.limitId === "string" ? row.limitId : null,
    usedPercent: percent,
    windowMins: primary && typeof primary.windowDurationMins === "number" ? primary.windowDurationMins : null,
    resetsAt: primary && typeof primary.resetsAt === "number" ? primary.resetsAt : null,
    remainingRequests: null,
  };
}

export function parseClaudeFixture(fixture: string, expectedModel: string, readOnly: boolean): ParsedTransport {
  const parsed: ParsedTransport = {
    providerId: "claude-code", sessionId: null, turnId: null, modelId: null, ok: false, errorClass: null, message: null,
    turnUsage: null, cumulativeUsage: null, rateLimits: null, gatewayAccount: null, upstreamAccount: null, tools: [],
    redeemedCredits: false, processStarted: false,
  };
  const allowed = new Set(readOnly ? ["Read", "Glob", "Grep"] : ["Read", "Glob", "Grep", "Edit", "Write"]);
  for (const row of linesOf(fixture)) {
    const event = asRecord(row);
    if (!event) continue;
    if (event.type === "system" && event.subtype === "init") {
      parsed.sessionId = typeof event.session_id === "string" ? event.session_id : parsed.sessionId;
      parsed.modelId = typeof event.model === "string" ? event.model : parsed.modelId;
      if (Array.isArray(event.tools)) parsed.tools = event.tools.filter((tool): tool is string => typeof tool === "string");
    }
    if (event.type === "assistant") {
      const message = asRecord(event.message);
      if (typeof message?.model === "string") parsed.modelId = message.model;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const item = asRecord(block);
        if (item?.type === "tool_use" && typeof item.name === "string") parsed.tools.push(item.name);
      }
      if (message?.usage) parsed.turnUsage = message.usage;
    }
    if (event.type === "result") {
      parsed.turnId = typeof event.session_id === "string" ? event.session_id : parsed.turnId;
      if (event.usage) parsed.turnUsage = event.usage;
      if (event.is_error === true) {
        parsed.errorClass = classifyProviderError({ message: String(event.result ?? event.error ?? "") });
        parsed.message = typeof event.result === "string" ? event.result : "Claude result failed.";
      }
    }
  }
  if (parsed.modelId && parsed.modelId !== expectedModel) {
    parsed.errorClass = "unsupported-model";
    parsed.message = "The fixture model does not match the requested model.";
  }
  if (parsed.tools.some((tool) => !allowed.has(tool))) {
    parsed.errorClass = "permission-denied";
    parsed.message = readOnly ? "Reviewer fixture used a tool outside the read-only set." : "Developer fixture used a tool outside the bounded set.";
  }
  parsed.ok = parsed.errorClass == null && parsed.modelId === expectedModel;
  return parsed;
}

export function parseCursorFixture(fixture: string): ParsedTransport {
  const text = fixture.toLowerCase();
  const sandbox = /sandbox mode is enabled but not available|sandbox_apply|operation not permitted/.test(text);
  return {
    providerId: "cursor", sessionId: null, turnId: null, modelId: null, ok: false,
    errorClass: sandbox ? "containment" : "unknown",
    message: sandbox ? "Cursor sandbox startup failed. No model request was sent." : "Cursor fixture did not establish a compatible startup.",
    turnUsage: null, cumulativeUsage: null, rateLimits: null, gatewayAccount: null, upstreamAccount: null, tools: [],
    redeemedCredits: false, processStarted: false,
  };
}

export function parseDeepSeekFixture(fixture: string): ParsedTransport & { apiBalanceIdentifiesHarness: false } {
  const row = asRecord(linesOf(fixture)[0]);
  const isApiBalance = row?.object === "balance" || typeof row?.is_available === "boolean";
  return {
    providerId: isApiBalance ? "deepseek-api" : "deepseek-dsh",
    sessionId: null, turnId: null, modelId: null, ok: false, errorClass: "containment",
    message: isApiBalance ? DEEPSEEK_SURFACES.api.note : DEEPSEEK_SURFACES.harness.note,
    turnUsage: null, cumulativeUsage: null, rateLimits: null, gatewayAccount: null, upstreamAccount: null, tools: [],
    redeemedCredits: false, processStarted: false, apiBalanceIdentifiesHarness: false,
  };
}

export function parseAcpFixture(providerId: "antigravity" | "fx", fixture: string, expectedModel: string, readOnly: boolean): ParsedTransport {
  const parsed: ParsedTransport = {
    providerId, sessionId: null, turnId: null, modelId: null, ok: false, errorClass: null, message: null,
    turnUsage: null, cumulativeUsage: null, rateLimits: null, gatewayAccount: null, upstreamAccount: null, tools: [],
    redeemedCredits: false, processStarted: false,
  };
  for (const row of linesOf(fixture)) {
    const message = asRecord(row);
    if (!message) continue;
    const method = typeof message.method === "string" ? message.method : "";
    const params = asRecord(message.params) ?? asRecord(message.result) ?? {};
    if (method === "session/new" || method === "session/update") {
      parsed.sessionId = typeof params.sessionId === "string" ? params.sessionId : parsed.sessionId;
      parsed.modelId = typeof params.model === "string" ? params.model : parsed.modelId;
    }
    if (method === "session/cancel") parsed.errorClass = parsed.errorClass ?? "cancelled";
    if (typeof params.gatewayAccount === "string") parsed.gatewayAccount = params.gatewayAccount;
    if (typeof params.upstreamAccount === "string") parsed.upstreamAccount = params.upstreamAccount;
    if (Array.isArray(params.tools)) parsed.tools.push(...params.tools.filter((tool): tool is string => typeof tool === "string"));
    if (params.usage) parsed.turnUsage = params.usage;
    const error = asRecord(message.error);
    if (error) {
      parsed.errorClass = classifyProviderError({ message: String(error.message ?? "") });
      parsed.message = typeof error.message === "string" ? error.message : parsed.message;
    }
  }
  if (parsed.modelId && parsed.modelId !== expectedModel) {
    parsed.errorClass = "unsupported-model";
    parsed.message = "ACP model does not match the requested model.";
  }
  if (readOnly && parsed.tools.some((tool) => /write|edit|shell|exec/i.test(tool))) {
    parsed.errorClass = "permission-denied";
    parsed.message = "Reviewer ACP fixture requested a write tool.";
  }
  if (providerId === "fx" && parsed.upstreamAccount == null) parsed.message = parsed.message ?? "Upstream provider account is Unknown. The gateway account is not that subject.";
  parsed.ok = parsed.errorClass == null && parsed.sessionId != null && parsed.modelId === expectedModel;
  return parsed;
}

export function parseGeminiFixture(fixture: string, expectedModel: string, readOnly: boolean): ParsedTransport {
  const row = asRecord(linesOf(fixture)[0]);
  const stats = asRecord(row?.stats);
  const error = asRecord(row?.error);
  const tools = Array.isArray(row?.tools) ? row.tools.filter((tool): tool is string => typeof tool === "string") : [];
  const modelId = typeof row?.model === "string" ? row.model : null;
  let errorClass: ProviderErrorClass | null = error ? classifyProviderError({ message: String(error.message ?? "") }) : null;
  let message = error && typeof error.message === "string" ? error.message : null;
  if (modelId && modelId !== expectedModel) {
    errorClass = "unsupported-model";
    message = "Gemini fixture model does not match the requested model.";
  }
  if (readOnly && tools.some((tool) => /write|edit|shell/i.test(tool))) {
    errorClass = "permission-denied";
    message = "Reviewer Gemini fixture requested a write tool.";
  }
  return {
    providerId: "gemini",
    sessionId: typeof row?.sessionId === "string" ? row.sessionId : null,
    turnId: typeof row?.turnId === "string" ? row.turnId : null,
    modelId, ok: errorClass == null && modelId === expectedModel, errorClass, message,
    turnUsage: stats, cumulativeUsage: null, rateLimits: null, gatewayAccount: null, upstreamAccount: null, tools,
    redeemedCredits: false, processStarted: false,
  };
}
