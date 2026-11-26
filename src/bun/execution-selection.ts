/** Deterministic configuration used by routing and supervised execution. */
import { DEFAULT_MODEL, supportedModes, type Task, type Harness } from "../shared/types.ts";
import type { PreflightRequest } from "../shared/execution/preflight.ts";
import type { ExecutorPreferences } from "../shared/execution/executor-routing.ts";
import type { ExecutionConfig } from "../shared/project-execution.ts";
import { harnesses } from "./db.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";
import { normalizeConfig, configFromTask, safestHandsOffMode } from "./project-execution.ts";
export function employeeConfig(task: Task, harness: Harness, request: PreflightRequest, prefs: ExecutorPreferences = loadExecutorPreferences()): ExecutionConfig {
  const sameHarness = harnesses.getByIdOrKind(task.agent)?.id === harness.id;
  let config: ExecutionConfig;
  if (sameHarness) {
    const base = normalizeConfig(configFromTask(task));
    config = request.model === null && request.effort === null
      ? base
      : { ...base, pipelineId: null, profileId: null, model: request.model ?? base.model, effort: request.effort ?? base.effort };
  } else {
    config = {
      pipelineId: null,
      profileId: null,
      harness: harness.id,
      model: request.model ?? DEFAULT_MODEL[harness.kind],
      effort: request.effort,
      mode: safestHandsOffMode(harness.kind, task),
      fast: false,
      maxMode: false,
    };
  }
  if (prefs.requiredMode && prefs.requiredMode !== config.mode && supportedModes(harness.kind, config.model).some((m) => m.id === prefs.requiredMode)) {
    config = { ...config, pipelineId: null, profileId: null, mode: prefs.requiredMode };
  }
  return config;
}
