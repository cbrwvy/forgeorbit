/**
 * FO-UX-SIMPLIFY02-M0: shared, pure presenters that turn canonical codes into plain words.
 *
 * Rules every function here follows:
 * - the canonical code/value is never changed or lost; callers show it in technical details;
 * - an unknown cost, quota or account is never presented as zero or as available;
 * - a code with no mapping falls back to the raw code (never to an empty or reassuring label).
 */
import { t, type TranslationKey } from "@/i18n/core";
import { en } from "@/i18n/en";
import type { ColumnId } from "../../shared/types.ts";

function has(key: string): key is TranslationKey {
  return Object.hasOwn(en, key);
}
function mapped(prefix: string, code: string | null | undefined, fallback: string): string {
  if (code == null || code === "") return fallback;
  const key = `${prefix}.${code}`;
  return has(key) ? t(key) : code;
}

const COLUMN_KEYS: Record<ColumnId, TranslationKey> = {
  backlog: "column.backlog",
  inbox: "column.inbox",
  ready: "column.ready",
  running: "column.running",
  blocked: "column.blocked",
  review: "column.review",
  done: "column.done",
};
/** The one display name of a kanban column. Column ids stay canonical. */
export function columnLabel(id: string): string {
  return Object.hasOwn(COLUMN_KEYS, id) ? t(COLUMN_KEYS[id as ColumnId]) : id;
}

export function yesNoLabel(value: boolean | null | undefined): string {
  if (value == null) return t("m0.unknown");
  return value ? t("m0.yes") : t("m0.no");
}
export function allowedLabel(value: boolean | null | undefined): string {
  if (value == null) return t("m0.unknown");
  return value ? t("m0.allowed") : t("m0.notAllowed");
}

/** `executionReady: false` -> "Running isn't available yet". Never claims readiness for a missing value. */
export function executionReadyText(ready: boolean | null | undefined): string {
  return ready === true ? t("m0.executionReady.true") : t("m0.executionReady.false");
}

/** Owner operation account id: the protocol uses the literal "unbound" when no account is confirmed. */
export function operationAccountText(accountId: string | null | undefined): string {
  if (accountId == null || accountId === "") return t("m0.account.unidentified");
  return accountId === "unbound" ? t("m0.account.unbound") : accountId;
}

/** `costCoverage` of an Owner operation. `unknown-subscription` is never shown as "no cost". */
export function costCoverageText(coverage: string | null | undefined): string {
  return mapped("m0.cost", coverage, t("m0.unknown"));
}

/** Data origin of a quota or account fact (`known | user-provided | observed | estimated | unknown`). */
export function quotaOriginText(origin: string | null | undefined): string {
  return mapped("m0.quotaOrigin", origin, t("m0.quotaOrigin.unknown"));
}

/** Resource availability fact value (`available | unavailable | null`). Missing stays "unknown", never "available". */
export function availabilityText(value: string | null | undefined): string {
  if (value == null) return t("m0.unknown");
  if (value === "available") return t("m0.available");
  if (value === "unavailable") return t("m0.unavailable");
  return value;
}

export function filesystemAccessText(value: string | null | undefined): string {
  return mapped("m0.fs", value, t("m0.unknown"));
}
export function enrollmentStateText(state: string | null | undefined): string {
  return mapped("m0.enrollment", state, t("m0.enrollment.none"));
}
export function priorityText(priority: string | null | undefined): string {
  return mapped("m0.priority", priority, t("m0.priority.normal"));
}

/** Plain-language sentence for an Owner-authorization / native-helper code. Unknown codes get the generic sentence. */
export function ownerCodeText(code: string | null | undefined): string {
  if (!code) return t("ownerCode.unknown");
  const key = `ownerCode.${code}`;
  return has(key) ? t(key) : t("ownerCode.unknown");
}

/** Plain one-line summary of the Owner-trust state (`ownerTrust.state.*` ids). */
export function ownerStateSummary(state: string): string {
  const key = `ownerPlain.${state}`;
  return has(key) ? t(key) : t("ownerCode.unknown");
}
/** States whose "what to do" is an engineering step. The Owner sees one plain sentence; the steps live in technical details. */
const BUILD_LEVEL_STATES = new Set([
  "development-or-qa",
  "unsigned-or-adhoc",
  "trusted-signature-missing",
  "helper-missing",
  "helper-identity-mismatch",
]);
export function isBuildLevelOwnerState(state: string): boolean {
  return BUILD_LEVEL_STATES.has(state);
}

/**
 * Generic code -> plain text for the handful of protocol codes named in the UX audit.
 * Returns null when the code has no plain-language mapping so callers can keep the raw value.
 */
export function plainStatusCode(code: string): string | null {
  switch (code) {
    case "executionReady:false": return t("m0.executionReady.false");
    case "unknown-subscription": return t("m0.cost.unknown-subscription");
    case "unbound": return t("m0.account.unbound");
    case "owner-se-key-storage-unavailable": return t("ownerCode.owner-se-key-storage-unavailable");
    default: {
      const key = `ownerCode.${code}`;
      return has(key) ? t(key) : null;
    }
  }
}

/** Mission plan phase (`mc.phase.*`). An unmapped phase keeps its raw code. */
export function missionPhaseText(phase: string | null | undefined): string {
  return mapped("mc.phase", phase, t("m0.unknown"));
}
/** Mission status (`mc.status.*`). An unmapped status keeps its raw code. */
export function missionStatusText(status: string | null | undefined): string {
  return mapped("mc.status", status, t("m0.unknown"));
}

/**
 * Plain name of a mission history event. The backend writes free-form event names
 * ("paused_authorization_mismatch", "recovery tick"); the name is normalized only to find a
 * label. An event with no label is shown as written, never dropped or renamed.
 */
export function missionEventText(event: string | null | undefined): string {
  if (!event) return t("m0.unknown");
  const key = `mcEvent.${event.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  return has(key) ? t(key) : event;
}
/** Condition of a cross-project dependency (`qc_pass | done | awaiting_owner`). */
export function dependencyConditionText(condition: string | null | undefined): string {
  return mapped("mcDep", condition, t("m0.unknown"));
}

/** Where a Brain memory came from. An origin with no label keeps its raw code; it is never shown as "Owner". */
export function brainOriginText(origin: string | null | undefined): string {
  if (origin == null || origin === "") return t("m0.unknown");
  if (origin === "owner") return t("brain.origin.owner");
  if (origin === "owner-approved-proposal") return t("brain.origin.proposal");
  if (origin === "automatic-extraction") return t("brain.origin.extracted");
  return origin;
}
/** Brain memory kind (`fact | decision | observation`). An unmapped kind keeps its raw code. */
export function brainKindText(kind: string | null | undefined): string {
  return mapped("brain.kind", kind, t("m0.unknown"));
}
