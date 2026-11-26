/**
 * Wire contracts for FO-P2-005-B profile recovery and activation UX.
 *
 * Shared by the Bun core (ProfileActivationService) and the React webview.
 * Summaries only — no database rows, credentials, or journal internals.
 */

import type { BackupActivationReadiness, RestoreRecoveryPreview } from "./backup.ts";

export type ProfileTransitionAction = "activate" | "rollback";

export type ProfileTransitionState =
  | "prepared"
  | "switching"
  | "pending_startup_validation"
  | "rollback_required"
  | "rolling_back"
  | "active"
  | "rolled_back"
  | "failed";

export interface ProfileActivationPendingView {
  transitionId: string;
  action: ProfileTransitionAction;
  state: ProfileTransitionState;
  candidatePath: string;
  originalPath: string;
  requestedAt: number;
  updatedAt: number;
  startupAttempts: number;
  error: { code: string; message: string } | null;
}

export interface ProfileActivationActiveView {
  profileRoot: string;
  baseDataDir: string;
  identity: string | null;
  generation: number | null;
  transitionId: string | null;
}

export interface ProfileActivationStartupView {
  recovered: boolean;
  recoveredFrom: ProfileTransitionState | null;
  warnings: string[];
}

export interface ProfileActivationRollbackView {
  available: boolean;
  reason: string | null;
  targetPath: string | null;
  targetIdentity: string | null;
  transitionId: string | null;
}

export interface ProfileActivationStatusResponse {
  active: ProfileActivationActiveView;
  startup: ProfileActivationStartupView;
  pendingTransition: ProfileActivationPendingView | null;
  rollback: ProfileActivationRollbackView;
}

export interface ProfileActivationCheckView {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface ProfileActivationCandidateResponse {
  ok: boolean;
  code: string | null;
  message: string | null;
  candidatePath: string;
  canonicalPath: string | null;
  readiness: BackupActivationReadiness | null;
  snapshotId: string | null;
  manifestVersion: number | null;
  appVersion: string | null;
  databaseSha256: string | null;
  databaseBytes: number | null;
  pendingMigrationCount: number;
  recoveryPreview?: RestoreRecoveryPreview | null;
  checks: ProfileActivationCheckView[];
  warnings: string[];
}

export interface ProfileActivationRelinkResponse {
  ok: true;
  candidatePath: string;
  oldPath: string;
  newPath: string;
  reboundBrainMemories: number;
  readiness: BackupActivationReadiness;
  totalExternalProjectsRequiringAttention: number;
  recoveryPreview: RestoreRecoveryPreview;
}

export interface ProfileActivationPrepareResponse {
  transitionId: string;
  state: ProfileTransitionState;
  action: ProfileTransitionAction;
  candidatePath?: string;
  targetPath?: string;
  originalPath?: string;
  currentPath?: string;
  requestedAt: number;
  requiresRestart: true;
  snapshotId: string | null;
  requiresMigration?: boolean;
}

export interface ProfileActivationRelaunchResponse {
  ok: true;
  pendingTransitionId: string;
}
