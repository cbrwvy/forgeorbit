/**
 * Production Codex and Claude launch binding.
 * The functions are the real spawn implementations. A verified native Owner
 * proof is required before either one runs. This process cannot present the
 * production application identity, so the gate stays closed. An environment
 * value cannot replace the proof.
 */
import { spawnClaudeViaTmux, type ClaudeLaunchOptions } from "../claude-tmux.ts";
import { spawnCodexViaTmux, type CodexLaunchOptions } from "../codex-tmux.ts";
import { ownerTrust } from "../owner-trust/service.ts";
import { admitVerifiedFixture } from "../owner-trust/fixture-launch.ts";

export const productionCodexLauncher = spawnCodexViaTmux;
export const productionClaudeLauncher = spawnClaudeViaTmux;

export interface LiveAuthorizationDecision {
  executionReady: boolean;
  method: "native-owner-proof";
  code: string;
  reason: string;
}

/**
 * Production trust decision for a live Codex or Claude launch.
 * Environment variables are not read. A missing or non-production proof
 * refuses. Deployment authorization stays on its own unsupported channel.
 */
export function assessTrustedLiveAuthorization(input?: { proof?: unknown; operation?: unknown }): LiveAuthorizationDecision {
  const trust = ownerTrust();
  if (input?.proof === undefined) {
    const status = trust.status();
    return {
      executionReady: false,
      method: "native-owner-proof",
      code: String(status.code),
      reason: String(status.reason),
    };
  }
  const decision = trust.admit(input.proof, input.operation, { trustClasses: ["production"], consume: false });
  return {
    executionReady: decision.executionReady,
    method: "native-owner-proof",
    code: decision.code,
    reason: decision.reason,
  };
}

export interface LiveLaunchResult {
  processStarted: boolean;
  launched: boolean;
  launcher: "spawnCodexViaTmux" | "spawnClaudeViaTmux" | "none";
  launcherBound: boolean;
  code: string;
  reason: string;
  provenance?: "qa-fixture" | "verified-fixture";
}

type PreparedLaunch =
  | { transport: "codex-live"; options: CodexLaunchOptions }
  | { transport: "claude-live"; options: ClaudeLaunchOptions };

/**
 * Invokes the bound launcher only after trusted authorization.
 * `AGETOR_PROVIDER_LIVE_SPAWN` is not read. A caller-supplied flag is not accepted.
 */
export async function invokeAuthorizedLiveLauncher(input: {
  transport: "recorded" | "codex-live" | "claude-live";
  prepared?: PreparedLaunch;
  proof?: unknown;
  operation?: unknown;
}): Promise<LiveLaunchResult> {
  if (input.transport === "recorded") {
    return {
      processStarted: false,
      launched: false,
      launcher: "none",
      launcherBound: false,
      code: "recorded",
      reason: "Recorded transport does not start a provider process.",
    };
  }
  const decision = assessTrustedLiveAuthorization(
    input.proof === undefined ? undefined : { proof: input.proof, operation: input.operation },
  );
  const launcherName = input.transport === "codex-live" ? "spawnCodexViaTmux" : "spawnClaudeViaTmux";
  const launcher = input.transport === "codex-live" ? productionCodexLauncher : productionClaudeLauncher;
  if (!decision.executionReady || decision.method !== "native-owner-proof") {
    return {
      processStarted: false,
      launched: false,
      launcher: launcherName,
      launcherBound: launcher === productionCodexLauncher || launcher === productionClaudeLauncher,
      code: decision.code,
      reason: decision.reason,
    };
  }
  if (!input.prepared || input.prepared.transport !== input.transport) {
    return {
      processStarted: false,
      launched: false,
      launcher: launcherName,
      launcherBound: true,
      code: "launch-not-prepared",
      reason: "Trusted authorization did not include prepared launch options. No process was started.",
    };
  }
  const consumed = ownerTrust().admit(input.proof, input.operation, { trustClasses: ["production"], consume: true });
  if (!consumed.ok || !consumed.executionReady) {
    return {
      processStarted: false,
      launched: false,
      launcher: launcherName,
      launcherBound: true,
      code: consumed.code,
      reason: consumed.reason,
    };
  }
  if (input.prepared.transport === "codex-live") await productionCodexLauncher(input.prepared.options);
  else await productionClaudeLauncher(input.prepared.options);
  return {
    processStarted: true,
    launched: true,
    launcher: launcherName,
    launcherBound: true,
    code: "launched",
    reason: "The bound production launcher started.",
  };
}

let qaFixture: (() => Promise<void>) | null = null;

/** Test-only recorded fixture. It cannot replace the production launcher. */
export function bindQaFixtureTransportForTest(run: (() => Promise<void>) | null): void {
  qaFixture = run;
}

export { admitVerifiedFixture };

/**
 * Test observation after the real admit() boundary.
 * It does not call spawnCodexViaTmux or spawnClaudeViaTmux.
 * The production singleton cannot construct the fixture identity this uses.
 */
export async function observeAuthorizedTransportForTest(input: {
  trust: { admit: (proof: unknown, operation: unknown, options?: { trustClasses?: Array<"production" | "qa-dev" | "synthetic-test">; consume?: boolean }) => LiveAuthorizationDecision & { grantId?: string | null; ok?: boolean } };
  proof: unknown;
  operation: {
    accountId: string;
    modelId: string;
    role: string;
    mode: string;
    workspace: string;
    providerId: string;
    filesystem: string;
  };
  transport: "codex-live" | "claude-live";
  spy: (seen: {
    accountId: string;
    modelId: string;
    role: string;
    mode: string;
    workspace: string;
    providerId: string;
    filesystem: string;
    grantId: string | null;
  }) => void;
}): Promise<LiveLaunchResult & { spyCalled: boolean }> {
  const decision = input.trust.admit(input.proof, input.operation, { trustClasses: ["production"], consume: true });
  const launcherName = input.transport === "codex-live" ? "spawnCodexViaTmux" : "spawnClaudeViaTmux";
  if (!decision.executionReady || decision.method !== "native-owner-proof") {
    return {
      processStarted: false,
      launched: false,
      launcher: launcherName,
      launcherBound: true,
      code: decision.code,
      reason: decision.reason,
      spyCalled: false,
    };
  }
  input.spy({
    accountId: input.operation.accountId,
    modelId: input.operation.modelId,
    role: input.operation.role,
    mode: input.operation.mode,
    workspace: input.operation.workspace,
    providerId: input.operation.providerId,
    filesystem: input.operation.filesystem,
    grantId: decision.grantId ?? null,
  });
  return {
    processStarted: false,
    launched: false,
    launcher: launcherName,
    launcherBound: true,
    code: "transport-observed",
    reason: "The proof passed verification. The test spy recorded the launch and no provider process was started.",
    spyCalled: true,
  };
}

export async function invokeQaFixtureTransport(): Promise<LiveLaunchResult> {
  if (!qaFixture) {
    return {
      processStarted: false,
      launched: false,
      launcher: "none",
      launcherBound: false,
      code: "qa-fixture-unbound",
      provenance: "qa-fixture",
      reason: "No QA fixture transport is bound. No provider process was started.",
    };
  }
  await qaFixture();
  return {
    processStarted: false,
    launched: false,
    launcher: "none",
    launcherBound: false,
    code: "qa-fixture",
    provenance: "qa-fixture",
    reason: "QA fixture transport ran. No provider process was started.",
  };
}
