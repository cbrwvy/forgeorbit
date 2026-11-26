/**
 * Spawn and signal one local process.
 *
 * When perl is available and the profile asked for a process group, the
 * process is the supervisor from {@link processGroupArgv}. Signalling the
 * supervisor's process group reaches children that stayed in that session.
 * There is no lookup by process name and no "whatever is on this port".
 */

import { existsSync } from "node:fs";

import { commandProvesToken, directArgv, processGroupArgv } from "../../shared/environment/command.ts";
import type { ProcessOwnershipRecord } from "../../shared/environment/types.ts";
import { extractEnvToken, parseLstart, type ProcessSnapshot } from "./ps.ts";

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface LocalStartRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  processGroup: boolean;
  token: string;
  onOutput: (stream: "stdout" | "stderr", text: string) => void;
}

export interface LiveProcess {
  pid: number;
  startedAtMs: number;
  processGroup: boolean;
  exited: Promise<ExitInfo>;
  signal: (signal: "SIGTERM" | "SIGINT" | "SIGKILL") => void;
}

export type LocalStartResult = { ok: true; process: LiveProcess } | { ok: false; detail: string };

export interface LocalProcessHost {
  start(request: LocalStartRequest): Promise<LocalStartResult>;
}

export interface ProcessInspector {
  inspect(pid: number): Promise<ProcessSnapshot | null>;
}

export interface ProcessSignaller {
  signal(pid: number, signal: "SIGTERM" | "SIGINT" | "SIGKILL", processGroup: boolean): "ok" | "esrch" | "eperm" | "error";
}

export type ProbeVerdict =
  | { kind: "dead" }
  | { kind: "proven"; relation: "session" | "prior-forgeorbit" }
  | { kind: "foreign"; detail: string }
  | { kind: "unverified"; detail: string };

export function classifyProcessProbe(
  record: ProcessOwnershipRecord,
  snapshot: ProcessSnapshot | null,
  currentSessionId: string,
): ProbeVerdict {
  if (!snapshot) return { kind: "dead" };
  const byCommand = commandProvesToken(snapshot.command, record.token, record.executable);
  const byEnv = snapshot.envToken === record.token || extractEnvToken(snapshot.command, record.token) === record.token;
  if (byCommand || byEnv) {
    return {
      kind: "proven",
      relation: record.sessionId === currentSessionId ? "session" : "prior-forgeorbit",
    };
  }
  if (snapshot.envToken && snapshot.envToken !== record.token) {
    return { kind: "foreign", detail: `pid ${record.pid} is alive but its ownership token does not match` };
  }
  return {
    kind: "unverified",
    detail: `pid ${record.pid} is alive but its command line does not prove this environment owns it`,
  };
}

export function createBunProcessHost(options: { perlAvailable?: boolean; now?: () => number } = {}): LocalProcessHost {
  const perlAvailable = options.perlAvailable ?? existsSync("/usr/bin/perl");
  const now = options.now ?? (() => Date.now());
  return {
    async start(request) {
      const useGroup = request.processGroup && perlAvailable;
      const argv = useGroup
        ? processGroupArgv(request.token, request.executable, request.args)
        : directArgv(request.executable, request.args);
      let proc: Bun.Subprocess;
      try {
        proc = Bun.spawn(argv, {
          cwd: request.cwd,
          env: request.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
      pump(asStream(proc.stdout), (text) => request.onOutput("stdout", text));
      pump(asStream(proc.stderr), (text) => request.onOutput("stderr", text));
      const pid = proc.pid;
      const processGroup = useGroup;
      const exited = proc.exited.then((code: number) => ({
        code: proc.signalCode ? null : code,
        signal: proc.signalCode == null ? null : String(proc.signalCode),
      }));
      return {
        ok: true,
        process: {
          pid,
          startedAtMs: now(),
          processGroup,
          exited,
          signal(signal) {
            signalPid(pid, signal, processGroup);
          },
        },
      };
    },
  };
}

export function createPsInspector(runner: { run: (argv: string[]) => Promise<{ code: number | null; stdout: string }> }): ProcessInspector {
  return {
    async inspect(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const id = String(pid);
      const started = await runner.run(["/bin/ps", "-p", id, "-o", "lstart="]);
      if (started.code !== 0 || started.stdout.trim() === "") return null;
      const command = await runner.run(["/bin/ps", "-p", id, "-ww", "-o", "command="]);
      if (command.code !== 0) return null;
      return {
        pid,
        startedAtMs: parseLstart(started.stdout),
        command: command.stdout.trim(),
        envToken: null,
      };
    },
  };
}

export function signalPid(
  pid: number,
  signal: "SIGTERM" | "SIGINT" | "SIGKILL",
  processGroup: boolean,
): "ok" | "esrch" | "eperm" | "error" {
  try {
    process.kill(processGroup ? -pid : pid, signal);
    return "ok";
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") return "esrch";
    if (code === "EPERM") return "eperm";
    return "error";
  }
}

export const bunProcessSignaller: ProcessSignaller = {
  signal(pid, signal, processGroup) {
    return signalPid(pid, signal, processGroup);
  },
};

function asStream(value: unknown): ReadableStream<Uint8Array> | null {
  if (typeof value === "object" && value !== null && "getReader" in value) {
    return value as ReadableStream<Uint8Array>;
  }
  return null;
}

function pump(stream: ReadableStream<Uint8Array> | null, onText: (text: string) => void): void {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) onText(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) onText(tail);
    } catch {
      // The pipe closes when the process exits or we kill it.
    }
  })();
}
