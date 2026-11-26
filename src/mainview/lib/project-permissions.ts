/**
 * Presenters for project permission requests. The server's English sentences stay
 * canonical (they are shown in technical details); everyday text comes from here.
 * An unknown status falls back to the raw value, never to a reassuring label.
 */
import { t, type TranslationKey } from "@/i18n/core";
import { en } from "@/i18n/en";
import type { PermissionRequestStatus, ProjectPermissionRequest } from "../../shared/project-permissions.ts";

function key(name: string): TranslationKey | null {
  return Object.hasOwn(en, name) ? (name as TranslationKey) : null;
}

export function permissionStatusText(status: string): string {
  const k = key(`perm.status.${status}`);
  return k ? t(k) : status;
}

/** One plain sentence about what happened to a request. Never claims a run that did not happen. */
export function permissionOutcomeText(request: Pick<ProjectPermissionRequest, "status" | "authority" | "exitCode" | "reason">): string {
  const status: PermissionRequestStatus | string = request.status;
  if (status === "completed") return t("perm.outcome.completed");
  if (status === "failed") {
    return request.exitCode == null ? t("perm.outcome.failed_noexit") : t("perm.outcome.failed", { code: String(request.exitCode) });
  }
  const k = key(`perm.outcome.${status}`);
  return k ? t(k) : status;
}

export function permissionAuthorityText(authority: string | null): string {
  if (authority === "owner-once") return t("perm.authority.owner_once");
  if (authority === "project-rule") return t("perm.authority.project_rule");
  return t("perm.authority.none");
}

export function isOpenRequest(status: string): boolean {
  return status === "pending" || status === "running";
}

/** The one place an evidence kind or freshness becomes everyday text. Unknown values fall back to the raw value. */
export function evidenceKindText(kind: string): string {
  const k = key(`perm.ev.kind.${kind}`);
  return k ? t(k) : kind;
}

export function evidenceDescriptionText(entry: { kind: string; exitCode: number | null }): string {
  if (entry.kind === "failed") {
    return entry.exitCode == null ? t("perm.ev.desc.failed_noexit") : t("perm.ev.desc.failed", { code: String(entry.exitCode) });
  }
  const k = key(`perm.ev.desc.${entry.kind}`);
  return k ? t(k) : entry.kind;
}

export function evidenceFreshnessText(freshness: string): string {
  const k = key(`perm.ev.fresh.${freshness}`);
  return k ? t(k) : freshness;
}

export function evidenceFreshnessReasonText(reason: string): string {
  const k = key(`perm.ev.reason.${reason}`);
  return k ? t(k) : reason;
}
