import type { CodexProfileView } from "../../shared/accounts/codex-profile.ts";
import type { ClaudeProfileView } from "../../shared/accounts/claude-profile.ts";
import type { ExecutionMeta, ExecutionProfile, ProjectAccountPreference } from "../../shared/accounts/execution-profile.ts";
import type { CodexSourceState } from "../../shared/accounts/codex-source.ts";
import type { ProviderEvidenceView } from "../../shared/accounts/provider-evidence.ts";
import type { QuotaRefreshAvailability } from "../../shared/accounts/quota-sources.ts";
import type { ProviderRefusalSummary } from "../../shared/provider-refusal.ts";
import type {
  Account,
  Binding,
  ModelCapability,
  ProfileAssociation,
  QuotaDefinition,
  QuotaObservation,
  QuotaState,
  ResourceIdentity,
  Subscription,
} from "../../shared/accounts/types.ts";

export interface AccountResource {
  account: Account;
  bindings: Binding[];
  profiles: ProfileAssociation[];
  subscriptionIds: string[];
  quotas: QuotaState[];
  providerRefusals?: ProviderRefusalSummary[];
  models: ModelCapability[];
}
export interface AccountResources {
  accounts: AccountResource[];
  subscriptions: Subscription[];
  commitments: {
    subscriptionIds: string[];
    totals: { currency: string; billingPeriod: string; minor: number }[];
    unknownIds: string[];
  };
}
export interface HistoryPage<T> {
  observations: T[];
  nextCursor: number | null;
}
export interface LegacyMeter {
  id: number;
  harnessId: string;
  source: string | null;
  observedAt: number;
  expiresAt: number;
  provenance: string;
  verification: string;
  warnings: string[];
  meters: {
    scope: string;
    indicator: { kind: "percent-used"; value: number };
    resetAt: number | null;
  }[];
}
export interface LegacyTokens {
  id: number;
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
  source: string;
}
export type AccountInput = Pick<
  Account,
  "provider" | "displayName" | "externalIdentity" | "availability"
> & { provenance: "unknown" | "user-provided" };
export type SubscriptionInput = Pick<
  Subscription,
  | "provider"
  | "planLabel"
  | "currency"
  | "recurringCostMinor"
  | "billingPeriod"
  | "renewsAt"
  | "resetsAt"
>;
export type DefinitionInput = Pick<
  QuotaDefinition,
  "accountId" | "subscriptionId" | "scope" | "unit" | "window" | "windowMs" | "modelIds" | "category" | "warnAtRemainingPercent"
>;
export type ObservationInput = Pick<
  QuotaObservation,
  | "observedAt"
  | "expiresAt"
  | "resetAt"
  | "limit"
  | "used"
  | "remaining"
  | "indicator"
  | "confidence" | "sourceNote" | "evidenceReference" | "revises"
>;
type Transport = <T>(
  path: string,
  init?: RequestInit,
  opts?: { retry?: boolean },
) => Promise<T>;

/** Uses the application's bearer transport. No usage refreshes, probes or mutation retries. */
export function createAccountApi(request: Transport) {
  const id = encodeURIComponent;
  const read = <T>(path: string) => request<T>(`/account-core${path}`);
  const write = <T>(path: string, method: string, body?: unknown) =>
    request<T>(
      `/account-core${path}`,
      {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { retry: false },
    );
  const before = (cursor?: number | null) =>
    cursor == null ? "" : `?before=${cursor}`;
  const subscriptions = () =>
    read<{
      subscriptions: Subscription[];
      commitments: AccountResources["commitments"];
    }>("/subscriptions");
  const resources = async (): Promise<AccountResources> => {
    try {
      return (
        await request<{ accountResources: AccountResources }>(
          "/portfolio/analysis",
        )
      ).accountResources;
    } catch (error) {
      // Portfolio size/validation must not prevent fixing account metadata. Use only existing core readers.
      if (![413, 422].includes((error as { status?: number })?.status ?? 0))
        throw error;
      const [accounts, registry] = await Promise.all([
        read<Account[]>("/accounts"),
        subscriptions(),
      ]);
      const rows: AccountResource[] = new Array(accounts.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, accounts.length) }, async () => {
          while (next < accounts.length) {
            const index = next++;
            const account = accounts[index]!;
            const path = `/accounts/${id(account.id)}`;
            const [bindings, profiles, linked, quotas, models, providerRefusals] =
              await Promise.all([
                read<Binding[]>(`${path}/harnesses`),
                read<ProfileAssociation[]>(`${path}/profiles`),
                read<Subscription[]>(`${path}/subscriptions`),
                read<QuotaState[]>(`${path}/quotas`),
                read<ModelCapability[]>(`${path}/models`),
                read<ProviderRefusalSummary[]>(`${path}/provider-refusals`),
              ]);
            rows[index] = {
              account,
              bindings,
              profiles,
              subscriptionIds: linked.map((s) => s.id),
              quotas,
              providerRefusals,
              models,
            };
          }
        }),
      );
      return { ...registry, accounts: rows };
    }
  };
  return {
    codexProfiles: () => read<CodexProfileView[]>("/codex-profiles"),
    registerCodexProfile: (input: { displayName: string; directory: string }, accountId?: string) => write<CodexProfileView>(`/codex-profiles${accountId ? "/" + id(accountId) : ""}`, accountId ? "PATCH" : "POST", input),
    checkCodexProfile: (accountId: string) => write<CodexProfileView>(`/codex-profiles/${id(accountId)}/check`, "POST"),
    removeCodexProfile: (accountId: string) => write(`/codex-profiles/${id(accountId)}`, "DELETE"),
    executionProfiles: () => read<{ profiles: ExecutionProfile[]; preferences: ProjectAccountPreference[] }>("/execution-profiles"),
    claudeProfiles: () => read<ClaudeProfileView[]>("/claude-profiles"),
    registerClaudeProfile: (input: { displayName: string; directory: string; homeAccessAccepted: boolean }, accountId?: string) =>
      write<ClaudeProfileView>(`/claude-profiles${accountId ? "/" + id(accountId) : ""}`, accountId ? "PATCH" : "POST", input),
    acceptClaudeHomeAccess: (accountId: string) =>
      write<ClaudeProfileView>(`/claude-profiles/${id(accountId)}`, "PATCH", { homeAccessAccepted: true }),
    checkClaudeProfile: (accountId: string) => write<ClaudeProfileView>(`/claude-profiles/${id(accountId)}/check`, "POST"),
    removeClaudeProfile: (accountId: string, confirmActive = false) =>
      write(`/claude-profiles/${id(accountId)}${confirmActive ? "?confirm=active" : ""}`, "DELETE"),
    updateExecutionMeta: (accountId: string, patch: Partial<Pick<ExecutionMeta, "disabled" | "concurrencyLimit" | "providerSharedLimit" | "models" | "configuredIdentity">>) =>
      write<ExecutionMeta>(`/execution-profiles/${id(accountId)}/meta`, "PUT", patch),
    setProjectAccountPreference: (input: { projectPath: string; role: string; accountId: string | null }) =>
      write<ProjectAccountPreference | null>("/project-account-preferences", "PUT", input),
    codexSource: () => read<CodexSourceState>("/codex-source"),
    inspectCodex: (signal?: AbortSignal) => request<CodexSourceState>("/account-core/codex-source/inspect",
      { method: "POST", body: JSON.stringify({ consent: true }), signal }, { retry: false }),
    disconnectCodex: () => write<CodexSourceState>("/codex-source", "DELETE"),
    providerEvidence: (accountId: string) => read<ProviderEvidenceView>(`/accounts/${id(accountId)}/provider-evidence`),
    refreshProviderEvidence: (accountId: string, signal?: AbortSignal) => request<ProviderEvidenceView>(`/account-core/accounts/${id(accountId)}/provider-evidence`,
      { method: "POST", body: JSON.stringify({ consent: true }), signal }, { retry: false }),
    sources: () => read<QuotaRefreshAvailability[]>("/quota-sources"),
    quotaSources: (accountId: string) => read<QuotaRefreshAvailability[]>(`/accounts/${id(accountId)}/quota-sources`),
    refreshQuota: (accountId: string, sourceId: string) => write<{ observations: QuotaObservation[]; refreshedAt: number }>(
      `/accounts/${id(accountId)}/quota-refresh`, "POST", { sourceId }),
    accounts: (includeArchived = false) =>
      read<Account[]>(`/accounts${includeArchived ? "?archived=true" : ""}`),
    resources,
    createAccount: (input: AccountInput) =>
      write<Account>("/accounts", "POST", input),
    updateAccount: (accountId: string, input: Omit<AccountInput, "provider">) =>
      write<Account>(`/accounts/${id(accountId)}`, "PATCH", input),
    archiveAccount: (accountId: string) =>
      write(`/accounts/${id(accountId)}`, "DELETE"),
    bindHarness: (accountId: string, harnessId: string) =>
      write(`/accounts/${id(accountId)}/harnesses`, "POST", { harnessId }),
    unbindHarness: (accountId: string, harnessId: string) =>
      write(`/accounts/${id(accountId)}/harnesses/${id(harnessId)}`, "DELETE"),
    bindProfile: (accountId: string, profileId: string) =>
      write(`/accounts/${id(accountId)}/profiles`, "POST", { profileId }),
    unbindProfile: (accountId: string, profileId: string) =>
      write(`/accounts/${id(accountId)}/profiles/${id(profileId)}`, "DELETE"),
    identity: (harnessId: string, profileId: string) =>
      read<ResourceIdentity>(
        `/identity?harnessId=${id(harnessId)}&profileId=${id(profileId)}`,
      ),
    createSubscription: (input: SubscriptionInput) =>
      write<Subscription>("/subscriptions", "POST", input),
    updateSubscription: (
      subscriptionId: string,
      input: Omit<SubscriptionInput, "provider">,
    ) =>
      write<Subscription>(
        `/subscriptions/${id(subscriptionId)}`,
        "PATCH",
        input,
      ),
    archiveSubscription: (subscriptionId: string) =>
      write(`/subscriptions/${id(subscriptionId)}`, "DELETE"),
    linkSubscription: (accountId: string, subscriptionId: string) =>
      write(`/accounts/${id(accountId)}/subscriptions`, "POST", {
        subscriptionId,
      }),
    unlinkSubscription: (accountId: string, subscriptionId: string) =>
      write(
        `/accounts/${id(accountId)}/subscriptions/${id(subscriptionId)}`,
        "DELETE",
      ),
    createDefinition: (input: DefinitionInput) =>
      write<QuotaDefinition>("/quotas", "POST", input),
    archiveDefinition: (quotaId: string) =>
      write(`/quotas/${id(quotaId)}`, "DELETE"),
    definitions: (accountId: string) =>
      read<QuotaDefinition[]>(
        `/accounts/${id(accountId)}/definitions?archived=true`,
      ),
    recordOwnerPool: (accountId: string, definition: Omit<DefinitionInput, "accountId">, observation: ObservationInput) =>
      write<{ definition: QuotaDefinition; observation: QuotaObservation }>(`/accounts/${id(accountId)}/quota-observations`, "POST", { definition, observation }),
    updateQuotaThreshold: (quotaId: string, warnAtRemainingPercent: number | null) =>
      write<QuotaDefinition>(`/quotas/${id(quotaId)}`, "PATCH", { warnAtRemainingPercent }),
    recordObservation: (quotaId: string, input: ObservationInput) =>
      write<QuotaObservation>(
        `/quotas/${id(quotaId)}/observations`,
        "POST",
        input,
      ),
    history: (quotaId: string, cursor?: number | null) =>
      read<HistoryPage<QuotaObservation>>(
        `/quotas/${id(quotaId)}/observations${before(cursor)}`,
      ),
    legacyUsage: (cursor?: number | null) =>
      read<HistoryPage<LegacyMeter>>(`/legacy-usage${before(cursor)}`),
    legacyTokens: (cursor?: number | null) =>
      read<HistoryPage<LegacyTokens>>(`/legacy-tokens${before(cursor)}`),
  };
}
