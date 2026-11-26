/**
 * Direction 9: what the launch will actually run, stated in one place.
 *
 * The facts here describe the executable a harness resolves to, the version it
 * reported (when a probe was allowed to ask), the version floor that applies to
 * the chosen model (only where `MODEL_MIN_CLI_VERSION` defines one), and the mode.
 * The classifier is pure. It never starts a process and never reads a credential.
 *
 * What it will not do:
 *  - invent a version floor (only a model-specific floor from `MODEL_MIN_CLI_VERSION` counts);
 *  - read a missing, unreadable or unchecked version as "compatible" when a floor applies;
 *  - turn a stale registration, an exhausted quota or an observed provider refusal into
 *    an upgrade recommendation;
 *  - read "signed in" or "compatible CLI" as verified capacity.
 */

import { cliVersionSatisfies, parseCliVersion } from "./cli-version.ts";

/** Where the resolved executable name came from. Mirrors `resolveBin` in `src/bun/agents.ts`. */
export type LaunchResolutionSource =
  /** The harness record names the binary (an additional-account harness may differ from the built-in). */
  | "harness-executable"
  /** An `AGETOR_<KIND>_BIN` override in the core's environment. */
  | "environment-override"
  /** The default command name found on the core's PATH. */
  | "path-lookup"
  /** The default command name; nothing on PATH answered. */
  | "default-name";

/** `read`: a probe ran and printed a parseable version. `unreadable`: a probe ran and did not. `not-checked`: no probe was allowed or has happened. */
export type LaunchVersionState = "read" | "unreadable" | "not-checked";

export type LaunchTargetCode =
  | "compatible"
  | "contract-blocked"
  | "registration-stale"
  | "executable-missing"
  | "mode-unsupported"
  | "version-below-minimum"
  | "version-unreadable"
  | "version-prerelease-at-minimum"
  | "version-not-checked";

/** `blocked` refuses the launch. `unverified` is not a pass: a required fact is missing. `compatible` is all this check can establish. */
export type LaunchTargetVerdict = "compatible" | "blocked" | "unverified";

export interface LaunchTargetInput {
  kind: string;
  /** `AgentOption` blocked by the provider contract (Cursor, DeepSeek). */
  contractBlocked: boolean;
  /** A Codex account profile whose registration was removed, disabled, moved or replaced. */
  registration: "ok" | "stale" | "not-applicable";
  executable: { bin: string; path: string | null; source: LaunchResolutionSource };
  version: { raw: string | null; state: LaunchVersionState };
  /** The model-specific floor from `MODEL_MIN_CLI_VERSION`, or null when none is defined. */
  floor: { model: string; min: string } | null;
  /** The harness driver is the recorded fixture: no CLI catalog is queried, so an unreadable version cannot matter. */
  fixtureDriver: boolean;
  /** The exact inert QA stub, which is not the provider CLI. The floor is skipped for it only. */
  inertStub: boolean;
  /** `supported === null`: the mode was not evaluated (a passive screen). */
  mode: { id: string | null; supported: boolean | null };
}

export interface LaunchTargetFacts {
  verdict: LaunchTargetVerdict;
  code: LaunchTargetCode;
  executable: { bin: string; path: string | null; source: LaunchResolutionSource };
  version: { raw: string | null; parsed: string | null; state: LaunchVersionState };
  floor: { model: string; min: string } | null;
  mode: { id: string | null; supported: boolean | null };
  /** Always true here: an enforced minimum exists only when `floor` is set. Claude Code has none. */
  minimumEnforced: boolean;
}

function parsedVersion(raw: string | null): string | null {
  const v = parseCliVersion(raw);
  if (!v) return null;
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease !== undefined ? `-${v.prerelease}` : ""}`;
}

/**
 * Precedence, most specific reason first: contract block, stale registration, missing
 * executable, unsupported mode, version below the floor, unreadable version, unchecked version.
 * A pre-release exactly at the floor stays `unverified` (the existing rule: it never blocks).
 * A fixture driver and the inert QA stub never query the CLI's model catalog, so an unreadable or
 * unchecked version is `unverified` (shown, not blocking) there and `blocked` (unreadable) or
 * `unverified` (not checked) with a real driver. A version that parses below the floor blocks in
 * every case except the inert stub, which is not the provider CLI.
 */
export function classifyLaunchTarget(input: LaunchTargetInput): LaunchTargetFacts {
  const facts = (verdict: LaunchTargetVerdict, code: LaunchTargetCode): LaunchTargetFacts => ({
    verdict,
    code,
    executable: input.executable,
    version: { raw: input.version.raw, parsed: parsedVersion(input.version.raw), state: input.version.state },
    floor: input.floor,
    mode: input.mode,
    minimumEnforced: input.floor !== null,
  });
  if (input.contractBlocked) return facts("blocked", "contract-blocked");
  if (input.registration === "stale") return facts("blocked", "registration-stale");
  if (input.executable.path === null) return facts("blocked", "executable-missing");
  if (input.mode.supported === false) return facts("blocked", "mode-unsupported");
  if (input.floor && !input.inertStub) {
    if (input.version.state === "not-checked") return facts("unverified", "version-not-checked");
    const satisfied = cliVersionSatisfies(input.version.raw, input.floor.min);
    if (satisfied === false) return facts("blocked", "version-below-minimum");
    if (satisfied === null) {
      // A parseable pre-release exactly at the floor: whether the catalog gate is open for it is
      // unknown, and an unknown of this kind has never blocked a launch. It is shown, not passed.
      if (parsedVersion(input.version.raw) !== null) return facts("unverified", "version-prerelease-at-minimum");
      return facts(input.fixtureDriver ? "unverified" : "blocked", "version-unreadable");
    }
  }
  return facts("compatible", "compatible");
}

/**
 * The one sentence for "this model needs a minimum CLI version and the executable did not print one".
 * Shared by the launch review and the board's Run so the two cannot word (or decide) it differently.
 */
export function formatUnreadableVersionError(input: { harnessLabel: string; where: string; model: string; kind: string; min: string }): string {
  return `${input.harnessLabel}'s version could not be read from ${input.where}, and ${input.model} needs ${input.kind} CLI ${input.min} or newer. `
    + "Reinstall the tool or point the harness at a working executable, then try again. Nothing was started.";
}
