/**
 * Generic/Custom CLI execution adapter for ForgeOrbit (`kind === "custom"`).
 *
 * Launches any user-configured CLI binary using a structured argument vector
 * (`Bun.spawn([bin, ...args])`) with zero shell eval / string concatenation.
 *
 * Supports:
 * - Prompt delivery via command argument (optional prompt flag), stdin, or
 *   interactive terminal hint.
 * - Optional model & effort flags when configured.
 * - Live streaming of stdout/stderr into ForgeOrbit's run_events / SSE pipeline.
 * - Reliable process & descendant-tree cancellation (`kill()`).
 * - Honest error & exit handling — exit code 0 finishes the manual/custom run
 *   without claiming isolated autonomous Developer/Reviewer verification.
 */
import path from "node:path";
import type { CustomCliConfig, Harness } from "../shared/types.ts";
import { DEFAULT_CUSTOM_CLI_CONFIG, normalizeCustomCliConfig } from "../shared/custom-cli.ts";
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";
import { descendantPids, killOwnedTree } from "./provider-runtime/containment.ts";
import { buildMacSearchPath } from "./cli-discovery.ts";

export interface CustomCliBuiltCommand {
  bin: string;
  argv: string[];
  env: Record<string, string>;
  stdinPrompt: string | null;
  config: CustomCliConfig;
}

export function effectiveCustomCliConfig(harness: Harness): CustomCliConfig {
  return normalizeCustomCliConfig(harness.cliConfig) ?? { ...DEFAULT_CUSTOM_CLI_CONFIG };
}

export function resolveCustomCliBin(harness: Harness): string {
  const raw = harness.bin?.trim() || "";
  if (!raw) return harness.id;
  if (path.isAbsolute(raw)) return raw;
  const found = Bun.which(raw, { PATH: buildMacSearchPath() });
  return found ?? raw;
}

export function buildCustomCliCommand(
  harness: Harness,
  prompt: string,
  opts: {
    model?: string | null;
    effort?: string | null;
    env?: Record<string, string>;
  } = {},
): CustomCliBuiltCommand {
  const config = effectiveCustomCliConfig(harness);
  const bin = resolveCustomCliBin(harness);
  const argv: string[] = [bin, ...config.args];

  const effectiveModel = (opts.model && opts.model !== "default" ? opts.model : config.defaultModel) ?? null;
  if (effectiveModel && config.modelFlag) {
    argv.push(config.modelFlag, effectiveModel);
  }
  if (opts.effort && opts.effort !== "auto" && config.effortFlag) {
    argv.push(config.effortFlag, opts.effort);
  }

  let stdinPrompt: string | null = null;
  if (config.promptDelivery === "stdin") {
    stdinPrompt = prompt;
  } else if (config.promptDelivery === "arg") {
    if (config.promptFlag) {
      argv.push(config.promptFlag, prompt);
    } else {
      argv.push(prompt);
    }
  } else {
    // Interactive mode still passes prompt as final arg if non-empty when launched from a task.
    if (prompt.trim()) {
      if (config.promptFlag) argv.push(config.promptFlag, prompt);
      else argv.push(prompt);
    }
  }

  const env: Record<string, string> = { ...(opts.env ?? {}) };
  return { bin, argv, env, stdinPrompt, config };
}

/**
 * Spawn a custom CLI child process with structured argv, real stdout/stderr
 * streaming, clean stdin delivery, and process-tree cancellation.
 */
export function spawnCustomCli(args: {
  harness: Harness;
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model?: string | null;
  effort?: string | null;
  onChunk: ChunkHandler;
}): SpawnedAgent {
  const built = buildCustomCliCommand(args.harness, args.prompt, {
    model: args.model,
    effort: args.effort,
    env: args.env,
  });

  const effectiveCwd = built.config.workdir && path.isAbsolute(built.config.workdir) && !args.cwd
    ? built.config.workdir
    : args.cwd;

  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") spawnEnv[k] = v;
  }
  spawnEnv.PATH = buildMacSearchPath(spawnEnv.PATH);
  for (const [k, v] of Object.entries(built.env)) {
    spawnEnv[k] = v;
  }

  args.onChunk(
    "status",
    `Launching ${args.harness.label} (${path.basename(built.bin)}) in ${effectiveCwd} — manual/custom CLI mode`,
  );

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(built.argv, {
      cwd: effectiveCwd,
      env: spawnEnv,
      stdin: built.stdinPrompt !== null ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    args.onChunk("stderr", `Failed to start ${args.harness.label} (${built.bin}): ${msg}`);
    return {
      kill: () => {},
      writeInput: () => false,
      done: Promise.resolve(127),
    };
  }

  if (built.stdinPrompt !== null && proc.stdin && typeof proc.stdin !== "number") {
    try {
      proc.stdin.write(built.stdinPrompt);
      proc.stdin.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      args.onChunk("stderr", `Failed to write prompt to stdin: ${msg}`);
    }
  }

  const activeReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const pumpStream = async (
    stream: ReadableStream<Uint8Array> | number | null | undefined,
    kind: "assistant" | "stderr",
  ) => {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    activeReaders.push(reader);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl !== -1) {
            const line = buffer.slice(0, nl + 1);
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) args.onChunk(kind, line);
            nl = buffer.indexOf("\n");
          }
          if (buffer.length >= 2048) {
            args.onChunk(kind, buffer);
            buffer = "";
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) args.onChunk(kind, buffer);
    } catch {
      /* stream closed on cancellation */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  };

  const stdoutDone = pumpStream(proc.stdout, "assistant");
  const stderrDone = pumpStream(proc.stderr, "stderr");

  let killed = false;
  const exited = (async () => {
    const code = await proc.exited;
    if (killed) {
      await Promise.race([Promise.allSettled([stdoutDone, stderrDone]), Bun.sleep(200)]);
      args.onChunk("status", `${args.harness.label} stopped by user.`);
      return code === 0 ? 143 : code;
    }
    await Promise.allSettled([stdoutDone, stderrDone]);
    if (code !== 0) {
      args.onChunk("status", `${args.harness.label} exited with code ${code}.`);
    }
    return code;
  })();

  return {
    kill: () => {
      if (killed) return;
      killed = true;
      const pid = proc.pid;
      const children = pid > 0 ? descendantPids(pid) : [];
      for (const childPid of children) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      for (const reader of activeReaders) {
        reader.cancel().catch(() => {});
      }
      if (pid > 0) {
        const timer = setTimeout(() => {
          try { killOwnedTree(pid); } catch { /* ignore */ }
        }, 300);
        timer.unref?.();
      }
    },
    writeInput: () => false,
    done: exited,
  };
}
