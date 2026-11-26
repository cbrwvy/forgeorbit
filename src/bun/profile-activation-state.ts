/**
 * FO-P2-005-A-R2: read-only durable activation state for CLI discovery.
 *
 * Controlled startup (`resolveStartupProfile`) may replay transitions under the
 * transition lock. External CLI processes must never do that — they validate the
 * on-disk evidence and fail closed before daemon discovery or spawn.
 */

import { existsSync, lstatSync } from "node:fs";
import { resolveDataDir } from "./data-dir.ts";
import { ProfileActivationError } from "./profile-activation-errors.ts";
import { inspectRollbackTarget } from "./profile-activation-preflight.ts";
import {
  activationControlDir,
  canonicalizeProfilePath,
  ensureActivationControlDir,
  getPinnedRuntimeActiveDataDir,
  profileIdentityForPath,
  readProfileSelection,
  type ProfileSelection,
} from "./profile-paths.ts";
import {
  isTerminalTransitionState,
  readTransitionJournal,
  type TransitionJournal,
} from "./profile-transition-journal.ts";

export interface DurableActivationState {
  baseDataDir: string;
  controlDir: string;
  activeDataDir: string;
  selection: ProfileSelection | null;
  journal: TransitionJournal | null;
}

/** Bound selection path to its canonical location-derived identity. */
export { assertSelectionPathIdentities } from "./profile-paths.ts";

function terminalSelectionPath(selection: ProfileSelection | null, baseDataDir: string): string {
  const raw = selection?.activeProfilePath ?? baseDataDir;
  return canonicalizeProfilePath(raw);
}

/**
 * CLI-only guard: a restored/non-base selection must already exist on disk.
 * The base profile may still be absent on legitimate first run — never create
 * it here and never replay the journal from read-only validation.
 */
function assertCliActiveProfilePresent(
  activeDataDir: string,
  baseDataDir: string,
): void {
  const canonicalActive = canonicalizeProfilePath(activeDataDir);
  const canonicalBase = canonicalizeProfilePath(baseDataDir);
  if (canonicalActive === canonicalBase) return;

  let st;
  try {
    st = lstatSync(canonicalActive);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ProfileActivationError(
        "The selected active profile no longer exists",
        "ACTIVE_PROFILE_MISSING",
      );
    }
    throw new ProfileActivationError("The selected active profile is unavailable", "IO_ERROR");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new ProfileActivationError(
      "The selected active profile is not a real directory",
      "ACTIVE_PROFILE_MISSING",
    );
  }
}

function finalizeCliActivationState(state: DurableActivationState): DurableActivationState {
  assertCliActiveProfilePresent(state.activeDataDir, state.baseDataDir);
  return state;
}

function activePathForTerminalJournal(
  journal: TransitionJournal,
  selection: ProfileSelection | null,
  baseDataDir: string,
): string {
  if (journal.state === "active") {
    const active = canonicalizeProfilePath(journal.candidate.path);
    if (!selection || canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(active)) {
      throw new ProfileActivationError(
        "The activation journal says active but the selection disagrees",
        "SELECTION_CORRUPT",
      );
    }
    return active;
  }
  if (journal.state === "rolled_back") {
    const active = canonicalizeProfilePath(
      journal.action === "activate" ? journal.original.path : journal.candidate.path,
    );
    if (!selection || canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(active)) {
      throw new ProfileActivationError(
        "The rolled-back journal says a different profile is active",
        "SELECTION_CORRUPT",
      );
    }
    return active;
  }
  if (journal.state === "failed") {
    if (!selection) {
      throw new ProfileActivationError(
        "The activation journal failed but no selection is recorded",
        "SELECTION_CORRUPT",
      );
    }
    const active = terminalSelectionPath(selection, baseDataDir);
    const bootCheck = inspectRollbackTarget({
      targetPath: active,
      activeDataDir: active,
      allowActiveProfile: true,
    });
    if (!bootCheck.ok) {
      throw new ProfileActivationError(
        bootCheck.message ?? "The selected profile is not bootable after a failed transition",
        bootCheck.code ?? "ACTIVE_PROFILE_MISSING",
      );
    }
    return active;
  }
  throw new ProfileActivationError("Transition journal is in an unsupported terminal state", "JOURNAL_CORRUPT");
}

/**
 * Validate durable activation evidence without acquiring the transition lock or
 * mutating journal/selection state. Throws {@link ProfileActivationError} when
 * evidence is corrupt, inconsistent, or mid-transition.
 */
export function validateDurableActivationState(
  context: Parameters<typeof resolveDataDir>[0] = {},
): DurableActivationState {
  const baseDataDir = resolveDataDir(context);
  const controlDir = activationControlDir(baseDataDir);
  if (!existsSync(controlDir)) {
    return finalizeCliActivationState({
      baseDataDir: canonicalizeProfilePath(baseDataDir),
      controlDir,
      activeDataDir: canonicalizeProfilePath(baseDataDir),
      selection: null,
      journal: null,
    });
  }
  ensureActivationControlDir(controlDir, false);
  const selection = readProfileSelection(controlDir);
  const journal = readTransitionJournal(controlDir);

  if (!journal) {
    if (
      selection &&
      canonicalizeProfilePath(selection.activeProfilePath) !== canonicalizeProfilePath(baseDataDir)
    ) {
      throw new ProfileActivationError(
        "The active profile selection has no matching transition journal",
        "SELECTION_WITHOUT_JOURNAL",
      );
    }
    return finalizeCliActivationState({
      baseDataDir: canonicalizeProfilePath(baseDataDir),
      controlDir,
      activeDataDir: terminalSelectionPath(selection, baseDataDir),
      selection,
      journal: null,
    });
  }

  if (
    selection &&
    selection.transitionId !== journal.transitionId &&
    selection.transitionId !== journal.previousTransitionId
  ) {
    throw new ProfileActivationError(
      "The active profile selection belongs to a different transition",
      "SELECTION_CORRUPT",
    );
  }

  if (isTerminalTransitionState(journal.state)) {
    return finalizeCliActivationState({
      baseDataDir: canonicalizeProfilePath(baseDataDir),
      controlDir,
      activeDataDir: activePathForTerminalJournal(journal, selection, baseDataDir),
      selection,
      journal,
    });
  }

  throw new ProfileActivationError(
    "A profile transition is still in progress; open ForgeOrbit to finish activation",
    "ACTIVATION_PENDING",
  );
}

/** Active profile directory whose `agetor-core.json` the CLI should probe. */
export function resolveCliActiveDataDir(explicitBaseDataDir?: string): string {
  const context =
    explicitBaseDataDir !== undefined
      ? {
          env: {
            ...process.env,
            FORGEORBIT_DATA_DIR: explicitBaseDataDir,
            AGETOR_DATA_DIR: explicitBaseDataDir,
          },
        }
      : {};
  return validateDurableActivationState(context).activeDataDir;
}

export function expectedProfileIdentityForActiveDir(activeDataDir: string): string {
  return profileIdentityForPath(canonicalizeProfilePath(activeDataDir));
}

/** Resolve the active profile directory and its expected daemon identity for discovery. */
export function resolveCoreDiscoveryTarget(explicitBaseDataDir?: string): {
  activeDataDir: string;
  expectedProfileIdentity: string;
} {
  const activeDataDir = resolveCliActiveDataDir(explicitBaseDataDir);
  return {
    activeDataDir,
    expectedProfileIdentity: expectedProfileIdentityForActiveDir(activeDataDir),
  };
}

/**
 * The active data directory for this process. After controlled startup pins the
 * profile (`pinRuntimeProfileRoots`), returns the pinned root and ignores live
 * `selection.json` changes. Unpinned callers (CLI discovery) read durable
 * selection on each call and fail closed when activation evidence is corrupt.
 */
export function resolveActiveDataDir(
  context: Parameters<typeof resolveDataDir>[0] = {},
): string {
  const pinned = getPinnedRuntimeActiveDataDir();
  if (pinned !== null) return pinned;
  return validateDurableActivationState(context).activeDataDir;
}
