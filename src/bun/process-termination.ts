/**
 * Stop a tmux-hosted one-shot agent process and say what was observed.
 *
 * `tmux kill-session` only hangs the pane up (SIGHUP); a process that ignores it keeps running while the
 * run would be recorded as cancelled. This records the pane process before killing the session, escalates
 * to SIGTERM then SIGKILL on the process group, and reports `exited` only after the recorded process id and
 * its group were gone. If something is still alive after every signal the outcome is `unconfirmed`, and the
 * caller must keep the run open.
 */
import type { RunTermination } from "../shared/run-termination.ts";
import { killSessionByName, panePidFor } from "./claude-tmux.ts";

export interface ProcessControl {
  /** True while the process, or any member of the group it leads, exists. */
  isAlive(pid: number): boolean;
  /** Signal the group the pane process leads, then the process itself. Never throws. */
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Start time of the process (`ps lstart`), or null when it cannot be read. It guards against id reuse. */
  startedAt(pid: number): Promise<string | null>;
  /** The same read for a synchronous caller (project lifecycle counts). Optional: without it identity stays unread. */
  startedAtSync?(pid: number): string | null;
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export const systemProcessControl: ProcessControl = {
  isAlive: (pid) => exists(pid) || exists(-pid),
  signal: (pid, signal) => {
    for (const target of [-pid, pid]) {
      try { process.kill(target, signal); } catch { /* already gone, or not ours */ }
    }
  },
  startedAt: async (pid) => {
    try {
      const proc = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const text = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return text || null;
    } catch { return null; }
  },
  startedAtSync: (pid) => {
    try {
      const proc = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const text = new TextDecoder().decode(proc.stdout).trim();
      return text || null;
    } catch { return null; }
  },
};

let control: ProcessControl = systemProcessControl;
/** Test seam: replace how liveness is read and signals are sent. */
export function __setProcessControlForTest(next: ProcessControl | null): void { control = next ?? systemProcessControl; }
export function processControl(): ProcessControl { return control; }

export interface TerminationTiming { graceMs: number; termMs: number; killMs: number; pollMs: number }
export const DEFAULT_TERMINATION_TIMING: TerminationTiming = { graceMs: 2500, termMs: 2000, killMs: 3000, pollMs: 100 };
let timing: TerminationTiming = DEFAULT_TERMINATION_TIMING;
export function __setTerminationTimingForTest(next: Partial<TerminationTiming> | null): void {
  timing = next ? { ...DEFAULT_TERMINATION_TIMING, ...next } : DEFAULT_TERMINATION_TIMING;
}

export interface TerminationEvidence {
  outcome: "exited" | "no-process" | "unconfirmed";
  processId: number | null;
  processStarted: string | null;
  methods: RunTermination["methods"];
  checkedAt: number;
  note: string;
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (true) {
    if (!control.isAlive(pid)) return true;
    if (Date.now() >= end) return false;
    await Bun.sleep(timing.pollMs);
  }
}

/** Stop whatever the session hosts and report. Safe to call again after an `unconfirmed` outcome. */
export async function terminateTmuxHostedProcess(sessionName: string, knownPid?: { pid: number; started: string | null }): Promise<TerminationEvidence> {
  const listed = await panePidFor(sessionName).catch(() => null);
  const pid = listed ?? knownPid?.pid ?? null;
  const started = pid == null ? null : (listed != null ? await control.startedAt(pid) : knownPid?.started ?? null);
  const methods: TerminationEvidence["methods"] = [];
  if (listed != null) {
    methods.push("session-kill");
    await killSessionByName(sessionName).catch(() => undefined);
  } else {
    // The session may already be gone; a stale session of this name is still removed.
    await killSessionByName(sessionName).catch(() => undefined);
  }
  if (pid == null) {
    return { outcome: "no-process", processId: null, processStarted: null, methods, checkedAt: Date.now(), note: "No live session or pane process was found to stop." };
  }
  if (await waitGone(pid, timing.graceMs)) {
    return { outcome: "exited", processId: pid, processStarted: started, methods, checkedAt: Date.now(), note: `Process ${pid} was observed to exit after the session was closed.` };
  }
  control.signal(pid, "SIGTERM"); methods.push("sigterm");
  if (await waitGone(pid, timing.termMs)) {
    return { outcome: "exited", processId: pid, processStarted: started, methods, checkedAt: Date.now(), note: `Process ${pid} ignored the hang-up and exited after SIGTERM.` };
  }
  control.signal(pid, "SIGKILL"); methods.push("sigkill");
  if (await waitGone(pid, timing.killMs)) {
    return { outcome: "exited", processId: pid, processStarted: started, methods, checkedAt: Date.now(), note: `Process ${pid} ignored the hang-up and SIGTERM and exited after SIGKILL.` };
  }
  return { outcome: "unconfirmed", processId: pid, processStarted: started, methods, checkedAt: Date.now(), note: `Process ${pid} was still running after the session kill, SIGTERM and SIGKILL.` };
}

/** One read after a restart: is the recorded process still the same live process? */
export async function recheckRecordedProcess(pid: number | null, started: string | null): Promise<"gone" | "alive" | "unknown"> {
  if (pid == null) return "unknown";
  if (!control.isAlive(pid)) return "gone";
  const now = await control.startedAt(pid);
  if (started && now && now !== started) return "gone"; // the id was reused by another process
  return started && now ? "alive" : "unknown";
}

/**
 * The same look as `recheckRecordedProcess`, for a synchronous caller. Fail-closed the same way: a process that exists
 * but whose identity cannot be read is `unknown` (still treated as alive by the caller), never `gone`.
 */
export function recheckRecordedProcessSync(pid: number | null, started: string | null): "gone" | "alive" | "unknown" {
  if (pid == null) return "unknown";
  if (!control.isAlive(pid)) return "gone";
  const now = control.startedAtSync ? control.startedAtSync(pid) : null;
  if (started && now && now !== started) return "gone";
  return started && now ? "alive" : "unknown";
}

/**
 * The stop function a one-shot tmux driver hands the orchestrator. One attempt runs at a time (a repeated
 * Stop while one is in flight shares it). After `unconfirmed` the run must stay open: `settle` is not called
 * until a later look finds the process gone, so the driver's `done` does not resolve while it is alive.
 */
export function makeTerminator(opts: {
  sessionName: string;
  /** Called once a stop begins, so the driver's own death watch stops treating the vanished session as a crash. */
  begin: () => void;
  /** Flush the log and resolve the driver's `done`. Called when the process is gone. */
  settle: () => void;
}): () => Promise<TerminationEvidence> {
  let inflight: Promise<TerminationEvidence> | null = null;
  let known: { pid: number; started: string | null } | undefined;
  let lateWatch: ReturnType<typeof setInterval> | null = null;
  const stopLateWatch = () => { if (lateWatch) { clearInterval(lateWatch); lateWatch = null; } };
  return () => {
    if (inflight) return inflight;
    inflight = (async () => {
      opts.begin();
      stopLateWatch();
      const evidence = await terminateTmuxHostedProcess(opts.sessionName, known);
      if (evidence.processId != null) known = { pid: evidence.processId, started: evidence.processStarted };
      if (evidence.outcome === "unconfirmed" && known) {
        const pid = known.pid;
        lateWatch = setInterval(() => {
          if (control.isAlive(pid)) return;
          stopLateWatch();
          opts.settle();
        }, 1000);
        (lateWatch as unknown as { unref?: () => void }).unref?.();
      } else {
        opts.settle();
      }
      return evidence;
    })().finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * Why a task must not start another process: an earlier run's recorded process may still be alive. Reads only
 * (`kill(pid, 0)` and `ps`), never signals. A process found gone is recorded as such and no longer blocks; one that
 * is alive, or whose identity cannot be read while the id exists, blocks until a later look finds it gone.
 */
export async function priorProcessRefusal(
  unresolved: Array<{ termination: RunTermination; processStarted: string | null }>,
  record: (runId: string, outcome: "recovered-gone", processId: number | null, note: string) => void,
): Promise<string | null> {
  for (const { termination, processStarted } of unresolved) {
    const seen = await recheckRecordedProcess(termination.processId, processStarted);
    if (seen === "gone") {
      record(termination.runId, "recovered-gone", termination.processId, "A later check found no process with the recorded id.");
      continue;
    }
    return `An earlier run of this task left process ${termination.processId} that may still be running (it was not confirmed to exit). Nothing was started. Check that it has ended, then try again.`;
  }
  return null;
}
