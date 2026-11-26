/**
 * Launch profiles and runtime vocabulary for the local environment manager.
 *
 * Pure data. The Bun runtime (`src/bun/environment`) is the only thing that
 * spawns processes or talks to Docker. A future HTTP layer can return these
 * shapes without importing that runtime. Nothing here opens a browser, a
 * socket, or a database.
 *
 * `recorded` is the phase ForgeOrbit last committed to. `observed` is what a
 * probe last saw. They are allowed to disagree until reconcile/refresh applies
 * a transition — a stale PID must not be treated as proof the process is still
 * the one we started.
 */

export const ENVIRONMENT_PHASES = [
  "stopped",
  "starting",
  "running",
  "degraded",
  "stopping",
  "error",
  "unknown",
] as const;

export type EnvironmentPhase = (typeof ENVIRONMENT_PHASES)[number];

/**
 * Kinds this core actually runs. Makefile, Python, native macOS apps, and
 * arbitrary custom commands are intentionally absent: adding one means
 * extending {@link LaunchSpec} and the manager, not overloading `local-process`
 * with a shell string.
 */
export type EnvironmentKind = "docker-compose" | "local-process";

export const URL_ROLES = ["website", "api", "admin", "docs", "other"] as const;
export type UrlRole = (typeof URL_ROLES)[number];

export type OwnershipClass =
  | "none"
  | "session"
  | "prior-forgeorbit"
  | "external"
  | "unverified";

export type EnvErrorCode =
  | "invalid-profile"
  | "not-found"
  | "missing-workdir"
  | "missing-compose-file"
  | "docker-unavailable"
  | "busy"
  | "start-failed"
  | "startup-timeout"
  | "shutdown-timeout"
  | "health-failed"
  | "cancelled"
  | "foreign-process"
  | "foreign-compose-project"
  | "external-environment"
  | "unverified-ownership"
  | "process-exited"
  | "project-name-conflict";

/** argv launch. Never a shell string. `executable` is a bare name or an absolute path. */
export interface StructuredCommand {
  executable: string;
  args: string[];
}

export type EnvBinding =
  | { name: string; from: "literal"; value: string }
  | { name: string; from: "inherit" };

export interface PortExpectation {
  host: string;
  port: number;
}

export type StopStrategy =
  | {
      kind: "signal";
      /** Graceful signal. SIGKILL is only used afterwards, and only for a process we still own. */
      signal: "SIGTERM" | "SIGINT";
      graceMs: number;
      killAfterGrace: boolean;
      /**
       * Ask the runner to place the process in its own session so a later
       * signal can reach children that stayed in that session. When the
       * platform cannot do that, the runner reports it and only signals the
       * recorded pid.
       */
      processGroup: boolean;
    }
  | { kind: "compose-stop" };

export type HealthCheck =
  | {
      id: string;
      kind: "tcp";
      host: string;
      port: number;
      timeoutMs: number;
      intervalMs: number;
      maxAttempts: number;
      required: boolean;
    }
  | {
      id: string;
      kind: "http";
      url: string;
      method: "GET" | "HEAD";
      acceptedStatuses: number[];
      timeoutMs: number;
      intervalMs: number;
      maxAttempts: number;
      required: boolean;
    }
  | {
      id: string;
      kind: "process-alive";
      timeoutMs: number;
      intervalMs: number;
      maxAttempts: number;
      required: boolean;
    }
  | {
      id: string;
      kind: "docker-service";
      service: string;
      timeoutMs: number;
      intervalMs: number;
      maxAttempts: number;
      required: boolean;
    };

export interface EnvironmentUrl {
  id: string;
  name: string;
  role: UrlRole;
  url: string;
  healthCheckId: string | null;
  /** An optional URL can be down while the environment is still running. */
  optional: boolean;
}

export type UrlAvailabilityStatus = "up" | "down" | "unknown";

export interface UrlAvailability {
  id: string;
  name: string;
  role: UrlRole;
  url: string;
  optional: boolean;
  status: UrlAvailabilityStatus;
  detail: string | null;
}

export interface DockerComposeLaunch {
  kind: "docker-compose";
  /** Relative to `cwd`. Absolute paths and `..` segments are rejected. */
  composeFile: string;
  /**
   * Passed as `--project-name` on every compose invocation. Required so two
   * projects never fall through to Docker's directory-name default.
   */
  projectName: string;
  /** Empty means "every service the compose file declares". */
  services: string[];
}

export interface LocalProcessLaunch {
  kind: "local-process";
  command: StructuredCommand;
}

export type LaunchSpec = DockerComposeLaunch | LocalProcessLaunch;

export interface LaunchProfile {
  id: string;
  projectPath: string;
  name: string;
  cwd: string;
  launch: LaunchSpec;
  stop: StopStrategy;
  expectedPorts: PortExpectation[];
  healthChecks: HealthCheck[];
  urls: EnvironmentUrl[];
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  env: EnvBinding[];
}

export interface ProcessOwnershipRecord {
  kind: "process";
  pid: number;
  startedAtMs: number;
  token: string;
  sessionId: string;
  executable: string;
  args: string[];
  cwd: string;
  processGroup: boolean;
}

export interface ComposeOwnershipRecord {
  kind: "compose";
  projectName: string;
  composeFile: string;
  cwd: string;
  token: string;
  /** False when `up` succeeded but the ownership label was not visible afterwards. */
  tokenApplied: boolean;
  sessionId: string;
  profileId: string;
  containerIds: string[];
}

export type OwnershipRecord = ProcessOwnershipRecord | ComposeOwnershipRecord;

export interface RuntimeRecord {
  phase: EnvironmentPhase;
  ownership: OwnershipRecord | null;
  ownershipClass: OwnershipClass;
  lastError: string | null;
  errorCode: EnvErrorCode | null;
  updatedAt: number;
  /** Session that last started this environment, when one has. */
  sessionId: string | null;
}

/** JSON-serializable row a future SQLite adapter can store as one blob. */
export interface StoredEnvironment {
  profile: LaunchProfile;
  runtime: RuntimeRecord;
}

export interface ObservedRuntime {
  ownership: OwnershipClass;
  /** `null` when this kind has no single pid to probe (compose) or we have not probed yet. */
  processAlive: boolean | null;
  detail: string | null;
  at: number | null;
}

export interface HealthOutcome {
  id: string;
  ok: boolean;
  required: boolean;
  detail: string;
  attempts: number;
}

export interface EnvironmentStatus {
  profileId: string;
  name: string;
  kind: EnvironmentKind;
  /** Phase ForgeOrbit committed to. */
  recordedPhase: EnvironmentPhase;
  /** Last probe. Independent of `recordedPhase`. */
  observed: ObservedRuntime;
  ownership: OwnershipClass;
  pid: number | null;
  composeProject: string | null;
  lastError: string | null;
  errorCode: EnvErrorCode | null;
  updatedAt: number;
  health: HealthOutcome[];
}

export interface EnvironmentLogs {
  lines: LogLine[];
}

export interface LogLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: number;
}

export type EnvironmentOperationResult =
  | { ok: true; status: EnvironmentStatus }
  | { ok: false; code: EnvErrorCode; error: string; status: EnvironmentStatus | null };
