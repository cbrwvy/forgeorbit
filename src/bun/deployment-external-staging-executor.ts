/**
 * FO-DEPLOY03 — External staging subprocess executor (fixed argv; no shell).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { StagingIntegrationRecord } from "../shared/deployment-request/integration.ts";
import type { DeploymentPlan } from "../shared/deployment-request/types.ts";
import {
  resolveImageArtifactsFromCatalog,
  type DeploymentImageArtifact,
} from "../shared/deployment-request/image-artifacts.ts";
import { sanitizeDeploymentLog } from "../shared/deployment-request/log-sanitize.ts";
import { OWNER_CHANNEL_BLOCKER } from "../shared/deployment-request/owner-authorization.ts";

export interface ExternalImageResolution {
  artifacts: DeploymentImageArtifact[];
  imagesFilePath: string;
  catalogDigest: string;
}

export function resolveExternalImageArtifacts(
  plan: DeploymentPlan,
  integration: StagingIntegrationRecord,
): { ok: true; value: ExternalImageResolution } | { ok: false; finding: { code: string; message: string } } {
  if (!integration.imagesCatalogRef) {
    return {
      ok: false,
      finding: {
        code: "catalog.missing",
        message: "External staging requires an Owner-configured images catalog path (published-images.env).",
      },
    };
  }
  if (!isSafeCatalogPath(integration.imagesCatalogRef)) {
    return { ok: false, finding: { code: "catalog.path", message: "Images catalog path is invalid." } };
  }
  if (!existsSync(integration.imagesCatalogRef)) {
    return {
      ok: false,
      finding: { code: "catalog.missing_file", message: "Images catalog file is not present on this machine." },
    };
  }
  if (!plan.revisionResolved) {
    return { ok: false, finding: { code: "revision.missing", message: "Resolved Git SHA is required." } };
  }
  let content: string;
  try {
    content = readFileSync(integration.imagesCatalogRef, "utf8");
  } catch {
    return { ok: false, finding: { code: "catalog.read", message: "Could not read images catalog file." } };
  }
  const resolved = resolveImageArtifactsFromCatalog({
    projectSlug: integration.projectSlug,
    revisionResolved: plan.revisionResolved,
    catalogContent: content,
    imagesFilePath: integration.imagesCatalogRef,
  });
  if (!resolved.ok) {
    return { ok: false, finding: { code: resolved.code, message: resolved.message } };
  }
  return {
    ok: true,
    value: {
      artifacts: resolved.artifacts,
      imagesFilePath: resolved.imagesFilePath,
      catalogDigest: resolved.catalogDigest,
    },
  };
}

function isSafeCatalogPath(ref: string): boolean {
  if (!ref.startsWith("/") || ref.includes("..") || ref.includes("\0")) return false;
  try {
    realpathSync(ref);
    return true;
  } catch {
    return false;
  }
}

export function buildExternalControllerArgv(
  subcommand: "preflight" | "deploy",
  integration: StagingIntegrationRecord,
  plan: DeploymentPlan,
  options: { dryRun?: boolean; imagesFilePath: string },
): string[] {
  const sha = plan.revisionResolved!;
  const argv = [
    integration.entrypointRef,
    subcommand,
    integration.projectSlug,
    "--sha",
    sha,
    "--images-file",
    options.imagesFilePath,
  ];
  if (subcommand === "deploy" && options.dryRun) {
    argv.push("--dry-run");
  }
  return argv;
}

export interface ExternalSubprocessResult {
  exitCode: number | null;
  log: string;
  timedOut: boolean;
  signal: string | null;
}

export async function runExternalControllerArgv(
  argv: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExternalSubprocessResult> {
  const proc = Bun.spawn([argv[0]!, ...argv.slice(1)], {
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs);
  options.signal?.addEventListener(
    "abort",
    () => {
      proc.kill();
    },
    { once: true },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const exitCode = await proc.exited;
  const log = sanitizeDeploymentLog(`${stdout}\n${stderr}`.trim());
  return {
    exitCode: timedOut ? null : exitCode,
    log,
    timedOut,
    signal: proc.signalCode,
  };
}

export async function externalStagingStatus(
  integration: StagingIntegrationRecord,
  options: { timeoutMs: number },
): Promise<ExternalSubprocessResult> {
  const argv = [integration.entrypointRef, "status", integration.projectSlug];
  return runExternalControllerArgv(argv, options);
}

export type ExternalExecuteOutcome = {
  exitCode: number | null;
  log: string;
  errorMessage: string | null;
  state: "succeeded" | "failed" | "cancelled" | "reconciliation_required";
};

/** FO-DEPLOY04: deliberately unavailable even to direct callers; no environment override. */
export async function externalStagingExecuteDeploy(
  _plan: DeploymentPlan,
  _integration: StagingIntegrationRecord,
  _imagesFilePath: string,
  _options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExternalExecuteOutcome> {
  return { exitCode: null, log: "", errorMessage: OWNER_CHANNEL_BLOCKER, state: "failed" };
}
