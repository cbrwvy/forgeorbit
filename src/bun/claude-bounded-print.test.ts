import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boundedClaudeCommand, boundedClaudeEnvironment, BOUNDED_CLAUDE, spawnBoundedClaude } from "./claude-bounded-print.ts";

const root = mkdtempSync(path.join(tmpdir(), "fo-claude-print-"));
process.env.AGETOR_DATA_DIR = root;
process.env.HOME = root;
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY", "TMUX"]) process.env[`AGETOR_${kind}_BIN`] = "/bin/echo";
delete process.env.AGETOR_CLAUDE_ARGS;
const bin = path.join(root, "claude-fixture");
writeFileSync(bin, `#!${process.execPath}\n${readFileSync(path.join(import.meta.dir, "claude-bounded-print.fixture.ts"), "utf8")}`, { mode: 0o700 });
const model = "claude-haiku-5-5";
function scenario(name: string, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
  const cwd = mkdtempSync(path.join(root, "run-"));
  const events: { stream: string; data: string }[] = [];
  const agent = spawnBoundedClaude({ argv: boundedClaudeCommand(bin, model, options.readOnly), cwd, env: boundedClaudeEnvironment({}),
    prompt: `fixture-case:${name}`, readOnly: options.readOnly ?? false, timeoutMs: options.timeoutMs,
    onChunk: (stream, data) => events.push({ stream, data }) });
  const count = () => existsSync(path.join(cwd, ".fixture-launches")) ? readFileSync(path.join(cwd, ".fixture-launches"), "utf8").trim().split("\n").length : 0;
  return { agent, events, count, cwd };
}

test("bounded argv fixes model, limits and explicit safe tools; never permits shell/MCP/resume", () => {
  const cmd = boundedClaudeCommand(bin, model);
  for (const flag of ["--print", "--restricted", "--safe-mode", "--no-session-persistence", "--strict-mcp-config"]) expect(cmd).toContain(flag);
  expect(cmd[cmd.indexOf("--max-turns") + 1]).toBe("6");
  expect(cmd[cmd.indexOf("--max-budget-usd") + 1]).toBe("0.25");
  expect(cmd[cmd.indexOf("--model") + 1]).toBe(model);
  expect(cmd[cmd.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Edit,Write");
  expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  expect(cmd[cmd.indexOf("--permission-prompts") + 1]).toBe("none");
  expect(cmd.join(" ")).not.toMatch(/Bash|Agent,|bypass|--resume|--continue|--fallback|--add-dir/);
  expect(boundedClaudeCommand(bin, model, true)[cmd.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  expect(() => boundedClaudeCommand(bin, "")).toThrow();
});
test("valid output persists text/usage/stdout/stderr and succeeds once", async () => {
  const run = scenario("success");
  expect(await run.agent.done).toBe(0);
  expect(run.count()).toBe(1);
  expect(run.agent.writeInput("no continuation")).toBe(false);
  expect(run.events.some(e => e.stream === "assistant")).toBe(true);
  expect(run.events.some(e => e.stream === "stdout" && e.data.includes('"usage"'))).toBe(true);
  expect(run.events.some(e => e.stream === "stderr" && e.data.includes("fixture stderr"))).toBe(true);
  const recorded = JSON.parse(readFileSync(path.join(run.cwd, ".fixture-launches"), "utf8"));
  expect(recorded.orchestrationTokenPresent).toBe(false);
});
for (const name of ["exit-failure", "malformed", "no-result", "turn-limit", "budget-limit", "too-many-turns", "forbidden-tool", "advertised-shell", "model-mismatch", "model-fallback", "duplicate-result"]) {
  test(`${name} fails without retry`, async () => {
    const run = scenario(name);
    expect(await run.agent.done).not.toBe(0);
    expect(run.count()).toBe(1);
  });
}
test("timeout kills only owned process without retry", async () => {
  const run = scenario("timeout", { timeoutMs: 1000 });
  expect(await run.agent.done).not.toBe(0);
  expect(run.count()).toBe(1);
  expect(run.events.some(e => e.data.includes("timed out"))).toBe(true);
});
test("cancellation does not restart and refuses input", async () => {
  const run = scenario("timeout");
  const deadline = Date.now() + 2000;
  while (run.count() === 0 && Date.now() < deadline) await Bun.sleep(10);
  run.agent.kill();
  expect(await run.agent.done).not.toBe(0);
  expect(run.count()).toBe(1);
});
test("authorization is rechecked before any process", () => {
  expect(() => spawnBoundedClaude({ argv: boundedClaudeCommand(bin, model), cwd: root, env: {}, prompt: "unused", readOnly: true,
    onChunk: () => {}, authorize: () => false })).toThrow("authorization changed");
});
test("existing interactive defaults stay unchanged; overrides/continuation fail closed", async () => {
  const { buildCommand } = await import("./agents.ts");
  const { defaultModeFor, supportedModes } = await import("../shared/types.ts");
  const harness = { id: "claude-code", kind: "claude-code" as const, isBuiltin: true, label: "Claude", home: null, bin, env: {}, enabled: true };
  const normal = buildCommand(harness, "hello", { model: "haiku-5.5", effort: "low", mode: "ask" });
  expect(normal.cmd).not.toContain("--print");
  expect(defaultModeFor("claude-code")).toBe("auto");
  expect(supportedModes("claude-code", "haiku-5.5").some(m => m.id === "bounded-print")).toBe(true);
  const bounded = buildCommand(harness, "hello", { model: "haiku-5.5", mode: "bounded-print" });
  expect(bounded.cmd).toContain("--print");
  expect(bounded.cmd).toContain("claude-haiku-5-5");
  expect(BOUNDED_CLAUDE.maxTurns).toBe(6);
  expect(() => buildCommand(harness, "hello", { model: "haiku-5.5", mode: "bounded-print", resumeSessionId: "prior" })).toThrow("cannot resume");
  process.env.AGETOR_CLAUDE_ARGS = "--dangerously-skip-permissions";
  try { expect(() => buildCommand(harness, "hello", { model: "haiku-5.5", mode: "bounded-print" })).toThrow("overrides"); }
  finally { delete process.env.AGETOR_CLAUDE_ARGS; }
});
