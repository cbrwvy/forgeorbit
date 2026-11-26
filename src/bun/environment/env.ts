/**
 * Environment passed to a managed local process.
 *
 * The parent environment is not copied. A dev server needs PATH and HOME;
 * it does not need every secret that happens to be in ForgeOrbit's environment.
 * Named `inherit` bindings are the explicit escape hatch. The ownership
 * variables are reserved so a profile cannot spoof them.
 */

import type { EnvBinding } from "../../shared/environment/types.ts";

export const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BUN_INSTALL",
] as const;

export const OWNERSHIP_TOKEN_ENV = "FORGEORBIT_ENV_TOKEN";
export const OWNERSHIP_ID_ENV = "FORGEORBIT_ENV_ID";
export const OWNERSHIP_PROFILE_ENV = "FORGEORBIT_ENV_PROFILE";

export function buildProcessEnv(options: {
  parent: Record<string, string | undefined>;
  bindings: readonly EnvBinding[];
  profileId: string;
  token: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = options.parent[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const binding of options.bindings) {
    if (binding.from === "literal") {
      env[binding.name] = binding.value;
      continue;
    }
    const value = options.parent[binding.name];
    if (typeof value === "string") env[binding.name] = value;
  }
  env[OWNERSHIP_ID_ENV] = options.profileId;
  env[OWNERSHIP_PROFILE_ENV] = options.profileId;
  env[OWNERSHIP_TOKEN_ENV] = options.token;
  return env;
}

/** Docker must not inherit COMPOSE_PROJECT_NAME / COMPOSE_FILE from the parent. */
export function buildDockerEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { LC_ALL: "C" };
  for (const key of ["PATH", "HOME", "USER", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_CONFIG_HOME", "TMPDIR"]) {
    const value = parent[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
