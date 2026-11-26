/**
 * Unified presentation model for Settings → AI Providers & Accounts.
 *
 * Groups built-in harnesses, additional account harnesses, custom CLIs,
 * execution profiles, detected local CLIs, and technical diagnostics into
 * ONE card per service without deleting or merging any database records.
 */
import type { AgentKind, Harness, HarnessStatus } from "../../shared/types.ts";
import type { ExecutionProfile } from "../../shared/accounts/execution-profile.ts";
import type { CliCapabilities, DiscoveredCli } from "../../shared/custom-cli.ts";
import { capabilitiesForKind } from "../../shared/custom-cli.ts";
import type { HarnessInstallation } from "../../shared/harness-installation.ts";
import type { ProviderDiagnostic } from "../../shared/provider-readiness.ts";
import type { RuntimeReadiness } from "../../shared/provider-runtime/readiness.ts";

export type ProviderStatusLight = "green" | "yellow" | "red" | "muted";

export type ProviderShortStatus =
  | "ready"
  | "connected"
  | "manual_only"
  | "auth_needed"
  | "not_installed"
  | "detected"
  | "disabled";

export interface ProviderServiceAccountItem {
  id: string;
  harness: Harness | null;
  status: HarnessStatus | null;
  executionProfile: ExecutionProfile | null;
  displayName: string;
  isPrimary: boolean;
  enabled: boolean;
  available: boolean;
  loggedIn: boolean | null;
  light: ProviderStatusLight;
  shortStatus: ProviderShortStatus;
  configDir: string | null;
}

export interface ProviderServiceGroup {
  serviceId: string;
  label: string;
  iconKind: string;
  primaryKind: AgentKind;
  /** Primary built-in or first registered harness for this service, if any. */
  primaryHarness: Harness | null;
  /** All registered harnesses belonging to this service (built-in + additional). */
  harnesses: Harness[];
  /** Execution profiles (Codex/Claude) attached to this service. */
  executionProfiles: ExecutionProfile[];
  /** Unified per-account rows rendered inside the expanded card (never merges distinct identities). */
  accounts: ProviderServiceAccountItem[];
  /** Number of distinct accounts/profiles inside this service. */
  accountCount: number;
  installed: boolean;
  enabled: boolean;
  connected: boolean;
  light: ProviderStatusLight;
  shortStatus: ProviderShortStatus;
  discoveredCli: DiscoveredCli | null;
  capabilities: CliCapabilities;
  limitationCode: DiscoveredCli["limitationCode"];
  diagnostics: {
    resolvedPath: string | null;
    version: string | null;
    runtimeReadiness: RuntimeReadiness | null;
    providerDiagnostic: ProviderDiagnostic | null;
    installation: HarnessInstallation | null;
  };
}

const KNOWN_SERVICE_ORDER: readonly string[] = [
  "codex",
  "claude-code",
  "cursor",
  "antigravity",
  "deepseek",
  "gemini",
  "opencode",
  "copilot",
  "fx",
];

const BUILTIN_LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  antigravity: "Antigravity",
  deepseek: "DeepSeek",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  fx: "fx.sh",
};

/** Resolve the canonical service group id for a harness row. */
export function serviceIdForHarness(harness: Harness): string {
  if (harness.kind !== "custom") return harness.kind;
  if (harness.cliConfig?.serviceId) return harness.cliConfig.serviceId;
  const binBase = harness.bin ? harness.bin.split("/").pop()?.toLowerCase() ?? "" : "";
  if (binBase === "dsh" || harness.id === "deepseek" || harness.id === "deepseek-dsh" || harness.id.startsWith("deepseek-")) {
    return "deepseek";
  }
  if (binBase === "opencode" || harness.id === "opencode" || harness.id.startsWith("opencode-")) {
    return "opencode";
  }
  if (binBase === "copilot" || binBase === "github-copilot-cli" || harness.id === "copilot" || harness.id.startsWith("copilot-")) {
    return "copilot";
  }
  return harness.id;
}

/** Resolve the canonical service group id for an execution profile. */
export function serviceIdForExecutionProfile(profile: ExecutionProfile, harnesses: readonly Harness[]): string {
  if (profile.kind === "codex") return "codex";
  if (profile.kind === "claude") return "claude-code";
  const h = harnesses.find((item) => item.id === profile.harnessId);
  if (h) return serviceIdForHarness(h);
  const p = profile.provider.toLowerCase();
  if (p.includes("deepseek")) return "deepseek";
  if (p.includes("cursor")) return "cursor";
  if (p.includes("antigravity")) return "antigravity";
  return profile.provider || profile.accountId;
}

function runtimeProviderIdForService(serviceId: string): string {
  if (serviceId === "deepseek") return "deepseek-dsh";
  return serviceId;
}

function evaluateAccountItem(
  harness: Harness | null,
  status: HarnessStatus | null,
  profile: ExecutionProfile | null,
  capabilities: CliCapabilities,
): { light: ProviderStatusLight; shortStatus: ProviderShortStatus; available: boolean; loggedIn: boolean | null } {
  const enabled = profile ? !profile.disabled : (harness?.enabled ?? false);
  const available = status ? status.available : profile ? profile.authentication !== "unavailable" : false;
  const loggedIn =
    profile?.authentication === "authenticated"
      ? true
      : profile?.authentication === "required"
        ? false
        : (status?.loggedIn ?? (status?.account ? true : null));

  if (!enabled) {
    return { light: "muted", shortStatus: "disabled", available, loggedIn };
  }
  if (!available) {
    return { light: "red", shortStatus: "not_installed", available, loggedIn };
  }
  if (loggedIn === false) {
    return { light: "red", shortStatus: "auth_needed", available, loggedIn };
  }
  if (!capabilities.autonomousDeveloper && harness?.kind === "custom") {
    return { light: "yellow", shortStatus: "manual_only", available, loggedIn };
  }
  if (loggedIn === true) {
    return { light: "green", shortStatus: "ready", available, loggedIn };
  }
  return { light: "yellow", shortStatus: "connected", available, loggedIn };
}

export function buildProviderServiceGroups(input: {
  harnesses: readonly Harness[];
  statuses: readonly HarnessStatus[];
  discoveredClis?: readonly DiscoveredCli[];
  executionProfiles?: readonly ExecutionProfile[];
  runtimeReadiness?: readonly RuntimeReadiness[];
  providerDiagnostics?: readonly ProviderDiagnostic[];
  installations?: readonly HarnessInstallation[];
}): ProviderServiceGroup[] {
  const statusMap = new Map(input.statuses.map((s) => [s.harnessId, s]));
  const discoveredMap = new Map((input.discoveredClis ?? []).map((d) => [d.serviceId, d]));
  const readinessMap = new Map((input.runtimeReadiness ?? []).map((r) => [r.providerId, r]));
  const diagnosticMap = new Map((input.providerDiagnostics ?? []).map((d) => [d.id, d]));

  const harnessesByService = new Map<string, Harness[]>();
  for (const h of input.harnesses) {
    const sid = serviceIdForHarness(h);
    const list = harnessesByService.get(sid) ?? [];
    list.push(h);
    harnessesByService.set(sid, list);
  }

  const profilesByService = new Map<string, ExecutionProfile[]>();
  for (const p of input.executionProfiles ?? []) {
    const sid = serviceIdForExecutionProfile(p, input.harnesses);
    const list = profilesByService.get(sid) ?? [];
    list.push(p);
    profilesByService.set(sid, list);
  }

  // Collect all unique service IDs: registered harnesses, detected installed CLIs, and execution profiles.
  const allServiceIds = new Set<string>();
  for (const sid of harnessesByService.keys()) allServiceIds.add(sid);
  for (const sid of profilesByService.keys()) allServiceIds.add(sid);
  for (const d of input.discoveredClis ?? []) {
    if (d.installed || harnessesByService.has(d.serviceId)) {
      allServiceIds.add(d.serviceId);
    }
  }
  // If DeepSeek app installation was detected even without discoveredClis populated (older server payload), include it once.
  const deepseekInst = input.installations?.find((i) => i.id === "deepseek-dsh" || i.provider === "deepseek") ?? null;
  if (deepseekInst && deepseekInst.status !== "missing" && deepseekInst.status !== "unidentified") {
    allServiceIds.add("deepseek");
  }

  const groups: ProviderServiceGroup[] = [];
  for (const serviceId of allServiceIds) {
    const serviceHarnesses = harnessesByService.get(serviceId) ?? [];
    const serviceProfiles = profilesByService.get(serviceId) ?? [];
    const discovered = discoveredMap.get(serviceId) ?? null;
    const primaryHarness = serviceHarnesses.find((h) => h.isBuiltin) ?? serviceHarnesses[0] ?? null;
    const primaryKind: AgentKind = primaryHarness?.kind ?? discovered?.kind ?? "custom";
    const capabilities = discovered?.capabilities ?? capabilitiesForKind(primaryKind, serviceId);

    const profileByHarnessId = new Map(serviceProfiles.map((p) => [p.harnessId, p]));
    const accounts: ProviderServiceAccountItem[] = [];
    const matchedProfileIds = new Set<string>();

    for (const h of serviceHarnesses) {
      const st = statusMap.get(h.id) ?? null;
      const prof = profileByHarnessId.get(h.id) ?? null;
      if (prof) matchedProfileIds.add(prof.accountId);
      const evalRes = evaluateAccountItem(h, st, prof, capabilities);
      const accountEmail = st?.account?.email ?? null;
      const displayName = prof
        ? prof.displayName
        : h.isBuiltin
          ? (accountEmail ? `${h.label} (${accountEmail})` : h.label)
          : h.label;
      accounts.push({
        id: prof ? `profile:${prof.accountId}` : `harness:${h.id}`,
        harness: h,
        status: st,
        executionProfile: prof,
        displayName,
        isPrimary: h.isBuiltin || serviceHarnesses[0]?.id === h.id,
        enabled: prof ? !prof.disabled : h.enabled,
        available: evalRes.available,
        loggedIn: evalRes.loggedIn,
        light: evalRes.light,
        shortStatus: evalRes.shortStatus,
        configDir: prof?.authProfile.path ?? h.home ?? null,
      });
    }

    // Include any execution profile whose harness wasn't already listed above (preserving distinct identities).
    for (const prof of serviceProfiles) {
      if (matchedProfileIds.has(prof.accountId)) continue;
      const st = statusMap.get(prof.harnessId) ?? null;
      const evalRes = evaluateAccountItem(null, st, prof, capabilities);
      accounts.push({
        id: `profile:${prof.accountId}`,
        harness: null,
        status: st,
        executionProfile: prof,
        displayName: prof.displayName,
        isPrimary: accounts.length === 0,
        enabled: !prof.disabled,
        available: evalRes.available,
        loggedIn: evalRes.loggedIn,
        light: evalRes.light,
        shortStatus: evalRes.shortStatus,
        configDir: prof.authProfile.path ?? null,
      });
    }

    const enabled = accounts.some((a) => a.enabled);
    const anyAvailable = accounts.some((a) => a.available);
    const installed = anyAvailable || (discovered?.installed ?? false) ||
      (serviceId === "deepseek" && Boolean(deepseekInst && deepseekInst.status !== "missing" && deepseekInst.status !== "unidentified"));
    const connected = serviceHarnesses.length > 0 || serviceProfiles.length > 0;

    let light: ProviderStatusLight;
    let shortStatus: ProviderShortStatus;

    if (!connected) {
      light = installed ? "yellow" : "muted";
      shortStatus = installed ? "detected" : "not_installed";
    } else if (!enabled) {
      light = "muted";
      shortStatus = "disabled";
    } else if (!installed) {
      light = "red";
      shortStatus = "not_installed";
    } else if (accounts.some((a) => a.enabled && a.light === "green")) {
      light = "green";
      shortStatus = "ready";
    } else if (accounts.some((a) => a.enabled && a.light === "yellow")) {
      light = "yellow";
      shortStatus =
        primaryKind === "custom" || serviceId === "cursor" || serviceId === "deepseek"
          ? "manual_only"
          : "connected";
    } else if (accounts.some((a) => a.enabled && a.shortStatus === "auth_needed")) {
      light = "red";
      shortStatus = "auth_needed";
    } else {
      light = "red";
      shortStatus = "not_installed";
    }

    const primaryStatus = primaryHarness ? statusMap.get(primaryHarness.id) ?? null : null;
    const rtId = runtimeProviderIdForService(serviceId);
    const label =
      BUILTIN_LABELS[serviceId] ??
      discovered?.label ??
      primaryHarness?.label ??
      serviceId;

    const limitationCode: DiscoveredCli["limitationCode"] =
      discovered?.limitationCode ??
      (serviceId === "cursor"
        ? "cursor-nested-sandbox"
        : serviceId === "deepseek"
          ? "deepseek-containment"
          : primaryKind === "custom"
            ? "custom-manual-only"
            : null);

    groups.push({
      serviceId,
      label,
      iconKind: serviceId,
      primaryKind,
      primaryHarness,
      harnesses: serviceHarnesses,
      executionProfiles: serviceProfiles,
      accounts,
      accountCount: accounts.length,
      installed,
      enabled,
      connected,
      light,
      shortStatus,
      discoveredCli: discovered,
      capabilities,
      limitationCode,
      diagnostics: {
        resolvedPath:
          primaryStatus?.path ??
          discovered?.resolvedPath ??
          (serviceId === "deepseek" ? deepseekInst?.path ?? null : null),
        version:
          primaryStatus?.version ??
          (serviceId === "deepseek" ? deepseekInst?.version ?? null : null),
        runtimeReadiness: readinessMap.get(rtId as RuntimeReadiness["providerId"]) ?? null,
        providerDiagnostic: diagnosticMap.get(rtId as ProviderDiagnostic["id"]) ?? null,
        installation: serviceId === "deepseek" ? deepseekInst : null,
      },
    });
  }

  groups.sort((a, b) => {
    // Enabled/connected services first, then installed detected services, then known order, then alphabetical.
    const aOrder = KNOWN_SERVICE_ORDER.indexOf(a.serviceId);
    const bOrder = KNOWN_SERVICE_ORDER.indexOf(b.serviceId);
    const aRank = a.enabled ? 0 : a.installed ? 1 : 2;
    const bRank = b.enabled ? 0 : b.installed ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    if (aOrder !== -1 && bOrder !== -1) return aOrder - bOrder;
    if (aOrder !== -1) return -1;
    if (bOrder !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

  return groups;
}
