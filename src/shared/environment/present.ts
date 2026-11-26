/**
 * Display and draft helpers for the environment manager.
 *
 * Pure. The webview and the HTTP layer both use these so a launch profile
 * cannot be assembled as a shell string on one side and validated differently
 * on the other. Nothing here spawns a process or opens a URL.
 */

import { parseLoopbackHttpUrl } from "./health-policy.ts";
import { validateLaunchProfile } from "./profile.ts";
import type {
  EnvBinding,
  EnvironmentPhase,
  EnvironmentStatus,
  EnvironmentUrl,
  HealthCheck,
  LaunchProfile,
  OwnershipClass,
  UrlAvailability,
  UrlRole,
} from "./types.ts";

export const DISPLAY_PHASES = [
  "not-configured",
  "stopped",
  "starting",
  "running",
  "degraded",
  "stopping",
  "error",
  "external",
  "unknown",
] as const;

export type DisplayPhase = (typeof DISPLAY_PHASES)[number];

export const PHASE_LABELS: Record<DisplayPhase, string> = {
  "not-configured": "Not configured",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  degraded: "Degraded",
  stopping: "Stopping",
  error: "Error",
  external: "External",
  unknown: "Unknown",
};

const OWNED: ReadonlySet<OwnershipClass> = new Set(["session", "prior-forgeorbit"]);

export interface EnvironmentActions {
  start: boolean;
  stop: boolean;
  restart: boolean;
}

export function displayPhase(input: {
  configured: boolean;
  recordedPhase: EnvironmentPhase;
  ownership: OwnershipClass;
}): DisplayPhase {
  if (!input.configured) return "not-configured";
  if (input.ownership === "external") return "external";
  return input.recordedPhase;
}

/** Stop is offered only when this session, or a previous ForgeOrbit session, still owns the process. */
export function environmentActions(phase: DisplayPhase, ownership: OwnershipClass): EnvironmentActions {
  const owned = OWNED.has(ownership);
  if (phase === "starting" || phase === "stopping") return { start: false, stop: false, restart: false };
  if (phase === "external" || phase === "unknown" || phase === "not-configured") {
    return { start: false, stop: false, restart: false };
  }
  if (phase === "running" || phase === "degraded") {
    return { start: false, stop: owned, restart: owned };
  }
  if (phase === "stopped") return { start: true, stop: false, restart: false };
  if (phase === "error") {
    return { start: ownership !== "unverified", stop: owned, restart: false };
  }
  return { start: false, stop: false, restart: false };
}

export function blockingReason(phase: DisplayPhase, ownership: OwnershipClass): string | null {
  if (phase === "external" || ownership === "external") {
    return "ForgeOrbit did not start this environment and will not stop or change it.";
  }
  if (phase === "unknown" || ownership === "unverified") {
    return "Ownership is not proven. Stop will not signal this process.";
  }
  return null;
}

export function ownershipLabel(ownership: OwnershipClass): string {
  switch (ownership) {
    case "session":
      return "Managed by this session";
    case "prior-forgeorbit":
      return "Managed by a previous ForgeOrbit session";
    case "external":
      return "External — not managed";
    case "unverified":
      return "Ownership could not be verified";
    case "none":
      return "Not running";
  }
}

/** Stable compose project name. `fo-` plus a hash of the project path, so it does not collide with a hand-run stack named after the folder. */
export function defaultComposeProjectName(projectPath: string): string {
  let hash = 2166136261;
  for (let i = 0; i < projectPath.length; i++) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function openableLoopbackUrl(raw: string): string | null {
  const parsed = parseLoopbackHttpUrl(raw);
  return parsed.ok ? parsed.target.href : null;
}

export function websiteUrl(urls: readonly UrlAvailability[]): UrlAvailability | null {
  return urls.find((url) => url.role === "website" && openableLoopbackUrl(url.url) !== null) ?? null;
}

export interface PublicEnvBinding {
  name: string;
  from: "inherit" | "literal";
  redacted?: true;
}

export interface PublicLaunchProfile extends Omit<LaunchProfile, "env"> {
  env: PublicEnvBinding[];
}

export function toPublicProfile(profile: LaunchProfile): PublicLaunchProfile {
  return {
    ...profile,
    env: profile.env.map((binding) =>
      binding.from === "inherit"
        ? { name: binding.name, from: "inherit" }
        : { name: binding.name, from: "literal", redacted: true },
    ),
  };
}

/** New literal values are refused. A `{ redacted: true }` binding is only a round-trip of a value already stored. */
export function literalEnvRejection(env: unknown): string | null {
  if (env === undefined) return null;
  if (!Array.isArray(env)) return "env must be an array";
  for (const binding of env) {
    if (!binding || typeof binding !== "object") return "env entries must be objects";
    const record = binding as { from?: unknown; value?: unknown; redacted?: unknown };
    if (record.from !== "literal") continue;
    if (record.redacted === true && (record.value === undefined || record.value === "")) continue;
    return 'literal environment values are not stored; reference an existing variable with { name, from: "inherit" }';
  }
  return null;
}

export function restoreRedactedEnv(input: unknown, previous: LaunchProfile): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: true, value: input };
  const profile = { ...(input as Record<string, unknown>) };
  if (!Array.isArray(profile.env)) return { ok: true, value: profile };
  const previousLiterals = new Map<string, string>();
  for (const binding of previous.env) {
    if (binding.from === "literal") previousLiterals.set(binding.name, binding.value);
  }
  const env: unknown[] = [];
  for (const binding of profile.env) {
    if (!binding || typeof binding !== "object") {
      env.push(binding);
      continue;
    }
    const record = binding as { name?: unknown; from?: unknown; redacted?: unknown; value?: unknown };
    if (record.from === "literal" && record.redacted === true && typeof record.name === "string") {
      const value = previousLiterals.get(record.name);
      if (value === undefined) {
        return { ok: false, error: `no stored value for ${record.name}` };
      }
      env.push({ name: record.name, from: "literal", value });
      continue;
    }
    env.push(binding);
  }
  profile.env = env;
  return { ok: true, value: profile };
}

const SECRET_MIN = 8;

/** Replace ownership tokens and other secrets. Short strings are left alone so ordinary words are not blanked. */
export function redactEnvironmentText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < SECRET_MIN || !out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(/FORGEORBIT_ENV_TOKEN=[^\s]+/g, "FORGEORBIT_ENV_TOKEN=[redacted]");
}

export interface EnvironmentProfileView {
  profile: PublicLaunchProfile;
  status: EnvironmentStatus;
  urls: UrlAvailability[];
}

export interface ComposeSuggestion {
  file: string;
  services: string[];
}

export interface EnvironmentIndex {
  profiles: EnvironmentProfileView[];
  suggestions: { composeFiles: ComposeSuggestion[] };
}

export interface EnvironmentCommandResult {
  ok: boolean;
  status: EnvironmentStatus | null;
  urls?: UrlAvailability[];
  profile?: PublicLaunchProfile | null;
  error?: string;
  code?: string;
}

export interface ProfileDraft {
  id?: string;
  name: string;
  kind: "docker-compose" | "local-process";
  cwd: string;
  composeFile: string;
  projectName: string;
  services: string[];
  executable: string;
  args: string[];
  inherit: string[];
  httpUrl: string;
  tcpPort: string;
  websiteUrl: string;
  apiUrl: string;
  adminUrl: string;
  docsUrl: string;
  signal: "SIGTERM" | "SIGINT";
  graceMs: number;
  killAfterGrace: boolean;
  processGroup: boolean;
}

export function emptyDraft(projectPath: string, kind: ProfileDraft["kind"] = "local-process"): ProfileDraft {
  return {
    name: "Local",
    kind,
    cwd: projectPath,
    composeFile: "compose.yaml",
    projectName: defaultComposeProjectName(projectPath),
    services: [],
    executable: "",
    args: [],
    inherit: [],
    httpUrl: "",
    tcpPort: "",
    websiteUrl: "",
    apiUrl: "",
    adminUrl: "",
    docsUrl: "",
    signal: "SIGTERM",
    graceMs: 5_000,
    killAfterGrace: false,
    processGroup: true,
  };
}

export function draftFromProfile(profile: PublicLaunchProfile): ProfileDraft {
  const http = profile.healthChecks.find((check) => check.kind === "http");
  const tcp = profile.healthChecks.find((check) => check.kind === "tcp");
  const url = (role: UrlRole) => profile.urls.find((entry) => entry.role === role)?.url ?? "";
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.launch.kind,
    cwd: profile.cwd,
    composeFile: profile.launch.kind === "docker-compose" ? profile.launch.composeFile : "compose.yaml",
    projectName:
      profile.launch.kind === "docker-compose"
        ? profile.launch.projectName
        : defaultComposeProjectName(profile.projectPath),
    services: profile.launch.kind === "docker-compose" ? [...profile.launch.services] : [],
    executable: profile.launch.kind === "local-process" ? profile.launch.command.executable : "",
    args: profile.launch.kind === "local-process" ? [...profile.launch.command.args] : [],
    inherit: profile.env.filter((binding) => binding.from === "inherit").map((binding) => binding.name),
    httpUrl: http && http.kind === "http" ? http.url : "",
    tcpPort: tcp && tcp.kind === "tcp" ? String(tcp.port) : "",
    websiteUrl: url("website"),
    apiUrl: url("api"),
    adminUrl: url("admin"),
    docsUrl: url("docs"),
    signal: profile.stop.kind === "signal" ? profile.stop.signal : "SIGTERM",
    graceMs: profile.stop.kind === "signal" ? profile.stop.graceMs : 5_000,
    killAfterGrace: profile.stop.kind === "signal" ? profile.stop.killAfterGrace : false,
    processGroup: profile.stop.kind === "signal" ? profile.stop.processGroup : true,
  };
}

export function splitArgLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

export function splitServiceNames(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const CHECK_TIMEOUT = 2_000;
const CHECK_INTERVAL = 500;
const CHECK_ATTEMPTS = 10;

function httpCheck(id: string, url: string, required: boolean): HealthCheck {
  return {
    id,
    kind: "http",
    url,
    method: "GET",
    acceptedStatuses: [200, 201, 202, 203, 204, 206],
    timeoutMs: CHECK_TIMEOUT,
    intervalMs: CHECK_INTERVAL,
    maxAttempts: CHECK_ATTEMPTS,
    required,
  };
}

function tcpCheck(port: number): HealthCheck {
  return {
    id: "port",
    kind: "tcp",
    host: "127.0.0.1",
    port,
    timeoutMs: CHECK_TIMEOUT,
    intervalMs: CHECK_INTERVAL,
    maxAttempts: CHECK_ATTEMPTS,
    required: true,
  };
}

export function profileFromDraft(projectPath: string, draft: ProfileDraft): ReturnType<typeof validateLaunchProfile> {
  const healthChecks: HealthCheck[] = [];
  const urls: EnvironmentUrl[] = [];
  const httpUrl = draft.httpUrl.trim() || draft.websiteUrl.trim();
  if (httpUrl) healthChecks.push(httpCheck("web", httpUrl, true));
  const tcpPort = draft.tcpPort.trim();
  let port: number | null = null;
  if (tcpPort) {
    port = Number(tcpPort);
    if (!Number.isInteger(port)) {
      return { ok: false, errors: [{ path: "tcpPort", message: "port must be an integer" }] };
    }
    healthChecks.push(tcpCheck(port));
  }
  const roles: { role: UrlRole; url: string; name: string }[] = [
    { role: "website", url: draft.websiteUrl.trim(), name: "Website" },
    { role: "api", url: draft.apiUrl.trim(), name: "API" },
    { role: "admin", url: draft.adminUrl.trim(), name: "Admin" },
    { role: "docs", url: draft.docsUrl.trim(), name: "Documentation" },
  ];
  for (const entry of roles) {
    if (!entry.url) continue;
    urls.push({
      id: entry.role,
      name: entry.name,
      role: entry.role,
      url: entry.url,
      healthCheckId: entry.url === httpUrl ? "web" : null,
      optional: entry.role !== "website",
    });
  }
  const inherit: EnvBinding[] = draft.inherit
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name, from: "inherit" as const }));
  const launch =
    draft.kind === "docker-compose"
      ? {
          kind: "docker-compose" as const,
          composeFile: draft.composeFile.trim(),
          projectName: draft.projectName.trim(),
          services: draft.services,
        }
      : {
          kind: "local-process" as const,
          command: { executable: draft.executable.trim(), args: draft.args },
        };
  const stop =
    draft.kind === "docker-compose"
      ? { kind: "compose-stop" as const }
      : {
          kind: "signal" as const,
          signal: draft.signal,
          graceMs: draft.graceMs,
          killAfterGrace: draft.killAfterGrace,
          processGroup: draft.processGroup,
        };
  const expectedPorts = port === null ? [] : [{ host: "127.0.0.1", port }];
  return validateLaunchProfile({
    id: draft.id && draft.id.length > 0 ? draft.id : newProfileId(),
    projectPath,
    name: draft.name,
    cwd: draft.cwd.trim(),
    launch,
    stop,
    expectedPorts,
    healthChecks,
    urls,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000,
    env: inherit,
  });
}

export function selectDisplayedProfile<T extends { status: EnvironmentStatus }>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  const active = rows.find((row) => {
    const phase = row.status.recordedPhase;
    return phase === "starting" || phase === "running" || phase === "degraded" || phase === "stopping";
  });
  return active ?? rows[0] ?? null;
}

export function logMentionsService(text: string, service: string): boolean {
  if (!service) return true;
  return text.includes(service);
}

function newProfileId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `p${hex}`;
}
