/** Opt-in one-shot transport for the existing Claude harness and Run lifecycle.
 * No tmux, settings installer, continuation, fallback or automatic retry.
 * Claude's restricted file tools are a provider policy, not an OS sandbox.
 */
import { CLAUDE_QA_AUTH_HOME_SETTING, configuredClaudeQaAuthHome, configuredClaudeQaDirectory, copyClaudeStorageCompatibility, validateClaudeQaDirectory } from "./claude-auth-compat.ts";
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";

import { BOUNDED_CLAUDE, CLAUDE_READ_TOOLS as READ_TOOLS, CLAUDE_EDIT_TOOLS as EDIT_TOOLS } from "../shared/bounded-claude.ts";
export { BOUNDED_CLAUDE } from "../shared/bounded-claude.ts";
const children = new Set<ReturnType<typeof Bun.spawn>>();

export function boundedClaudeCommand(bin: string, model: string, readOnly = false): string[] {
  if (!model) throw new Error("An explicit model is required for bounded Claude.");
  const tools = (readOnly ? READ_TOOLS : EDIT_TOOLS).join(",");
  return [bin, "--print", "--verbose", "--output-format", "stream-json",
    "--model", model, "--max-turns", String(BOUNDED_CLAUDE.maxTurns),
    "--max-budget-usd", String(BOUNDED_CLAUDE.maxBudgetUsd),
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--restricted", "--safe-mode", "--tools", tools, "--allowedTools", tools,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "", "--no-session-persistence"];
}

export function stopBoundedClaudeProcesses(): void {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
}
process.once("exit", stopBoundedClaudeProcesses);

export function spawnBoundedClaude(opts: {
  argv: string[]; env: Record<string, string>; cwd: string; prompt: string;
  onChunk: ChunkHandler; readOnly: boolean; timeoutMs?: number;
  authorize?: () => boolean;
}): SpawnedAgent {
  if (opts.authorize && !opts.authorize()) throw new Error("Owner authorization changed before adapter submission.");
  // The caller freezes this environment before the auth probe. Re-filter only
  // those bytes; never re-read ambient configuration between probe and launch.
  const env = boundedClaudeEnvironment(opts.env, {});
  const child = Bun.spawn(opts.argv, { cwd: opts.cwd, env, stdin: new TextEncoder().encode(opts.prompt), stdout: "pipe", stderr: "pipe" });
  children.add(child);
  opts.onChunk("status", JSON.stringify({ kind: "claude-bounded-start", pid: child.pid, argv: opts.argv,
    maxTurns: BOUNDED_CLAUDE.maxTurns, maxBudgetUsd: BOUNDED_CLAUDE.maxBudgetUsd, readOnly: opts.readOnly }));
  let problem: string | null = null;
  let result: Record<string, unknown> | null = null;
  let initialized = false;
  let ended = false;
  let bytes = 0;
  const allowedTools = new Set(opts.readOnly ? READ_TOOLS : EDIT_TOOLS);
  const fail = (message: string) => {
    if (!problem) { problem = message; opts.onChunk("stderr", `bounded Claude: ${message}`); }
    try { child.kill("SIGKILL"); } catch { /* exited */ }
  };
  const timer = setTimeout(() => fail("execution timed out; no retry"), opts.timeoutMs ?? BOUNDED_CLAUDE.timeoutMs);
  const line = (raw: string) => {
    if (!raw.trim() || problem) return;
    if (raw.length > 256_000) { fail("structured output line too large"); return; }
    let event: Record<string, any>;
    try { event = JSON.parse(raw); } catch { fail("malformed structured output"); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { fail("invalid structured event"); return; }
    opts.onChunk("stdout", raw);
    if (event.type === "system" && event.subtype === "init") {
      if (initialized || result || event.model !== opts.argv[opts.argv.indexOf("--model") + 1]) { fail("unexpected initialization/model"); return; }
      if (!Array.isArray(event.tools) || event.tools.some((tool: unknown) => typeof tool !== "string" || !allowedTools.has(tool))) { fail("unexpected advertised tools"); return; }
      initialized = true;
      opts.onChunk("status", `bounded Claude initialized — model=${event.model}`);
    } else if (event.type === "assistant") {
      if (!initialized || result || !Array.isArray(event.message?.content)) { fail("invalid assistant event ordering/content"); return; }
      if (event.message.model && event.message.model !== opts.argv[opts.argv.indexOf("--model") + 1]) { fail("unexpected assistant model; fallback refused"); return; }
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") opts.onChunk("assistant", block.text);
        else if (block.type === "thinking" && typeof block.thinking === "string") opts.onChunk("thinking", block.thinking);
        else if (block.type === "tool_use") {
          if (!allowedTools.has(block.name)) { fail("unexpected tool outside bounded policy"); return; }
          opts.onChunk("tool_use", JSON.stringify(block));
        }
      }
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block.type === "tool_result") opts.onChunk("tool_result", JSON.stringify(block));
    } else if (event.type === "result") {
      if (!initialized || result) { fail("missing initialization or duplicate result"); return; }
      result = event;
      opts.onChunk("status", JSON.stringify({ ...event, kind: "claude-bounded-result" }));
      if (event.subtype !== "success" || event.is_error !== false) fail(`terminated: ${event.subtype ?? "invalid result"}; no retry`);
      else if (!Number.isInteger(event.num_turns) || event.num_turns < 1 || event.num_turns > BOUNDED_CLAUDE.maxTurns) fail("invalid or exceeded turn count");
      else if (event.permission_denials?.length) fail("tool permissions denied");
    }
  };
  async function read(stream: ReadableStream<Uint8Array>, stdout: boolean) {
    const reader = stream.getReader(), decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4_000_000) { fail("output capture limit exceeded"); break; }
      const text = decoder.decode(value, { stream: true });
      if (!stdout) { opts.onChunk("stderr", text); continue; }
      pending += text;
      if (pending.length > 256_000 && !pending.includes("\n")) { fail("structured output line too large"); break; }
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const raw of lines) line(raw);
    }
    if (stdout) line(pending + decoder.decode());
  }
  const done = (async () => {
    try {
      const [exit] = await Promise.all([child.exited, read(child.stdout as ReadableStream<Uint8Array>, true), read(child.stderr as ReadableStream<Uint8Array>, false)]);
      if (!result && !problem) fail("process exited without a terminal result");
      opts.onChunk("status", JSON.stringify({ kind: "claude-bounded-exit", pid: child.pid, processExitCode: exit, problem }));
      return problem ? 1 : exit;
    } catch {
      fail("process/output capture failed; no retry");
      return 1;
    } finally { ended = true; clearTimeout(timer); children.delete(child); }
  })();
  return { done, kill: () => { if (!ended) fail("cancelled; no retry"); }, writeInput: () => false };
}

export function boundedClaudeEnvironment(source: Record<string, string>, ambient: Record<string, string | undefined> = process.env, cwd?: string): Record<string, string> {
  // Avoid passing orchestration bearer tokens, unrelated provider credentials,
  // NODE_OPTIONS or injected CLI arguments into the provider child. Account
  // authentication stays in the selected harness's config/normal Keychain.
  const env: Record<string, string> = {};
  const permitted = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EFFORT_LEVEL",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  for (const key of permitted) {
    const value = source[key] ?? ambient[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false", DISABLE_AUTOUPDATER: "1",
    DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  });
  const qaDirectory = configuredClaudeQaDirectory(source, ambient);
  const authHome = configuredClaudeQaAuthHome(source, ambient);
  if (authHome !== undefined && qaDirectory === undefined) throw new Error(`${CLAUDE_QA_AUTH_HOME_SETTING} requires an explicitly selected persistent Claude QA config; no fallback or inference.`);
  if (qaDirectory !== undefined) {
    validateClaudeQaDirectory(qaDirectory, { ...ambient, ...source, HOME: env.HOME, TMPDIR: env.TMPDIR }, authHome, cwd);
    env.CLAUDE_CONFIG_DIR = qaDirectory;
    // Only this child receives the explicitly selected authentication HOME.
    if (authHome !== undefined) env.HOME = authHome;
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    copyClaudeStorageCompatibility({ ...ambient, ...source }, env);
  }
  return env;
}
