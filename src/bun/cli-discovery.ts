/**
 * Read-only discovery of installed AI CLIs on macOS.
 *
 * Scans both the active process PATH and common macOS user/Homebrew binary
 * directories (compensating for launchd's minimal GUI-app PATH).
 *
 * Invariants:
 * - Never executes inference, never contacts network, never installs/updates CLIs.
 * - Never treats a desktop .app bundle as a CLI unless an actual executable CLI
 *   binary exists inside it (e.g. DeepSeek Harness.app's bundled `dsh` launcher).
 * - Never re-enables a harness the user explicitly disabled.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentKind, CustomCliConfig, Harness } from "../shared/types.ts";
import { capabilitiesForKind, type DiscoveredCli } from "../shared/custom-cli.ts";

interface KnownCliSpec {
  serviceId: string;
  label: string;
  description: string;
  kind: AgentKind;
  suggestedHarnessId: string;
  /** Candidate command names to look up on PATH (in preference order). */
  commands: string[];
  /** Extra absolute paths checked even if not on PATH (must be real CLI executables). */
  extraAbsolutePaths?: (home: string) => string[];
  defaultCliConfig?: CustomCliConfig | null;
  limitationCode?: DiscoveredCli["limitationCode"];
}

export const KNOWN_CLI_SPECS: readonly KnownCliSpec[] = [
  {
    serviceId: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    kind: "codex",
    suggestedHarnessId: "codex",
    commands: ["codex"],
    limitationCode: null,
  },
  {
    serviceId: "claude-code",
    label: "Claude Code",
    description: "Anthropic Claude Code CLI",
    kind: "claude-code",
    suggestedHarnessId: "claude-code",
    commands: ["claude"],
    limitationCode: null,
  },
  {
    serviceId: "cursor",
    label: "Cursor",
    description: "Cursor Agent CLI (cursor-agent)",
    kind: "cursor",
    suggestedHarnessId: "cursor",
    commands: ["cursor-agent"],
    limitationCode: "cursor-nested-sandbox",
  },
  {
    serviceId: "antigravity",
    label: "Antigravity",
    description: "Google Antigravity CLI (agy)",
    kind: "antigravity",
    suggestedHarnessId: "antigravity",
    commands: ["agy"],
    limitationCode: null,
  },
  {
    serviceId: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek Harness CLI (dsh)",
    kind: "custom",
    suggestedHarnessId: "deepseek",
    commands: ["dsh"],
    extraAbsolutePaths: (home) => [
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
      path.join(home, "Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"),
    ],
    defaultCliConfig: {
      args: ["--profile", "headless"],
      promptDelivery: "arg",
      promptFlag: null,
      interactionMode: "manual",
      workdir: null,
      defaultModel: null,
      modelFlag: null,
      effortFlag: null,
      serviceId: "deepseek",
      homeEnvVar: "DSH_HOME",
      terminalArgs: ["tui"],
    },
    limitationCode: "deepseek-containment",
  },
  {
    serviceId: "gemini",
    label: "Gemini CLI",
    description: "Google Gemini CLI",
    kind: "gemini",
    suggestedHarnessId: "gemini",
    commands: ["gemini"],
    limitationCode: null,
  },
  {
    serviceId: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI",
    kind: "custom",
    suggestedHarnessId: "opencode",
    commands: ["opencode"],
    defaultCliConfig: {
      args: ["run"],
      promptDelivery: "arg",
      promptFlag: null,
      interactionMode: "manual",
      workdir: null,
      defaultModel: null,
      modelFlag: "--model",
      effortFlag: null,
      serviceId: "opencode",
      homeEnvVar: null,
      terminalArgs: null,
    },
    limitationCode: "custom-manual-only",
  },
  {
    serviceId: "copilot",
    label: "GitHub Copilot",
    description: "GitHub Copilot CLI",
    kind: "custom",
    suggestedHarnessId: "copilot",
    commands: ["copilot", "github-copilot-cli"],
    defaultCliConfig: {
      args: [],
      promptDelivery: "arg",
      promptFlag: "-p",
      interactionMode: "manual",
      workdir: null,
      defaultModel: null,
      modelFlag: "--model",
      effortFlag: null,
      serviceId: "copilot",
      homeEnvVar: null,
      terminalArgs: null,
    },
    limitationCode: "custom-manual-only",
  },
  {
    serviceId: "fx",
    label: "fx.sh",
    description: "Vercel fx coding agent CLI",
    kind: "fx",
    suggestedHarnessId: "fx",
    commands: ["fx"],
    limitationCode: null,
  },
];

/** Build an expanded macOS search PATH covering launchd + common user/Homebrew dirs. */
export function buildMacSearchPath(envPath = process.env.PATH ?? "", home = homedir()): string {
  const standard = [
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".cargo/bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of [...envPath.split(":"), ...standard]) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }
  return parts.join(":");
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCommandOnMac(
  commands: readonly string[],
  opts: {
    envPath?: string;
    home?: string;
    extraAbsolutePaths?: readonly string[];
  } = {},
): string | null {
  const home = opts.home ?? homedir();
  const searchPath = buildMacSearchPath(opts.envPath ?? process.env.PATH ?? "", home);
  for (const cmd of commands) {
    if (!cmd) continue;
    if (path.isAbsolute(cmd)) {
      if (isExecutableFile(cmd)) return cmd;
      continue;
    }
    const found = Bun.which(cmd, { PATH: searchPath });
    if (found && isExecutableFile(found)) return found;
  }
  for (const abs of opts.extraAbsolutePaths ?? []) {
    if (abs && path.isAbsolute(abs) && isExecutableFile(abs)) return abs;
  }
  return null;
}

function matchesRegisteredHarness(spec: KnownCliSpec, harness: Harness): boolean {
  if (spec.kind !== "custom") {
    return harness.kind === spec.kind;
  }
  if (harness.cliConfig?.serviceId && harness.cliConfig.serviceId === spec.serviceId) return true;
  if (harness.id === spec.serviceId || harness.id === spec.suggestedHarnessId) return true;
  if (harness.id.startsWith(`${spec.serviceId}-`)) return true;
  if (harness.bin) {
    const base = path.basename(harness.bin).toLowerCase();
    if (spec.commands.includes(base)) return true;
  }
  return false;
}

/**
 * Discover all known AI CLIs on this machine without executing them or making
 * any network calls.
 */
export function discoverInstalledClis(
  registeredHarnesses: readonly Harness[],
  opts: { envPath?: string; home?: string } = {},
): DiscoveredCli[] {
  const home = opts.home ?? homedir();
  const envPath = opts.envPath ?? process.env.PATH ?? "";
  return KNOWN_CLI_SPECS.map((spec) => {
    const extraAbsolutePaths = spec.extraAbsolutePaths ? spec.extraAbsolutePaths(home) : [];
    const resolvedPath = resolveCommandOnMac(spec.commands, { envPath, home, extraAbsolutePaths });
    const matching = registeredHarnesses.filter((h) => matchesRegisteredHarness(spec, h));
    const enabled = matching.some((h) => h.enabled);
    const explicitlyDisabled = matching.length > 0 && !enabled;
    const defaultCliConfig = spec.defaultCliConfig
      ? { ...spec.defaultCliConfig }
      : null;

    return {
      serviceId: spec.serviceId,
      label: spec.label,
      description: spec.description,
      kind: spec.kind,
      suggestedHarnessId: spec.suggestedHarnessId,
      command: spec.commands[0]!,
      resolvedPath,
      installed: resolvedPath !== null,
      registeredHarnessIds: matching.map((h) => h.id),
      enabled,
      explicitlyDisabled,
      defaultCliConfig,
      capabilities: capabilitiesForKind(spec.kind, spec.serviceId),
      limitationCode: spec.limitationCode ?? null,
    };
  });
}
