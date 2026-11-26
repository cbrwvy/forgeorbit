/**
 * Health checks. Each attempt has its own timeout; the batch also stops at a
 * deadline or when the caller aborts. HTTP 500 is a failure unless that status
 * is listed in `acceptedStatuses`. Targets are re-checked against the loopback
 * policy here so a probe cannot be aimed at an arbitrary host.
 */

import net from "node:net";

import { containersStopped } from "../../shared/environment/compose-ownership.ts";
import type { ComposeClassification, ComposeExpectation } from "../../shared/environment/compose-ownership.ts";
import { assertLoopbackHost, parseLoopbackHttpUrl } from "../../shared/environment/health-policy.ts";
import type { HealthCheck, HealthOutcome } from "../../shared/environment/types.ts";
import type { ComposeHost } from "./docker-compose.ts";

export interface HealthProbes {
  tcp(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<void>;
  http(url: string, method: "GET" | "HEAD", timeoutMs: number, signal: AbortSignal): Promise<{ status: number }>;
  processAlive(pid: number, signal: AbortSignal): Promise<boolean>;
  dockerService(service: string, signal: AbortSignal): Promise<{ state: string | null; detail: string }>;
}

export interface HealthRunInput {
  checks: readonly HealthCheck[];
  signal: AbortSignal;
  deadlineAt: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  probes: HealthProbes;
  pid: number | null;
}

export interface HealthRunResult {
  ok: boolean;
  code: "ok" | "health-failed" | "startup-timeout" | "cancelled";
  detail: string;
  outcomes: HealthOutcome[];
  degraded: boolean;
}

export async function runHealthChecks(input: HealthRunInput): Promise<HealthRunResult> {
  const outcomes: HealthOutcome[] = [];
  for (const check of input.checks) {
    if (input.signal.aborted) {
      return { ok: false, code: "cancelled", detail: "health check cancelled", outcomes, degraded: false };
    }
    if (input.now() >= input.deadlineAt) {
      return {
        ok: false,
        code: "startup-timeout",
        detail: `health check deadline exceeded before ${check.id}`,
        outcomes,
        degraded: false,
      };
    }
    const outcome = await runOne(check, input);
    outcomes.push(outcome);
    if (!outcome.ok && outcome.detail === "cancelled") {
      return { ok: false, code: "cancelled", detail: "health check cancelled", outcomes, degraded: false };
    }
  }
  const requiredFailed = outcomes.filter((outcome) => outcome.required && !outcome.ok);
  if (requiredFailed.length > 0) {
    return {
      ok: false,
      code: "health-failed",
      detail: requiredFailed.map((outcome) => `${outcome.id}: ${outcome.detail}`).join("; "),
      outcomes,
      degraded: false,
    };
  }
  const optionalFailed = outcomes.some((outcome) => !outcome.required && !outcome.ok);
  return { ok: true, code: "ok", detail: optionalFailed ? "optional checks failed" : "ok", outcomes, degraded: optionalFailed };
}

async function runOne(check: HealthCheck, input: HealthRunInput): Promise<HealthOutcome> {
  let lastDetail = "not checked";
  let attempts = 0;
  for (let attempt = 1; attempt <= check.maxAttempts; attempt++) {
    if (input.signal.aborted) {
      return { id: check.id, ok: false, required: check.required, detail: "cancelled", attempts };
    }
    if (input.now() >= input.deadlineAt) {
      return { id: check.id, ok: false, required: check.required, detail: "deadline exceeded", attempts };
    }
    attempts = attempt;
    try {
      const result = await attemptCheck(check, input);
      if (result.ok) {
        return { id: check.id, ok: true, required: check.required, detail: result.detail, attempts };
      }
      lastDetail = result.detail;
    } catch (error) {
      if (input.signal.aborted) {
        return { id: check.id, ok: false, required: check.required, detail: "cancelled", attempts };
      }
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt < check.maxAttempts) {
      const remaining = input.deadlineAt - input.now();
      if (remaining <= 0) break;
      await input.sleep(Math.min(check.intervalMs, remaining), input.signal);
    }
  }
  return { id: check.id, ok: false, required: check.required, detail: lastDetail, attempts };
}

async function attemptCheck(check: HealthCheck, input: HealthRunInput): Promise<{ ok: boolean; detail: string }> {
  if (check.kind === "tcp") {
    const hostError = assertLoopbackHost(check.host);
    if (hostError) return { ok: false, detail: hostError };
    await input.probes.tcp(check.host, check.port, check.timeoutMs, input.signal);
    return { ok: true, detail: `${check.host}:${check.port} accepted a connection` };
  }
  if (check.kind === "http") {
    const parsed = parseLoopbackHttpUrl(check.url);
    if (!parsed.ok) return { ok: false, detail: parsed.error };
    const response = await input.probes.http(parsed.target.href, check.method, check.timeoutMs, input.signal);
    if (!check.acceptedStatuses.includes(response.status)) {
      return { ok: false, detail: `HTTP ${response.status} from ${parsed.target.href}` };
    }
    return { ok: true, detail: `HTTP ${response.status}` };
  }
  if (check.kind === "process-alive") {
    if (input.pid === null) return { ok: false, detail: "no process id is recorded" };
    const alive = await input.probes.processAlive(input.pid, input.signal);
    return alive
      ? { ok: true, detail: `pid ${input.pid} is alive` }
      : { ok: false, detail: `pid ${input.pid} is not alive` };
  }
  const service = await input.probes.dockerService(check.service, input.signal);
  if (service.state !== "running") {
    return { ok: false, detail: service.detail || `service ${check.service} is ${service.state ?? "missing"}` };
  }
  return { ok: true, detail: service.detail || `service ${check.service} is running` };
}

export function createDefaultHealthProbes(): Pick<HealthProbes, "tcp" | "http"> {
  return {
    tcp(host, port, timeoutMs, signal) {
      return tcpConnect(host, port, timeoutMs, signal);
    },
    http(url, method, timeoutMs, signal) {
      return httpStatus(url, method, timeoutMs, signal);
    },
  };
}

export function tcpConnect(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const blocked = assertLoopbackHost(host);
  if (blocked) return Promise.reject(new Error(blocked));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => finish(new Error(`tcp timeout after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => finish(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish(null));
    socket.once("error", (error: Error) => finish(error));
    function finish(error: Error | null): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
  });
}

export async function httpStatus(
  url: string,
  method: "GET" | "HEAD",
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ status: number }> {
  const parsed = parseLoopbackHttpUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(parsed.target.href, { method, signal: combined, redirect: "manual" });
  } catch (error) {
    if (signal.aborted) throw new Error("cancelled");
    throw error;
  }
  return { status: response.status };
}

export function dockerServiceFromClassification(
  classification: ComposeClassification | { kind: "docker-error"; detail: string },
  service: string,
): { state: string | null; detail: string } {
  if (classification.kind === "docker-error") return { state: null, detail: classification.detail };
  if (classification.kind === "absent") return { state: null, detail: `service ${service} has no container` };
  if (classification.kind !== "managed" && classification.kind !== "external") {
    return { state: null, detail: classification.detail };
  }
  const containers = classification.containers.filter((container) => container.service === service);
  const container = containers[0];
  if (!container) return { state: null, detail: `service ${service} has no container` };
  if (containersStopped([container])) return { state: container.state, detail: `service ${service} is ${container.state}` };
  return { state: container.state, detail: `service ${service} is ${container.state}` };
}

export function expectationFor(
  profileId: string,
  token: string | null,
  projectName: string,
  composeFile: string,
  workingDir: string,
  recordedIds: readonly string[],
  tokenApplied: boolean,
): ComposeExpectation {
  return { profileId, token, projectName, composeFile, workingDir, recordedIds, tokenApplied };
}

/** Used by the manager so a docker-service probe reads the compose host. */
export function composeProbe(host: ComposeHost, expected: ComposeExpectation): HealthProbes["dockerService"] {
  return async (service) => {
    const view = await host.inspect(expected);
    return dockerServiceFromClassification(view, service);
  };
}
