/**
 * Validate a launch profile before anything is spawned.
 *
 * The input is `unknown` on purpose: the future HTTP route and a hand-edited
 * config file both land here, and a typed object from a test does too. The
 * returned profile is the only shape the manager will store.
 */

import { commandRejection } from "./command.ts";
import { assertLoopbackHost, parseLoopbackHttpUrl } from "./health-policy.ts";
import type {
  DockerComposeLaunch,
  EnvBinding,
  EnvironmentKind,
  EnvironmentUrl,
  HealthCheck,
  LaunchProfile,
  LocalProcessLaunch,
  PortExpectation,
  StopStrategy,
  UrlRole,
} from "./types.ts";
import { URL_ROLES } from "./types.ts";

export const ENV_LIMITS = {
  name: 120,
  id: 64,
  startupTimeoutMin: 100,
  startupTimeoutMax: 10 * 60 * 1000,
  shutdownTimeoutMin: 100,
  shutdownTimeoutMax: 120_000,
  healthTimeoutMin: 50,
  healthTimeoutMax: 60_000,
  healthIntervalMax: 60_000,
  healthAttemptsMax: 100,
  envValue: 16 * 1024,
  servicesMax: 30,
  checksMax: 20,
  urlsMax: 20,
  argsMax: 64,
  argLength: 4096,
} as const;

/** Statuses a check accepts when the profile does not say otherwise. 5xx is not in this list. */
export const DEFAULT_HTTP_OK_STATUSES = [200, 201, 202, 203, 204, 206] as const;

export const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_ENV_NAMES = new Set([
  "FORGEORBIT_ENV_ID",
  "FORGEORBIT_ENV_TOKEN",
  "FORGEORBIT_ENV_PROFILE",
]);

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ProfileValidation =
  | { ok: true; profile: LaunchProfile; warnings: string[] }
  | { ok: false; errors: ValidationIssue[] };

export function validateLaunchProfile(input: unknown): ProfileValidation {
  const errors: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "profile must be an object" }] };
  }

  const id = requireString(input, "id", errors);
  if (id !== null && !PROFILE_ID_PATTERN.test(id)) {
    errors.push({ path: "id", message: "id must be 1–64 letters, digits, '_' or '-'" });
  }

  const name = typeof input.name === "string" ? input.name.trim() : null;
  if (name === null || name.length === 0 || name.length > ENV_LIMITS.name || /[\u0000-\u001f]/.test(name)) {
    errors.push({ path: "name", message: "name must be 1–120 characters without control characters" });
  }

  const projectPath = requireAbsolutePath(input.projectPath, "projectPath", errors);
  const cwd = requireAbsolutePath(input.cwd, "cwd", errors);
  if (projectPath && cwd && !isLexicalInside(projectPath, cwd)) {
    errors.push({ path: "cwd", message: "cwd must stay inside projectPath" });
  }

  const launch = readLaunch(input.launch, errors);
  const stop = readStop(input.stop, launch?.kind ?? null, errors);
  const startupTimeoutMs = requireTimeout(
    input.startupTimeoutMs,
    "startupTimeoutMs",
    ENV_LIMITS.startupTimeoutMin,
    ENV_LIMITS.startupTimeoutMax,
    errors,
  );
  const shutdownTimeoutMs = requireTimeout(
    input.shutdownTimeoutMs,
    "shutdownTimeoutMs",
    ENV_LIMITS.shutdownTimeoutMin,
    ENV_LIMITS.shutdownTimeoutMax,
    errors,
  );

  const expectedPorts = readPorts(input.expectedPorts, errors);
  const healthChecks = readHealthChecks(input.healthChecks, errors);
  const urls = readUrls(input.urls, healthChecks, errors);
  const env = readEnv(input.env, errors);

  if (launch?.kind === "docker-compose") {
    const known = new Set(launch.services);
    for (const check of healthChecks) {
      if (check.kind === "docker-service" && known.size > 0 && !known.has(check.service)) {
        errors.push({
          path: `healthChecks.${check.id}.service`,
          message: `service ${check.service} is not in the profile's service list`,
        });
      }
    }
  }
  if (launch?.kind === "local-process") {
    for (const check of healthChecks) {
      if (check.kind === "docker-service") {
        errors.push({
          path: `healthChecks.${check.id}`,
          message: "docker-service checks belong on a docker-compose profile",
        });
      }
    }
  }

  if (errors.length > 0 || !launch || !stop || !projectPath || !cwd || !name || !id) {
    return { ok: false, errors };
  }
  if (startupTimeoutMs === null || shutdownTimeoutMs === null) {
    return { ok: false, errors };
  }

  const warnings: string[] = [];
  for (const port of expectedPorts) {
    const covered = healthChecks.some((check) => {
      if (check.kind === "tcp") return check.port === port.port && check.host === port.host;
      if (check.kind === "http") {
        const parsed = parseLoopbackHttpUrl(check.url);
        return parsed.ok && parsed.target.port === port.port;
      }
      return false;
    });
    if (!covered) {
      warnings.push(`expected port ${port.host}:${port.port} has no tcp or http health check`);
    }
  }

  const profile: LaunchProfile = {
    id,
    projectPath,
    name,
    cwd,
    launch,
    stop,
    expectedPorts,
    healthChecks,
    urls,
    startupTimeoutMs,
    shutdownTimeoutMs,
    env,
  };
  return { ok: true, profile, warnings };
}

function readLaunch(value: unknown, errors: ValidationIssue[]): LaunchProfile["launch"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push({ path: "launch", message: "launch.kind is required" });
    return null;
  }
  if (value.kind === "local-process") return readLocalLaunch(value, errors);
  if (value.kind === "docker-compose") return readComposeLaunch(value, errors);
  errors.push({
    path: "launch.kind",
    message: `kind ${value.kind} is not implemented (supported: local-process, docker-compose)`,
  });
  return null;
}

function readLocalLaunch(value: Record<string, unknown>, errors: ValidationIssue[]): LocalProcessLaunch | null {
  const command = value.command;
  if (!isRecord(command) || typeof command.executable !== "string" || !Array.isArray(command.args)) {
    errors.push({ path: "launch.command", message: "local-process launch requires { executable, args }" });
    return null;
  }
  const args = command.args.filter((arg): arg is string => typeof arg === "string");
  if (args.length !== command.args.length) {
    errors.push({ path: "launch.command.args", message: "every argument must be a string" });
  }
  if (args.length > ENV_LIMITS.argsMax || args.some((arg) => arg.length > ENV_LIMITS.argLength)) {
    errors.push({ path: "launch.command.args", message: "too many arguments or an argument is too long" });
  }
  const rejection = commandRejection(command.executable, args);
  if (rejection) errors.push({ path: "launch.command", message: rejection });
  if (errors.some((issue) => issue.path.startsWith("launch.command"))) return null;
  return { kind: "local-process", command: { executable: command.executable, args: [...args] } };
}

function readComposeLaunch(value: Record<string, unknown>, errors: ValidationIssue[]): DockerComposeLaunch | null {
  const composeFile = typeof value.composeFile === "string" ? value.composeFile : null;
  if (composeFile === null || !isSafeRelativeFile(composeFile)) {
    errors.push({
      path: "launch.composeFile",
      message: "composeFile must be a relative path inside the working directory",
    });
  }
  const projectName = typeof value.projectName === "string" ? value.projectName : null;
  if (projectName === null || !COMPOSE_PROJECT_PATTERN.test(projectName)) {
    errors.push({
      path: "launch.projectName",
      message: "projectName is required and must be a lowercase compose project name",
    });
  }
  const services: string[] = [];
  if (value.services !== undefined) {
    if (!Array.isArray(value.services)) {
      errors.push({ path: "launch.services", message: "services must be an array" });
    } else if (value.services.length > ENV_LIMITS.servicesMax) {
      errors.push({ path: "launch.services", message: "too many services" });
    } else {
      for (const service of value.services) {
        if (typeof service !== "string" || !SERVICE_NAME_PATTERN.test(service)) {
          errors.push({ path: "launch.services", message: "invalid service name" });
          break;
        }
        services.push(service);
      }
    }
  }
  if (composeFile === null || projectName === null || !isSafeRelativeFile(composeFile) || !COMPOSE_PROJECT_PATTERN.test(projectName)) {
    return null;
  }
  if (errors.some((issue) => issue.path.startsWith("launch.services"))) return null;
  return { kind: "docker-compose", composeFile, projectName, services };
}

function readStop(value: unknown, kind: EnvironmentKind | null, errors: ValidationIssue[]): StopStrategy | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push({ path: "stop", message: "stop strategy is required" });
    return null;
  }
  if (value.kind === "compose-stop") {
    if (kind !== null && kind !== "docker-compose") {
      errors.push({ path: "stop", message: "compose-stop is only valid for docker-compose" });
      return null;
    }
    return { kind: "compose-stop" };
  }
  if (value.kind === "signal") {
    if (kind !== null && kind !== "local-process") {
      errors.push({ path: "stop", message: "signal stop is only valid for a local process" });
      return null;
    }
    const signal = value.signal === "SIGINT" ? "SIGINT" : value.signal === "SIGTERM" ? "SIGTERM" : null;
    if (signal === null) {
      errors.push({ path: "stop.signal", message: "signal must be SIGTERM or SIGINT" });
    }
    const graceMs = requireTimeout(value.graceMs, "stop.graceMs", ENV_LIMITS.shutdownTimeoutMin, ENV_LIMITS.shutdownTimeoutMax, errors);
    if (typeof value.killAfterGrace !== "boolean" || typeof value.processGroup !== "boolean") {
      errors.push({ path: "stop", message: "killAfterGrace and processGroup must be booleans" });
    }
    if (signal === null || graceMs === null || typeof value.killAfterGrace !== "boolean" || typeof value.processGroup !== "boolean") {
      return null;
    }
    return { kind: "signal", signal, graceMs, killAfterGrace: value.killAfterGrace, processGroup: value.processGroup };
  }
  errors.push({ path: "stop.kind", message: `unknown stop strategy ${value.kind}` });
  return null;
}

function readPorts(value: unknown, errors: ValidationIssue[]): PortExpectation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path: "expectedPorts", message: "expectedPorts must be an array" });
    return [];
  }
  const ports: PortExpectation[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!isRecord(entry) || typeof entry.port !== "number" || !isPort(entry.port)) {
      errors.push({ path: `expectedPorts.${index}`, message: "port must be an integer from 1 to 65535" });
      continue;
    }
    const host = entry.host === undefined ? "127.0.0.1" : entry.host;
    if (typeof host !== "string" || assertLoopbackHost(host)) {
      errors.push({ path: `expectedPorts.${index}.host`, message: "expected ports must be on loopback" });
      continue;
    }
    ports.push({ host, port: entry.port });
  }
  return ports;
}

function readHealthChecks(value: unknown, errors: ValidationIssue[]): HealthCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path: "healthChecks", message: "healthChecks must be an array" });
    return [];
  }
  if (value.length > ENV_LIMITS.checksMax) {
    errors.push({ path: "healthChecks", message: "too many health checks" });
    return [];
  }
  const checks: HealthCheck[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const path = `healthChecks.${index}`;
    if (!isRecord(entry) || typeof entry.kind !== "string") {
      errors.push({ path, message: "health check must be an object with a kind" });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!PROFILE_ID_PATTERN.test(id)) {
      errors.push({ path: `${path}.id`, message: "health check id is invalid" });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ path: `${path}.id`, message: `duplicate health check id ${id}` });
      continue;
    }
    seen.add(id);
    const timing = readTiming(entry, path, errors);
    if (!timing) continue;
    const required = entry.required === undefined ? true : entry.required;
    if (typeof required !== "boolean") {
      errors.push({ path: `${path}.required`, message: "required must be a boolean" });
      continue;
    }
    if (entry.kind === "tcp") {
      const host = typeof entry.host === "string" ? entry.host : "";
      const port = entry.port;
      if (assertLoopbackHost(host) || typeof port !== "number" || !isPort(port)) {
        errors.push({ path, message: "tcp check needs a loopback host and a valid port" });
        continue;
      }
      checks.push({ id, kind: "tcp", host, port, ...timing, required });
      continue;
    }
    if (entry.kind === "http") {
      if (typeof entry.url !== "string") {
        errors.push({ path: `${path}.url`, message: "http check requires a url" });
        continue;
      }
      const parsed = parseLoopbackHttpUrl(entry.url);
      if (!parsed.ok) {
        errors.push({ path: `${path}.url`, message: parsed.error });
        continue;
      }
      const method = entry.method === undefined ? "GET" : entry.method;
      if (method !== "GET" && method !== "HEAD") {
        errors.push({ path: `${path}.method`, message: "http method must be GET or HEAD" });
        continue;
      }
      const accepted = readAcceptedStatuses(entry.acceptedStatuses, path, errors);
      if (!accepted) continue;
      checks.push({
        id,
        kind: "http",
        url: parsed.target.href,
        method,
        acceptedStatuses: accepted,
        ...timing,
        required,
      });
      continue;
    }
    if (entry.kind === "process-alive") {
      checks.push({ id, kind: "process-alive", ...timing, required });
      continue;
    }
    if (entry.kind === "docker-service") {
      const service = typeof entry.service === "string" ? entry.service : "";
      if (!SERVICE_NAME_PATTERN.test(service)) {
        errors.push({ path: `${path}.service`, message: "docker-service check needs a service name" });
        continue;
      }
      checks.push({ id, kind: "docker-service", service, ...timing, required });
      continue;
    }
    errors.push({ path: `${path}.kind`, message: `unknown health check kind ${entry.kind}` });
  }
  return checks;
}

function readAcceptedStatuses(value: unknown, path: string, errors: ValidationIssue[]): number[] | null {
  if (value === undefined) return [...DEFAULT_HTTP_OK_STATUSES];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: `${path}.acceptedStatuses`, message: "acceptedStatuses must be a non-empty list" });
    return null;
  }
  const statuses: number[] = [];
  for (const status of value) {
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      errors.push({ path: `${path}.acceptedStatuses`, message: "HTTP statuses must be integers from 100 to 599" });
      return null;
    }
    if (!statuses.includes(status)) statuses.push(status);
  }
  return statuses;
}

function readTiming(
  entry: Record<string, unknown>,
  path: string,
  errors: ValidationIssue[],
): { timeoutMs: number; intervalMs: number; maxAttempts: number } | null {
  const timeoutMs = requireTimeout(entry.timeoutMs, `${path}.timeoutMs`, ENV_LIMITS.healthTimeoutMin, ENV_LIMITS.healthTimeoutMax, errors);
  const intervalMs = requireTimeout(entry.intervalMs, `${path}.intervalMs`, 0, ENV_LIMITS.healthIntervalMax, errors);
  const maxAttempts = entry.maxAttempts;
  if (
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > ENV_LIMITS.healthAttemptsMax
  ) {
    errors.push({ path: `${path}.maxAttempts`, message: "maxAttempts must be an integer from 1 to 100" });
    return null;
  }
  if (timeoutMs === null || intervalMs === null) return null;
  return { timeoutMs, intervalMs, maxAttempts };
}

function readUrls(
  value: unknown,
  checks: readonly HealthCheck[],
  errors: ValidationIssue[],
): EnvironmentUrl[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path: "urls", message: "urls must be an array" });
    return [];
  }
  if (value.length > ENV_LIMITS.urlsMax) {
    errors.push({ path: "urls", message: "too many urls" });
    return [];
  }
  const checkIds = new Set(checks.map((check) => check.id));
  const urls: EnvironmentUrl[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const path = `urls.${index}`;
    if (!isRecord(entry)) {
      errors.push({ path, message: "url must be an object" });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!PROFILE_ID_PATTERN.test(id) || seen.has(id)) {
      errors.push({ path: `${path}.id`, message: "url id is missing, invalid, or duplicated" });
      continue;
    }
    seen.add(id);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0 || name.length > ENV_LIMITS.name) {
      errors.push({ path: `${path}.name`, message: "url name is required" });
      continue;
    }
    const role = entry.role;
    if (typeof role !== "string" || !(URL_ROLES as readonly string[]).includes(role)) {
      errors.push({ path: `${path}.role`, message: "url role is invalid" });
      continue;
    }
    if (typeof entry.url !== "string") {
      errors.push({ path: `${path}.url`, message: "url is required" });
      continue;
    }
    const parsed = parseLoopbackHttpUrl(entry.url);
    if (!parsed.ok) {
      errors.push({ path: `${path}.url`, message: parsed.error });
      continue;
    }
    let healthCheckId: string | null = null;
    if (entry.healthCheckId !== undefined && entry.healthCheckId !== null) {
      if (typeof entry.healthCheckId !== "string" || !checkIds.has(entry.healthCheckId)) {
        errors.push({ path: `${path}.healthCheckId`, message: "healthCheckId does not match a health check" });
        continue;
      }
      healthCheckId = entry.healthCheckId;
    }
    const optional = entry.optional === undefined ? false : entry.optional;
    if (typeof optional !== "boolean") {
      errors.push({ path: `${path}.optional`, message: "optional must be a boolean" });
      continue;
    }
    urls.push({ id, name, role: role as UrlRole, url: parsed.target.href, healthCheckId, optional });
  }
  return urls;
}

function readEnv(value: unknown, errors: ValidationIssue[]): EnvBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path: "env", message: "env must be an array" });
    return [];
  }
  const bindings: EnvBinding[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!isRecord(entry) || typeof entry.name !== "string" || (entry.from !== "literal" && entry.from !== "inherit")) {
      errors.push({ path: `env.${index}`, message: "env entry must be { name, from: 'literal' | 'inherit' }" });
      continue;
    }
    if (!ENV_NAME_PATTERN.test(entry.name) || RESERVED_ENV_NAMES.has(entry.name)) {
      errors.push({ path: `env.${index}.name`, message: "env name is invalid or reserved" });
      continue;
    }
    if (seen.has(entry.name)) {
      errors.push({ path: `env.${index}.name`, message: "duplicate env name" });
      continue;
    }
    seen.add(entry.name);
    if (entry.from === "inherit") {
      bindings.push({ name: entry.name, from: "inherit" });
      continue;
    }
    if (typeof entry.value !== "string" || entry.value.includes("\0") || entry.value.length > ENV_LIMITS.envValue) {
      errors.push({ path: `env.${index}.value`, message: "literal env value is missing or too large" });
      continue;
    }
    bindings.push({ name: entry.name, from: "literal", value: entry.value });
  }
  return bindings;
}

function requireString(record: Record<string, unknown>, key: string, errors: ValidationIssue[]): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    errors.push({ path: key, message: `${key} is required` });
    return null;
  }
  return value;
}

function requireAbsolutePath(value: unknown, path: string, errors: ValidationIssue[]): string | null {
  if (typeof value !== "string" || value.length === 0) {
    errors.push({ path, message: `${path} is required` });
    return null;
  }
  if (value.includes("\0")) {
    errors.push({ path, message: `${path} contains a NUL byte` });
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    errors.push({ path, message: `${path} must be an absolute path` });
    return null;
  }
  if (value.split("/").includes("..")) {
    errors.push({ path, message: `${path} must not contain '..'` });
    return null;
  }
  return stripTrailingSlash(value);
}

function requireTimeout(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: ValidationIssue[],
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `${path} must be an integer from ${min} to ${max}` });
    return null;
  }
  return value;
}

export function isLexicalInside(parent: string, child: string): boolean {
  const root = stripTrailingSlash(parent);
  const target = stripTrailingSlash(child);
  return target === root || target.startsWith(`${root}/`);
}

export function isSafeRelativeFile(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\0")) return false;
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return /^[A-Za-z0-9._@+/-]+$/.test(value);
}

function stripTrailingSlash(value: string): string {
  if (value.length > 1 && value.endsWith("/")) return value.replace(/\/+$/, "");
  return value;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
