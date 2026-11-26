/**
 * Short-lived argv runner used by the Docker adapter and the process inspector.
 * `Bun.spawn` receives the array as-is — nothing joins it into a shell.
 */

export const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

export interface CommandRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CommandRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  pid: number | null;
}

export interface CommandRunner {
  run(argv: readonly string[], options: CommandRunOptions): Promise<CommandRunResult>;
}

export function createBunCommandRunner(): CommandRunner {
  return {
    async run(argv, options) {
      if (options.signal?.aborted) {
        return { code: null, stdout: "", stderr: "", timedOut: false, spawnError: "cancelled", pid: null };
      }
      let proc: Bun.Subprocess;
      try {
        proc = Bun.spawn([...argv], {
          cwd: options.cwd,
          env: options.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        return {
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error),
          pid: null,
        };
      }
      const pid = proc.pid;
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, options.timeoutMs);
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGTERM");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const [stdout, stderr, code] = await Promise.all([
          readCapped(asStream(proc.stdout)),
          readCapped(asStream(proc.stderr)),
          proc.exited,
        ]);
        return {
          code,
          stdout,
          stderr,
          timedOut,
          spawnError: aborted ? "cancelled" : null,
          pid,
        };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function asStream(value: unknown): ReadableStream<Uint8Array> | null {
  if (typeof value === "object" && value !== null && "getReader" in value) {
    return value as ReadableStream<Uint8Array>;
  }
  return null;
}

async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (size < MAX_COMMAND_OUTPUT_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = MAX_COMMAND_OUTPUT_BYTES - size;
    const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    text += decoder.decode(slice, { stream: true });
    size += slice.byteLength;
    if (value.byteLength > remaining) {
      await reader.cancel();
      break;
    }
  }
  text += decoder.decode();
  return text;
}
