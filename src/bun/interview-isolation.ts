/**
 * What an interview turn is actually allowed to do, per harness (FO-003.1).
 *
 * None of the supported CLIs can be limited to "only the context we hand
 * it" by a command-line flag alone, so this module does two things:
 *
 * 1. Builds the strongest flags each CLI offers for a text-only turn and
 *    verifies them against the installed binary where the CLI can report
 *    its own effective configuration without a model call:
 *    - codex: `--ephemeral`, web search off, every tool feature from a fixed
 *      list that this version knows (`features list`) disabled, every MCP
 *      server from the user's config disabled. Verified by re-running
 *      `features list` / `mcp list --json` with the same flags; the shell
 *      tool must report off and every MCP server disabled, or the turn is
 *      refused (fail closed).
 *    - cursor: `--mode ask` (read-only) and `--sandbox enabled`, no `--force`,
 *      no `--approve-mcps`; `--trust` for the empty scratch folder only
 *      (print mode otherwise stops at "Workspace Trust Required" before
 *      reaching the model — live-verified on 2026.10.22). Only the flags'
 *      presence in `--help` can be checked locally.
 *    - antigravity: plan mode, `--sandbox`, `--disable-slash-commands`. MCP
 *      servers can't be disabled per run, so the enabled ones are listed.
 * 2. Describes, honestly, what still isn't prevented. The wizard shows it
 *    and the server refuses a turn until the user confirmed that exact text
 *    (`consentKey`), so a changed setup (a new MCP server) asks again.
 *
 * Probes run the local CLI only (`features list`, `mcp list`, `--help`);
 * none of them talks to a model.
 */

import { createHash } from "node:crypto";
import { agentDriverIsFake, harnessEnv, resolveBin } from "./agents.ts";
import { dataDir } from "./db.ts";
import { prepareCursorRuntime, removeCursorRuntime, wrapCursorArgv } from "./cursor-runtime-isolation.ts";
import type { InterviewIsolation } from "../shared/project-interview.ts";
import type { Harness } from "../shared/types.ts";

/** `stdout` carries stdout and stderr together: some CLIs (agy) print
 *  `--help` to stderr. Parsers that need clean JSON get `json` instead. */
export type ProbeRunner = (argv: string[], env: Record<string, string>, cwd?: string) => Promise<{ code: number; stdout: string; json?: string }>;

const PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;

/** Codex features that give the model a way to act or read beyond the
 *  prompt. Disabled when the installed version knows them. */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "hooks",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "image_generation",
  "view_image",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies",
  "worktrees",
] as const;

/** Must report off after the disables, or codex isn't used. */
const CODEX_REQUIRED_OFF = ["shell_tool", "apps", "plugins", "browser_use", "computer_use", "hooks"];

const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const defaultProbeRunner: ProbeRunner = async (argv, env, cwd = dataDir) => {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, NO_COLOR: "1" },
  });
  const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout: `${stdout}\n${stderr}`, json: stdout };
  } catch {
    return { code: 1, stdout: "" };
  } finally {
    clearTimeout(timer);
  }
};

/** `name  stage  true|false` rows from `codex features list`. */
export function parseCodexFeatures(stdout: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of stdout.split("\n")) {
    const match = /^([a-z0-9_]+)\s+.*\s(true|false)\s*$/.exec(line.trim());
    if (match) out.set(match[1]!, match[2] === "true");
  }
  return out;
}

/** `codex mcp list --json` → name → enabled. Null when it isn't that shape. */
export function parseCodexMcp(stdout: string): Map<string, boolean> | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!Array.isArray(value)) return null;
    const out = new Map<string, boolean>();
    for (const item of value) {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== "string") return null;
      out.set(record.name, record.enabled === true);
    }
    return out;
  } catch {
    return null;
  }
}

/** Enabled server names from `agy mcp list` (NAME TYPE STATUS …). */
export function parseAgyMcp(stdout: string): string[] | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  if (!/^NAME\s+TYPE\s+STATUS/.test(lines[0]!)) {
    return /no mcp servers/i.test(stdout) ? [] : null;
  }
  const names: string[] = [];
  for (const line of lines.slice(1)) {
    const [name, , status] = line.split(/\s+/);
    if (name && status === "enabled") names.push(name);
  }
  return names;
}

function consentKeyOf(harness: Harness, args: string[], warnings: string[]): string {
  return createHash("sha256").update(JSON.stringify([harness.id, harness.kind, args, warnings])).digest("hex").slice(0, 16);
}

function finish(harness: Harness, args: string[], writes: string, warnings: string[]): InterviewIsolation {
  return { harnessId: harness.id, kind: harness.kind, args, writes, warnings, consentKey: consentKeyOf(harness, args, warnings) };
}

type Resolved = { ok: true; isolation: InterviewIsolation } | { ok: false; error: string };

async function codexIsolation(harness: Harness, run: ProbeRunner): Promise<Resolved> {
  const bin = resolveBin(harness);
  const env = harnessEnv(harness);
  const fail = (why: string): Resolved => ({
    ok: false,
    error: `Codex can't be locked down for an interview: ${why} No interview turn was sent.`,
  });
  const features = await run([bin, "features", "list"], env);
  const known = parseCodexFeatures(features.stdout);
  if (features.code !== 0 || known.size === 0) return fail("`codex features list` didn't answer.");
  const disables = CODEX_DISABLED_FEATURES.filter((name) => known.has(name));
  const globalArgs = ["-c", 'web_search="disabled"', ...disables.flatMap((name) => ["--disable", name])];

  const servers = await run([bin, ...globalArgs, "mcp", "list", "--json"], env);
  const listed = parseCodexMcp(servers.json ?? servers.stdout);
  if (servers.code !== 0 || !listed) return fail("`codex mcp list` didn't answer.");
  const toDisable = [...listed].filter(([, enabled]) => enabled).map(([name]) => name);
  const bad = toDisable.find((name) => !MCP_NAME_RE.test(name));
  if (bad) return fail(`the MCP server name "${bad.slice(0, 64)}" can't be disabled from the command line.`);
  globalArgs.push(...toDisable.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]));

  // Verify with the exact flags the turn will use.
  const [checkFeatures, checkServers] = await Promise.all([
    run([bin, ...globalArgs, "features", "list"], env),
    run([bin, ...globalArgs, "mcp", "list", "--json"], env),
  ]);
  const effective = parseCodexFeatures(checkFeatures.stdout);
  const effectiveServers = parseCodexMcp(checkServers.json ?? checkServers.stdout);
  if (checkFeatures.code !== 0 || effective.size === 0 || checkServers.code !== 0 || !effectiveServers) {
    return fail("its configuration couldn't be verified.");
  }
  const stillOn = CODEX_REQUIRED_OFF.filter((name) => effective.get(name) === true);
  if (stillOn.length > 0) return fail(`${stillOn.join(", ")} stayed on.`);
  const liveServers = [...effectiveServers].filter(([, enabled]) => enabled).map(([name]) => name);
  if (liveServers.length > 0) return fail(`MCP servers stayed enabled: ${liveServers.join(", ")}.`);

  const warnings: string[] = [
    "Codex's shell, browser, computer use, apps, plugins, hooks and memories are turned off for these turns" +
      (toDisable.length > 0 ? `, and your ${toDisable.length} MCP server${toDisable.length > 1 ? "s are" : " is"} disabled.` : "."),
  ];
  const residual = disables.filter((name) => effective.get(name) === true);
  if (residual.length > 0) {
    warnings.push(`This Codex version keeps ${residual.join(", ")} on even when asked to turn it off. It still runs inside the read-only sandbox, which can read any file your account can.`);
  } else {
    warnings.push("Codex's read-only sandbox lets any remaining tool read files your account can read. ForgeOrbit can't verify every tool a future Codex version adds.");
  }
  warnings.push("The interview text goes to OpenAI under your Codex account and counts against its usage. Codex runs with --ephemeral, so it doesn't save the session.");
  return {
    ok: true,
    isolation: finish(harness, ["--ephemeral", ...globalArgs], "Blocked by Codex's macOS sandbox (read-only).", warnings),
  };
}

async function cursorIsolation(harness: Harness, run: ProbeRunner): Promise<Resolved> {
  const bin = resolveBin(harness);
  const env = harnessEnv(harness);
  const argv = [bin, "--help"];
  const prep = run === defaultProbeRunner
    ? prepareCursorRuntime({ bin, harnessEnv: env, harnessHome: harness.home, protectedPaths: [dataDir], network: false })
    : null;
  if (prep && !prep.ok) return prep;
  let help;
  try {
    help = prep
      ? await run(wrapCursorArgv(prep.value, argv), {}, prep.value.paths.work)
      : await run(argv, env);
  } finally {
    if (prep) removeCursorRuntime(prep.value.receipt);
  }
  if (
    help.code !== 0 || !/--mode\b/.test(help.stdout) || !/\bask\b/.test(help.stdout)
    || !/--sandbox\b/.test(help.stdout) || !/--trust\b/.test(help.stdout)
  ) {
    return { ok: false, error: "This Cursor CLI has no read-only ask mode. No interview turn was sent." };
  }
  return {
    ok: true,
    isolation: finish(harness, ["--mode", "ask", "--sandbox", "enabled", "--trust"], "Cursor runs in ask mode with writes confined to its private runtime by the macOS kernel sandbox.", [
      "Cursor can use its private local socket and the macOS login Keychain. System files and filesystem metadata can still be visible.",
      "MCP servers aren't auto-approved, and commands aren't forced.",
      "The interview text goes to Cursor under your account and counts against its usage. Cursor may keep the chat in its own history.",
    ]),
  };
}

async function antigravityIsolation(harness: Harness, run: ProbeRunner): Promise<Resolved> {
  const bin = resolveBin(harness);
  const env = harnessEnv(harness);
  const help = await run([bin, "--help"], env);
  if (help.code !== 0 || !/--sandbox\b/.test(help.stdout) || !/--mode\b/.test(help.stdout)) {
    return { ok: false, error: "This Antigravity CLI has no sandbox or plan mode. No interview turn was sent." };
  }
  const args = ["--sandbox"];
  if (/--disable-slash-commands\b/.test(help.stdout)) args.push("--disable-slash-commands");
  const mcp = await run([bin, "mcp", "list"], env);
  const servers = mcp.code === 0 ? parseAgyMcp(mcp.stdout) : null;
  const warnings = [
    servers == null
      ? "Couldn't list Antigravity's MCP servers. Any that are enabled stay available to the model."
      : servers.length > 0
        ? `These Antigravity MCP servers are enabled and available to the model. They cannot be turned off for only this run, and ForgeOrbit does not disable them: ${servers.join(", ")}.`
        : "No Antigravity MCP servers are enabled.",
    "Antigravity's read tools can still read files outside the empty interview folder.",
    "The interview text goes to Google under your Antigravity account and counts against its usage.",
  ];
  return {
    ok: true,
    isolation: finish(harness, args, "Blocked by Antigravity's plan mode. The CLI enforces it, not an OS sandbox.", warnings),
  };
}

const cache = new Map<string, { at: number; value: Resolved }>();

/**
 * The flags and warnings for one harness. Cached briefly per harness, bin
 * and home, so a few turns in a row don't re-run the probes.
 */
export async function resolveInterviewIsolation(
  harness: Harness,
  deps: { run?: ProbeRunner; now?: number; noCache?: boolean } = {},
): Promise<Resolved> {
  if (agentDriverIsFake(harness.kind)) {
    return {
      ok: true,
      isolation: finish(harness, [], "Test driver: no agent runs.", ["Test driver: no real agent runs and nothing leaves this machine."]),
    };
  }
  const now = deps.now ?? Date.now();
  const key = `${harness.id}\0${resolveBin(harness)}\0${harness.home ?? ""}`;
  const hit = cache.get(key);
  if (!deps.noCache && hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const run = deps.run ?? defaultProbeRunner;
  let value: Resolved;
  if (harness.kind === "codex") value = await codexIsolation(harness, run);
  else if (harness.kind === "cursor") value = await cursorIsolation(harness, run);
  else if (harness.kind === "antigravity") value = await antigravityIsolation(harness, run);
  else value = { ok: false, error: `${harness.label} can't run interviews.` };
  if (!deps.noCache) cache.set(key, { at: now, value });
  return value;
}

export function clearIsolationCache(): void {
  cache.clear();
}
