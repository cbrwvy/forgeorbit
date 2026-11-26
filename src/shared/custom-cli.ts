import type { AgentKind, CustomCliConfig, CustomInteractionMode, CustomPromptDelivery } from "./types.ts";

export interface CliCapabilities {
  /** Can be launched manually in Terminal.app or via user-initiated task run. */
  manualRun: boolean;
  /** Supports capturing structured or stdout/stderr output automatically. */
  automatedOutput: boolean;
  /** Admitted for isolated autonomous Developer execution under ForgeOrbit policies. */
  autonomousDeveloper: boolean;
  /** Admitted for isolated autonomous independent Reviewer execution. */
  autonomousReviewer: boolean;
  /** Whether independent multi-account isolation is supported. */
  multiAccount: "isolated" | "partial" | "single-login" | "configurable";
}

export interface DiscoveredCli {
  /** Stable service id for grouping/deduplication (e.g. "codex", "deepseek", "opencode"). */
  serviceId: string;
  /** Display name (e.g. "DeepSeek", "OpenCode"). */
  label: string;
  /** Short description key or fallback text. */
  description: string;
  /** Target AgentKind when registering. */
  kind: AgentKind;
  /** Suggested harness slug id when adding. */
  suggestedHarnessId: string;
  /** Executable command name searched on PATH. */
  command: string;
  /** Resolved absolute path if found on this Mac, else null. */
  resolvedPath: string | null;
  /** True iff an executable CLI binary was actually found on disk. */
  installed: boolean;
  /** Existing harness ids already registered for this service. */
  registeredHarnessIds: string[];
  /** True if at least one harness for this service is currently enabled. */
  enabled: boolean;
  /** True if the user explicitly disabled the built-in/registered harness. */
  explicitlyDisabled: boolean;
  /** Default structured CLI config for custom CLIs. */
  defaultCliConfig?: CustomCliConfig | null;
  /** Honest capability breakdown — never fakes autonomous support. */
  capabilities: CliCapabilities;
  /** Optional short limitation code when autonomous execution is unavailable. */
  limitationCode?: "cursor-nested-sandbox" | "deepseek-containment" | "custom-manual-only" | "single-login" | null;
}

export interface CliDiscoveryResponse {
  discovered: DiscoveredCli[];
}

export const DEFAULT_CUSTOM_CLI_CONFIG: CustomCliConfig = {
  args: [],
  promptDelivery: "arg",
  promptFlag: null,
  interactionMode: "manual",
  workdir: null,
  defaultModel: null,
  modelFlag: null,
  effortFlag: null,
  serviceId: null,
  homeEnvVar: null,
  terminalArgs: null,
};

const VALID_DELIVERIES = new Set<CustomPromptDelivery>(["arg", "stdin", "interactive"]);
const VALID_MODES = new Set<CustomInteractionMode>(["manual", "automated"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Safely parse a space-separated CLI argument string into an argument vector
 * without invoking a shell. Supports single and double quotes plus backslash
 * escaping. Returns an empty array for empty/whitespace-only strings.
 */
export function parseArgString(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaped) {
      current += ch;
      inToken = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          escaped = true;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaped) current += "\\";
  if (inToken) args.push(current);
  return args;
}

/** Format an argument vector back into a readable string for editing. */
export function formatArgString(args: readonly string[] | null | undefined): string {
  if (!args || args.length === 0) return "";
  return args
    .map((arg) => {
      if (arg === "") return '""';
      if (/[\s"'\\]/.test(arg)) {
        return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      }
      return arg;
    })
    .join(" ");
}

/**
 * Sanitize and normalize an untrusted CustomCliConfig payload (from HTTP API or DB).
 * Returns null if raw is null/undefined.
 */
export function normalizeCustomCliConfig(raw: unknown): CustomCliConfig | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const args: string[] = Array.isArray(r.args)
    ? r.args.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0"))
    : typeof r.args === "string"
      ? parseArgString(r.args)
      : [];
  const promptDelivery: CustomPromptDelivery =
    typeof r.promptDelivery === "string" && VALID_DELIVERIES.has(r.promptDelivery as CustomPromptDelivery)
      ? (r.promptDelivery as CustomPromptDelivery)
      : "arg";
  const interactionMode: CustomInteractionMode =
    typeof r.interactionMode === "string" && VALID_MODES.has(r.interactionMode as CustomInteractionMode)
      ? (r.interactionMode as CustomInteractionMode)
      : "manual";
  const cleanStr = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    if (!trimmed || trimmed.includes("\0")) return null;
    return trimmed;
  };
  const homeEnvVarRaw = cleanStr(r.homeEnvVar);
  const homeEnvVar = homeEnvVarRaw && ENV_NAME_RE.test(homeEnvVarRaw) ? homeEnvVarRaw : null;
  const terminalArgs = Array.isArray(r.terminalArgs)
    ? r.terminalArgs.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0"))
    : null;
  return {
    args,
    promptDelivery,
    promptFlag: cleanStr(r.promptFlag),
    interactionMode,
    workdir: cleanStr(r.workdir),
    defaultModel: cleanStr(r.defaultModel),
    modelFlag: cleanStr(r.modelFlag),
    effortFlag: cleanStr(r.effortFlag),
    serviceId: cleanStr(r.serviceId),
    homeEnvVar,
    terminalArgs: terminalArgs && terminalArgs.length > 0 ? terminalArgs : null,
  };
}

/**
 * Validate a custom CLI binary reference: either an absolute path (`/opt/homebrew/bin/opencode`)
 * or a plain executable command name (`opencode`, `my-cli`). Rejects empty strings, relative
 * paths (`./foo`, `../bar`), NUL bytes, whitespace, or shell metacharacters.
 */
export function isValidCustomBin(bin: string): boolean {
  const trimmed = bin.trim();
  if (!trimmed || trimmed.includes("\0")) return false;
  if (trimmed.startsWith("/")) {
    return !/[\r\n]/.test(trimmed);
  }
  if (trimmed.includes("/")) return false;
  return /^[A-Za-z0-9._+-]+$/.test(trimmed);
}

/** Derive a clean slug from a user-entered CLI name. */
export function slugifyHarnessId(name: string, fallback = "custom-cli"): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/-+$/, "");
  return slug || fallback;
}

/** Honest capability matrix per built-in or known service kind. */
export function capabilitiesForKind(kind: AgentKind, serviceId?: string | null): CliCapabilities {
  switch (kind) {
    case "codex":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: true,
        autonomousReviewer: true,
        multiAccount: "isolated",
      };
    case "claude-code":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: true,
        autonomousReviewer: true,
        multiAccount: "partial",
      };
    case "cursor":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: false,
        autonomousReviewer: false,
        multiAccount: "single-login",
      };
    case "antigravity":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: false,
        autonomousReviewer: false,
        multiAccount: "configurable",
      };
    case "gemini":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: false,
        autonomousReviewer: false,
        multiAccount: "isolated",
      };
    case "fx":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: false,
        autonomousReviewer: false,
        multiAccount: "configurable",
      };
    case "custom":
      return {
        manualRun: true,
        automatedOutput: true,
        autonomousDeveloper: false,
        autonomousReviewer: false,
        multiAccount: serviceId === "deepseek" ? "configurable" : "configurable",
      };
  }
}
