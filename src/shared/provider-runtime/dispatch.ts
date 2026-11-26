/**
 * Production transport selection.
 * A recorded fixture never becomes a live process.
 * Live Codex or Claude is named only when a separate Owner authorization
 * matches this operation. This module does not spawn a process.
 */
import { planProviderExecution, type LaunchPlan, type RuntimeExecutionRequest } from "./negotiate.ts";

export interface OwnerLiveAuthorization {
  id: string;
  projectPath: string;
  taskId: string;
  missionId: string;
  role: "developer" | "reviewer";
  providerId: "codex" | "claude-code";
  harnessId: string;
  modelId: string;
  accountId: string;
  mode: string;
  workspace: string;
  filesystem: "workspace-write" | "read-only";
  terminal: boolean;
  envelopeId: string | null;
  runId: string;
  attemptId: string;
  scope: string;
  expiresAt: number;
  grantedBy: "owner-live-acceptance";
}

export interface TransportSelection {
  ok: true;
  transport: "recorded" | "codex-live" | "claude-live";
  plan: LaunchPlan;
  processStarted: false;
  launcher: "none" | "spawnCodexViaTmux" | "spawnClaudeViaTmux";
  readOnly: boolean;
}

export interface TransportRefusal {
  ok: false;
  code: string;
  reason: string;
  processStarted: false;
}

export type ProductionTransport = TransportSelection | TransportRefusal;

export interface ProductionTransportInput {
  request: RuntimeExecutionRequest;
  live: OwnerLiveAuthorization | null;
  now: number;
  workspace: string;
  filesystem: "workspace-write" | "read-only";
  terminal: boolean;
  envelopeId: string | null;
  scope: string;
}

function refuse(code: string, reason: string): TransportRefusal {
  return { ok: false, code, reason, processStarted: false };
}

function same(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

/** Returns the first field that does not match. A mismatch is not rewritten. */
export function liveAuthorizationMismatch(auth: OwnerLiveAuthorization, input: ProductionTransportInput): string | null {
  if (auth.grantedBy !== "owner-live-acceptance") return "grantedBy";
  if (!(auth.expiresAt > input.now)) return "expiresAt";
  if (!same(auth.projectPath, input.request.projectPath)) return "projectPath";
  if (!same(auth.taskId, input.request.taskId)) return "taskId";
  if (!same(auth.missionId, input.request.missionId)) return "missionId";
  if (auth.role !== input.request.role) return "role";
  if (auth.providerId !== input.request.providerId) return "providerId";
  if (!same(auth.harnessId, input.request.harnessId)) return "harnessId";
  if (!same(auth.modelId, input.request.modelId)) return "modelId";
  if (!same(auth.accountId, input.request.accountId)) return "accountId";
  if (!same(auth.mode, input.request.permissionMode)) return "mode";
  if (!same(auth.workspace, input.workspace)) return "workspace";
  if (auth.filesystem !== input.filesystem) return "filesystem";
  if (auth.terminal !== input.terminal) return "terminal";
  if (!same(auth.envelopeId, input.envelopeId)) return "envelopeId";
  if (!same(auth.runId, input.request.runId)) return "runId";
  if (!same(auth.attemptId, input.request.attemptId)) return "attemptId";
  if (!auth.scope || auth.scope !== input.scope) return "scope";
  if (auth.providerId !== "codex" && auth.providerId !== "claude-code") return "providerId";
  if (input.request.role === "reviewer" && auth.filesystem !== "read-only") return "filesystem";
  if (input.request.role === "developer" && auth.filesystem !== "workspace-write") return "filesystem";
  return null;
}

/**
 * Selects the transport. Cursor and DeepSeek stay blocked even if an
 * authorization object is present. A missing live authorization uses the
 * recorded fixture path. It does not start a process.
 */
export function selectProductionTransport(input: ProductionTransportInput): ProductionTransport {
  if (input.request.providerId === "cursor" || input.request.providerId === "deepseek-dsh") {
    const blocked = planProviderExecution({ ...input.request, transport: "recorded-fixture" });
    return blocked.ok
      ? refuse("blocked-provider", "This provider stays blocked. No process was started.")
      : refuse(blocked.code, blocked.reason);
  }
  if (input.live) {
    const field = liveAuthorizationMismatch(input.live, input);
    if (field) {
      return refuse("live-not-authorized", `Live authorization does not match ${field}. No other provider, model, or account was selected.`);
    }
    const planned = planProviderExecution({ ...input.request, transport: "recorded-fixture" });
    if (!planned.ok) return refuse(planned.code, planned.reason);
    const transport = input.live.providerId === "codex" ? "codex-live" : "claude-live";
    return {
      ok: true,
      transport,
      plan: planned.plan,
      processStarted: false,
      launcher: transport === "codex-live" ? "spawnCodexViaTmux" : "spawnClaudeViaTmux",
      readOnly: planned.plan.readOnly,
    };
  }
  if (input.request.transport === "live") {
    return refuse("live-not-authorized", "Live provider execution is not authorized. Opening diagnostics does not start a turn.");
  }
  const planned = planProviderExecution(input.request);
  if (!planned.ok) return refuse(planned.code, planned.reason);
  return {
    ok: true,
    transport: "recorded",
    plan: planned.plan,
    processStarted: false,
    launcher: "none",
    readOnly: planned.plan.readOnly,
  };
}
