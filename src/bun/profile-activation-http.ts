/**
 * FO-P2-005-B — HTTP mapping for the trusted profile activation core.
 */

import type {
  ProfileActivationCandidateResponse,
  ProfileActivationPrepareResponse,
  ProfileActivationRelinkResponse,
  ProfileActivationStatusResponse,
} from "../shared/profile-activation.ts";
import { startupProfileInfo } from "./db.ts";
import {
  ProfileActivationError,
  type ProfileActivationErrorCode,
} from "./profile-activation-errors.ts";
import type {
  ActivationPreparation,
  ActiveProfileInfo,
  PendingTransitionInfo,
  ProfileActivationService,
  RollbackAvailability,
  RollbackPreparation,
} from "./profile-activation.ts";
import type { CandidateInspection } from "./profile-activation-preflight.ts";

export function activationHttpStatus(code: ProfileActivationErrorCode): number {
  if (
    code === "INVALID_INPUT" ||
    code === "NOT_A_DIRECTORY" ||
    code === "UNTRUSTED_SYMLINK" ||
    code === "PROTECTED_PATH" ||
    code === "CANDIDATE_OUTSIDE_MANAGED"
  ) return 400;
  if (
    code === "CANDIDATE_NOT_FOUND" ||
    code === "CANDIDATE_NOT_DIRECTORY" ||
    code === "PROJECT_NOT_FOUND" ||
    code === "DIRECTORY_NOT_FOUND"
  ) return 404;
  if (code === "PROJECT_CONFLICT") return 409;
  return 409;
}

export function activationRouteError(
  err: unknown,
  json: (data: unknown, init?: ResponseInit) => Response,
  headers: HeadersInit,
): Response {
  if (err instanceof ProfileActivationError) {
    return json({ error: err.message, code: err.code }, { status: activationHttpStatus(err.code), headers });
  }
  console.error("[profile-activation] unexpected route failure", err instanceof Error ? err.name : typeof err);
  return json(
    { error: "Profile activation could not be completed", code: "IO_ERROR" },
    { status: 500, headers },
  );
}

export function requireActivationConfirm(body: Record<string, unknown>): boolean {
  return body.confirm === true;
}

export function readCandidatePath(body: Record<string, unknown>): string {
  const value = body.candidatePath;
  if (typeof value !== "string" || !value.trim()) {
    throw new ProfileActivationError("candidatePath is required", "INVALID_INPUT");
  }
  return value;
}

function toPendingView(pending: PendingTransitionInfo | null) {
  if (!pending) return null;
  return {
    transitionId: pending.transitionId,
    action: pending.action,
    state: pending.state,
    candidatePath: pending.candidatePath,
    originalPath: pending.originalPath,
    requestedAt: pending.requestedAt,
    updatedAt: pending.updatedAt,
    startupAttempts: pending.startupAttempts,
    error: pending.error,
  };
}

function toRollbackView(rollback: RollbackAvailability) {
  return {
    available: rollback.available,
    reason: rollback.reason,
    targetPath: rollback.targetPath,
    targetIdentity: rollback.targetIdentity,
    transitionId: rollback.transitionId,
  };
}

export function buildActivationStatus(service: ProfileActivationService): ProfileActivationStatusResponse {
  const activeInfo = service.inspectActiveProfile();
  const rollback = service.getRollbackAvailability();
  return {
    active: {
      profileRoot: activeInfo.activeDataDir,
      baseDataDir: activeInfo.baseDataDir,
      identity: activeInfo.identity,
      generation: activeInfo.generation,
      transitionId: activeInfo.transitionId,
    },
    startup: {
      recovered: startupProfileInfo.recovered,
      recoveredFrom: startupProfileInfo.recoveredFrom,
      warnings: [...startupProfileInfo.warnings],
    },
    pendingTransition: toPendingView(activeInfo.pendingTransition ?? service.getPendingTransition()),
    rollback: toRollbackView(rollback),
  };
}

export function buildCandidateView(inspection: CandidateInspection): ProfileActivationCandidateResponse {
  return {
    ok: inspection.ok,
    code: inspection.code,
    message: inspection.message,
    candidatePath: inspection.candidatePath,
    canonicalPath: inspection.canonicalPath,
    readiness: inspection.readiness,
    snapshotId: inspection.snapshotId,
    manifestVersion: inspection.manifestVersion,
    appVersion: inspection.appVersion,
    databaseSha256: inspection.databaseSha256,
    databaseBytes: inspection.databaseBytes,
    pendingMigrationCount: inspection.pendingMigrationCount,
    recoveryPreview: inspection.recoveryPreview ?? null,
    checks: inspection.checks.map((check) => ({
      id: check.id,
      ok: check.ok,
      detail: check.detail,
    })),
    warnings: [...inspection.warnings],
  };
}

export function buildPrepareView(
  result: ActivationPreparation | RollbackPreparation,
): ProfileActivationPrepareResponse {
  if (result.action === "activate") {
    return {
      transitionId: result.transitionId,
      state: result.state,
      action: "activate",
      candidatePath: result.candidatePath,
      originalPath: result.originalPath,
      requestedAt: result.requestedAt,
      requiresRestart: true,
      snapshotId: result.snapshotId,
      requiresMigration: result.requiresMigration,
    };
  }
  return {
    transitionId: result.transitionId,
    state: result.state,
    action: "rollback",
    targetPath: result.targetPath,
    currentPath: result.currentPath,
    requestedAt: result.requestedAt,
    requiresRestart: true,
    snapshotId: null,
  };
}

export function toActiveSummary(info: ActiveProfileInfo) {
  return {
    profileRoot: info.activeDataDir,
    baseDataDir: info.baseDataDir,
    identity: info.identity,
    generation: info.generation,
    transitionId: info.transitionId,
  };
}
