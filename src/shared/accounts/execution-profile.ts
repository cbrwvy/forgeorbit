/**
 * FO-MULTIACCOUNT02. Separates registered profile metadata from verified identity,
 * quota, and the frozen execution resource. No credentials.
 */
import { createHash } from "node:crypto";
import type { ClaudeProfile } from "./claude-profile.ts";
import { CLAUDE_PROFILE_LIMITATIONS } from "./claude-profile.ts";

export type ProfileSupport = "supported" | "partial" | "blocked";
export type ProfileAuthentication = "unknown" | "authenticated" | "required" | "unavailable";
export type ProfileReadiness = "ready" | "blocked" | "unchecked";
export type QuotaEvidenceStatus = "unknown" | "verified" | "observed";

export interface ExecutionModelEligibility {
  id: string;
  eligibility: "declared" | "verified" | "unknown";
  modes: string[];
}

export interface ExecutionQuotaEvidence {
  status: QuotaEvidenceStatus;
  /** Set only for a verified observation with a numeric remaining value. */
  remaining: number | null;
  unit: string | null;
}

export interface ExecutionProfile {
  accountId: string;
  provider: string;
  displayName: string;
  kind: "codex" | "claude" | "other";
  support: ProfileSupport;
  authProfile: {
    mechanism: "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "none";
    path: string | null;
    directoryIdentity: string | null;
  };
  configuredIdentity: string | null;
  /** Always null unless a future documented subject binding exists. Login status is not that binding. */
  verifiedSubject: string | null;
  subjectLabel: "Unknown" | "Configured";
  authentication: ProfileAuthentication;
  /** Historical check only. Restart does not treat this as a current grant. */
  lastAuthentication: ProfileAuthentication;
  lastVerifiedAt: number | null;
  models: ExecutionModelEligibility[];
  modes: string[];
  readiness: ProfileReadiness;
  blockers: string[];
  limitations: string[];
  quota: ExecutionQuotaEvidence;
  concurrencyLimit: number | null;
  providerSharedLimit: number | null;
  disabled: boolean;
  executionReady: boolean;
  harnessId: string;
  homeAccessAccepted: boolean | null;
  /** Latest active provider refusal for this profile's harness, if any. Separate from quota and sign-in. */
  providerRefusal?: import("../provider-refusal.ts").ProviderRefusalSummary | null;
}

export interface ExecutionMeta {
  disabled: boolean;
  concurrencyLimit: number | null;
  providerSharedLimit: number | null;
  models: ExecutionModelEligibility[];
  configuredIdentity: string | null;
  lastVerifiedAt: number | null;
  lastAuthentication: ProfileAuthentication;
}

export const EMPTY_EXECUTION_META: ExecutionMeta = {
  disabled: false,
  concurrencyLimit: null,
  providerSharedLimit: null,
  models: [],
  configuredIdentity: null,
  lastVerifiedAt: null,
  lastAuthentication: "unknown",
};

export interface FrozenExecutionResource {
  accountId: string;
  provider: string;
  harnessId: string;
  modelId: string;
  mode: string;
  directory: string;
  directoryIdentity: string;
  fingerprint: string;
}

export function executionFingerprint(parts: Omit<FrozenExecutionResource, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify([
    parts.accountId,
    parts.provider,
    parts.harnessId,
    parts.modelId,
    parts.mode,
    parts.directory,
    parts.directoryIdentity,
  ])).digest("hex");
}

export function freezeExecutionResource(parts: Omit<FrozenExecutionResource, "fingerprint">): FrozenExecutionResource {
  return { ...parts, fingerprint: executionFingerprint(parts) };
}

export function subjectLabel(configuredIdentity: string | null): "Unknown" | "Configured" {
  return configuredIdentity ? "Configured" : "Unknown";
}

export function claudeLimitations(): string[] {
  return [...CLAUDE_PROFILE_LIMITATIONS];
}

export function codexLimitations(): string[] {
  return [
    "CODEX_HOME plus file credential storage selects this profile for the child process.",
    "Login status does not prove a distinct provider subject. The subject stays Unknown unless separate documented identity evidence exists.",
    "Remaining quota stays Unknown unless a verified quota observation is stored for this account.",
  ];
}

export interface ProjectAccountPreference {
  projectPath: string;
  role: string;
  accountId: string;
  updatedAt: number;
}

export interface AccountAttribution {
  taskId: string;
  accountId: string | null;
  displayName: string | null;
  modelId: string | null;
  provider: string | null;
}

export interface AccountAnswerSnapshot {
  profiles: ExecutionProfile[];
  preferences: ProjectAccountPreference[];
  attributions: AccountAttribution[];
}

function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function profileLine(profile: ExecutionProfile): string {
  const subject = profile.verifiedSubject ?? "Unknown";
  const quota = profile.quota.status === "verified" && profile.quota.remaining != null
    ? `verified remaining ${profile.quota.remaining} ${profile.quota.unit ?? ""}`.trim()
    : profile.quota.status === "observed"
      ? "observed usage; remaining limit Unknown"
      : "remaining limit Unknown";
  return `• ${profile.displayName} (${profile.provider}, ${profile.accountId}): support ${profile.support}, authentication ${profile.authentication}, verified subject ${subject}, readiness ${profile.readiness}, ${quota}`;
}

/** Factual answers from AccountCore and router records. Returns null when the question is not about accounts. */
export function answerAccountQuestion(question: string, snapshot: AccountAnswerSnapshot): string | null {
  const text = clean(question);
  const lower = text.toLowerCase();
  if (!text) return null;
  const profiles = snapshot.profiles.filter((profile) => !profile.disabled);
  const mentionsAccount = /account|профиль|аккаунт|codex|claude|quota|квот/.test(lower);
  if (!mentionsAccount && !/which ai|available model|cheaper eligible|separate available/.test(lower)) return null;

  if (/which ai accounts are available|which accounts are available|какие аккаунты доступны|какие ии-аккаунты/.test(lower)) {
    if (profiles.length === 0) return "No registered provider profiles are available. Nothing was invented.";
    return ["Registered provider profiles:", ...profiles.map(profileLine)].join("\n");
  }

  if (/why is this account unavailable|why is .+ unavailable|почему этот аккаунт недоступен|почему .+ недоступ/.test(lower)) {
    const named = snapshot.profiles
      .filter((profile) => lower.includes(profile.displayName.toLowerCase()) || lower.includes(profile.accountId))
      .sort((a, b) => b.displayName.length - a.displayName.length)[0];
    const target = named ?? snapshot.profiles.find((profile) => profile.readiness !== "ready" || profile.disabled);
    if (!target) return "No registered profile is currently blocked. Authentication that has not been checked stays Unknown.";
    const reasons = target.blockers.length ? target.blockers.join(" ") : "No additional blocker is recorded.";
    return `${target.displayName} is ${target.readiness}. Authentication is ${target.authentication}. Verified subject is Unknown. ${reasons}`;
  }

  if (/which account executed|какой аккаунт выполнил/.test(lower)) {
    const task = snapshot.attributions.find((row) => text.includes(row.taskId));
    const row = task ?? (snapshot.attributions.length === 1 ? snapshot.attributions[0] : null);
    if (!row) return "No execution attribution is stored for that task. An account was not guessed.";
    if (!row.accountId) return `Task ${row.taskId} has no account attribution. The provider subject is Unknown.`;
    return `Task ${row.taskId} is attributed to ${row.displayName ?? row.accountId} (${row.accountId})${row.modelId ? `, model ${row.modelId}` : ""}. Verified provider subject remains Unknown unless the run record says otherwise.`;
  }

  if (/known usage|unknown remaining|известн(ое|ый) использован|неизвестн(ый|ые) лимит/.test(lower)) {
    if (snapshot.profiles.length === 0) return "No account usage records are stored. Remaining limits are Unknown.";
    return ["Usage evidence:", ...snapshot.profiles.map(profileLine)].join("\n");
  }

  if (/use my work codex|work codex profile|используй .*codex|рабоч(ий|его) .*codex/.test(lower)) {
    const work = profiles.find((profile) => profile.kind === "codex" && /work|рабоч/i.test(profile.displayName));
    if (!work) return "No registered Codex profile is named as a work profile. The request was not applied and no account was substituted.";
    return `Work Codex profile "${work.displayName}" (${work.accountId}) is registered. Applying it to a project needs an Owner-approved plan. It was not switched automatically. Verified subject is Unknown.`;
  }

  if (/cheaper eligible model|более деш[её]в/.test(lower)) {
    const ranked = profiles.flatMap((profile) => profile.models.map((model) => ({ profile, model })));
    const economy = ranked.find((row) => /luna|haiku/i.test(row.model.id)) ?? ranked[0];
    if (!economy) return "No eligible model is recorded on a registered profile. A cheaper model was not invented.";
    return `The cheaper recorded eligible model on ${economy.profile.displayName} is ${economy.model.id} (${economy.model.eligibility}). This is a recommendation, not a launch.`;
  }

  if (/separate available accounts|разным доступным аккаунтам|separate accounts/.test(lower)) {
    const ready = profiles.filter((profile) => profile.executionReady || profile.readiness !== "blocked");
    if (ready.length < 2) return "Fewer than two available profiles are registered. The tasks were not assigned and no account was substituted.";
    return `Two distinct registered profiles can be named in an Owner-approved plan: ${ready[0]!.displayName} (${ready[0]!.accountId}) and ${ready[1]!.displayName} (${ready[1]!.accountId}). Assignment was not applied automatically.`;
  }

  return null;
}

export function claudeProfileOf(account: { claudeProfile?: ClaudeProfile }): ClaudeProfile | null {
  return account.claudeProfile ?? null;
}
