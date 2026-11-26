import { createHash } from "node:crypto";
import type { DeploymentPlan } from "./types.ts";

export function computePlanDigest(plan: DeploymentPlan, integrationId: string | null, integrationType: string | null): string {
  const payload = JSON.stringify({
    projectPath: plan.projectPath,
    clusterId: plan.clusterId,
    environment: plan.environment,
    revision: plan.revision,
    revisionResolved: plan.revisionResolved,
    integrationResourceId: plan.integrationResourceId,
    integrationId,
    integrationType,
    stagingProjectSlug: plan.stagingProjectSlug,
    entrypointRef: plan.entrypointRef,
    imagesCatalogRef: plan.imagesCatalogRef,
    imageCatalogDigest: plan.imageCatalogDigest,
    imageArtifacts: plan.imageArtifacts,
    steps: plan.steps,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function computeExecutionAuthDigest(input: {
  requestId: string;
  projectPath: string;
  clusterId: string;
  environment: string;
  revision: string;
  revisionResolved: string | null;
  planDigest: string;
  integrationId: string | null;
  integrationType: string | null;
  imageCatalogDigest: string | null;
  executionAuthGeneration: number;
}): string {
  const payload = JSON.stringify(input);
  return createHash("sha256").update(payload).digest("hex");
}
