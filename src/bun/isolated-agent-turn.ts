/**
 * One-shot, text-only agent turn outside the task system (FO-003, shared
 * with the FO-005A project manager).
 *
 * A turn goes through the same `spawnAgent` adapters tasks use (binary
 * resolution, harness env, auth, model flags) but is NOT a task: no task
 * row, no run row, no worktree. It runs in a fresh empty scratch folder
 * (a short private runtime for Cursor) with the hardening
 * flags `interview-isolation.ts` resolved, and everything it leaves behind
 * (the scratch folder, the driver's `<runId>.*` log files) is removed when
 * it settles.
 *
 * Callers own their own job bookkeeping and reply parsing; this module only
 * spawns, collects the assistant text, and cleans up. Its registry of
 * running turns backs the exit-time kill and the boot sweep for every
 * caller, so nothing a turn starts outlives the process.
 */

import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDriverIsFake, harnessEnv, resolveBin, spawnAgent } from "./agents.ts";
import { dataDir, projects } from "./db.ts";
import { killSessionByName, sessionNameFor, type SpawnedAgent } from "./claude-tmux.ts";
import { resolveTmuxBin, tmuxClientEnv, tmuxSocketArgs } from "./tmux-resolution.ts";
import { redactSecrets } from "../shared/project-interview.ts";
import { codexUsageLimitRetryHint, isCodexProviderAgent, legacyCodexUsageLimitLine, trustedCodexQuotaProof, type CodexQuotaEvent } from "../shared/codex-quota-failure.ts";
import { prepareCursorRuntime, removeCursorRuntime, removeRecordedCursorRuntime, type CursorRuntime } from "./cursor-runtime-isolation.ts";
import { providerRefusalEvidence } from "../shared/provider-refusal.ts";
import {
  consumeHeadTurnLaunchTicket,
  discardUnconsumedLaunchTicket,
  discardUnconsumedSpawnAuthorization,
} from "./owner-trust/launch-gate.ts";
import type { Harness } from "../shared/types.ts";

const DIAG_LINES = 20;

const SCRATCH_ROOT = path.join(dataDir, "interview-scratch");
/** Per-run driver logs live here, named `<runId>.*`. */
const DRIVER_LOG_DIRS = ["codex-logs", "cursor-logs", "antigravity-logs"].map((dir) => path.join(dataDir, dir));

export interface IsolatedTurnSpec {
  /** A uuid. Names the scratch folder, the run id and the tmux session. */
  turnId: string;
  harness: Harness;
  mode: string;
  model: string;
  effort: string | null;
  fast: boolean;
  maxMode: boolean;
  prompt: string;
  lockdownArgs: string[];
  timeoutMs: number;
  /** Single-use production macOS Owner launch ticket bound to this exact turn. */
  ownerLaunch?: {
    grantId: string;
    taskStateDigest: string;
  };
}

/** Shared between the caller and the runner: the caller sets
 *  `cancelRequested` and the runner kills `handle` once it exists. */
export interface IsolatedTurnControl {
  cancelRequested: boolean;
  handle: SpawnedAgent | null;
}

/**
 * Provider evidence from a failed turn, when the provider itself refused the request. Built only
 * from the provider's error events on the process stream (never assistant or user text) and
 * checked with the same trusted proof that batch recovery uses.
 */
export interface IsolatedProviderRefusal {
  kind: "usage-limit";
  proof: import("../shared/provider-refusal.ts").ProviderRefusalProof;
  retryHint: string | null;
  diagnostics: string;
}

export type IsolatedTurnOutcome =
  | { kind: "ok"; text: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string; providerRefusal?: IsolatedProviderRefusal };

/** Running turns by session name, for the exit-time kill. */
const running = new Map<string, IsolatedTurnControl>();

function compactOf(turnId: string): string {
  return turnId.replace(/-/g, "");
}

/**
 * `sessionNameFor` keeps the first 12 characters, so the key is exactly 12
 * and can never collide with a task's uuid prefix. The scratch folder is
 * named by the same compact id, which is what lets the boot sweep find the
 * session of a turn a crashed process left behind.
 */
export function isolatedSessionKey(turnId: string): string {
  return `iv-${compactOf(turnId).slice(0, 9)}`;
}

export function isolatedRunId(turnId: string): string {
  return `interview-${compactOf(turnId)}`;
}

export function isolatedTurnScratchDir(turnId: string): string {
  return path.join(SCRATCH_ROOT, compactOf(turnId));
}

export function isolatedSessionName(turnId: string): string {
  return sessionNameFor(isolatedSessionKey(turnId));
}

function removeRunFiles(runId: string): void {
  for (const dir of DRIVER_LOG_DIRS) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(`${runId}.`)) continue;
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        /* already gone */
      }
    }
  }
}

/** Ask a running turn to stop; the runner settles it as cancelled. */
export function cancelIsolatedTurn(control: IsolatedTurnControl): void {
  control.cancelRequested = true;
  try {
    control.handle?.kill();
  } catch {
    /* the runner settles regardless */
  }
}

/**
 * The trusted Codex usage-limit proof over this turn\'s provider error events. The turn is one failed
 * Codex process, so it is bound exactly like a failed task run: machine token, or the exact CLI
 * sentence on an `error:` / `turn.failed:` line of a Codex agent with a Codex session id.
 */
export function providerRefusalOf(agent: string, sessionId: string | null, events: CodexQuotaEvent[]): IsolatedProviderRefusal | null {
  return providerRefusalEvidence(agent, sessionId, events);
}

/** Run one turn to completion. Never throws. */
export async function runIsolatedTurn(spec: IsolatedTurnSpec, control: IsolatedTurnControl): Promise<IsolatedTurnOutcome> {
  const compact = compactOf(spec.turnId);
  if (!/^[0-9a-f]{32}$/.test(compact)) return { kind: "failed", error: "Invalid isolated turn ID." };
  const sessionKey = isolatedSessionKey(spec.turnId);
  const sessionName = sessionNameFor(sessionKey);
  if (running.has(sessionName)) {
    discardUnconsumedLaunchTicket(spec.ownerLaunch?.grantId);
    return { kind: "failed", error: "Isolated turn session name is already in use." };
  }
  if (control.cancelRequested) {
    discardUnconsumedLaunchTicket(spec.ownerLaunch?.grantId);
    return { kind: "cancelled" };
  }
  const runId = isolatedRunId(spec.turnId);
  const cwd = isolatedTurnScratchDir(spec.turnId);
  const assistant: string[] = [];
  const diagnostics: string[] = [];
  // Provider error events, with the adapter's line ids, for the trusted refusal proof.
  const providerErrors: CodexQuotaEvent[] = [];
  let providerSessionId: string | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  running.set(sessionName, control);
  let cursorRuntime: CursorRuntime | undefined;
  let scratchCreated = false;
  let turnCwd = cwd;
  try {
    mkdirSync(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { mode: 0o700 });
    scratchCreated = true;
    if (spec.harness.kind === "cursor" && !agentDriverIsFake("cursor")) {
      const prepared = prepareCursorRuntime({
        bin: resolveBin(spec.harness),
        harnessEnv: harnessEnv(spec.harness),
        harnessHome: spec.harness.home,
        protectedPaths: [dataDir, ...projects.list().map((p) => p.path)],
        network: true,
      });
      if (!prepared.ok) {
        return { kind: "failed", error: `Cursor runtime isolation refused: ${prepared.error}` };
      }
      cursorRuntime = prepared.value;
      writeFileSync(path.join(cwd, "cursor-runtime.json"), JSON.stringify(cursorRuntime.receipt), { mode: 0o600, flag: "wx" });
      turnCwd = cursorRuntime.paths.work;
    }
    if (control.cancelRequested) return { kind: "cancelled" };
    if (spec.ownerLaunch) {
      consumeHeadTurnLaunchTicket({
        grantId: spec.ownerLaunch.grantId,
        turnId: spec.turnId,
        taskId: sessionKey,
        runId,
        harnessId: spec.harness.id,
        modelId: spec.model,
        mode: spec.mode,
        resolvedWorkspace: turnCwd,
        taskStateDigest: spec.ownerLaunch.taskStateDigest,
      });
    }
    const handle = await spawnAgent({
      taskId: sessionKey,
      runId,
      harness: spec.harness,
      prompt: spec.prompt,
      cwd: turnCwd,
      onSessionId: (sessionId) => { providerSessionId = sessionId; },
      onChunk: (stream, data, lineUuid) => {
        if (stream === "stderr" && providerErrors.length < 40) providerErrors.push({ stream, data: data.slice(0, 2000), lineUuid: lineUuid ?? null });
        if (stream === "assistant") {
          assistant.push(data);
        } else if (stream === "stderr" || stream === "status") {
          const line = data.trim();
          if (line && line !== "turn complete") {
            diagnostics.push(line.slice(0, 500));
            if (diagnostics.length > DIAG_LINES) diagnostics.shift();
          }
        }
      },
      opts: {
        mode: spec.mode,
        model: spec.model,
        effort: spec.effort,
        fast: spec.fast,
        maxMode: spec.maxMode,
        runId,
        lockdownArgs: spec.lockdownArgs,
        cursorRuntime,
      },
    });
    control.handle = handle;
    if (control.cancelRequested) handle.kill();
    timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, spec.timeoutMs);
    const code = await handle.done.catch(() => 1);
    if (control.cancelRequested) return { kind: "cancelled" };
    if (timedOut) {
      return { kind: "failed", error: `The agent didn't answer within ${Math.round(spec.timeoutMs / 1000)} seconds.` };
    }
    const text = assistant.join("\n\n").trim();
    if (code !== 0 || !text) {
      // The exit line alone ("exited with code 1") hides the cause the CLI
      // printed just before it, so keep the last few distinct lines.
      const tail = [...new Set(diagnostics.slice(-6))].slice(-4).map((line) => line.slice(0, 300));
      const detail = tail.length > 0 ? redactSecrets(tail.join(" · ")) : null;
      const refusal = isCodexProviderAgent(spec.harness.id) || spec.harness.kind === "codex"
        ? providerRefusalOf(spec.harness.id, providerSessionId, providerErrors) : null;
      return {
        kind: "failed",
        error: detail
          ? `The agent stopped with an error: ${detail}`
          : code !== 0
            ? `The agent exited with code ${code}.`
            : "The agent finished without replying.",
        ...(refusal ? { providerRefusal: refusal } : {}),
      };
    }
    return { kind: "ok", text };
  } catch (error) {
    if (control.cancelRequested) return { kind: "cancelled" };
    return { kind: "failed", error: `Couldn't start the agent: ${redactSecrets((error as Error).message)}` };
  } finally {
    if (timer) clearTimeout(timer);
    discardUnconsumedLaunchTicket(spec.ownerLaunch?.grantId);
    discardUnconsumedSpawnAuthorization(runId);
    running.delete(sessionName);
    control.handle = null;
    const cursorRemoved = !cursorRuntime || removeCursorRuntime(cursorRuntime.receipt);
    if (scratchCreated && cursorRemoved) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (scratchCreated) removeRunFiles(runId);
    // The shell wrapper writes `<runId>.exit` after the CLI exits, which can
    // be after `done` resolved (live-verified with cursor-agent), so sweep
    // the run's files again shortly after.
    if (scratchCreated && !cursorRuntime) {
      for (const delay of [3_000, 20_000]) {
        const late = setTimeout(() => removeRunFiles(runId), delay);
        (late as { unref?: () => void }).unref?.();
      }
    }
  }
}

/**
 * Kill every running turn's tmux session, synchronously, for exit handlers
 * where an async kill would never finish. Only sessions this process
 * started, by name.
 */
export function stopIsolatedTurnsSync(): number {
  let killed = 0;
  for (const [sessionName, control] of running) {
    control.cancelRequested = true;
    try {
      Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-session", "-t", `=${sessionName}`], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: tmuxClientEnv(),
      });
      killed += 1;
    } catch {
      /* best effort on the way out */
    }
  }
  return killed;
}

/**
 * Boot backstop for a turn whose process died (crash, force quit): each
 * leftover scratch folder names one turn this data dir started, so its
 * tmux session is killed by that exact name, then its recorded Cursor
 * runtime, the scratch folder and the driver's run files are removed.
 * Never enumerates sessions or short runtimes from other app instances.
 */
export async function sweepIsolatedLeftovers(deps: { kill?: (name: string) => Promise<void> } = {}): Promise<number> {
  const kill = deps.kill ?? killSessionByName;
  let names: string[];
  try {
    names = readdirSync(SCRATCH_ROOT);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    try {
      await kill(sessionNameFor(`iv-${name.slice(0, 9)}`));
    } catch {
      /* already gone */
    }
    const scratch = path.join(SCRATCH_ROOT, name);
    if (!removeRecordedCursorRuntime(scratch)) continue;
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    removeRunFiles(`interview-${name}`);
    swept += 1;
  }
  // Run files whose scratch folder is already gone (a late `.exit`). No turn
  // runs at boot, and the `interview-` prefix is this module's own.
  for (const dir of DRIVER_LOG_DIRS) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/^interview-[0-9a-f]{32}\./.test(file)) continue;
      try {
        unlinkSync(path.join(dir, file));
      } catch {
        /* already gone */
      }
    }
  }
  return swept;
}
