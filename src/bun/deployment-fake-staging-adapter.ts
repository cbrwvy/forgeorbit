/**
 * FO-DEPLOY02 — in-process fake staging adapter (tests only; no network).
 */

import type { StagingIntegrationRecord } from "../shared/deployment-request/integration.ts";
import type { DeploymentPlan, DryRunOutcome, PreflightFinding } from "../shared/deployment-request/types.ts";

export type FakeAdapterMode =
  | "ok"
  | "preflight_fail"
  | "dry_run_fail"
  | "execute_fail"
  | "timeout"
  | "cancel"
  | "ambiguous";

let fakeMode: FakeAdapterMode = "ok";
let fakeRunning: { cancel: () => void } | null = null;

export function setFakeStagingAdapterMode(mode: FakeAdapterMode): void {
  fakeMode = mode;
}

export function getFakeStagingAdapterRunning(): boolean {
  return fakeRunning != null;
}

export function cancelFakeStagingAdapterRun(): void {
  fakeRunning?.cancel();
}

export interface AdapterPreflightResult {
  findings: PreflightFinding[];
  passed: boolean;
  preflightStatus: DryRunOutcome | "FAILED";
  message: string;
}

export interface AdapterDryRunResult {
  outcome: DryRunOutcome;
  simulated: boolean;
  remoteCommandsExecuted: number;
  message: string;
  evidence?: import("../shared/deployment-request/types.ts").DryRunEvidence;
}

export interface AdapterExecuteResult {
  exitCode: number | null;
  log: string;
  errorMessage: string | null;
  state: "succeeded" | "failed" | "cancelled" | "reconciliation_required";
}

export function fakeStagingPreflight(
  plan: DeploymentPlan,
  integration: StagingIntegrationRecord,
): AdapterPreflightResult {
  if (integration.integrationType !== "forgeorbit-fake-staging-v1") {
    return {
      findings: [{ code: "adapter.unsupported", severity: "error", message: "Wrong integration type for fake adapter." }],
      passed: false,
      preflightStatus: "UNSUPPORTED",
      message: "UNSUPPORTED",
    };
  }
  if (fakeMode === "preflight_fail") {
    return {
      findings: [{ code: "fake.preflight", severity: "error", message: "Fake preflight failure." }],
      passed: false,
      preflightStatus: "FAILED",
      message: "FAILED — fake preflight.",
    };
  }
  if (!plan.revisionResolved || plan.revisionResolved.length !== 40) {
    return {
      findings: [{ code: "revision.sha", severity: "error", message: "Fake adapter requires a 40-char commit SHA." }],
      passed: false,
      preflightStatus: "FAILED",
      message: "FAILED — revision binding.",
    };
  }
  return {
    findings: [
      {
        code: "fake.preflight.ok",
        severity: "info",
        message: `Fake adapter mapped ${integration.projectSlug} for staging.`,
      },
    ],
    passed: true,
    preflightStatus: "CONFIG_VERIFIED",
    message: "CONFIG_VERIFIED — fake adapter mapping (synthetic, not real infrastructure).",
  };
}

export function fakeStagingDryRun(plan: DeploymentPlan, integration: StagingIntegrationRecord): AdapterDryRunResult {
  const pre = fakeStagingPreflight(plan, integration);
  if (!pre.passed) {
    return {
      outcome: pre.preflightStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED",
      simulated: false,
      remoteCommandsExecuted: 0,
      message: pre.message,
    };
  }
  if (fakeMode === "dry_run_fail") {
    return {
      outcome: "FAILED",
      simulated: false,
      remoteCommandsExecuted: 0,
      message: "FAILED — fake dry-run.",
    };
  }
  return {
    outcome: "SIMULATED",
    simulated: true,
    remoteCommandsExecuted: 0,
    evidence: "synthetic",
    message: "SIMULATED — in-process test adapter (not verified against real infrastructure).",
  };
}

export function fakeStagingExecute(
  plan: DeploymentPlan,
  integration: StagingIntegrationRecord,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<AdapterExecuteResult> {
  return new Promise((resolve) => {
    if (integration.integrationType !== "forgeorbit-fake-staging-v1") {
      resolve({
        exitCode: 1,
        log: "",
        errorMessage: "Unsupported integration type.",
        state: "failed",
      });
      return;
    }
    const pre = fakeStagingPreflight(plan, integration);
    if (!pre.passed) {
      resolve({ exitCode: 1, log: pre.message, errorMessage: pre.message, state: "failed" });
      return;
    }
    let settled = false;
    const finish = (result: AdapterExecuteResult) => {
      if (settled) return;
      settled = true;
      fakeRunning = null;
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ exitCode: null, log: "timeout", errorMessage: "Timed out.", state: "reconciliation_required" });
    }, options.timeoutMs);
    fakeRunning = {
      cancel: () => {
        clearTimeout(timer);
        finish({ exitCode: null, log: "cancelled", errorMessage: "Cancelled.", state: "cancelled" });
      },
    };
    options.signal?.addEventListener("abort", () => fakeRunning?.cancel(), { once: true });

    const delay = fakeMode === "timeout" ? options.timeoutMs + 50 : 15;
    setTimeout(() => {
      clearTimeout(timer);
      if (fakeMode === "cancel") {
        finish({ exitCode: null, log: "cancelled", errorMessage: "Cancelled.", state: "cancelled" });
        return;
      }
      if (fakeMode === "ambiguous") {
        finish({
          exitCode: null,
          log: "process lost",
          errorMessage: "Ambiguous exit — reconciliation required.",
          state: "reconciliation_required",
        });
        return;
      }
      if (fakeMode === "execute_fail") {
        finish({ exitCode: 2, log: "deploy failed", errorMessage: "Fake execution failed.", state: "failed" });
        return;
      }
      finish({
        exitCode: 0,
        log: `SIMULATED STAGING EXECUTION OK project=${integration.projectSlug} sha=${plan.revisionResolved}\nsecret=token=should-be-redacted`,
        errorMessage: null,
        state: "succeeded",
      });
    }, delay);
  });
}
