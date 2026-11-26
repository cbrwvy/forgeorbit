import { parseSupervisedRunLimit, SUPERVISED_RUN_LIMIT_ENV } from "../shared/run-termination.ts";

/**
 * The opt-in wall-clock limit for supervised Developer and Reviewer runs, read from the launch environment
 * (`FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS`, like `FORGEORBIT_CODEX_READ_SCOPE`). Unset means no new limit: the
 * default changes nothing. A malformed value is an error a supervised launch reports; it is never guessed.
 */
export function supervisedRunLimit(env: NodeJS.ProcessEnv = process.env): { seconds: number | null; error: string | null } {
  const parsed = parseSupervisedRunLimit(env[SUPERVISED_RUN_LIMIT_ENV]);
  return parsed.ok ? { seconds: parsed.seconds, error: null } : { seconds: null, error: parsed.error };
}

/** For Owner-review surfaces: the limit that would apply, or null (also null when the value is malformed). */
export function supervisedRunLimitSeconds(env: NodeJS.ProcessEnv = process.env): number | null {
  return supervisedRunLimit(env).seconds;
}
