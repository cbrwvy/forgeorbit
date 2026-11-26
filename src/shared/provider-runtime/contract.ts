/**
 * FO-PROVIDERS-RUNTIME01 execution contract.
 *
 * Each harness is a separately versioned integration. A supported capability
 * is something this adapter can negotiate. It is not a claim that a CLI is
 * installed, authenticated, entitled, or that a live inference succeeded.
 */

export const PROVIDER_RUNTIME_VERSION = "fo-providers-runtime01";

export const PROVIDER_RUNTIME_IDS = [
  "codex",
  "claude-code",
  "cursor",
  "antigravity",
  "gemini",
  "fx",
  "deepseek-dsh",
] as const;

export type ProviderRuntimeId = (typeof PROVIDER_RUNTIME_IDS)[number];

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface CapabilityFact {
  state: CapabilityState;
  /** Why the state is what it is. Unsupported is never emulated. */
  reason: string;
}

export interface ProviderCapabilityContract {
  providerId: string;
  harnessId: ProviderRuntimeId;
  adapterVersion: string;
  adapterImplemented: true;
  bindingMethod: string;
  isolation: "exact-profile" | "partial-serialize" | "ambient-blocked" | "containment-blocked" | "gateway-not-upstream";
  genuineExecutionVerified: false;
  accountIdentityVerified: false;
  quotaDataVerified: false;
  remainingRestriction: string;
  capabilities: {
    executablePath: CapabilityFact;
    versionCompatibility: CapabilityFact;
    authenticationReadiness: CapabilityFact;
    registeredAccount: CapabilityFact;
    accountBinding: CapabilityFact;
    modelDiscovery: CapabilityFact;
    modelSelection: CapabilityFact;
    developerExecution: CapabilityFact;
    reviewerReadOnly: CapabilityFact;
    permissions: CapabilityFact;
    sessionIdentity: CapabilityFact;
    cancellation: CapabilityFact;
    timeout: CapabilityFact;
    errorClassification: CapabilityFact;
    tokenUsage: CapabilityFact;
    costEvidence: CapabilityFact;
    provenance: CapabilityFact;
    parallelAccounts: CapabilityFact;
    identityVerification: CapabilityFact;
    quotaObservation: CapabilityFact;
  };
}

const fact = (state: CapabilityState, reason: string): CapabilityFact => ({ state, reason });
const supported = (reason: string) => fact("supported", reason);
const unsupported = (reason: string) => fact("unsupported", reason);
const unknown = (reason: string) => fact("unknown", reason);

const commonUnknownIdentity = unknown("A local profile path is not a verified provider subject. Identity stays Unknown until a documented, non-secret metadata read is authorized.");
const commonLiveQuota = unknown("This milestone does not perform an authenticated quota request. A percentage or a catalog is not remaining capacity.");

function contract(
  partial: Omit<ProviderCapabilityContract, "adapterVersion" | "adapterImplemented" | "genuineExecutionVerified" | "accountIdentityVerified" | "quotaDataVerified">,
): ProviderCapabilityContract {
  return {
    ...partial,
    adapterVersion: PROVIDER_RUNTIME_VERSION,
    adapterImplemented: true,
    genuineExecutionVerified: false,
    accountIdentityVerified: false,
    quotaDataVerified: false,
  };
}

export const PROVIDER_RUNTIME_CONTRACTS: Record<ProviderRuntimeId, ProviderCapabilityContract> = {
  codex: contract({
    providerId: "openai",
    harnessId: "codex",
    bindingMethod: "CODEX_HOME on the child only, with file credential storage forced and alternate credential variables removed",
    isolation: "exact-profile",
    remainingRestriction: "Live Codex execution and account/rateLimits/read require a separate Owner authorization. Synthetic profiles are not independent provider subjects.",
    capabilities: {
      executablePath: supported("The registered harness binary is used. A missing binary is not treated as ready."),
      versionCompatibility: supported("A reported CLI version is recorded. It does not by itself prove model entitlement."),
      authenticationReadiness: supported("Profile authentication is a status check against the selected CODEX_HOME. It is not a login flow."),
      registeredAccount: supported("The AccountCore id is required. The ambient default is not a substitute."),
      accountBinding: supported("Exact CODEX_HOME directory identity is part of the frozen fingerprint."),
      modelDiscovery: supported("Recorded app-server model/list responses can be parsed. A live list is not requested here."),
      modelSelection: supported("The requested model is pinned. A different model in a fixture is a failure, not a fallback."),
      developerExecution: supported("Developer turns use Codex sandbox workspace-write. danger-full-access is not selected by this contract."),
      reviewerReadOnly: supported("Reviewer turns use Codex sandbox read-only."),
      permissions: supported("Sandbox and approval policy are explicit argv. Extra Codex argument overrides are refused."),
      sessionIdentity: supported("thread/started and turn ids from the app-server stream are kept. Resume across profiles is refused."),
      cancellation: supported("The owned app-server or exec process is killed. An interrupted turn is not success."),
      timeout: supported("A deadline ends the turn as timeout. There is no automatic retry."),
      errorClassification: supported("Authentication, rate-limit, model, permission, cancel, and timeout failures stay distinct."),
      tokenUsage: supported("Turn usage is attributable. A cumulative total without a prior baseline is Unknown, not this turn's usage."),
      costEvidence: supported("Subscription runs do not inherit an estimated API price as a bill. Missing money stays null."),
      provenance: supported("Account, model, run, task, and session ids are required on the receipt."),
      parallelAccounts: supported("Distinct CODEX_HOME directories may run together. The same directory may not."),
      identityVerification: commonUnknownIdentity,
      quotaObservation: supported("account/rateLimits/read windows keep usedPercent, duration, and reset. Percent is not a remaining-request count. Reset credits are not redeemed."),
    },
  }),
  "claude-code": contract({
    providerId: "anthropic",
    harnessId: "claude-code",
    bindingMethod: "CLAUDE_CONFIG_DIR on the child, after explicit HOME-access acceptance",
    isolation: "partial-serialize",
    remainingRestriction: "CLAUDE_CONFIG_DIR does not isolate ~/.claude.json or the macOS credential store. Concurrent Claude profiles are serialized. The verified subject stays Unknown.",
    capabilities: {
      executablePath: supported("The registered Claude binary is used."),
      versionCompatibility: supported("A reported CLI version is recorded and is not entitlement."),
      authenticationReadiness: supported("Auth status must name the same config directory. Login and logout are not started."),
      registeredAccount: supported("The registered profile id is required."),
      accountBinding: supported("The child receives only that CLAUDE_CONFIG_DIR. Acceptance of the HOME disclosure is required and is not a wider filesystem grant."),
      modelDiscovery: unknown("A live model catalog is not requested. Declared models are eligibility labels, not proof of access."),
      modelSelection: supported("The requested model is pinned. An assistant event for another model fails the turn."),
      developerExecution: supported("Bounded Developer turns allow Read, Glob, Grep, Edit, and Write."),
      reviewerReadOnly: supported("Bounded Reviewer turns allow only Read, Glob, and Grep."),
      permissions: supported("dontAsk is paired with an allow-list. bypassPermissions and dangerously-skip-permissions are refused."),
      sessionIdentity: supported("A session may continue only for the same registered profile."),
      cancellation: supported("The owned Claude process is killed and is not recorded as success."),
      timeout: supported("The bounded timeout fails the turn and does not retry."),
      errorClassification: supported("Tool denial, authentication, rate limit, model mismatch, cancel, and timeout are classified."),
      tokenUsage: supported("stream-json usage reports input, output, cache read, and cache write. Missing fields stay null."),
      costEvidence: supported("A reported USD figure is an estimate unless the receipt says it is a provider bill. Subscription consumption stays Unknown when the receipt does not attribute quota."),
      provenance: supported("Profile id, model, run, and task are required."),
      parallelAccounts: unsupported("Credential-store isolation is not established, so Claude profiles of the same machine are serialized."),
      identityVerification: commonUnknownIdentity,
      quotaObservation: commonLiveQuota,
    },
  }),
  cursor: contract({
    providerId: "cursor",
    harnessId: "cursor",
    bindingMethod: "Active macOS Keychain login. CURSOR_CONFIG_DIR does not select a different account.",
    isolation: "ambient-blocked",
    remainingRestriction: "Cursor's required nested sandbox cannot start under ForgeOrbit's Seatbelt. No execution mode is authorized. An escalation proposal is not a grant.",
    capabilities: {
      executablePath: supported("Installation can be detected. Detection is not execution."),
      versionCompatibility: unsupported("No installed Cursor version has a seatbelt-compatible sandbox startup."),
      authenticationReadiness: unknown("A CLI login is the active Keychain identity. It is not an AccountCore selection."),
      registeredAccount: unsupported("A different requested account cannot be bound. The ambient login is not substituted."),
      accountBinding: unsupported("There is no documented per-account config directory that isolates the Keychain items cursor-access-token and cursor-refresh-token."),
      modelDiscovery: unknown("A previously observed catalog is not rechecked and is not entitlement."),
      modelSelection: unsupported("Model selection cannot be executed while startup is blocked."),
      developerExecution: unsupported("Developer mode stays blocked. --force and --sandbox disabled are not used to force a launch."),
      reviewerReadOnly: unsupported("Reviewer mode stays blocked. Ask mode still requires the same sandbox startup."),
      permissions: unsupported("ForgeOrbit's Seatbelt stays in force. Full Computer is not granted."),
      sessionIdentity: unsupported("No Cursor session is started."),
      cancellation: supported("No process is started, so there is nothing to reap. A future launch would still use the owned-process supervisor."),
      timeout: unsupported("No Cursor turn is started."),
      errorClassification: supported("Sandbox startup failures stay classified as containment, not as an empty success."),
      tokenUsage: unsupported("No Cursor usage receipt is produced by a blocked launch."),
      costEvidence: unknown("Quota and cost stay Unknown."),
      provenance: supported("A refusal records the requested account and model and starts nothing."),
      parallelAccounts: unsupported("Accounts are not isolated, and execution is blocked."),
      identityVerification: unknown("The active Keychain login is not read and is not a verified subject."),
      quotaObservation: commonLiveQuota,
    },
  }),
  antigravity: contract({
    providerId: "google",
    harnessId: "antigravity",
    bindingMethod: "ACP session on the selected harness. ACP authentication does not expose an independent account subject.",
    isolation: "exact-profile",
    remainingRestriction: "Account identity from ACP stays Unknown. Live ACP sessions are not opened by this milestone.",
    capabilities: {
      executablePath: supported("A missing binary stays missing. Recorded ACP fixtures still exercise the adapter."),
      versionCompatibility: unknown("Compatibility is recorded from a reported version and is not inferred from installation."),
      authenticationReadiness: unknown("ACP initialize does not prove a distinct Google account."),
      registeredAccount: supported("A requested account id is kept on the receipt. It is not verified against Google."),
      accountBinding: unknown("No documented ACP field isolates two Google accounts. Identity stays Unknown."),
      modelDiscovery: supported("A recorded capability or model advertisement can be parsed. It is not entitlement."),
      modelSelection: supported("The requested model is compared with the session advertisement."),
      developerExecution: supported("Recorded ACP tool calls are accepted only inside the effective permission policy."),
      reviewerReadOnly: supported("Reviewer sessions reject non-read tool names in the fixture."),
      permissions: supported("A tool request outside the effective policy fails the turn. The model's own text is not a boundary."),
      sessionIdentity: supported("session/new ids are kept. session/cancel is the cancellation method."),
      cancellation: supported("session/cancel is recorded. The owned process would be killed on a live session."),
      timeout: supported("A session that never completes is a timeout, not a success."),
      errorClassification: supported("ACP errors are classified and are not retried."),
      tokenUsage: unknown("ACP usage is recorded only when the fixture contains it. Missing usage stays null."),
      costEvidence: unknown("No ACP cost field is treated as a bill unless the fixture classifies it."),
      provenance: supported("Session id, model, account id, run, and task are stored together."),
      parallelAccounts: unknown("Independent ACP account isolation is not proven, so same-provider sessions are serialized."),
      identityVerification: commonUnknownIdentity,
      quotaObservation: commonLiveQuota,
    },
  }),
  gemini: contract({
    providerId: "google",
    harnessId: "gemini",
    bindingMethod: "Headless CLI argv with an explicit model. GEMINI_CLI_HOME may be set; it is not a verified Google subject.",
    isolation: "exact-profile",
    remainingRestriction: "The executable may be absent. Absence does not block the recorded adapter. Live headless runs are not authorized, and no CLI is installed by this milestone.",
    capabilities: {
      executablePath: supported("Installed and missing are separate from adapter implementation."),
      versionCompatibility: unknown("A missing binary has no version. A reported version is not entitlement."),
      authenticationReadiness: unknown("Authentication is not probed."),
      registeredAccount: supported("The requested account id is required on the receipt."),
      accountBinding: unknown("A CLI home directory is not proof of a distinct Google account."),
      modelDiscovery: unknown("Model discovery requires an authorized CLI session and stays Unknown here."),
      modelSelection: supported("The headless fixture must report the requested model."),
      developerExecution: supported("Recorded headless JSON can represent a Developer result."),
      reviewerReadOnly: supported("A Reviewer fixture that reports a write tool is refused."),
      permissions: supported("The adapter does not add an unrestricted approval flag."),
      sessionIdentity: supported("A session id in the JSON is kept. A missing id stays null."),
      cancellation: supported("An owned Gemini process would be killed. Recorded fixtures do not start one."),
      timeout: supported("A timeout error in the JSON is not success and is not retried."),
      errorClassification: supported("Headless error objects are classified."),
      tokenUsage: supported("stats tokens are copied when present and left null when absent."),
      costEvidence: unknown("Gemini headless output does not by itself prove a bill."),
      provenance: supported("Model, account, run, and task stay on the receipt."),
      parallelAccounts: unknown("Distinct Google subjects are not proven, so sessions are serialized."),
      identityVerification: commonUnknownIdentity,
      quotaObservation: commonLiveQuota,
    },
  }),
  fx: contract({
    providerId: "fx",
    harnessId: "fx",
    bindingMethod: "fx ACP gateway session. The gateway account is not the upstream provider account.",
    isolation: "gateway-not-upstream",
    remainingRestriction: "Upstream provider identity stays Unknown unless a fixture explicitly contains a non-secret upstream subject. Live fx turns are not authorized.",
    capabilities: {
      executablePath: supported("Installation is separate from the ACP adapter."),
      versionCompatibility: unknown("A reported fx version is recorded and is not upstream entitlement."),
      authenticationReadiness: unknown("fx auth status is not a new probe in this milestone."),
      registeredAccount: supported("The fx gateway account id is the registered account."),
      accountBinding: supported("The receipt keeps gatewayAccount and upstreamAccount as different fields."),
      modelDiscovery: unknown("A gateway model list is not proof the upstream account can use that model."),
      modelSelection: supported("The requested model is pinned on the ACP turn."),
      developerExecution: supported("Recorded ACP results can complete a Developer fixture."),
      reviewerReadOnly: supported("Reviewer fixtures reject write tools."),
      permissions: supported("Permission requests stay inside the effective policy."),
      sessionIdentity: supported("The ACP session id is the session identity."),
      cancellation: supported("The owned fx child is cancellable. There is no tmux reattach."),
      timeout: supported("A timed-out turn is not success and is not retried."),
      errorClassification: supported("Gateway errors are not relabeled as upstream success."),
      tokenUsage: supported("Usage is recorded when the fixture reports it."),
      costEvidence: supported("Gateway cost is not copied into an upstream bill. Subscription consumption stays Unknown when unattributed."),
      provenance: supported("Gateway account, upstream account, model, run, and task are separate."),
      parallelAccounts: unknown("Two gateway logins are not proof of two upstream subjects. Same-gateway sessions are serialized."),
      identityVerification: unknown("The upstream account stays Unknown when the fixture does not name one."),
      quotaObservation: commonLiveQuota,
    },
  }),
  "deepseek-dsh": contract({
    providerId: "deepseek",
    harnessId: "deepseek-dsh",
    bindingMethod: "No admitted DSH account adapter. The DeepSeek API balance is a different surface.",
    isolation: "containment-blocked",
    remainingRestriction: "DSH 0.2.1-rc.5 and 0.2.2-rc.1 stay execution-disabled. Hard-link preflight and descendant reaping are necessary and are not sufficient while component boot and unconfined reads remain.",
    capabilities: {
      executablePath: supported("Desktop metadata can identify dsh. Identification does not launch it."),
      versionCompatibility: unsupported("Only 0.2.1-rc.5 and 0.2.2-rc.1 were assessed, and both are execution-unsupported. Other versions stay unassessed."),
      authenticationReadiness: unknown("No credential is read. API credit balance does not identify the DSH account."),
      registeredAccount: unsupported("No DSH account adapter is registered. A requested account is not invented."),
      accountBinding: unsupported("There is no admitted per-account DSH profile."),
      modelDiscovery: unknown("No model catalog is verified."),
      modelSelection: unsupported("A model cannot be executed while admission is blocked."),
      developerExecution: unsupported("Developer execution stays blocked."),
      reviewerReadOnly: unsupported("Reviewer execution stays blocked."),
      permissions: unsupported("Seatbelt, process supervision, and filesystem restrictions stay in force. Unrestricted access is not a containment strategy."),
      sessionIdentity: unsupported("No DSH session is started."),
      cancellation: supported("The supervisor can reap recorded descendant pids, including a setsid child whose parent is still alive. DSH itself is not spawned."),
      timeout: unsupported("No DSH turn is started."),
      errorClassification: supported("Containment refusal is a blocker, not an empty success."),
      tokenUsage: unsupported("No DSH usage receipt is produced."),
      costEvidence: unknown("API credit and harness subscription usage are different and both stay unread."),
      provenance: supported("A refusal names the requested resource and starts no process."),
      parallelAccounts: unsupported("Account isolation is not implemented."),
      identityVerification: unknown("The API user-balance response is not a DSH subject."),
      quotaObservation: unknown("No authenticated balance request is made. An API balance would still not be DSH quota."),
    },
  }),
};

export function providerRuntimeContract(id: string): ProviderCapabilityContract | null {
  return Object.hasOwn(PROVIDER_RUNTIME_CONTRACTS, id) ? PROVIDER_RUNTIME_CONTRACTS[id as ProviderRuntimeId] : null;
}

/** Surfaces that must not be collapsed into one DeepSeek account. */
export const DEEPSEEK_SURFACES = {
  api: {
    id: "deepseek-api",
    documentation: "https://api-docs.deepseek.com/api/get-user-balance/",
    identifiesDshAccount: false,
    note: "A user-balance response describes API credit. It does not identify the account used by DSH.",
  },
  harness: {
    id: "deepseek-dsh",
    execution: "blocked" as const,
    note: "The DSH launcher is a coding harness. Its authenticated upstream account stays Unknown.",
  },
  apiCreditBalance: "not-read" as const,
  subscriptionUsage: "unknown" as const,
} as const;

export const CLAUDE_UNISOLATED_ARTIFACTS = [
  "~/.claude.json",
  "macOS credential store items used by Claude Code",
  "HOME itself",
] as const;

export const CURSOR_ESCALATION_ID = "cursor-nested-sandbox";
