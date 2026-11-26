/**
 * Pure aggregation & presentation model for the 4 topbar AI service indicators
 * (Codex, Claude, Cursor, Antigravity).
 *
 * Truthfulness invariants:
 * - Green ONLY when at least one usable account/harness has fresh, verified
 *   remaining capacity strictly > 50% across ALL applicable limiting windows.
 * - Yellow when usable with > 0% and <= 50% remaining, or when exact remaining
 *   percentage is unknown / outdated (stale). Never treat a raw positive count
 *   without a percentage/cap as confirmed > 50% green.
 * - Red when no usable account exists, the service is disabled/unavailable/
 *   unauthenticated, a provider refusal is active, or ANY limiting window on
 *   that account is exhausted (0% remaining).
 * - Never mix quotas or plan metadata across distinct accounts/profiles.
 */
import { clampPercent } from "@/lib/usage";
import type { AgentKind, AgentStatus, Harness, HarnessQuota, QuotaMeter } from "../../../shared/types.ts";
import type { ExecutionProfile } from "../../../shared/accounts/execution-profile.ts";
import type { HarnessInstallation } from "../../../shared/harness-installation.ts";
import { serviceIdForHarness } from "@/lib/provider-services";

export type BuiltinTopbarServiceId = "codex" | "claude" | "cursor" | "antigravity" | "deepseek";
export type TopbarServiceId = BuiltinTopbarServiceId | (string & {});

export type ServiceLight = "green" | "yellow" | "red";

export type ServiceReasonCode =
  | "ok"
  | "low_limit"
  | "almost_out"
  | "limit_unknown"
  | "stale_quota"
  | "auth_unchecked"
  | "limited_profiles"
  | "limit_reached"
  | "provider_refusal"
  | "auth_required"
  | "acceptance_required"
  | "not_installed"
  | "disabled"
  | "blocked";

export type ServiceAvailabilityState = "available" | "disabled" | "unavailable";
export type ServiceAuthState = "signed_in" | "not_signed_in" | "unchecked" | "unknown";

/** Maximum age (ms) for a quota snapshot to confirm a green >50% status. */
export const USAGE_QUOTA_FRESHNESS_MS = 60 * 60_000;

export interface TopbarServiceDefinition {
  id: TopbarServiceId;
  label: string;
  agentKind: AgentKind | "deepseek";
  builtinHarnessId: string;
  profileKind: "codex" | "claude" | null;
}

export const TOPBAR_SERVICES: readonly TopbarServiceDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    agentKind: "codex",
    builtinHarnessId: "codex",
    profileKind: "codex",
  },
  {
    id: "claude",
    label: "Claude",
    agentKind: "claude-code",
    builtinHarnessId: "claude-code",
    profileKind: "claude",
  },
  {
    id: "cursor",
    label: "Cursor",
    agentKind: "cursor",
    builtinHarnessId: "cursor",
    profileKind: null,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    agentKind: "antigravity",
    builtinHarnessId: "antigravity",
    profileKind: null,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    agentKind: "deepseek",
    builtinHarnessId: "deepseek-dsh",
    profileKind: null,
  },
] as const;

export interface ServiceMeterView {
  id: string;
  label: string;
  scope?: string;
  usedPercent: number;
  remainingPercent: number;
  light: ServiceLight;
  resetsAtMs: number | null;
  stale: boolean;
}

export interface ServiceProfileSummary {
  id: string;
  harnessId: string;
  displayName: string;
  light: ServiceLight;
  reason: ServiceReasonCode;
  retryHint: string | null;
  resetsAtMs: number | null;
  verifiedQuota: { remaining: number; unit: string } | null;
  isBuiltinAccount?: boolean;
}

export interface TopbarServiceSummary {
  id: TopbarServiceId;
  label: string;
  agentKind: AgentKind | "deepseek";
  /** True when the built-in harness is enabled, an installation is detected, or at least one non-disabled profile is registered. */
  connected: boolean;
  light: ServiceLight;
  reason: ServiceReasonCode;
  availability: ServiceAvailabilityState;
  auth: ServiceAuthState;
  planType: string | null;
  meters: ServiceMeterView[];
  quotaStale: boolean;
  verifiedQuota: { remaining: number; unit: string } | null;
  nextResetAtMs: number | null;
  retryHint: string | null;
  profiles: ServiceProfileSummary[];
  /** Target harness id passed to onOpenAccounts(harnessId). */
  accountsTargetHarnessId: string;
  /** Secondary technical notes kept collapsed under Details. */
  technicalNotes: {
    version: string | null;
    cliReason: string | null;
    hasClaudePartialNote: boolean;
    hasDeepSeekBlockedNote: boolean;
  };
}

const LIGHT_RANK: Record<ServiceLight, number> = {
  green: 2,
  yellow: 1,
  red: 0,
};

function remainingFromUsed(usedPercent: number): number {
  const clamped = clampPercent(usedPercent);
  if (clamped >= 100) return 0;
  if (clamped <= 0) return 100;
  const raw = 100 - clamped;
  if (raw > 50) return Math.max(51, Math.min(100, Math.round(raw)));
  return Math.max(1, Math.min(50, Math.round(raw)));
}

function meterLight(usedPercent: number, stale: boolean): ServiceLight {
  if (stale) return "yellow";
  const clamped = clampPercent(usedPercent);
  if (clamped >= 100) return "red";
  if (clamped >= 50) return "yellow";
  return "green";
}

function isSnapshotStale(quota: HarnessQuota, nowMs: number): boolean {
  if (!Number.isFinite(quota.fetchedAtMs)) return true;
  if (nowMs - quota.fetchedAtMs > USAGE_QUOTA_FRESHNESS_MS) return true;
  // If any meter's reset window has already passed, the snapshot predates a reset and is stale.
  for (const m of quota.meters) {
    if (m.resetsAtMs != null && Number.isFinite(m.resetsAtMs) && m.resetsAtMs <= nowMs) {
      return true;
    }
  }
  return false;
}

function toMeterViews(
  quota: HarnessQuota | null,
  nowMs: number,
): { meters: ServiceMeterView[]; stale: boolean } {
  if (!quota || quota.status !== "ok" || !Array.isArray(quota.meters) || quota.meters.length === 0) {
    return { meters: [], stale: false };
  }
  const finiteMeters = quota.meters.filter((m) => Number.isFinite(m.usedPercent));
  if (finiteMeters.length === 0) {
    return { meters: [], stale: false };
  }
  const stale = isSnapshotStale(quota, nowMs);
  const meters = finiteMeters.map((m: QuotaMeter) => {
    const used = clampPercent(m.usedPercent);
    const remaining = remainingFromUsed(used);
    return {
      id: m.id,
      label: m.label,
      scope: m.scope,
      usedPercent: used,
      remainingPercent: remaining,
      light: meterLight(used, stale),
      resetsAtMs: m.resetsAtMs ?? null,
      stale,
    };
  });
  return { meters, stale };
}

function evaluateMeters(
  meters: ServiceMeterView[],
  stale: boolean,
): {
  light: ServiceLight;
  reason: ServiceReasonCode;
  nextResetAtMs: number | null;
} | null {
  if (meters.length === 0) return null;
  if (stale) {
    return { light: "yellow", reason: "stale_quota", nextResetAtMs: null };
  }

  let worstUsed = -1;
  let worstReset: number | null = null;
  let exhaustedReset: number | null = null;
  let earliestReset: number | null = null;

  for (const m of meters) {
    if (m.usedPercent > worstUsed) {
      worstUsed = m.usedPercent;
      worstReset = m.resetsAtMs;
    }
    if (m.usedPercent >= 100 && m.resetsAtMs != null) {
      exhaustedReset = exhaustedReset == null ? m.resetsAtMs : Math.min(exhaustedReset, m.resetsAtMs);
    }
    if (m.resetsAtMs != null) {
      earliestReset = earliestReset == null ? m.resetsAtMs : Math.min(earliestReset, m.resetsAtMs);
    }
  }

  if (worstUsed >= 100) {
    return { light: "red", reason: "limit_reached", nextResetAtMs: exhaustedReset ?? worstReset };
  }
  if (worstUsed >= 85) {
    return { light: "yellow", reason: "almost_out", nextResetAtMs: worstReset ?? earliestReset };
  }
  if (worstUsed >= 50) {
    return { light: "yellow", reason: "low_limit", nextResetAtMs: worstReset ?? earliestReset };
  }
  return { light: "green", reason: "ok", nextResetAtMs: earliestReset };
}

function isPercentageUnit(unit: string | null): boolean {
  if (!unit) return false;
  const normalized = unit.trim().toLowerCase();
  return normalized === "%" || normalized === "percent" || normalized === "pct";
}

function matchesServiceProfile(def: TopbarServiceDefinition, profile: ExecutionProfile, harnesses: readonly Harness[]): boolean {
  if (def.profileKind && profile.kind === def.profileKind) return true;
  const h = harnesses.find((item) => item.id === profile.harnessId);
  if (h && h.kind === def.agentKind) return true;
  if (def.id === "cursor" && /cursor/i.test(profile.provider)) return true;
  if (def.id === "antigravity" && /antigravity|agy/i.test(profile.provider)) return true;
  if (def.id === "deepseek" && /deepseek/i.test(profile.provider)) return true;
  return false;
}

function cleanProfileDisplayName(name: string, serviceLabel: string): string {
  const trimmed = name.trim();
  const prefix = `${serviceLabel} · `;
  if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim() || trimmed;
  return trimmed;
}

interface EvaluatedUnit {
  harnessId: string;
  light: ServiceLight;
  reason: ServiceReasonCode;
  available: boolean;
  enabled: boolean;
  auth: ServiceAuthState;
  planType: string | null;
  meters: ServiceMeterView[];
  quotaStale: boolean;
  verifiedQuota: { remaining: number; unit: string } | null;
  nextResetAtMs: number | null;
  retryHint: string | null;
  profileSummary?: ServiceProfileSummary;
}

function evaluateProfileUnit(
  def: TopbarServiceDefinition,
  profile: ExecutionProfile,
  agent: AgentStatus | null,
  quota: HarnessQuota | null,
  nowMs: number,
): EvaluatedUnit {
  const { meters, stale } = toMeterViews(quota, nowMs);
  const meterEval = evaluateMeters(meters, stale);
  const verifiedQuota =
    profile.quota.status === "verified" &&
    profile.quota.remaining !== null &&
    Number.isFinite(profile.quota.remaining) &&
    profile.quota.unit
      ? { remaining: profile.quota.remaining, unit: profile.quota.unit }
      : null;
  const activeRefusal =
    profile.providerRefusal && profile.providerRefusal.supersededAt === null
      ? profile.providerRefusal
      : null;

  const auth: ServiceAuthState =
    profile.authentication === "authenticated"
      ? "signed_in"
      : profile.authentication === "required"
        ? "not_signed_in"
        : profile.authentication === "unknown"
          ? "unchecked"
          : "unknown";

  const cliUnavailable = (agent !== null && !agent.available) || profile.authentication === "unavailable";

  let light: ServiceLight;
  let reason: ServiceReasonCode;
  const nextResetAtMs = meterEval?.nextResetAtMs ?? null;
  const retryHint: string | null = activeRefusal?.retryHint ?? null;

  if (profile.disabled) {
    light = "red";
    reason = "disabled";
  } else if (cliUnavailable) {
    light = "red";
    reason = "not_installed";
  } else if (profile.kind === "claude" && profile.homeAccessAccepted === false) {
    light = "red";
    reason = "acceptance_required";
  } else if (profile.authentication === "required") {
    light = "red";
    reason = "auth_required";
  } else if (profile.readiness === "blocked") {
    light = "red";
    reason = "blocked";
  } else if (activeRefusal) {
    light = "red";
    reason = "provider_refusal";
  } else if (meterEval?.light === "red") {
    light = "red";
    reason = "limit_reached";
  } else if (verifiedQuota && verifiedQuota.remaining <= 0) {
    light = "red";
    reason = "limit_reached";
  } else if (profile.authentication === "unknown" || profile.readiness === "unchecked") {
    light = "yellow";
    reason = meterEval?.light === "yellow" ? meterEval.reason : "auth_unchecked";
  } else if (meterEval?.light === "yellow") {
    light = "yellow";
    reason = meterEval.reason;
  } else if (meterEval?.light === "green") {
    light = "green";
    reason = "ok";
  } else if (verifiedQuota && isPercentageUnit(verifiedQuota.unit)) {
    if (verifiedQuota.remaining > 50) {
      light = "green";
      reason = "ok";
    } else if (verifiedQuota.remaining <= 15) {
      light = "yellow";
      reason = "almost_out";
    } else {
      light = "yellow";
      reason = "low_limit";
    }
  } else {
    // Raw non-percentage positive count (no total cap known) or unknown quota cannot confirm >50% remaining.
    light = "yellow";
    reason = "limit_unknown";
  }

  return {
    harnessId: profile.harnessId,
    light,
    reason,
    available: !cliUnavailable,
    enabled: !profile.disabled,
    auth,
    planType: quota?.planType ?? null,
    meters,
    quotaStale: stale,
    verifiedQuota,
    nextResetAtMs,
    retryHint,
    profileSummary: {
      id: profile.accountId,
      harnessId: profile.harnessId,
      displayName: cleanProfileDisplayName(profile.displayName, def.label),
      light,
      reason,
      retryHint,
      resetsAtMs: nextResetAtMs,
      verifiedQuota,
    },
  };
}

function evaluateBuiltinHarnessUnit(
  def: TopbarServiceDefinition,
  harness: Harness | null,
  agent: AgentStatus | null,
  quota: HarnessQuota | null,
  nowMs: number,
): EvaluatedUnit {
  const enabled = harness?.enabled ?? false;
  const available = agent?.available ?? false;
  const { meters, stale } = toMeterViews(quota, nowMs);
  const meterEval = evaluateMeters(meters, stale);

  const auth: ServiceAuthState =
    agent?.loggedIn === false
      ? "not_signed_in"
      : agent?.loggedIn === true || agent?.account != null
        ? "signed_in"
        : "unknown";

  let light: ServiceLight;
  let reason: ServiceReasonCode;

  if (!enabled) {
    light = "red";
    reason = "disabled";
  } else if (!agent || !available) {
    light = "red";
    reason = "not_installed";
  } else if (agent.loggedIn === false) {
    light = "red";
    reason = "auth_required";
  } else if (meterEval?.light === "red") {
    light = "red";
    reason = "limit_reached";
  } else if (meterEval?.light === "yellow") {
    light = "yellow";
    reason = meterEval.reason;
  } else if (meterEval?.light === "green") {
    light = "green";
    reason = "ok";
  } else {
    light = "yellow";
    reason = "limit_unknown";
  }

  return {
    harnessId: harness?.id ?? def.builtinHarnessId,
    light,
    reason,
    available,
    enabled,
    auth,
    planType: quota?.planType ?? null,
    meters,
    quotaStale: stale,
    verifiedQuota: null,
    nextResetAtMs: meterEval?.nextResetAtMs ?? null,
    retryHint: null,
  };
}

function pickBestUnit(units: EvaluatedUnit[]): EvaluatedUnit {
  return units.reduce((best, cur) => {
    const rankDiff = LIGHT_RANK[cur.light] - LIGHT_RANK[best.light];
    if (rankDiff > 0) return cur;
    if (rankDiff < 0) return best;
    if (cur.meters.length > 0 && best.meters.length === 0) return cur;
    if (cur.enabled && !best.enabled) return cur;
    if (best.reason === "disabled" && cur.reason !== "disabled") return cur;
    return best;
  });
}

export function buildTopbarServiceSummary(
  def: TopbarServiceDefinition,
  input: {
    agents: readonly AgentStatus[];
    harnesses: readonly Harness[];
    usage: Readonly<Record<string, HarnessQuota>>;
    profiles: readonly ExecutionProfile[];
    installations?: readonly HarnessInstallation[];
    nowMs?: number;
  },
): TopbarServiceSummary {
  const nowMs = input.nowMs ?? Date.now();
  const matchingProfiles = input.profiles.filter((p) => matchesServiceProfile(def, p, input.harnesses));

  // Dedicated path for DeepSeek installation (detected via /harnesses `installations` OR connected as custom CLI).
  if (def.id === "deepseek") {
    const installation =
      input.installations?.find((item) => item.id === "deepseek-dsh" || item.provider === "deepseek") ??
      null;
    const detected = Boolean(
      installation && installation.status !== "missing" && installation.status !== "unidentified",
    );
    const deepseekHarnesses = input.harnesses.filter(
      (h) => h.kind === "custom" && serviceIdForHarness(h) === "deepseek",
    );
    const harnessUnits = deepseekHarnesses.map((h) => {
      const ag = input.agents.find((a) => a.harnessId === h.id) ?? null;
      const quota = input.usage[h.id] ?? null;
      return evaluateBuiltinHarnessUnit(def, h, ag, quota, nowMs);
    });
    const profileUnits = matchingProfiles.map((profile) => {
      const profileQuota = input.usage[profile.harnessId] ?? null;
      return evaluateProfileUnit(def, profile, null, profileQuota, nowMs);
    });
    const allUnits = [...profileUnits, ...harnessUnits];
    const anyEnabledUnit = allUnits.some((u) => u.enabled);
    const connected = detected || anyEnabledUnit;
    const primary = allUnits.length > 0 ? pickBestUnit(allUnits) : null;
    const light: ServiceLight = primary ? primary.light : "red";
    const reason: ServiceReasonCode = primary
      ? primary.reason
      : detected
        ? "blocked"
        : "disabled";
    return {
      id: def.id,
      label: def.label,
      agentKind: def.agentKind,
      connected,
      light,
      reason,
      availability: primary ? (primary.available ? "available" : "unavailable") : detected ? "unavailable" : "disabled",
      auth: primary ? primary.auth : "unknown",
      planType: primary?.planType ?? null,
      meters: primary?.meters ?? [],
      quotaStale: primary?.quotaStale ?? false,
      verifiedQuota: primary?.verifiedQuota ?? null,
      nextResetAtMs: primary?.nextResetAtMs ?? null,
      retryHint: primary?.retryHint ?? null,
      profiles: profileUnits.map((u) => u.profileSummary!).filter(Boolean),
      accountsTargetHarnessId: primary?.harnessId ?? def.builtinHarnessId,
      technicalNotes: {
        version: installation?.version ?? null,
        cliReason: null,
        hasClaudePartialNote: false,
        hasDeepSeekBlockedNote: detected && !installation?.executionSupported,
      },
    };
  }

  const builtinHarness =
    input.harnesses.find((h) => h.id === def.builtinHarnessId) ??
    input.harnesses.find((h) => h.kind === def.agentKind && h.isBuiltin) ??
    null;
  const builtinAgent =
    input.agents.find((a) => a.harnessId === (builtinHarness?.id ?? def.builtinHarnessId)) ??
    input.agents.find((a) => a.kind === def.agentKind) ??
    null;
  const builtinQuota = input.usage[builtinHarness?.id ?? def.builtinHarnessId] ?? null;

  const profileUnits = matchingProfiles.map((profile) => {
    const profileAgent =
      input.agents.find((a) => a.harnessId === profile.harnessId) ?? builtinAgent;
    // Strictly scoped to this profile's own harness quota — never cross-mixes another account's quota.
    const profileQuota = input.usage[profile.harnessId] ?? null;
    return evaluateProfileUnit(def, profile, profileAgent, profileQuota, nowMs);
  });

  const builtinUnit = evaluateBuiltinHarnessUnit(def, builtinHarness, builtinAgent, builtinQuota, nowMs);

  // Never mix quotas across accounts:
  // - When registered execution profiles exist, primary is selected strictly from those profiles
  //   and displays only that selected profile's own quota/meters/plan.
  // - When no registered profiles exist, the built-in harness drives the service summary.
  const primary = profileUnits.length > 0 ? pickBestUnit(profileUnits) : builtinUnit;

  // Availability summary
  const anyEnabled =
    profileUnits.some((u) => u.enabled) || builtinUnit.enabled;
  const anyAvailable =
    profileUnits.some((u) => u.enabled && u.available) || (builtinUnit.enabled && builtinUnit.available);
  const availability: ServiceAvailabilityState = !anyEnabled
    ? "disabled"
    : anyAvailable
      ? "available"
      : "unavailable";

  // Auth summary
  let auth: ServiceAuthState = primary.auth;
  if (profileUnits.length === 0 && auth === "unknown" && builtinAgent?.account) {
    auth = "signed_in";
  } else if (profileUnits.length > 0) {
    if (profileUnits.some((u) => u.enabled && u.auth === "signed_in")) {
      auth = "signed_in";
    } else if (profileUnits.every((u) => !u.enabled || u.auth === "not_signed_in")) {
      auth = "not_signed_in";
    } else if (profileUnits.some((u) => u.enabled && u.auth === "unchecked")) {
      auth = "unchecked";
    }
  }

  // Profiles list shown inside this service's popover
  const profiles: ServiceProfileSummary[] = profileUnits
    .map((u) => u.profileSummary!)
    .filter(Boolean);

  if (profiles.length === 0 && builtinAgent?.account) {
    const accountLabel =
      builtinAgent.account.displayName && builtinAgent.account.email
        ? `${builtinAgent.account.displayName} (${builtinAgent.account.email})`
        : builtinAgent.account.email || builtinAgent.account.displayName || def.label;
    profiles.push({
      id: `builtin:${def.id}`,
      harnessId: builtinUnit.harnessId,
      displayName: accountLabel,
      light: builtinUnit.light,
      reason: builtinUnit.reason,
      retryHint: null,
      resetsAtMs: builtinUnit.nextResetAtMs,
      verifiedQuota: null,
      isBuiltinAccount: true,
    });
  }

  const accountsTargetHarnessId =
    primary.harnessId || builtinHarness?.id || def.builtinHarnessId;

  return {
    id: def.id,
    label: def.label,
    agentKind: def.agentKind,
    connected: anyEnabled,
    light: primary.light,
    reason: primary.reason,
    availability,
    auth,
    planType: primary.planType,
    meters: primary.meters,
    quotaStale: primary.quotaStale,
    verifiedQuota: primary.verifiedQuota,
    nextResetAtMs: primary.nextResetAtMs,
    retryHint: primary.retryHint,
    profiles,
    accountsTargetHarnessId,
    technicalNotes: {
      version: builtinAgent?.version ?? null,
      cliReason: !builtinUnit.available ? (builtinAgent?.reason ?? null) : null,
      hasClaudePartialNote: matchingProfiles.some((p) => p.kind === "claude" && p.support === "partial"),
      hasDeepSeekBlockedNote: false,
    },
  };
}

export function buildAllTopbarServices(input: {
  agents: readonly AgentStatus[];
  harnesses: readonly Harness[];
  usage: Readonly<Record<string, HarnessQuota>>;
  profiles: readonly ExecutionProfile[];
  installations?: readonly HarnessInstallation[];
  nowMs?: number;
}): TopbarServiceSummary[] {
  const nowMs = input.nowMs ?? Date.now();
  const base = TOPBAR_SERVICES.map((def) => buildTopbarServiceSummary(def, input));
  const coveredServiceIds = new Set<string>(["codex", "claude-code", "claude", "cursor", "antigravity", "deepseek"]);

  // Group any additional connected services (gemini, fx, opencode, copilot, or user-added custom CLIs)
  // strictly ONE icon per service regardless of how many accounts/harnesses exist for it.
  const extraByService = new Map<string, Harness[]>();
  for (const h of input.harnesses) {
    if (!h.enabled) continue;
    const sid = serviceIdForHarness(h);
    if (coveredServiceIds.has(sid)) continue;
    const list = extraByService.get(sid) ?? [];
    list.push(h);
    extraByService.set(sid, list);
  }

  for (const [sid, list] of extraByService.entries()) {
    const primaryHarness = list.find((h) => h.isBuiltin) ?? list[0]!;
    const def: TopbarServiceDefinition = {
      id: sid,
      label: primaryHarness.label,
      agentKind: primaryHarness.kind,
      builtinHarnessId: primaryHarness.id,
      profileKind: null,
    };
    const units = list.map((h) => {
      const ag = input.agents.find((a) => a.harnessId === h.id) ?? null;
      const quota = input.usage[h.id] ?? null;
      return evaluateBuiltinHarnessUnit(def, h, ag, quota, nowMs);
    });
    const best = pickBestUnit(units);
    const profiles: ServiceProfileSummary[] =
      list.length > 1
        ? list.map((h, idx) => {
            const u = units[idx]!;
            return {
              id: `harness:${h.id}`,
              harnessId: h.id,
              displayName: h.label,
              light: u.light,
              reason: u.reason,
              retryHint: u.retryHint,
              resetsAtMs: u.nextResetAtMs,
              verifiedQuota: u.verifiedQuota,
            };
          })
        : [];
    base.push({
      id: sid,
      label: primaryHarness.label,
      agentKind: primaryHarness.kind === "custom" ? (sid as AgentKind) : primaryHarness.kind,
      connected: true,
      light: best.light,
      reason: best.reason,
      availability: best.available ? "available" : "unavailable",
      auth: best.auth,
      planType: best.planType,
      meters: best.meters,
      quotaStale: best.quotaStale,
      verifiedQuota: best.verifiedQuota,
      nextResetAtMs: best.nextResetAtMs,
      retryHint: best.retryHint,
      profiles,
      accountsTargetHarnessId: primaryHarness.id,
      technicalNotes: {
        version: input.agents.find((a) => a.harnessId === primaryHarness.id)?.version ?? null,
        cliReason: !best.available ? (input.agents.find((a) => a.harnessId === primaryHarness.id)?.reason ?? null) : null,
        hasClaudePartialNote: false,
        hasDeepSeekBlockedNote: false,
      },
    });
  }

  return base;
}
