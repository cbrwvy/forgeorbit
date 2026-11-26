/**
 * FO-P2-005-A: authoritative active-profile selection and the durable
 * activation control directory.
 *
 * Design constraints this module exists to satisfy:
 *
 *  - Exactly one mechanism decides which profile a ForgeOrbit process opens:
 *    the `selection.json` file in the activation control directory. There is
 *    no environment-variable swap, no symlink and no directory rename.
 *  - The control directory lives beside the base data directory (never inside
 *    a profile), so it survives replacing/removing a profile and is not part
 *    of any backup snapshot.
 *  - Every runtime subsystem that needs the active data directory resolves it
 *    through {@link resolveActiveDataDir} in `profile-activation-state.ts`. After controlled startup (`db.ts`
 *    calls {@link pinRuntimeProfileRoots}), the pinned root is fixed for the
 *    process lifetime; unpinned callers (CLI discovery) re-read durable selection.
 *  - Selection/journal writes are atomic (temp + rename + fsync of file and
 *    directory), mode 0600, and validated strictly on read. Corrupt evidence
 *    fails closed and is never deleted.
 *
 * This module deliberately has no dependency on `db.ts`, the backup service or
 * any UI module: it is imported during database bootstrap, before SQLite is
 * opened.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.ts";
import { activationFlockSupported, isPidAlive, tryAcquireFlock, releaseFlock } from "./backup-core.ts";
import { ProfileActivationError, sanitizeActivationText } from "./profile-activation-errors.ts";

export const ACTIVATION_SELECTION_FILENAME = "selection.json";
export const ACTIVATION_JOURNAL_FILENAME = "transition.json";
export const ACTIVATION_LOCK_FILENAME = "transition.lock";
export const ACTIVATION_HISTORY_DIRNAME = "history";

const MAX_SELECTION_BYTES = 16 * 1024;

/** Pinned at controlled startup (`db.ts`) for the lifetime of this process. */
let pinnedRuntimeActiveDataDir: string | null = null;
let pinnedRuntimeBaseDataDir: string | null = null;

/**
 * Freeze the active/base profile roots for a running server process. Later
 * changes to `selection.json` must not redirect an already-booted core.
 */
export function pinRuntimeProfileRoots(activeDataDir: string, baseDataDir: string): void {
  const active = canonicalizeProfilePath(activeDataDir);
  const base = canonicalizeProfilePath(baseDataDir);
  if (pinnedRuntimeActiveDataDir !== null) {
    if (pinnedRuntimeActiveDataDir !== active || pinnedRuntimeBaseDataDir !== base) {
      throw new ProfileActivationError(
        "Runtime profile roots were already pinned for this process",
        "IO_ERROR",
      );
    }
    return;
  }
  pinnedRuntimeActiveDataDir = active;
  pinnedRuntimeBaseDataDir = base;
}

/** Test-only: drop the runtime pin so another fixture can boot in-process. */
export function clearRuntimeProfilePinForTest(): void {
  pinnedRuntimeActiveDataDir = null;
  pinnedRuntimeBaseDataDir = null;
}

export function getPinnedRuntimeActiveDataDir(): string | null {
  return pinnedRuntimeActiveDataDir;
}

export function getPinnedRuntimeBaseDataDir(): string | null {
  return pinnedRuntimeBaseDataDir;
}

export interface ProfileSelection {
  version: 1;
  /** Monotonic counter, incremented on every committed selection change. */
  generation: number;
  /** Canonical absolute path of the profile this installation opens. */
  activeProfilePath: string;
  /** Stable identity derived from the canonical path (never from content). */
  activeProfileIdentity: string;
  /** Canonical path of the profile that was active before this transition. */
  previousProfilePath: string | null;
  previousProfileIdentity: string | null;
  /** Transition that produced this selection, or null for the initial one. */
  transitionId: string | null;
  updatedAt: number;
}

/**
 * The activation control directory for a base data directory.
 *
 * It is a hidden sibling, e.g. for `~/Library/Application Support/ForgeOrbit`
 * it is `~/Library/Application Support/.ForgeOrbit.forgeorbit-activation`.
 * Deriving it from the *base* (env-selected or platform default) keeps test
 * and developer profiles fully isolated while still being outside every
 * profile that can be replaced.
 */
export function activationControlDir(baseDataDir: string): string {
  const resolved = path.resolve(baseDataDir);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (!base || parent === resolved) {
    throw new ProfileActivationError("Base data directory has no usable parent for activation state", "INVALID_INPUT");
  }
  return path.join(parent, `.${base}.forgeorbit-activation`);
}

export function selectionFilePath(controlDir: string): string {
  return path.join(controlDir, ACTIVATION_SELECTION_FILENAME);
}

export function journalFilePath(controlDir: string): string {
  return path.join(controlDir, ACTIVATION_JOURNAL_FILENAME);
}

export function transitionLockPath(controlDir: string): string {
  return path.join(controlDir, ACTIVATION_LOCK_FILENAME);
}

/** macOS `/var` is a symlink to `/private/var`; normalize so identity matches post-create realpath. */
function normalizeDarwinVarPrefix(resolved: string): string {
  if (process.platform === "darwin" && resolved.startsWith("/var/") && !resolved.startsWith("/private/var/")) {
    return `/private${resolved}`;
  }
  return resolved;
}

/** macOS `/tmp` is a symlink to `/private/tmp`; normalize when ancestors are not yet materialized. */
function normalizeDarwinPublicSymlinks(resolved: string): string {
  if (process.platform === "darwin" && (resolved === "/tmp" || resolved.startsWith("/tmp/"))) {
    return `/private${resolved}`;
  }
  return normalizeDarwinVarPrefix(resolved);
}

/**
 * Canonical path without following the final component's symlink.
 *
 * Walks up through existing ancestors so a not-yet-created profile directory
 * still resolves `/tmp` → `/private/tmp` (and `/var` → `/private/var`) the same
 * way `realpathSync` will after the directory is created.
 */
export function canonicalizeProfilePath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return normalizeDarwinPublicSymlinks(resolved);
    }
    let tail = path.basename(resolved);
    let dir = path.dirname(resolved);
    for (;;) {
      try {
        const canonDir = realpathSync(dir);
        const combined = tail ? path.join(canonDir, tail) : canonDir;
        return normalizeDarwinPublicSymlinks(combined);
      } catch (inner) {
        const innerCode = (inner as NodeJS.ErrnoException).code;
        if (innerCode !== "ENOENT") {
          return normalizeDarwinPublicSymlinks(resolved);
        }
        if (dir === path.dirname(dir)) {
          return normalizeDarwinPublicSymlinks(resolved);
        }
        tail = path.join(path.basename(dir), tail);
        dir = path.dirname(dir);
      }
    }
  }
}

/** Stable, location-derived profile identity. Never derived from credentials. */
export function profileIdentityForPath(canonicalPath: string): string {
  return createHash("sha256").update(`forgeorbit-profile\0${canonicalPath}`).digest("hex");
}

export function isAbsoluteProfilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function currentUid(): number | null {
  try {
    return typeof process.getuid === "function" ? process.getuid() : null;
  } catch {
    return null;
  }
}

/** Validate a control directory (creating it only when `create` is set). */
export function ensureActivationControlDir(controlDir: string, create: boolean): void {
  let st;
  try {
    st = lstatSync(controlDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProfileActivationError("Activation control directory is unavailable", "CONTROL_DIR_UNTRUSTED");
    }
    if (!create) return;
    try {
      mkdirSync(controlDir, { recursive: false, mode: 0o700 });
    } catch (mkdirErr) {
      const code = (mkdirErr as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        ensureActivationControlDir(controlDir, false);
        return;
      }
      throw new ProfileActivationError("Activation control directory could not be created", "IO_ERROR");
    }
    return;
  }
  if (st.isSymbolicLink()) {
    throw new ProfileActivationError("Activation control directory must not be a symbolic link", "CONTROL_DIR_UNTRUSTED");
  }
  if (!st.isDirectory()) {
    throw new ProfileActivationError("Activation control path is not a directory", "CONTROL_DIR_UNTRUSTED");
  }
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) {
    throw new ProfileActivationError("Activation control directory is owned by another user", "CONTROL_DIR_UNTRUSTED");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ProfileActivationError(
      "Activation control directory must not be accessible by other users",
      "CONTROL_DIR_UNTRUSTED",
    );
  }
}

function readPrivateFile(file: string, maxBytes: number): string {
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw err;
    throw new ProfileActivationError("Activation state is unreadable", "IO_ERROR");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ProfileActivationError("Activation state must be a regular file", "JOURNAL_UNTRUSTED");
  }
  if (st.size > maxBytes) {
    throw new ProfileActivationError("Activation state exceeds its maximum size", "JOURNAL_CORRUPT");
  }
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) {
    throw new ProfileActivationError("Activation state is owned by another user", "JOURNAL_UNTRUSTED");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ProfileActivationError("Activation state must not be accessible by other users", "JOURNAL_UNTRUSTED");
  }
  return readFileSync(file, "utf8");
}

/** Read a bounded private state file with strict ownership/permission checks. */
export function readPrivateFileForState(file: string, maxBytes = 128 * 1024): string {
  return readPrivateFile(file, maxBytes);
}

/** Write JSON atomically: private temp file, full fsync, rename, directory fsync. */
export function writePrivateJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  ensureActivationControlDir(dir, true);
  const payload = JSON.stringify(value, null, 2);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, payload, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (err instanceof ProfileActivationError) throw err;
    throw new ProfileActivationError(
      `Activation state could not be persisted: ${sanitizeActivationText(err)}`,
      "IO_ERROR",
    );
  }
}

/** Strict structural validation of a selection record. */
export function parseProfileSelection(raw: unknown): ProfileSelection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileActivationError("Activation selection is not an object", "SELECTION_CORRUPT");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set([
    "version",
    "generation",
    "activeProfilePath",
    "activeProfileIdentity",
    "previousProfilePath",
    "previousProfileIdentity",
    "transitionId",
    "updatedAt",
  ]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new ProfileActivationError("Activation selection contains unknown fields", "SELECTION_CORRUPT");
  }
  if (record.version !== 1) {
    throw new ProfileActivationError("Unsupported activation selection version", "SELECTION_CORRUPT");
  }
  if (
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 0 ||
    !isAbsoluteProfilePath(record.activeProfilePath) ||
    !isSha256Hex(record.activeProfileIdentity) ||
    !isFiniteTimestamp(record.updatedAt)
  ) {
    throw new ProfileActivationError("Activation selection is malformed", "SELECTION_CORRUPT");
  }
  const previousPath = record.previousProfilePath;
  const previousIdentity = record.previousProfileIdentity;
  if (
    !(previousPath === null || isAbsoluteProfilePath(previousPath)) ||
    !(previousIdentity === null || isSha256Hex(previousIdentity)) ||
    (previousPath === null) !== (previousIdentity === null)
  ) {
    throw new ProfileActivationError("Activation selection history is malformed", "SELECTION_CORRUPT");
  }
  if (!(record.transitionId === null || isUuid(record.transitionId))) {
    throw new ProfileActivationError("Activation selection transition id is malformed", "SELECTION_CORRUPT");
  }
  return {
    version: 1,
    generation: record.generation as number,
    activeProfilePath: record.activeProfilePath,
    activeProfileIdentity: record.activeProfileIdentity,
    previousProfilePath: previousPath,
    previousProfileIdentity: previousIdentity,
    transitionId: record.transitionId,
    updatedAt: record.updatedAt,
  };
}

/** Read the committed selection. Returns null when no activation ever ran. */
export function readProfileSelection(controlDir: string): ProfileSelection | null {
  ensureActivationControlDir(controlDir, false);
  const file = selectionFilePath(controlDir);
  let text: string;
  try {
    text = readPrivateFile(file, MAX_SELECTION_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileActivationError("Activation selection is not valid JSON", "SELECTION_CORRUPT");
  }
  const selection = parseProfileSelection(parsed);
  assertSelectionPathIdentities(selection);
  return selection;
}

/** Bound selection paths to location-derived identities (FO-P2-005-A-R2). */
export function assertSelectionPathIdentities(selection: ProfileSelection): void {
  const activeCanonical = canonicalizeProfilePath(selection.activeProfilePath);
  if (profileIdentityForPath(activeCanonical) !== selection.activeProfileIdentity) {
    throw new ProfileActivationError(
      "Activation selection path identity does not match its stored identity",
      "SELECTION_CORRUPT",
    );
  }
  if (selection.previousProfilePath !== null) {
    const previousCanonical = canonicalizeProfilePath(selection.previousProfilePath);
    if (profileIdentityForPath(previousCanonical) !== selection.previousProfileIdentity) {
      throw new ProfileActivationError(
        "Activation selection previous path identity does not match its stored identity",
        "SELECTION_CORRUPT",
      );
    }
  }
}

/**
 * Construct the next selection record. The generation always advances, so a
 * stale reader can detect that the selection changed underneath it.
 */
export function buildSelection(input: {
  previous: ProfileSelection | null;
  activeProfilePath: string;
  activeProfileIdentity: string;
  previousProfilePath?: string | null;
  previousProfileIdentity?: string | null;
  transitionId: string | null;
  now: number;
}): ProfileSelection {
  return {
    version: 1,
    generation: (input.previous?.generation ?? 0) + 1,
    activeProfilePath: input.activeProfilePath,
    activeProfileIdentity: input.activeProfileIdentity,
    previousProfilePath: input.previousProfilePath ?? null,
    previousProfileIdentity: input.previousProfileIdentity ?? null,
    transitionId: input.transitionId,
    updatedAt: input.now,
  };
}

/** Remove a stale temporary file left by an interrupted atomic write. */
export function removeStaleStateTempFiles(controlDir: string): void {
  // Deliberately conservative: only our own `.selection.json.*.tmp` /
  // `.transition.json.*.tmp` siblings are removed, never a state file itself.
  try {
    const entries = existsSync(controlDir) ? (readdirSync(controlDir) as string[]) : [];
    for (const entry of entries) {
      if (!/^\..+\.json\.\d+\.[0-9]+\.tmp$/.test(entry)) continue;
      try {
        rmSync(path.join(controlDir, entry), { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

export interface TransitionLock {
  release(): void;
}

function tryLockOnce(lockPath: string): TransitionLock | null {
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new ProfileActivationError("Activation transition lock is unavailable", "TRANSITION_LOCK_UNAVAILABLE");
  }
  if (!tryAcquireFlock(fd)) {
    closeSync(fd);
    return null;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        releaseFlock(fd);
      } catch {
        /* ignore */
      }
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Acquire the cross-process transition lock. `timeoutMs === 0` is a single
 * non-blocking attempt (prepare/rollback requests); startup uses a bounded
 * wait so a simultaneous launch either observes the committed state or fails
 * closed instead of opening a half-selected profile.
 */
export function acquireTransitionLock(controlDir: string, timeoutMs = 0): TransitionLock {
  if (!activationFlockSupported()) {
    throw new ProfileActivationError(
      "Profile activation requires macOS kernel file locking, which is unavailable on this platform",
      "TRANSITION_LOCK_UNAVAILABLE",
    );
  }
  ensureActivationControlDir(controlDir, true);
  const lockPath = transitionLockPath(controlDir);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const lock = tryLockOnce(lockPath);
    if (lock) return lock;
    if (Date.now() >= deadline) {
      throw new ProfileActivationError(
        "Another ForgeOrbit process is changing the active profile",
        "TRANSITION_LOCKED",
      );
    }
    Bun.sleepSync(25);
  }
}

export interface LiveProfileOwner {
  pid: number;
  kind: "app" | "cli-daemon";
}

function readLiveCoreCreds(dataDir: string): LiveProfileOwner | null {
  const file = path.join(dataDir, "agetor-core.json");
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 8 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "app" && kind !== "cli-daemon") return null;
  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, kind };
}

function processLooksLikeForgeOrbit(pid: number): boolean {
  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-p", String(pid), "-o", "command="],
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
    });
    if (result.exitCode !== 0) return false;
    const command = new TextDecoder().decode(result.stdout).toLowerCase();
    return /forgeorbit|agetor|headless\.ts|native-bootstrap/.test(command);
  } catch {
    // Cannot prove ownership: err on the side of "might be live".
    return true;
  }
}

/**
 * Detect another live ForgeOrbit process that owns `dataDir`.
 *
 * A PID alone is explicitly not trusted: a live `agetor-core.json` is only
 * treated as ownership evidence when the PID is alive AND its command line
 * still looks like ForgeOrbit. A held `desktop-instance.lock` is stronger
 * evidence and is reported as a conflict when `checkDesktopLock` is set
 * (never for the base profile this process itself just locked).
 */
export function detectLiveProfileOwner(
  dataDir: string,
  options: { checkDesktopLock: boolean },
): LiveProfileOwner | null {
  const creds = readLiveCoreCreds(dataDir);
  if (creds && isPidAlive(creds.pid) && processLooksLikeForgeOrbit(creds.pid)) return creds;
  if (options.checkDesktopLock) {
    const lockPath = path.join(dataDir, "desktop-instance.lock");
    let st;
    try {
      st = lstatSync(lockPath);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || !st.isFile()) return null;
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    let acquired = false;
    try {
      acquired = tryAcquireFlock(fd);
    } finally {
      try {
        if (acquired) releaseFlock(fd);
      } catch {
        /* ignore */
      }
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (!acquired) {
      return { pid: 0, kind: "app" };
    }
  }
  return null;
}
