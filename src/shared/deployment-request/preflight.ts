/**
 * FO-DEPLOY01 preflight — pure checks over resolved metadata (no network/SSH).
 */

import type {
  DeploymentPlan,
  DeploymentPlanStep,
  DeploymentTargetEnvironment,
  PreflightFinding,
} from "./types.ts";
import { deploymentEnvironmentLabel } from "./types.ts";
import type { StagingIntegrationRecord } from "./integration.ts";
import { computePlanDigest } from "./plan-digest.ts";

export interface PreflightContext {
  projectPath: string;
  projectName: string;
  clusterId: string;
  clusterName: string | null;
  clusterArchived: boolean;
  membershipClusterId: string | null;
  declaredEnvironments: { environment: string; customLabel: string }[];
  integrationResource: { id: string; name: string; resourceType: string } | null;
  revisionResolved: string | null;
  revisionError: string | null;
  adapterConfigured: boolean;
  stagingIntegration: StagingIntegrationRecord | null;
  adapterPreflightFindings?: PreflightFinding[];
}

export interface PreflightResult {
  findings: PreflightFinding[];
  plan: DeploymentPlan | null;
  passed: boolean;
}

export function runDeploymentPreflight(input: {
  projectPath: string;
  projectName: string;
  clusterId: string;
  clusterName: string | null;
  environment: DeploymentTargetEnvironment;
  revision: string;
  context: PreflightContext;
}): PreflightResult {
  const findings: PreflightFinding[] = [];
  const push = (code: string, severity: PreflightFinding["severity"], message: string) => {
    findings.push({ code, severity, message });
  };

  if (!input.clusterName || input.context.clusterArchived) {
    push("cluster.missing", "error", "Cluster does not exist or is archived.");
  }
  if (input.context.membershipClusterId !== input.clusterId) {
    push(
      "cluster.membership",
      "error",
      "Project is not assigned to the selected cluster.",
    );
  }

  const envDeclared = input.context.declaredEnvironments.some(
    (row) => row.environment === input.environment && !row.customLabel,
  );
  if (!envDeclared) {
    push(
      "environment.missing",
      "error",
      `${deploymentEnvironmentLabel(input.environment)} is not declared for this project in the infrastructure registry.`,
    );
  }

  if (input.context.revisionError) {
    push("revision.invalid", "error", input.context.revisionError);
  } else if (input.context.revisionResolved) {
    push("revision.valid", "info", `Revision resolves to ${input.context.revisionResolved.slice(0, 12)}…`);
  }

  if (!input.context.integrationResource) {
    push(
      "integration.missing",
      "warning",
      "No CI/CD or deployment-environment resource is linked to this project and environment.",
    );
  }

  if (!input.context.adapterConfigured) {
    push(
      "adapter.not_configured",
      "warning",
      "Staging adapter is not configured on this ForgeOrbit instance.",
    );
  }

  if (input.environment === "staging" && !input.context.stagingIntegration) {
    push(
      "staging.integration.missing",
      "warning",
      "No Owner-configured staging deployment integration exists for this cluster and project.",
    );
  } else if (input.context.stagingIntegration) {
    push(
      "staging.integration.present",
      "info",
      `Staging integration: ${input.context.stagingIntegration.integrationLabel} (${input.context.stagingIntegration.integrationType}).`,
    );
    for (const finding of input.context.adapterPreflightFindings ?? []) {
      findings.push(finding);
    }
  }

  if (input.environment === "production") {
    push(
      "environment.production",
      "warning",
      "Production targets require explicit Owner confirmation at approval time.",
    );
  }

  const blocking = findings.some((f) => f.severity === "error");
  if (blocking) {
    return { findings, plan: null, passed: false };
  }

  const integration = input.context.stagingIntegration;
  const planBase = {
    projectPath: input.projectPath,
    projectName: input.projectName,
    clusterId: input.clusterId,
    clusterName: input.clusterName ?? input.clusterId,
    environment: input.environment,
    revision: input.revision,
    revisionResolved: input.context.revisionResolved,
    integrationResourceId: input.context.integrationResource?.id ?? null,
    integrationResourceName: input.context.integrationResource?.name ?? null,
    stagingIntegrationId: integration?.id ?? null,
    stagingIntegrationType: integration?.integrationType ?? null,
    stagingIntegrationLabel: integration?.integrationLabel ?? null,
    stagingProjectSlug: integration?.projectSlug ?? null,
    entrypointRef: integration?.entrypointRef ?? null,
    imagesCatalogRef: integration?.imagesCatalogRef ?? null,
    imageArtifacts: null as import("./types.ts").DeploymentPlan["imageArtifacts"],
    imageCatalogDigest: null as string | null,
    planDigest: null as string | null,
    steps: [] as DeploymentPlanStep[],
    note: "",
  };

  const steps: DeploymentPlanStep[] = [
    {
      kind: "validate",
      label: "Validate target",
      detail: `${input.projectName} → ${input.clusterName ?? input.clusterId} → ${deploymentEnvironmentLabel(input.environment)}`,
    },
    {
      kind: "validate",
      label: "Validate revision",
      detail: input.context.revisionResolved
        ? `${input.revision} (${input.context.revisionResolved.slice(0, 12)}…)`
        : input.revision,
    },
  ];
  if (input.context.integrationResource) {
    steps.push({
      kind: "prepare",
      label: "Use recorded integration",
      detail: `${input.context.integrationResource.name} (${input.context.integrationResource.resourceType})`,
    });
  }
  if (integration) {
    steps.push({
      kind: "prepare",
      label: "Staging integration",
      detail: `${integration.integrationLabel} → ${integration.projectSlug} via ${integration.entrypointRef}`,
    });
  }
  steps.push({
    kind: "simulate",
    label: "Dry-run only",
    detail: input.context.adapterConfigured
      ? integration
        ? "Adapter-backed preflight/dry-run — no remote deploy in FO-DEPLOY02."
        : "Legacy synthetic adapter when no integration is mapped."
      : "Adapter unavailable — outcome will be NOT_CONFIGURED.",
  });

  const planDigest = computePlanDigest(
    { ...planBase, steps, note: "" },
    integration?.id ?? null,
    integration?.integrationType ?? null,
  );

  const plan: DeploymentPlan = {
    ...planBase,
    steps,
    planDigest,
    note: "FO-DEPLOY03: real external staging execution requires Owner machine gates (FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE + FORGEORBIT_DEPLOYMENT_EXTERNAL_REAL_EXECUTE), integration flags, immutable image catalog, and separate execution authorization.",
  };

  return { findings, plan, passed: true };
}
