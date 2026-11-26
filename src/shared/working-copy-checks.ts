/**
 * Pure contract and policy classifier for local project checks inside an
 * isolated task working copy. Browser-safe (no node:* imports).
 *
 * Security rule: this policy check is a clear, fast blocker for disallowed
 * operations (git push, deployment, dependency install, network clients,
 * privilege escalation, path escapes). It is NOT the sole isolation boundary:
 * the macOS Seatbelt sandbox enforces write confinement and no-network at the
 * kernel level for every executed command and its child processes.
 */

export type WorkingCopyCheckStatus = "passed" | "failed" | "blocked" | "not-run" | "interrupted";

export interface WorkingCopyCheckRecord {
  id: string;
  command: string;
  argv: string[];
  cwd: string;
  status: WorkingCopyCheckStatus;
  exitCode: number | null;
  summary: string | null;
  reason: string | null;
  isolation: "macos-offline-seatbelt" | "codex-seatbelt" | "blocked" | "unverified";
  startedAt: number;
  finishedAt: number | null;
  sourceFingerprint: string | null;
  /** True only when ForgeOrbit itself executed or verified the command outcome. */
  observedByForgeOrbit: boolean;
}

export interface WorkingCopyCheckSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  interrupted: number;
  /** Aggregate headline: never "passed" unless at least one check ran and passed with no failures/blocks. */
  status: WorkingCopyCheckStatus;
}

export function summarizeWorkingCopyChecks(checks: readonly WorkingCopyCheckRecord[]): WorkingCopyCheckSummary {
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let interrupted = 0;
  for (const item of checks) {
    if (item.status === "passed" && item.exitCode === 0) passed += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "blocked") blocked += 1;
    else if (item.status === "interrupted") interrupted += 1;
  }
  const total = checks.length;
  let status: WorkingCopyCheckStatus = "not-run";
  if (total === 0) status = "not-run";
  else if (failed > 0) status = "failed";
  else if (blocked > 0) status = "blocked";
  else if (interrupted > 0) status = "interrupted";
  else if (passed > 0) status = "passed";
  return { total, passed, failed, blocked, interrupted, status };
}

export type WorkingCopyCommandPolicyResult =
  | { ok: true; argv: string[]; command: string }
  | { ok: false; code: string; reason: string };

const BLOCKED_GIT_SUBCOMMANDS = new Set([
  "push", "fetch", "pull", "clone", "remote", "submodule", "ls-remote",
  "credential", "credential-osxkeychain", "send-email", "svn",
]);

const BLOCKED_NETWORK_TOOLS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp",
  "http", "httpie", "xh", "dig", "nslookup", "host", "ping", "traceroute",
]);

const BLOCKED_DEPLOY_TOOLS = new Set([
  "vercel", "netlify", "fly", "flyctl", "kubectl", "helm", "terraform",
  "tofu", "pulumi", "aws", "gcloud", "gsutil", "az", "docker", "podman",
  "nerdctl", "ssh", "scp", "rsync", "gh", "glab", "heroku", "railway", "wrangler",
]);

const BLOCKED_PRIVILEGE_TOOLS = new Set([
  "sudo", "su", "doas", "osascript", "open", "launchctl", "security",
  "codesign", "defaults", "killall", "pkill", "sandbox-exec", "diskutil",
  "csrutil", "spctl", "networksetup", "scutil", "dscl",
]);

const BLOCKED_INSTALL_RUNNERS = new Set(["npx", "bunx", "dlx", "pnpx", "pipx"]);

const NODE_PM_INSTALL_SUBCOMMANDS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up",
  "upgrade", "publish", "unpublish", "login", "logout", "adduser", "link",
  "pm", "create", "init", "dlx", "x", "patch", "audit",
]);

const PYTHON_INSTALL_SUBCOMMANDS = new Set([
  "install", "uninstall", "download", "wheel", "sync", "add", "remove", "lock", "publish",
]);

const CARGO_BLOCKED_SUBCOMMANDS = new Set([
  "install", "uninstall", "publish", "login", "logout", "yank", "add", "update", "fetch",
]);

const GO_BLOCKED_SUBCOMMANDS = new Set(["get", "install"]);

const ALLOWED_LOCAL_EXECUTABLES = new Set([
  "bun", "node", "npm", "yarn", "pnpm",
  "tsc", "eslint", "biome", "prettier", "oxlint", "vitest", "jest", "mocha", "ava", "tsx", "vite", "esbuild", "rollup", "webpack",
  "python", "python3", "pytest", "ruff", "mypy", "flake8", "black", "isort", "pyright", "unittest",
  "go", "cargo", "rustc", "swift", "make", "cmake", "ninja", "ctest",
  "ruby", "rspec", "rake", "bundle", "php", "phpunit",
  "sh", "bash", "zsh", "env",
]);

function leafName(token: string): string {
  const idx = token.lastIndexOf("/");
  return idx === -1 ? token : token.slice(idx + 1);
}

/**
 * Tokenize a single local command without invoking a shell.
 * Rejects unclosed quotes, newlines, null bytes, command substitution, and shell chaining.
 */
export function parseLocalCheckCommand(raw: string): { ok: true; argv: string[] } | { ok: false; code: string; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: "empty-command", reason: "A command is required." };
  if (trimmed.length > 1000) return { ok: false, code: "command-too-long", reason: "Command exceeds the 1000-character limit." };
  if (/[\x00\r\n]/.test(trimmed)) return { ok: false, code: "unsafe-command", reason: "Multiline or control-character commands are not allowed." };
  if (trimmed.includes("$(") || trimmed.includes("`") || /[<>]\(/.test(trimmed)) {
    return { ok: false, code: "shell-substitution", reason: "Shell command substitution is not allowed in local project checks." };
  }

  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  let hasToken = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (escape) {
      current += ch;
      escape = false;
      hasToken = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escape = true;
      else if (ch === '"') quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === ">" || ch === "<") {
      return {
        ok: false,
        code: "shell-chaining",
        reason: "Shell chaining, pipes, and redirections are not allowed. Run one local project check command at a time.",
      };
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (escape || quote !== null) {
    return { ok: false, code: "unclosed-quote", reason: "Command has an unclosed quote or trailing escape." };
  }
  if (hasToken) argv.push(current);
  if (argv.length === 0) return { ok: false, code: "empty-command", reason: "A command is required." };
  return { ok: true, argv };
}

function hasPathEscapeArg(args: readonly string[]): string | null {
  for (const arg of args) {
    const value = arg.includes("=") && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (!value) continue;
    if (value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..")) {
      return `Argument "${arg}" traverses outside the working copy.`;
    }
    if (value.startsWith("/") || value.startsWith("~/") || value === "~") {
      return `Argument "${arg}" references a path outside the working copy.`;
    }
    if (value.includes(".git/") || value === ".git") {
      return `Argument "${arg}" targets Git metadata, which is outside working-copy checks.`;
    }
  }
  return null;
}

function checkToolAndArgs(lead: string, rest: readonly string[]): { ok: true } | { ok: false; code: string; reason: string } {
  if (BLOCKED_PRIVILEGE_TOOLS.has(lead)) {
    return { ok: false, code: "policy-system-privilege", reason: `Command "${lead}" is outside project working-copy permissions.` };
  }
  if (BLOCKED_NETWORK_TOOLS.has(lead)) {
    return { ok: false, code: "policy-network", reason: `Network command "${lead}" is blocked by project working-copy permissions.` };
  }
  if (BLOCKED_DEPLOY_TOOLS.has(lead)) {
    return { ok: false, code: "policy-deployment", reason: `Deployment or remote command "${lead}" is blocked by project working-copy permissions.` };
  }
  if (BLOCKED_INSTALL_RUNNERS.has(lead)) {
    return { ok: false, code: "policy-dependency-install", reason: `Package download runner "${lead}" is blocked; dependency installation is not granted by working-copy development.` };
  }
  if (lead === "brew" || lead === "pip" || lead === "pip3" || lead === "uv" || lead === "poetry" || lead === "composer" || lead === "gem") {
    const sub = rest.find((a) => !a.startsWith("-")) ?? "";
    if (lead === "brew" || PYTHON_INSTALL_SUBCOMMANDS.has(sub) || sub === "install" || sub === "add") {
      const label = `${lead} ${sub}`.trim();
      return { ok: false, code: "policy-dependency-install", reason: `Dependency installation ("${label}") is not allowed by project working-copy permissions.` };
    }
    if (lead === "uv" && (sub === "run" || sub === "tool")) {
      return { ok: false, code: "policy-dependency-install", reason: `"uv ${sub}" can download packages and is blocked by project working-copy permissions.` };
    }
  }
  if (lead === "git") {
    const sub = rest.find((a) => !a.startsWith("-")) ?? "";
    if (!sub || BLOCKED_GIT_SUBCOMMANDS.has(sub) || sub === "commit" || sub === "merge" || sub === "rebase" || sub === "checkout" || sub === "reset" || sub === "branch" || sub === "tag") {
      return { ok: false, code: "policy-git-remote", reason: `Git command "git ${sub}" is not allowed in working-copy checks. Working copies are non-git and never push or mutate Git refs.` };
    }
    return { ok: false, code: "policy-git-remote", reason: "Git commands are not run inside a non-git task working copy." };
  }
  if (lead === "npm" || lead === "bun" || lead === "yarn" || lead === "pnpm") {
    const sub = rest.find((a) => !a.startsWith("-")) ?? "";
    if (!sub) {
      return { ok: false, code: "policy-unsupported", reason: `Specify a local project check subcommand for "${lead}" (such as test, run, or build).` };
    }
    if (NODE_PM_INSTALL_SUBCOMMANDS.has(sub)) {
      return { ok: false, code: "policy-dependency-install", reason: `"${lead} ${sub}" is blocked: dependency installation and package publishing are not allowed by project working-copy permissions.` };
    }
    if (lead === "bun" && (sub === "exec" || sub === "repl" || sub === "upgrade")) {
      return { ok: false, code: "policy-unsupported", reason: `"bun ${sub}" is outside allowed local project checks.` };
    }
  }
  if (lead === "cargo") {
    const sub = rest.find((a) => !a.startsWith("-")) ?? "";
    if (!sub || CARGO_BLOCKED_SUBCOMMANDS.has(sub)) {
      return { ok: false, code: "policy-dependency-install", reason: `"cargo ${sub}" is blocked by project working-copy permissions.` };
    }
  }
  if (lead === "go") {
    const sub = rest.find((a) => !a.startsWith("-")) ?? "";
    if (!sub || GO_BLOCKED_SUBCOMMANDS.has(sub)) {
      return { ok: false, code: "policy-dependency-install", reason: `"go ${sub}" is blocked by project working-copy permissions.` };
    }
  }
  if (lead === "python" || lead === "python3") {
    const mIdx = rest.indexOf("-m");
    if (mIdx >= 0 && rest[mIdx + 1] === "pip") {
      return { ok: false, code: "policy-dependency-install", reason: "Running pip via python is blocked by project working-copy permissions." };
    }
  }
  if (lead === "sh" || lead === "bash" || lead === "zsh") {
    // Allow running a local project script (never `-c` arbitrary shell strings that bypass policy checks).
    if (rest.includes("-c") || rest.includes("-lc") || rest.length === 0) {
      return { ok: false, code: "policy-shell-inline", reason: "Inline shell commands (-c) are outside local check policy. Run the check tool or a local project script directly." };
    }
  }
  if (lead === "env") {
    return { ok: false, code: "policy-wrapper", reason: "Wrapper command \"env\" is not allowed; invoke the local check tool directly." };
  }
  return { ok: true };
}

/**
 * Evaluate a local project check command against working-copy policy.
 * Rejects disallowed commands before any process is spawned.
 */
export function evaluateWorkingCopyCommandPolicy(input: string | readonly string[]): WorkingCopyCommandPolicyResult {
  let argv: string[];
  let command: string;
  if (typeof input === "string") {
    const parsed = parseLocalCheckCommand(input);
    if (!parsed.ok) return parsed;
    argv = parsed.argv;
    command = input.trim();
  } else {
    if (!Array.isArray(input) || input.length === 0 || input.some((a) => typeof a !== "string" || !a || /[\x00\r\n]/.test(a))) {
      return { ok: false, code: "invalid-argv", reason: "Check command argv must be a non-empty list of single-line strings." };
    }
    argv = [...input];
    command = argv.join(" ");
  }

  const rawBin = argv[0]!;
  if (rawBin.includes("..")) {
    return { ok: false, code: "policy-path-escape", reason: "Executable path traverses outside the working copy." };
  }
  if (rawBin.startsWith("/")) {
    return { ok: false, code: "policy-path-escape", reason: "Use a bare tool name (resolved from local tools) or a relative path inside the working copy." };
  }

  const lead = leafName(rawBin);
  const rest = argv.slice(1);
  const toolCheck = checkToolAndArgs(lead, rest);
  if (!toolCheck.ok) return toolCheck;
  const isRelativeLocalScript = rawBin.startsWith("./") && !rawBin.startsWith("./.git");
  if (!isRelativeLocalScript && !ALLOWED_LOCAL_EXECUTABLES.has(lead)) {
    return {
      ok: false,
      code: "policy-unsupported",
      reason: `Command "${lead}" is outside the allowed local project check tools (tests, lint, typecheck, build).`,
    };
  }

  const escapeReason = hasPathEscapeArg(rest);
  if (escapeReason) {
    return { ok: false, code: "policy-path-escape", reason: escapeReason };
  }
  return { ok: true, argv, command };
}

export interface RunShellEventLike {
  stream: string;
  data: string;
  ts: number;
  subagentId?: string | null;
}

/**
 * Extract shell commands that actually executed during a Developer run
 * (e.g. Codex `command_execution` tool_use/tool_result pairs).
 * Never treats a Developer process's exit code 0 or assistant prose as a check.
 */
export function extractRunShellChecksFromEvents(
  events: readonly RunShellEventLike[],
  cwd: string,
): WorkingCopyCheckRecord[] {
  const uses = new Map<string, { command: string; ts: number }>();
  const results = new Map<string, { content: string; isError: boolean; exitCode: number | null; ts: number }>();

  for (const ev of events) {
    if (ev.subagentId != null) continue;
    if (ev.stream === "tool_use") {
      try {
        const parsed = JSON.parse(ev.data) as { id?: unknown; name?: unknown; input?: { command?: unknown } };
        const id = typeof parsed.id === "string" ? parsed.id : "";
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const cmd = typeof parsed.input?.command === "string" ? parsed.input.command.trim() : "";
        if (id && cmd && (name === "shell" || name === "Bash" || name === "command_execution")) {
          uses.set(id, { command: cmd, ts: ev.ts });
        }
      } catch { /* ignore non-JSON tool_use */ }
    } else if (ev.stream === "tool_result") {
      try {
        const parsed = JSON.parse(ev.data) as { toolUseId?: unknown; content?: unknown; isError?: unknown; exitCode?: unknown };
        const id = typeof parsed.toolUseId === "string" ? parsed.toolUseId : "";
        if (!id) continue;
        const content = typeof parsed.content === "string" ? parsed.content : "";
        const exitCode = typeof parsed.exitCode === "number" && Number.isInteger(parsed.exitCode) ? parsed.exitCode : null;
        const isError = parsed.isError === true || (exitCode !== null && exitCode !== 0);
        results.set(id, { content, isError, exitCode, ts: ev.ts });
      } catch { /* ignore non-JSON tool_result */ }
    }
  }

  const out: WorkingCopyCheckRecord[] = [];
  for (const [id, use] of uses.entries()) {
    const res = results.get(id);
    if (!res) {
      out.push({
        id: `run-shell:${id}`,
        command: use.command,
        argv: use.command.split(/\s+/).filter(Boolean),
        cwd,
        status: "interrupted",
        exitCode: null,
        summary: null,
        reason: "Command started during the run without a recorded completion result.",
        isolation: "codex-seatbelt",
        startedAt: use.ts,
        finishedAt: null,
        sourceFingerprint: null,
        observedByForgeOrbit: false,
      });
      continue;
    }
    const sandboxBlocked = /Operation not permitted|sandbox_apply|Permission denied|Read-only file system/i.test(res.content) && res.isError;
    const status = res.isError
      ? (sandboxBlocked ? "blocked" : "failed")
      : res.exitCode === 0 || (!res.isError && res.exitCode === null)
        ? "passed"
        : "failed";
    const summary = res.content.trim() ? res.content.trim().slice(0, 1000) : null;
    out.push({
      id: `run-shell:${id}`,
      command: use.command,
      argv: use.command.split(/\s+/).filter(Boolean),
      cwd,
      status,
      exitCode: res.exitCode ?? (res.isError ? 1 : 0),
      summary,
      reason: status === "passed"
        ? "Command executed inside the provider working-copy sandbox and exited 0."
        : status === "blocked"
          ? "Command was blocked by the working-copy sandbox."
          : `Command executed inside the provider working-copy sandbox and failed${res.exitCode != null ? ` (exit code ${res.exitCode})` : ""}.`,
      isolation: "codex-seatbelt",
      startedAt: use.ts,
      finishedAt: res.ts,
      sourceFingerprint: null,
      observedByForgeOrbit: false,
    });
  }
  return out;
}
