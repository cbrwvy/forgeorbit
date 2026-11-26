/** FO-DEPLOY04: no trusted Owner channel exists in the current desktop runtime. */
export const OWNER_CHANNEL_BLOCKER =
  "Trusted Owner confirmation is unsupported. Bearer tokens, role labels and confirmOwner cannot authorize LF execution. Review the manual handoff outside ForgeOrbit.";

/** Only the in-process fake adapter can receive these non-privileged test grants. */
export const SYNTHETIC_AUTH_TTL_MS = 5 * 60_000;

export interface DeploymentOwnerConfirmation {
  method: "unavailable";
  result: "unsupported";
  executionReady: false;
  expiresAt: null;
  reason: string;
}

export function unsupportedOwnerConfirmation(): DeploymentOwnerConfirmation {
  return {
    method: "unavailable",
    result: "unsupported",
    executionReady: false,
    expiresAt: null,
    reason: OWNER_CHANNEL_BLOCKER,
  };
}

export interface DeploymentManualHandoff {
  schema: "forgeorbit-deployment-review-v1";
  requestId: string;
  action: "deploy-staging";
  reviewOnly: true;
  executionAuthorized: false;
  generatedAt: number;
  planDigest: string;
  target: { projectPath: string; projectName: string; clusterId: string; clusterName: string; environment: "staging" };
  revisionResolved: string;
  integration: { id: string; type: string; label: string; projectSlug: string; entrypointRef: string };
  imagesCatalogRef: string;
  imageCatalogDigest: string;
  imageArtifacts: import("./image-artifacts.ts").DeploymentImageArtifact[];
  dryRunOutcome: import("./types.ts").DryRunOutcome;
  instructions: string;
}
