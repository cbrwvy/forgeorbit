/** FO-DEEPSEEK03 experimental, offline-only Seatbelt policy.
 * This is NOT an admitted harness, grant, or all-descendant lifetime boundary.
 * No existing provider uses it. Callers must own immutable runtime files and
 * stable roots; same-UID host mutation and already-open descriptors are outside
 * a path policy. Never pass credentials, ambient env, or inherited file handles.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalStartRequest } from "./environment/process-host.ts";

export interface OfflineBoundaryInput {
  project: string;
  scratch: string;
  role: "developer" | "reviewer";
  executable: string;
  /** Exact, explicitly trusted read-only runtime files; never a user HOME. */
  runtimeFiles?: readonly string[];
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(p: string): string {
  if (!path.isAbsolute(p) || /[\x00-\x1f\x7f]/.test(p)) throw new Error("An absolute path without control characters is required.");
  return realpathSync(p);
}
function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root + "/");
}
function literal(p: string): string { return `(literal ${JSON.stringify(p)})`; }
function subtree(p: string): string { return `(subpath ${JSON.stringify(p)})`; }

export function createOfflineMacosBoundary(input: OfflineBoundaryInput) {
  if (process.platform !== "darwin") throw new Error("macOS Seatbelt is required; no fallback.");
  if (input.role !== "developer" && input.role !== "reviewer") throw new Error("Unknown filesystem role.");
  const project = canonical(input.project), scratch = canonical(input.scratch);
  for (const p of [project, scratch]) {
    if (!statSync(p).isDirectory() || p.split("/").length < 4) throw new Error("A dedicated project/scratch directory is required.");
  }
  if (under(project, scratch) || under(scratch, project)) throw new Error("Project and scratch must be disjoint.");
  if ((statSync(scratch).mode & 0o077) !== 0) throw new Error("Scratch must be private (0700).");
  const executable = canonical(input.executable);
  const runtimeFiles = [...new Set([executable, ...(input.runtimeFiles ?? []).map(canonical)])].sort();
  for (const p of runtimeFiles) {
    if (!statSync(p).isFile() || under(p, project) || under(p, scratch)) throw new Error("Runtime files must be outside writable roots.");
  }
  if (!(statSync(executable).mode & 0o111)) throw new Error("Runtime is not executable.");
  // Freeze the actual imported bootstrap text, rather than a mutable include.
  // Apple's system.sb is deliberately NOT imported: it grants broad IPC, /dev/fd
  // and unrelated filesystem exceptions. dyld-support is the narrow boot subset.
  const dyld = readFileSync("/System/Library/Sandbox/Profiles/dyld-support.sb", "utf8");
  const roots = ["/System/Library", "/usr/lib"];
  const profile = [
    "(version 1)", "(deny default)", dyld,
    "(allow syscall* mach-bootstrap sysctl-read)",
    `(allow file-read* file-map-executable ${roots.map(subtree).join(" ")} ${runtimeFiles.map(literal).join(" ")})`,
    `(allow file-read* ${subtree(project)} ${subtree(scratch)})`,
    `(allow file-write* ${[scratch, ...(input.role === "developer" ? [project] : [])].map(subtree).join(" ")})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-write-data (literal "/dev/null"))',
    `(allow process-exec ${literal(executable)})`,
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    // No network*, mach-lookup, ipc*, process-info*, device*, user HOME,
    // shared TMPDIR, executable mappings in project/scratch, or shell exception.
  ].join("\n") + "\n";
  const identity = (p: string) => {
    const s = statSync(p);
    return { path: p, dev: s.dev, ino: s.ino, mode: s.mode };
  };
  const snapshot = Object.freeze({
    id: "fo-deepseek03-offline-seatbelt-v1", role: input.role, project, scratch, executable,
    roots: Object.freeze([identity(project), identity(scratch)].map(Object.freeze)),
    runtime: Object.freeze(runtimeFiles.map(p => Object.freeze({ ...identity(p), sha256: hash(readFileSync(p)) }))),
    dyldDigest: hash(dyld), profileDigest: hash(profile),
    network: "denied", machServices: "denied", admission: "offline-only",
  });
  const digest = hash(JSON.stringify(snapshot));
  return Object.freeze({ snapshot, profile, digest });
}

export type OfflineMacosBoundary = ReturnType<typeof createOfflineMacosBoundary>;

/** Uses the existing process host/group supervisor. sandbox-exec applies the
 * profile or fails before exec. No shell or unsandboxed retry exists here.
 * This request supplies ignore/pipe stdio through LocalProcessHost, never file
 * descriptors. It does not solve children that deliberately leave the group.
 */
export function offlineBoundaryRequest(boundary: OfflineMacosBoundary, args: readonly string[],
  token: string, onOutput: LocalStartRequest["onOutput"]): LocalStartRequest {
  const s = boundary.snapshot;
  const current = createOfflineMacosBoundary({ project: s.project, scratch: s.scratch, role: s.role,
    executable: s.executable, runtimeFiles: s.runtime.map(r => r.path) });
  if (current.digest !== boundary.digest || current.profile !== boundary.profile) throw new Error("Offline boundary identity changed; no fallback.");
  return {
    executable: "/usr/bin/sandbox-exec", args: ["-p", boundary.profile, s.executable, ...args],
    cwd: s.project, processGroup: true, token, onOutput,
    env: { HOME: s.scratch, TMPDIR: s.scratch, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  };
}

export interface WorkingCopyCommandBoundaryInput {
  workingCopy: string;
  scratch: string;
  role: "developer" | "reviewer";
  executable: string;
  /** Optional canonical read-only node_modules directory from the original project (NEVER writable). */
  readOnlyNodeModules?: string | null;
  /** Optional extra read-only runtime directories (e.g. ~/.bun/bin); NEVER user HOME or credential dirs. */
  extraReadRoots?: readonly string[];
}

const SYSTEM_READ_ROOTS = [
  "/System/Library",
  "/usr/lib",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/usr/share",
  "/Library/Developer/CommandLineTools",
  "/opt/homebrew",
  "/usr/local/bin",
  "/usr/local/lib",
] as const;

const DENIED_EXEC_BINARIES = [
  "/usr/bin/sandbox-exec",
  "/usr/bin/sudo",
  "/usr/bin/su",
  "/usr/bin/osascript",
  "/usr/bin/open",
  "/usr/bin/security",
  "/usr/bin/codesign",
  "/usr/bin/defaults",
  "/usr/bin/ssh",
  "/usr/bin/scp",
  "/usr/bin/sftp",
  "/usr/bin/curl",
  "/usr/bin/nc",
  "/usr/bin/ftp",
] as const;

function ancestorDirectories(targets: readonly string[]): string[] {
  const out = new Set<string>(["/"]);
  for (const target of targets) {
    let cursor = path.dirname(target);
    while (cursor && cursor !== "/") {
      out.add(cursor);
      const next = path.dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
  }
  return [...out].sort();
}

function isSensitiveHomeRoot(p: string, home: string | null): boolean {
  if (!home) return false;
  if (p === home) return true;
  const blocked = [
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".codex", ".claude",
    ".agetor", ".config", "Library", "Documents", "Desktop", "Downloads",
  ];
  return blocked.some((name) => {
    const candidate = path.join(home, name);
    return p === candidate || under(p, candidate);
  });
}

/**
 * Deny-default macOS Seatbelt boundary for local project checks (tests, lint,
 * typecheck, build) inside an isolated task working copy.
 *
 * Guarantees enforced by the macOS kernel for the process and every child:
 * - Writes ONLY inside `workingCopy` (when role === "developer") and private 0700 `scratch`.
 * - Reviewer role mounts `workingCopy` read-only (`scratch` only writable).
 * - Original project is NEVER writable (optional `node_modules` is strictly read-only).
 * - Symlinks escaping `workingCopy` cannot be written through: Seatbelt evaluates resolved vnode paths.
 * - Network is completely denied (zero `network*` rules).
 * - Other projects, personal folders, credentials, and ForgeOrbit dataDir are inaccessible.
 */
export function createWorkingCopyCommandBoundary(input: WorkingCopyCommandBoundaryInput) {
  if (process.platform !== "darwin") throw new Error("macOS Seatbelt is required; no fallback.");
  if (input.role !== "developer" && input.role !== "reviewer") throw new Error("Unknown filesystem role.");
  const workingCopy = canonical(input.workingCopy);
  const scratch = canonical(input.scratch);
  for (const p of [workingCopy, scratch]) {
    if (!statSync(p).isDirectory() || p.split("/").length < 4) throw new Error("A dedicated working copy and scratch directory are required.");
  }
  if (under(workingCopy, scratch) || under(scratch, workingCopy)) throw new Error("Working copy and scratch must be disjoint.");
  if ((statSync(scratch).mode & 0o077) !== 0) throw new Error("Scratch must be private (0700).");

  const executable = canonical(input.executable);
  if (!statSync(executable).isFile() || !(statSync(executable).mode & 0o111)) {
    throw new Error("Check tool executable is missing or not executable.");
  }
  if (under(executable, scratch)) throw new Error("Check tool executable must sit outside scratch.");

  let homeCanonical: string | null = null;
  try { homeCanonical = realpathSync(homedir()); } catch { homeCanonical = null; }

  const readRoots = new Set<string>();
  for (const sysRoot of SYSTEM_READ_ROOTS) {
    if (!existsSync(sysRoot)) continue;
    try {
      const real = canonical(sysRoot);
      if (statSync(real).isDirectory()) readRoots.add(real);
    } catch { /* ignore unavailable optional system dirs */ }
  }

  let readOnlyNodeModules: string | null = null;
  if (input.readOnlyNodeModules) {
    const nm = canonical(input.readOnlyNodeModules);
    if (!statSync(nm).isDirectory() || under(nm, workingCopy) || under(workingCopy, nm) || under(nm, scratch) || under(scratch, nm)) {
      throw new Error("Read-only node_modules must be a disjoint directory outside the working copy and scratch.");
    }
    readOnlyNodeModules = nm;
    readRoots.add(nm);
  }

  const candidateExtra = [path.dirname(executable), ...(input.extraReadRoots ?? [])];
  for (const raw of candidateExtra) {
    if (!raw) continue;
    const real = canonical(raw);
    if (!statSync(real).isDirectory()) continue;
    if (under(real, workingCopy) || under(real, scratch)) continue;
    if (real === "/" || real.split("/").length < 3 || isSensitiveHomeRoot(real, homeCanonical)) {
      throw new Error(`Refusing overly broad or sensitive runtime root: ${real}`);
    }
    readRoots.add(real);
  }

  const sortedReadRoots = [...readRoots].sort();
  const metadataAncestors = ancestorDirectories([workingCopy, scratch, ...sortedReadRoots]);
  const execRoots = sortedReadRoots.filter((r) => r !== workingCopy && r !== scratch);
  const dyld = readFileSync("/System/Library/Sandbox/Profiles/dyld-support.sb", "utf8");
  const writableRoots = input.role === "developer" ? [scratch, workingCopy] : [scratch];

  const profile = [
    "(version 1)",
    "(deny default)",
    dyld,
    "(allow syscall* mach-bootstrap sysctl-read)",
    `(allow file-read-metadata ${metadataAncestors.map(literal).join(" ")})`,
    `(allow file-read* file-map-executable ${sortedReadRoots.map(subtree).join(" ")})`,
    `(allow file-read* ${subtree(workingCopy)} ${subtree(scratch)})`,
    `(allow file-write* ${writableRoots.map(subtree).join(" ")})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (subpath "/dev/fd"))',
    '(allow file-write-data (literal "/dev/null"))',
    `(allow process-exec ${literal(executable)} ${execRoots.map(subtree).join(" ")})`,
    `(deny process-exec ${DENIED_EXEC_BINARIES.map(literal).join(" ")})`,
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    // Network, mach-lookup, ipc*, user HOME, shared TMPDIR, other projects, and original project writes are denied.
  ].join("\n") + "\n";

  const identity = (p: string) => {
    const s = statSync(p);
    return { path: p, dev: s.dev, ino: s.ino, mode: s.mode };
  };
  const snapshot = Object.freeze({
    id: "fo-working-copy-command-seatbelt-v1",
    role: input.role,
    workingCopy,
    scratch,
    executable,
    readOnlyNodeModules,
    readRoots: Object.freeze(sortedReadRoots),
    roots: Object.freeze([identity(workingCopy), identity(scratch)].map(Object.freeze)),
    executableIdentity: Object.freeze(identity(executable)),
    dyldDigest: hash(dyld),
    profileDigest: hash(profile),
    network: "denied",
    machServices: "denied",
  });
  const digest = hash(JSON.stringify(snapshot));
  return Object.freeze({ snapshot, profile, digest });
}

export type WorkingCopyCommandBoundary = ReturnType<typeof createWorkingCopyCommandBoundary>;

export function workingCopyCommandRequest(
  boundary: WorkingCopyCommandBoundary,
  args: readonly string[],
  token: string,
  onOutput: LocalStartRequest["onOutput"],
  pathEnv: string,
): LocalStartRequest {
  const s = boundary.snapshot;
  const current = createWorkingCopyCommandBoundary({
    workingCopy: s.workingCopy,
    scratch: s.scratch,
    role: s.role,
    executable: s.executable,
    readOnlyNodeModules: s.readOnlyNodeModules,
    extraReadRoots: s.readRoots.filter((r) => !(SYSTEM_READ_ROOTS as readonly string[]).includes(r) && r !== s.readOnlyNodeModules),
  });
  if (current.digest !== boundary.digest || current.profile !== boundary.profile) {
    throw new Error("Working-copy Seatbelt boundary identity changed; no fallback.");
  }
  const env: Record<string, string> = {
    HOME: s.scratch,
    TMPDIR: s.scratch,
    TEMP: s.scratch,
    TMP: s.scratch,
    XDG_CACHE_HOME: path.join(s.scratch, ".cache"),
    PATH: pathEnv,
    LANG: "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
  if (s.readOnlyNodeModules) env.NODE_PATH = s.readOnlyNodeModules;
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", boundary.profile, s.executable, ...args],
    cwd: s.workingCopy,
    processGroup: true,
    token,
    onOutput,
    env,
  };
}
