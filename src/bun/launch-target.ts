/**
 * Direction 9: describe the launch target of a harness from the SAME resolution the launch uses.
 *
 * `resolveBinDetailed` (agents.ts) is the one function that names the executable; this module only
 * adds the filesystem lookup, the version evidence and the registration state around it. It starts
 * no process: a version is read either from a probe the caller already ran (`probed: true`, the
 * launch review, a start) or from the memory of an earlier probe of the identical file
 * (`lastProbedVersion`). A passive screen therefore reports "not checked" rather than launching a CLI.
 */
import { agentDriverIsFake, resolveBinDetailed } from "./agents.ts";
import { lastProbedVersion, resolveBinPath } from "./agent-status.ts";
import { isCodexProfile, selectedCodexAccount } from "./codex-profiles.ts";
import { isClaudeProfile, selectedClaudeAccount } from "./claude-profiles.ts";
import { isInertQaStub } from "./provider-runtime/synthetic-auth.ts";
import { harnesses } from "./db.ts";
import { DEFAULT_MODEL, MODEL_MIN_CLI_VERSION, supportedModes, type Harness, type HarnessStatus } from "../shared/types.ts";
import { parseCliVersion } from "../shared/cli-version.ts";
import { classifyLaunchTarget, type LaunchTargetFacts } from "../shared/provider-launch-target.ts";

/** Env escape hatch shared with `minCliVersionError` (orchestrator.ts): the floors are not applied. */
export const SKIP_CLI_VERSION_FLOOR_ENV = "AGETOR_SKIP_CLI_VERSION_FLOOR";

export function cliVersionFloorSkipped(): boolean {
  const skip = process.env[SKIP_CLI_VERSION_FLOOR_ENV]?.trim().toLowerCase();
  return skip === "1" || skip === "true" || skip === "on" || skip === "yes";
}

/**
 * The minimum CLI version for a model, or null. Only `MODEL_MIN_CLI_VERSION` defines one (today
 * Codex's GPT-6 rows); there is no provider-wide floor. Claude Code has none: the versions seen
 * in this repository's notes are tested versions, not enforced ones.
 */
export function cliFloorFor(kind: Harness["kind"], model: string | null): { model: string; min: string } | null {
  if (cliVersionFloorSkipped()) return null;
  const id = model ?? DEFAULT_MODEL[kind];
  const min = MODEL_MIN_CLI_VERSION[kind]?.[id];
  return min === undefined ? null : { model: id, min };
}

function registrationOf(harness: Harness): "ok" | "stale" | "not-applicable" {
  try {
    if (isCodexProfile(harness)) return selectedCodexAccount(harness) ? "ok" : "stale";
    if (isClaudeProfile(harness)) return selectedClaudeAccount(harness) ? "ok" : "stale";
  } catch {
    return "stale";
  }
  return "not-applicable";
}

export interface DescribeLaunchTargetInput {
  model: string | null;
  mode: string | null;
  /** The result of an explicit probe the caller already ran. Omit for a passive read. */
  status?: HarnessStatus | null;
  /** True when `status.version` came from a probe that was allowed to ask the CLI. */
  probed?: boolean;
}

export function describeLaunchTarget(harness: Harness, input: DescribeLaunchTargetInput): LaunchTargetFacts {
  const { bin, source } = resolveBinDetailed(harness);
  const path = resolveBinPath(bin);
  const probed = input.probed === true && input.status != null;
  let version: { raw: string | null; state: "read" | "unreadable" | "not-checked" };
  if (probed) {
    const raw = input.status!.version;
    version = { raw, state: raw !== null && parseCliVersion(raw) !== null ? "read" : "unreadable" };
  } else {
    version = lastProbedVersion(harness, path);
  }
  const fixtureDriver = agentDriverIsFake(harness.kind);
  return classifyLaunchTarget({
    kind: harness.kind,
    // Cursor's own sandbox cannot start inside the production Seatbelt (provider-readiness.ts).
    contractBlocked: harness.kind === "cursor",
    registration: registrationOf(harness),
    executable: { bin, path, source },
    version,
    floor: cliFloorFor(harness.kind, input.model),
    fixtureDriver,
    inertStub: fixtureDriver && isInertQaStub(path),
    mode: {
      id: input.mode,
      supported: input.mode == null ? null : supportedModes(harness.kind, input.model).some((option) => option.id === input.mode),
    },
  });
}

/**
 * The passive launch target of a registered account profile's harness (no process is started).
 * `model` is the harness default, so the minimum shown is the one the default model needs; a review
 * of a specific model states that model's own minimum.
 */
export function profileLaunchTarget(harnessId: string): LaunchTargetFacts | null {
  const harness = harnesses.get(harnessId);
  if (!harness) return null;
  return describeLaunchTarget(harness, { model: null, mode: null });
}
