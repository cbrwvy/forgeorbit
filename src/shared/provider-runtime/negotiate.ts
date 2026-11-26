/**
 * Capability negotiation for one exact resource.
 * A refusal starts nothing. Unsupported capabilities are not emulated.
 */
import { codexSandboxFor } from "../execution/permissions.ts";
import {
  CLAUDE_UNISOLATED_ARTIFACTS,
  CURSOR_ESCALATION_ID,
  DEEPSEEK_SURFACES,
  providerRuntimeContract,
  type ProviderRuntimeId,
} from "./contract.ts";

export type RuntimeRole = "developer" | "reviewer";
export type RuntimeTransport = "recorded-fixture" | "live";

export interface RuntimeExecutionRequest {
  providerId: ProviderRuntimeId;
  harnessId: string;
  accountId: string;
  boundAccountId: string | null;
  modelId: string;
  role: RuntimeRole;
  /** Codex: ask | auto | full-access. Claude: a permission mode. Others: a mode label. */
  permissionMode: string;
  projectPath: string;
  taskId: string;
  missionId: string;
  runId: string;
  attemptId: string;
  profileDirectory: string | null;
  homeAccessAccepted: boolean;
  transport: RuntimeTransport;
  installed: boolean;
  resumeSessionAccountId?: string | null;
  projectPaused?: boolean;
  fullComputerGrant?: boolean;
  unrestricted?: boolean;
  consumedGrantId?: string | null;
  priorGrantIds?: readonly string[];
  completedRunIds?: readonly string[];
}

export interface EscalationProposal {
  id: typeof CURSOR_ESCALATION_ID;
  status: "proposal";
  authorizesExecution: false;
  missingCapability: string;
  developer: "blocked";
  reviewer: "blocked";
  fullComputer: "not-granted";
}

export interface LaunchPlan {
  providerId: ProviderRuntimeId;
  harnessId: string;
  accountId: string;
  modelId: string;
  role: RuntimeRole;
  transport: "recorded-fixture";
  processStarted: false;
  argv: string[];
  envBinding: Record<string, string>;
  readOnly: boolean;
  serializeKey: string | null;
  sessionScope: string;
}

export type RuntimeDecision =
  | { ok: true; plan: LaunchPlan }
  | { ok: false; code: string; reason: string; escalation?: EscalationProposal; processStarted: false };

const UNRESTRICTED = ["--dangerously-skip-permissions", "--permission-mode bypassPermissions", "--force", "--sandbox disabled", "danger-full-access"];

function refuse(code: string, reason: string, escalation?: EscalationProposal): RuntimeDecision {
  return { ok: false, code, reason, ...(escalation ? { escalation } : {}), processStarted: false };
}

export function cursorEscalationProposal(): EscalationProposal {
  return {
    id: CURSOR_ESCALATION_ID,
    status: "proposal",
    authorizesExecution: false,
    missingCapability: "Cursor requires sandbox-exec and a nested sandbox_apply. ForgeOrbit's Seatbelt denies that startup, and granting the helper still returns Operation not permitted. Full Computer is not granted.",
    developer: "blocked",
    reviewer: "blocked",
    fullComputer: "not-granted",
  };
}

function claudeTools(role: RuntimeRole): string[] {
  const read = ["Read", "Glob", "Grep"];
  return role === "reviewer" ? read : [...read, "Edit", "Write"];
}

export function planProviderExecution(request: RuntimeExecutionRequest): RuntimeDecision {
  const contract = providerRuntimeContract(request.providerId);
  if (!contract) return refuse("unknown-provider", "This provider has no execution contract. Nothing was selected in its place.");
  if (request.transport === "live") {
    return refuse("live-not-authorized", "Live provider execution is not authorized. Opening diagnostics does not start a turn.");
  }
  if (request.projectPaused) return refuse("project-paused", "The project is paused. No provider process was started.");
  if (!request.accountId || request.accountId !== request.boundAccountId) {
    return refuse("account-mismatch", "The requested account does not match the bound profile. The ambient account was not used.");
  }
  if (request.resumeSessionAccountId && request.resumeSessionAccountId !== request.accountId) {
    return refuse("cross-profile-resume", "A session from another profile cannot be resumed.");
  }
  if (request.unrestricted || request.permissionMode === "bypass" || request.permissionMode === "bypassPermissions" || request.permissionMode === "full-access") {
    return refuse("unrestricted-permission", "Unrestricted permission flags are not a way through the effective policy.");
  }
  if (request.fullComputerGrant) return refuse("full-computer-not-granted", "This milestone does not accept a Full Computer grant.");
  if (request.consumedGrantId && request.priorGrantIds?.includes(request.consumedGrantId)) {
    return refuse("grant-consumed", "This grant was already consumed. It was not reused.");
  }
  if (request.completedRunIds?.includes(request.runId)) {
    return refuse("duplicate-run", "This run already completed. Restart did not launch it again.");
  }
  if (!request.modelId || !request.projectPath || !request.taskId || !request.missionId || !request.runId || !request.attemptId) {
    return refuse("incomplete-binding", "Provider, model, project, task, mission, run, and attempt must all be exact.");
  }
  if (UNRESTRICTED.some((flag) => request.permissionMode.includes(flag))) {
    return refuse("unrestricted-permission", "Unrestricted permission flags are not a way through the effective policy.");
  }

  if (request.providerId === "cursor") {
    return refuse(
      "cursor-internal-sandbox",
      contract.remainingRestriction,
      cursorEscalationProposal(),
    );
  }
  if (request.providerId === "deepseek-dsh") {
    return refuse(
      "deepseek-containment",
      `${contract.remainingRestriction} ${DEEPSEEK_SURFACES.api.note}`,
    );
  }
  if (request.providerId === "claude-code") {
    if (!request.homeAccessAccepted) {
      return refuse("claude-acceptance-required", "Claude profile launch stays blocked until the Owner accepts the HOME-access disclosure.");
    }
    if (!request.profileDirectory) return refuse("missing-profile", "CLAUDE_CONFIG_DIR is missing. The default Claude account was not used.");
    const tools = claudeTools(request.role);
    return {
      ok: true,
      plan: {
        providerId: "claude-code",
        harnessId: request.harnessId,
        accountId: request.accountId,
        modelId: request.modelId,
        role: request.role,
        transport: "recorded-fixture",
        processStarted: false,
        argv: ["claude", "--print", "--output-format", "stream-json", "--model", request.modelId, "--permission-mode", "dontAsk", "--tools", tools.join(",")],
        envBinding: { CLAUDE_CONFIG_DIR: request.profileDirectory },
        readOnly: request.role === "reviewer",
        serializeKey: "claude-shared-credential-store",
        sessionScope: request.accountId,
      },
    };
  }
  if (request.providerId === "codex") {
    if (!request.profileDirectory) return refuse("missing-profile", "CODEX_HOME is missing. The ambient Codex account was not used.");
    let sandbox: ReturnType<typeof codexSandboxFor>;
    try {
      sandbox = codexSandboxFor(request.role === "reviewer" ? "ask" : "auto", "repo-root");
    } catch (error) {
      return refuse("unsupported-mode", error instanceof Error ? error.message : "Unsupported Codex mode.");
    }
    if (sandbox === "danger-full-access") return refuse("unrestricted-permission", "danger-full-access is outside this execution contract.");
    return {
      ok: true,
      plan: {
        providerId: "codex",
        harnessId: request.harnessId,
        accountId: request.accountId,
        modelId: request.modelId,
        role: request.role,
        transport: "recorded-fixture",
        processStarted: false,
        argv: ["codex", "exec", "--model", request.modelId, "--json", "--sandbox", sandbox, "-c", "approval_policy=never", "-c", "sandbox_workspace_write.network_access=false"],
        envBinding: { CODEX_HOME: request.profileDirectory },
        readOnly: sandbox === "read-only",
        serializeKey: null,
        sessionScope: request.profileDirectory,
      },
    };
  }
  if (request.providerId === "gemini" && !request.installed && request.transport === "recorded-fixture") {
    return {
      ok: true,
      plan: {
        providerId: "gemini",
        harnessId: request.harnessId,
        accountId: request.accountId,
        modelId: request.modelId,
        role: request.role,
        transport: "recorded-fixture",
        processStarted: false,
        argv: ["gemini", "--output-format", "json", "--model", request.modelId],
        envBinding: request.profileDirectory ? { GEMINI_CLI_HOME: request.profileDirectory } : {},
        readOnly: request.role === "reviewer",
        serializeKey: "gemini-unproven-subject",
        sessionScope: request.accountId,
      },
    };
  }
  if (request.providerId === "antigravity" || request.providerId === "fx" || request.providerId === "gemini") {
    const serializeKey = request.providerId === "fx" ? `fx-gateway:${request.accountId}` : `${request.providerId}-unproven-subject`;
    return {
      ok: true,
      plan: {
        providerId: request.providerId,
        harnessId: request.harnessId,
        accountId: request.accountId,
        modelId: request.modelId,
        role: request.role,
        transport: "recorded-fixture",
        processStarted: false,
        argv: request.providerId === "fx" ? ["fx", "acp"] : request.providerId === "antigravity" ? ["agy", "acp"] : ["gemini", "--output-format", "json", "--model", request.modelId],
        envBinding: {},
        readOnly: request.role === "reviewer",
        serializeKey,
        sessionScope: request.accountId,
      },
    };
  }
  return refuse("unsupported-provider", "This provider cannot be executed under the current contract.");
}

export function claudeIsolationDisclosure(): readonly string[] {
  return CLAUDE_UNISOLATED_ARTIFACTS;
}

/** Distinct directories may run together. Incomplete isolation serializes. */
export function concurrencyPlan(requests: readonly { accountId: string; providerId: ProviderRuntimeId; profileDirectory: string | null }[]): {
  parallel: string[];
  serialized: string[];
  reason: string;
} {
  const claude = requests.filter((row) => row.providerId === "claude-code").map((row) => row.accountId);
  const codexDirs = new Map<string, string>();
  const parallel: string[] = [];
  for (const row of requests) {
    if (row.providerId !== "codex" || !row.profileDirectory) continue;
    const previous = codexDirs.get(row.profileDirectory);
    if (previous && previous !== row.accountId) {
      return { parallel: [], serialized: [previous, row.accountId], reason: "Two registrations point at one CODEX_HOME. They cannot run together." };
    }
    codexDirs.set(row.profileDirectory, row.accountId);
    parallel.push(row.accountId);
  }
  return {
    parallel,
    serialized: claude,
    reason: claude.length > 1
      ? "Claude profiles share the credential store, so they run one at a time."
      : "Codex profiles with distinct directories can run together. Claude profiles serialize.",
  };
}
