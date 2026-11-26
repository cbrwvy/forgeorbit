/**
 * FO-DEPLOY02 — External staging adapter (read-only compatibility; no remote execution).
 */

import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { StagingIntegrationRecord } from "../shared/deployment-request/integration.ts";
import type { DeploymentPlan, DryRunOutcome, PreflightFinding } from "../shared/deployment-request/types.ts";
import { buildExternalControllerArgv, resolveExternalImageArtifacts } from "./deployment-external-staging-executor.ts";
import { sanitizeDeploymentLog } from "../shared/deployment-request/log-sanitize.ts";

function localPreflightEnabled(): boolean {
  return process.env.FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT === "1";
}

function trustedEntrypointBasenames(): string[] {
  const configured = process.env.FORGEORBIT_DEPLOYMENT_TRUSTED_ENTRYPOINTS?.trim();
  const extra = configured
    ? configured.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && !s.includes("/") && !s.includes(".."))
    : [];
  return ["deploy-staging.sh", "deploy-staging-fixture.sh", ...extra];
}

export function isTrustedExternalEntrypoint(entrypointRef: string): boolean {
  if (!entrypointRef.startsWith("/")) return false;
  if (entrypointRef.includes("..")) return false;
  try {
    const resolved = realpathSync(entrypointRef);
    const allowed = trustedEntrypointBasenames();
    if (!allowed.some((name) => resolved.endsWith(`/${name}`) || resolved === name)) {
      return false;
    }
    return existsSync(resolved);
  } catch {
    return false;
  }
}

function sha40(revisionResolved: string | null): boolean {
  return !!revisionResolved && /^[0-9a-f]{40}$/.test(revisionResolved);
}

export function externalStagingConfigPreflight(
  plan: DeploymentPlan,
  integration: StagingIntegrationRecord,
): { findings: PreflightFinding[]; passed: boolean; status: DryRunOutcome; message: string } {
  if (integration.integrationType !== "external-staging-v1") {
    return {
      findings: [{ code: "adapter.type", severity: "error", message: "Not an external staging integration." }],
      passed: false,
      status: "UNSUPPORTED",
      message: "UNSUPPORTED",
    };
  }
  const findings: PreflightFinding[] = [];
  if (integration.entrypointRef.startsWith("@")) {
    findings.push({ code: "entrypoint.token", severity: "error", message: "External staging integration requires an absolute entrypoint path." });
  } else if (!isTrustedExternalEntrypoint(integration.entrypointRef)) {
    findings.push({
      code: "entrypoint.missing",
      severity: "error",
      message: "Trusted staging entrypoint path is not present on this machine.",
    });
  } else {
    findings.push({
      code: "entrypoint.ok",
      severity: "info",
      message: `Entrypoint resolved for ${integration.projectSlug}.`,
    });
  }
  if (!sha40(plan.revisionResolved)) {
    findings.push({
      code: "revision.sha40",
      severity: "error",
      message: "External staging requires a resolved 40-character Git commit SHA.",
    });
  }
  if (findings.some((f) => f.severity === "error")) {
    return { findings, passed: false, status: "FAILED", message: "FAILED — external staging configuration preflight." };
  }
  return {
    findings,
    passed: true,
    status: "CONFIG_VERIFIED",
    message: "CONFIG_VERIFIED — staging mapping and entrypoint path validated locally (no subprocess).",
  };
}

export function externalStagingAdapterPreflight(
  plan: DeploymentPlan,
  integration: StagingIntegrationRecord,
): PreflightFinding[] {
  const config = externalStagingConfigPreflight(plan, integration);
  if (!config.passed) return config.findings;
  const findings = [...config.findings];
  if (!localPreflightEnabled()) {
    findings.push({
      code: "preflight.config_only",
      severity: "info",
      message: "CONFIG_VERIFIED — no preflight subprocess (enable FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT=1 for local subprocess).",
    });
    return findings;
  }
  if (!integration.imagesCatalogRef) {
    findings.push({
      code: "catalog.optional",
      severity: "info",
      message: "No images catalog — staging subprocess preflight skipped until catalog is configured.",
    });
    return findings;
  }
  const images = resolveExternalImageArtifacts(plan, integration);
  if (!images.ok) {
    findings.push({ code: images.finding.code, severity: "error", message: images.finding.message });
    return findings;
  }
  const argv = buildExternalControllerArgv("preflight", integration, plan, {
    imagesFilePath: images.value.imagesFilePath,
  });
  const proc = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 120_000 });
  const combined = sanitizeDeploymentLog(`${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim());
  if (proc.status === 0) {
    findings.push({
      code: "preflight.subprocess.ok",
      severity: "info",
      message: "REAL_PREFLIGHT_VERIFIED — local staging preflight subprocess exited 0.",
    });
  } else {
    findings.push({
      code: "preflight.subprocess.fail",
      severity: "error",
      message: combined.slice(0, 300) || "Staging preflight subprocess failed.",
    });
  }
  return findings;
}

export function externalStagingDryRun(
  plan: DeploymentPlan,
  integration: StagingIntegrationRecord,
): { outcome: DryRunOutcome; simulated: boolean; remoteCommandsExecuted: number; message: string; evidence?: import("../shared/deployment-request/types.ts").DryRunEvidence; log?: string } {
  const config = externalStagingConfigPreflight(plan, integration);
  if (!config.passed) {
    return {
      outcome: config.status === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED",
      simulated: false,
      remoteCommandsExecuted: 0,
      message: config.message,
    };
  }
  if (!localPreflightEnabled()) {
    return {
      outcome: "UNSUPPORTED",
      simulated: false,
      remoteCommandsExecuted: 0,
      message:
        "UNSUPPORTED — staging --dry-run is not invoked by default. Set FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT=1 only on a trusted local copy.",
    };
  }
  if (!integration.imagesCatalogRef) {
    return {
      outcome: "UNSUPPORTED",
      simulated: false,
      remoteCommandsExecuted: 0,
      message: "UNSUPPORTED — configure imagesCatalogRef before staging dry-run.",
    };
  }
  const images = resolveExternalImageArtifacts(plan, integration);
  if (!images.ok) {
    return {
      outcome: "FAILED",
      simulated: false,
      remoteCommandsExecuted: 0,
      message: images.finding.message,
    };
  }
  const argv = buildExternalControllerArgv("deploy", integration, plan, {
    dryRun: true,
    imagesFilePath: images.value.imagesFilePath,
  });
  const proc = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 120_000 });
  const combined = sanitizeDeploymentLog(`${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim());
  if (proc.status === 0) {
    return {
      outcome: "REAL_DRY_RUN_VERIFIED",
      simulated: false,
      remoteCommandsExecuted: 0,
      evidence: "local-dry-run",
      message: "REAL_DRY_RUN_VERIFIED — local staging --dry-run subprocess exited 0.",
      log: combined,
    };
  }
  return {
    outcome: "FAILED",
    simulated: false,
    remoteCommandsExecuted: 0,
    message: combined.slice(0, 300) || "Staging dry-run failed.",
    log: combined,
  };
}
