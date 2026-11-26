/**
 * Local environment manager runtime.
 *
 * Import this from a future HTTP layer. It does not register routes, open a
 * database, or start a daemon. See `docs/plans/environment-manager-core.md`.
 */

export { createBunCommandRunner, MAX_COMMAND_OUTPUT_BYTES } from "./command-runner.ts";
export type { CommandRunOptions, CommandRunResult, CommandRunner } from "./command-runner.ts";

export {
  assertSafeDockerArgv,
  composeBaseArgv,
  createDockerComposeHost,
  ownershipLabels,
  parseInspect,
  renderLabelOverride,
} from "./docker-compose.ts";
export type { ComposeHost, ComposeInspectResult, ComposeTarget } from "./docker-compose.ts";

export { BASE_ENV_KEYS, OWNERSHIP_TOKEN_ENV, buildDockerEnv, buildProcessEnv } from "./env.ts";

export {
  composeProbe,
  createDefaultHealthProbes,
  dockerServiceFromClassification,
  httpStatus,
  runHealthChecks,
  tcpConnect,
} from "./health.ts";
export type { HealthProbes, HealthRunInput, HealthRunResult } from "./health.ts";

export { LogBuffer } from "./logs.ts";

export { EnvironmentManager, ensureMarkerDir } from "./manager.ts";
export type { EnvironmentManagerOptions } from "./manager.ts";

export {
  bunProcessSignaller,
  classifyProcessProbe,
  createBunProcessHost,
  createPsInspector,
  signalPid,
} from "./process-host.ts";
export type {
  ExitInfo,
  LiveProcess,
  LocalProcessHost,
  LocalStartRequest,
  LocalStartResult,
  ProbeVerdict,
  ProcessInspector,
  ProcessSignaller,
} from "./process-host.ts";

export { extractEnvToken, parseLstart } from "./ps.ts";
export type { ProcessSnapshot } from "./ps.ts";

export { cancellableSleep } from "./sleep.ts";

export { MemoryEnvironmentStore } from "./store.ts";
export type { EnvironmentRepository } from "./store.ts";
