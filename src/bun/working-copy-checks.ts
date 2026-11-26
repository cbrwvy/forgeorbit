/**
 * Local project check runner for task working copies.
 *
 * Enforces both:
 *  1. Clear pre-spawn policy gates (blocking git push/remote, deployment,
 *     network clients, dependency installation, privilege escalation, and
 *     missing local tools with honest blockers instead of weakening boundaries).
 *  2. OS-level macOS Seatbelt confinement (`createWorkingCopyCommandBoundary`)
 *     for every executed command and its child processes: writes strictly to
 *     the working copy (read-only for Reviewer) and private 0700 scratch space,
 *     network completely denied, original project never writable.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  evaluateWorkingCopyCommandPolicy,
  extractRunShellChecksFromEvents,
  type WorkingCopyCheckRecord,
} from "../shared/working-copy-checks.ts";
import { testSummary } from "../shared/practical-cycle.ts";
import { sourceFingerprint } from "../shared/review-evidence.ts";
import { autonomyPolicyStore } from "./autonomy/policy-store.ts";
import { listedFiles, withPracticalTestLock } from "./autonomy/observed-test.ts";
import { dataDir, runs, tasks } from "./db.ts";
import { createBunProcessHost } from "./environment/process-host.ts";
import {
  createWorkingCopyCommandBoundary,
  workingCopyCommandRequest,
  type WorkingCopyCommandBoundary,
} from "./macos-offline-boundary.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { ownerProjectOf, taskInProject } from "./project-ownership.ts";
import { isWorkspaceDevelopmentEnabled, sandboxNotApplied } from "./project-permissions.ts";
import { getTaskWorkspace, recordWorkingCopyCheck, rescanSettledWorkspace } from "./task-workspace.ts";

export const WORKING_COPY_CHECK_TIMEOUT_MS = 60_000;
export const WORKING_COPY_CHECK_OUTPUT_BYTES = 64_000;

type CheckBoundaryFactory = typeof createWorkingCopyCommandBoundary;
let boundaryFactory: CheckBoundaryFactory = createWorkingCopyCommandBoundary;

export function setWorkingCopyCheckBoundaryFactoryForTest(factory: CheckBoundaryFactory | null): void {
  boundaryFactory = factory ?? createWorkingCopyCommandBoundary;
}

function resolveReadOnlyNodeModules(projectPath: string): string | null {
  let projectReal: string;
  try {
    projectReal = realpathSync(projectPath);
  } catch {
    return null;
  }
  const candidate = path.join(projectReal, "node_modules");
  try {
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    const real = realpathSync(candidate);
    if (real !== candidate || !real.startsWith(projectReal + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

function isSensitiveDir(dir: string, homeReal: string | null): boolean {
  if (!homeReal) return false;
  if (dir === homeReal) return true;
  const blocked = [
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".codex", ".claude",
    ".agetor", ".config", "Library", "Documents", "Desktop", "Downloads",
  ];
  return blocked.some((name) => {
    const p = path.join(homeReal, name);
    return dir === p || dir.startsWith(p + path.sep);
  });
}

function safeToolchainDirs(readOnlyNodeModules: string | null): string[] {
  let homeReal: string | null = null;
  try { homeReal = realpathSync(homedir()); } catch { homeReal = null; }
  const dirs: string[] = [];
  const add = (dir: string | null | undefined) => {
    if (!dir) return;
    try {
      const real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return;
      if (real === "/" || real.split("/").length < 2 || isSensitiveDir(real, homeReal)) return;
      if (!dirs.includes(real)) dirs.push(real);
    } catch { /* skip missing dir */ }
  };
  if (readOnlyNodeModules) add(path.join(readOnlyNodeModules, ".bin"));
  add(path.dirname(process.execPath));
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (!entry.trim()) continue;
    add(entry.trim());
  }
  add("/opt/homebrew/bin");
  add("/usr/local/bin");
  add("/usr/bin");
  add("/bin");
  return dirs;
}

function resolveLocalExecutable(
  tool: string,
  workingCopy: string,
  toolchainDirs: readonly string[],
): { ok: true; executable: string; extraReadRoots: string[] } | { ok: false; reason: string } {
  const isExecutableFile = (p: string): boolean => {
    try {
      const st = statSync(p);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };

  // Relative executable inside the working copy (e.g. ./scripts/check.sh)
  if (tool.includes("/")) {
    const abs = path.resolve(workingCopy, tool);
    try {
      const real = realpathSync(abs);
      if ((real === workingCopy || real.startsWith(workingCopy + path.sep)) && isExecutableFile(real)) {
        return { ok: true, executable: real, extraReadRoots: [] };
      }
    } catch { /* fall through */ }
    return {
      ok: false,
      reason: `Local tool "${tool}" was not found or is not executable inside the working copy.`,
    };
  }

  if (tool === "bun") {
    try {
      const bunReal = realpathSync(process.execPath);
      if (isExecutableFile(bunReal)) {
        return { ok: true, executable: bunReal, extraReadRoots: [path.dirname(bunReal)] };
      }
    } catch { /* fall through to PATH */ }
  }

  for (const dir of toolchainDirs) {
    const candidate = path.join(dir, tool);
    if (!existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      if (isExecutableFile(real)) {
        const extra = new Set<string>([path.dirname(real), dir]);
        return { ok: true, executable: real, extraReadRoots: [...extra] };
      }
    } catch { /* try next dir */ }
  }

  return {
    ok: false,
    reason: `Required local tool "${tool}" is not available in this environment. ForgeOrbit does not install dependencies automatically.`,
  };
}

function inspectPackageScriptBlocker(workingCopy: string, argv: readonly string[]): string | null {
  const lead = argv[0] ?? "";
  if (lead !== "bun" && lead !== "npm" && lead !== "yarn" && lead !== "pnpm") return null;
  let scriptName: string | null = null;
  if (argv[1] === "run" && argv[2] && !argv[2].startsWith("-")) scriptName = argv[2];
  else if (argv[1] === "test" && (lead === "npm" || lead === "yarn" || lead === "pnpm")) scriptName = "test";
  else if (lead === "yarn" && argv[1] && !argv[1].startsWith("-")) scriptName = argv[1];
  if (!scriptName) return null;

  const pkgPath = path.join(workingCopy, "package.json");
  try {
    const st = lstatSync(pkgPath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    const body = pkg?.scripts?.[scriptName];
    if (typeof body !== "string" || !body.trim()) return null;
    const trimmed = body.trim();
    if (/\bgit\s+(push|fetch|pull|clone|remote)\b/i.test(trimmed)) {
      return `Package script "${scriptName}" invokes a blocked remote Git operation.`;
    }
    if (/\b(curl|wget|ssh|scp|rsync|vercel|netlify|kubectl|terraform|docker)\b/i.test(trimmed)) {
      return `Package script "${scriptName}" invokes a network or deployment command outside working-copy policy.`;
    }
    if (/\b(npm|bun|yarn|pnpm)\s+(install|i|ci|add|publish)\b|\b(npx|bunx)\b/i.test(trimmed)) {
      return `Package script "${scriptName}" attempts dependency installation or package download, which is blocked by working-copy policy.`;
    }
  } catch {
    return null;
  }
  return null;
}

function classifyMissingDependencyHint(stderr: string, stdout: string): string | null {
  const combined = `${stderr}\n${stdout}`;
  if (/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/i.test(combined)) {
    return "The check failed because a required local dependency is not installed. ForgeOrbit does not install dependencies or enable network access for project commands.";
  }
  if (/Operation not permitted|EPERM|ENETUNREACH|EAI_AGAIN|FailedToOpenSocket|unable to connect/i.test(combined)) {
    return "The check failed because a network or out-of-sandbox operation was blocked by the working-copy sandbox.";
  }
  return null;
}

function fingerprintWorkingCopy(stagingPath: string): string | null {
  try {
    return sourceFingerprint(listedFiles(stagingPath));
  } catch {
    return null;
  }
}

export async function runWorkingCopyCheck(input: {
  taskId: string;
  command: string | readonly string[];
  role?: "developer" | "reviewer";
  allowDuringExecution?: boolean;
  timeoutMs?: number;
  persist?: boolean;
}): Promise<WorkingCopyCheckRecord> {
  const id = randomUUID();
  const startedAt = Date.now();
  const role = input.role ?? "developer";
  const persist = input.persist !== false;
  const rawCommand = typeof input.command === "string" ? input.command.trim() : input.command.join(" ");

  const recordBlocked = (reason: string, cwd = "", argv: string[] = [], fp: string | null = null): WorkingCopyCheckRecord => {
    const rec: WorkingCopyCheckRecord = {
      id,
      command: rawCommand,
      argv,
      cwd,
      status: "blocked",
      exitCode: null,
      summary: null,
      reason,
      isolation: "blocked",
      startedAt,
      finishedAt: Date.now(),
      sourceFingerprint: fp,
      observedByForgeOrbit: true,
    };
    if (persist && cwd) recordWorkingCopyCheck(input.taskId, rec);
    return rec;
  };

  const task = tasks.get(input.taskId);
  if (!task) return recordBlocked("Task not found. No command was started.");
  if (task.pipelineParentId) return recordBlocked("Pipeline step tasks cannot run working-copy checks directly.");

  const projectPath = ownerProjectOf(task.workdir, { fresh: true });
  if (!projectPath || !taskInProject(task, projectPath, { fresh: true })) {
    return recordBlocked("The task does not belong to a registered project. No command was started.");
  }
  if (autonomyPolicyStore.readEmergency().active) {
    return recordBlocked("Emergency stop is active. No command was started.");
  }
  const admission = checkProjectLaunchAdmission(projectPath);
  if (!admission.allowed) {
    return recordBlocked(`${admission.reason ?? "Project AI execution is stopped."} No command was started.`);
  }

  const workspace = getTaskWorkspace(input.taskId);
  if (!workspace || workspace.taskId !== input.taskId || workspace.projectPath !== projectPath) {
    return recordBlocked("No task working copy is bound to this task and project. No command was started.");
  }
  if (workspace.writeScope !== "working-copy") {
    return recordBlocked("This task workspace uses explicit output paths; Development in a working copy is not active for this workspace.");
  }
  const validStatus = input.allowDuringExecution
    ? (workspace.status === "executing" || workspace.status === "settled" || workspace.status === "publication-partial")
    : (workspace.status === "settled" || workspace.status === "publication-partial");
  if (!validStatus) {
    return recordBlocked(`The working copy is ${workspace.status}. Local checks can run only while executing or after the run has settled.`);
  }
  // An already-executing working-copy run stays under the policy it launched with; post-run checks require the project setting to still be enabled.
  if (!(input.allowDuringExecution && workspace.status === "executing") && !isWorkspaceDevelopmentEnabled(projectPath)) {
    return recordBlocked("Development in a working copy is disabled for this project. Enable it in Project settings to run local checks without per-command approval.");
  }

  let workingCopy: string;
  try {
    workingCopy = realpathSync(workspace.stagingPath);
  } catch {
    return recordBlocked("The task working copy is missing. No command was started.");
  }
  const fp = fingerprintWorkingCopy(workingCopy);

  const policy = evaluateWorkingCopyCommandPolicy(input.command);
  if (!policy.ok) {
    return recordBlocked(policy.reason, workingCopy, [], fp);
  }

  const scriptBlocker = inspectPackageScriptBlocker(workingCopy, policy.argv);
  if (scriptBlocker) {
    return recordBlocked(scriptBlocker, workingCopy, policy.argv, fp);
  }

  const readOnlyNodeModules = resolveReadOnlyNodeModules(projectPath);
  const toolchainDirs = safeToolchainDirs(readOnlyNodeModules);
  const resolvedTool = resolveLocalExecutable(policy.argv[0]!, workingCopy, toolchainDirs);
  if (!resolvedTool.ok) {
    return recordBlocked(resolvedTool.reason, workingCopy, policy.argv, fp);
  }

  // Dedicated private 0700 scratch directory for temp files & build caches produced by this check.
  const baseScratch = workspace.scratchPath && existsSync(workspace.scratchPath)
    ? workspace.scratchPath
    : path.join(dataDir, "working-copy-check-scratch");
  const checkScratch = path.join(baseScratch, `check-${id.slice(0, 12)}`);
  try {
    mkdirSync(checkScratch, { recursive: true, mode: 0o700 });
    chmodSync(checkScratch, 0o700);
  } catch (error) {
    return recordBlocked(
      error instanceof Error ? error.message : "Could not create a private scratch directory for this check.",
      workingCopy,
      policy.argv,
      fp,
    );
  }

  const cleanupScratch = () => {
    try { rmSync(checkScratch, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  };

  let boundary: WorkingCopyCommandBoundary;
  try {
    boundary = boundaryFactory({
      workingCopy,
      scratch: realpathSync(checkScratch),
      role,
      executable: resolvedTool.executable,
      readOnlyNodeModules,
      extraReadRoots: resolvedTool.extraReadRoots,
    });
  } catch (error) {
    cleanupScratch();
    return recordBlocked(
      error instanceof Error ? error.message : "The macOS Seatbelt boundary could not be built. No command was started.",
      workingCopy,
      policy.argv,
      fp,
    );
  }

  const timeoutMs = input.timeoutMs ?? WORKING_COPY_CHECK_TIMEOUT_MS;
  const pathEnv = toolchainDirs.join(":");
  const outcome = await withPracticalTestLock(async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let bytes = 0;
    let outputExceeded = false;
    const host = createBunProcessHost({ perlAvailable: false });
    const started = await host.start(
      workingCopyCommandRequest(boundary, policy.argv.slice(1), "b".repeat(32), (stream, text) => {
        bytes += Buffer.byteLength(text);
        if (bytes > WORKING_COPY_CHECK_OUTPUT_BYTES) {
          outputExceeded = true;
          return;
        }
        (stream === "stdout" ? stdout : stderr).push(text);
      }, pathEnv),
    );
    if (!started.ok) {
      return {
        started: false as const,
        reason: started.detail || "The sandboxed check process could not be started.",
        exitCode: null as number | null,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputExceeded: false,
        interrupted: false,
        finishedAt: Date.now(),
      };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      started.process.signal("SIGKILL");
    }, timeoutMs);
    const exit = await started.process.exited;
    clearTimeout(timer);
    if (outputExceeded) {
      try { started.process.signal("SIGKILL"); } catch { /* already gone */ }
    }
    const interrupted = !timedOut && exit.signal != null && exit.code == null;
    return {
      started: true as const,
      reason: null as string | null,
      exitCode: timedOut || interrupted || outputExceeded ? null : exit.code,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      timedOut,
      outputExceeded,
      interrupted,
      finishedAt: Date.now(),
    };
  });

  cleanupScratch();

  if (!outcome.started) {
    return recordBlocked(outcome.reason, workingCopy, policy.argv, fp);
  }

  const summary = testSummary(outcome.stdout, outcome.stderr, outcome.exitCode);

  if (sandboxNotApplied({ exitCode: outcome.exitCode, stderr: outcome.stderr })) {
    const rec: WorkingCopyCheckRecord = {
      id,
      command: policy.command,
      argv: policy.argv,
      cwd: workingCopy,
      status: "blocked",
      exitCode: null,
      summary,
      reason: "The macOS Seatbelt sandbox could not be applied here (sandbox-exec refused to start it). The command did not run.",
      isolation: "blocked",
      startedAt,
      finishedAt: outcome.finishedAt,
      sourceFingerprint: fp,
      observedByForgeOrbit: true,
    };
    if (persist) recordWorkingCopyCheck(input.taskId, rec);
    return rec;
  }

  if (outcome.timedOut || outcome.outputExceeded || outcome.interrupted || outcome.exitCode == null) {
    const reason = outcome.timedOut
      ? `Check command exceeded ${timeoutMs}ms and was stopped. No pass was recorded.`
      : outcome.outputExceeded
        ? "Check output exceeded the capture limit and was stopped. No pass was recorded."
        : "The check process was interrupted before it exited. No pass was recorded.";
    const rec: WorkingCopyCheckRecord = {
      id,
      command: policy.command,
      argv: policy.argv,
      cwd: workingCopy,
      status: "interrupted",
      exitCode: null,
      summary,
      reason,
      isolation: "macos-offline-seatbelt",
      startedAt,
      finishedAt: outcome.finishedAt,
      sourceFingerprint: fp,
      observedByForgeOrbit: true,
    };
    if (persist) recordWorkingCopyCheck(input.taskId, rec);
    return rec;
  }

  const passed = outcome.exitCode === 0;
  const failHint = passed ? null : classifyMissingDependencyHint(outcome.stderr, outcome.stdout);
  const rec: WorkingCopyCheckRecord = {
    id,
    command: policy.command,
    argv: policy.argv,
    cwd: workingCopy,
    status: passed ? "passed" : "failed",
    exitCode: outcome.exitCode,
    summary,
    reason: passed
      ? "The local check ran in the offline working-copy sandbox and passed."
      : (failHint ?? `The local check ran in the offline working-copy sandbox and failed (exit code ${outcome.exitCode}).`),
    isolation: "macos-offline-seatbelt",
    startedAt,
    finishedAt: outcome.finishedAt,
    sourceFingerprint: fp,
    observedByForgeOrbit: true,
  };
  if (persist) {
    recordWorkingCopyCheck(input.taskId, rec);
    if (workspace.status === "settled" || workspace.status === "publication-partial") {
      rescanSettledWorkspace(input.taskId);
    }
  }
  return rec;
}

/**
 * Extract shell commands that actually executed during a Developer run
 * (e.g. Codex `command_execution` tool_use/tool_result pairs).
 * Never treats a Developer process's exit code 0 or assistant prose as a check.
 */
export function extractRunShellChecks(runId: string, cwd: string): WorkingCopyCheckRecord[] {
  return extractRunShellChecksFromEvents(runs.events(runId), cwd);
}
