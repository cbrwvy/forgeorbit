/**
 * Connects provider capability negotiation to the production mission launch.
 * Recorded transport is the default. Live Codex and Claude use the real
 * spawn functions, and the native Owner proof is required before a process.
 */
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { selectedClaudeAccount } from "../claude-profiles.ts";
import { db, harnesses } from "../db.ts";
import { explainBinding } from "../multiaccount/binding.ts";
import { PROVIDER_RUNTIME_IDS, type ProviderRuntimeId } from "../../shared/provider-runtime/contract.ts";
import { selectProductionTransport, type OwnerLiveAuthorization, type ProductionTransport } from "../../shared/provider-runtime/dispatch.ts";
import type { RuntimeExecutionRequest, RuntimeRole } from "../../shared/provider-runtime/negotiate.ts";
import { assessTrustedLiveAuthorization } from "./live-launch.ts";
import { fixtureFor, openDispatchLease, dropDispatchLease, type DispatchLease } from "./lease.ts";

export interface MissionProviderGateInput {
  missionId: string;
  taskId: string;
  taskTitle: string;
  projectPath: string;
  workspace: string;
  role: RuntimeRole;
  harnessId: string;
  modelId: string;
  accountId: string | null | undefined;
  mode: string;
  reservationId: string;
  employeeId: string;
  projectPaused?: boolean;
  resumeSessionAccountId?: string | null;
  completedRunIds?: readonly string[];
  consumedGrantId?: string | null;
  priorGrantIds?: readonly string[];
  live?: OwnerLiveAuthorization | null;
}

export type MissionProviderGate =
  | { ok: true; lease: DispatchLease; transport: DispatchLease["transport"]; readOnly: boolean }
  | { ok: false; code: string; reason: string; processStarted: false };

function providerIdFor(harnessId: string, modelId: string): ProviderRuntimeId | null {
  const row = harnesses.get(harnessId);
  const kind = (row?.kind ?? harnessId).toLowerCase();
  if (kind === "deepseek" || modelId.toLowerCase().includes("deepseek")) return "deepseek-dsh";
  return (PROVIDER_RUNTIME_IDS as readonly string[]).includes(kind) ? kind as ProviderRuntimeId : null;
}

export function gateMissionProviderLaunch(input: MissionProviderGateInput, now = Date.now()): MissionProviderGate {
  const providerId = providerIdFor(input.harnessId, input.modelId);
  if (!providerId) {
    return { ok: false, code: "unknown-provider", reason: "This provider has no execution contract. Nothing was selected in its place.", processStarted: false };
  }
  const binding = explainBinding({
    harnessId: input.harnessId,
    accountId: input.accountId,
    modelId: input.modelId,
    mode: input.mode,
    provider: providerId,
  });
  if (!binding.ok) return { ok: false, code: "account-mismatch", reason: binding.reason, processStarted: false };
  const profileDirectory = binding.frozen?.directory ?? null;
  const harness = harnesses.get(input.harnessId);
  const homeAccessAccepted = providerId === "claude-code"
    ? Boolean(harness && selectedClaudeAccount(harness)?.claudeProfile?.homeAccessAccepted)
    : false;
  const filesystem = input.role === "reviewer" ? "read-only" as const : "workspace-write" as const;
  const request: RuntimeExecutionRequest = {
    providerId,
    harnessId: input.harnessId,
    accountId: input.accountId ?? "",
    boundAccountId: binding.frozen?.accountId ?? input.accountId ?? null,
    modelId: input.modelId,
    role: input.role,
    permissionMode: input.mode,
    projectPath: input.projectPath,
    taskId: input.taskId,
    missionId: input.missionId,
    runId: input.reservationId,
    attemptId: input.reservationId,
    profileDirectory,
    homeAccessAccepted,
    transport: input.live ? "live" : "recorded-fixture",
    installed: false,
    resumeSessionAccountId: input.resumeSessionAccountId,
    projectPaused: input.projectPaused,
    consumedGrantId: input.consumedGrantId,
    priorGrantIds: input.priorGrantIds,
    completedRunIds: input.completedRunIds,
  };
  const decision: ProductionTransport = selectProductionTransport({
    request,
    live: input.live ?? null,
    now,
    workspace: input.workspace,
    filesystem,
    terminal: false,
    envelopeId: null,
    scope: `${input.role}:${providerId}:${input.mode}`,
  });
  if (!decision.ok) return { ok: false, code: decision.code, reason: decision.reason, processStarted: false };
  if (decision.transport !== "recorded") {
    const trusted = assessTrustedLiveAuthorization();
    if (!trusted.executionReady || trusted.method !== "native-owner-proof") {
      return { ok: false, code: trusted.code, reason: trusted.reason, processStarted: false };
    }
    return {
      ok: false,
      code: "live-lease-withheld",
      reason: "The Owner proof is valid. This mission tick does not open a live lease and does not start a provider process.",
      processStarted: false,
    };
  }
  const fixture = fixtureFor(input.taskId, input.role);
  const lease: DispatchLease = {
    taskId: input.taskId,
    accountId: decision.plan.accountId,
    role: input.role,
    transport: "recorded",
    outcome: fixture.outcome,
    readOnly: decision.readOnly,
    providerId,
    modelId: input.modelId,
    argv: decision.plan.argv,
    tokens: fixture.outcome === "succeeded" ? fixture.tokens : null,
  };
  openDispatchLease(lease);
  try {
    new ActivityJournalCore(db).record({
      eventType: "execution.reviewed",
      actorType: "system",
      targetType: "execution",
      targetId: input.reservationId,
      taskId: input.taskId,
      projectPath: input.projectPath,
      employeeId: input.employeeId,
      idempotencyKey: `provider-dispatch:${input.reservationId}`,
      payload: {
        attemptId: input.reservationId,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        employeeId: input.employeeId,
        employeeName: input.role === "reviewer" ? "Reviewer" : "Developer",
        harnessId: input.harnessId,
        mode: input.mode,
      },
    });
  } catch {
    // The launch gate still stands. A journal write must not start a provider.
  }
  return { ok: true, lease, transport: "recorded", readOnly: decision.readOnly };
}

export { assessTrustedLiveAuthorization, invokeAuthorizedLiveLauncher, bindQaFixtureTransportForTest, invokeQaFixtureTransport, productionCodexLauncher, productionClaudeLauncher } from "./live-launch.ts";
export { dropDispatchLease };
