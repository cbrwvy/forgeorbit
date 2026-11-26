/**
 * Plain-language wording for "Work independently". Pure: no React, no network. A canonical code or enum is never shown
 * raw on an everyday screen; the exact value goes in technical details. An unmapped value falls back to itself and is
 * never turned into a nicer-sounding state.
 */
import { t as tr } from "@/i18n/core";
import type { HandsoffBlocker, HandsoffEventKind, HandsoffRun, HandsoffStatus, HandsoffTestState } from "../../shared/handsoff.ts";
import type { Task } from "../../shared/types.ts";
import type { HandsoffAuthorizationState } from "../../shared/handsoff-authorization.ts";

type Key = Parameters<typeof tr>[0];
const key = (value: string) => value as Key;

export type HandsoffTone = "info" | "warning" | "success" | "muted" | "danger";

/** The one headline for a run: where it is, or what happened. */
export function handsoffHeadline(run: Pick<HandsoffRun, "stage" | "status" | "round"> & { state?: Pick<HandsoffRun["state"], "waitKind"> }): { text: string; tone: HandsoffTone } {
  const status = run.status;
  if (status === "active") return { text: tr(key(`handsoff.stage.${run.stage}`)), tone: "info" };
  if (status === "waiting" && run.state?.waitKind === "scheduled") {
    return { text: tr(key("kanban.schedule.waiting")), tone: "muted" };
  }
  const tone: Record<Exclude<HandsoffStatus, "active">, HandsoffTone> = {
    waiting: "muted", "needs-owner": "warning", stopped: "muted", done: "success",
    "ready-to-apply": "info", "awaiting-accept": "info", failed: "danger", cancelled: "muted",
  };
  return { text: tr(key(`handsoff.status.${status}`)), tone: tone[status] };
}

/** True only while the Owner has something to do. Work in progress, a free slot or a known reset is not that. */
export function handsoffNeedsYou(run: Pick<HandsoffRun, "status"> | null | undefined): boolean {
  return run?.status === "needs-owner";
}

export function blockerText(blocker: Pick<HandsoffBlocker, "code" | "message">): string {
  const mapped = tr(key(`handsoff.blocker.${blocker.code}`));
  return mapped && mapped !== `handsoff.blocker.${blocker.code}` ? mapped : blocker.message;
}

export function eventText(kind: HandsoffEventKind | string): string {
  const mapped = tr(key(`handsoff.event.${kind}`));
  return mapped && mapped !== `handsoff.event.${kind}` ? mapped : String(kind);
}

export function testText(state: HandsoffTestState): string {
  return tr(key(`handsoff.test.${state}`));
}

export function verdictText(verdict: string | null): string {
  return tr(key(verdict ? `handsoff.verdict.${verdict}` : "handsoff.verdict.none"));
}

export function changeKindText(kind: string): string {
  const mapped = tr(key(`handsoff.change.${kind}`));
  return mapped && mapped !== `handsoff.change.${kind}` ? mapped : kind;
}

/** A task can be submitted when its project turned the policy on and the task is waiting to be worked on. */
export function canSubmitForWork(task: Pick<Task, "column" | "archivedAt" | "pipelineId" | "pipelineParentId">, policyEnabled: boolean, run: Pick<HandsoffRun, "finishedAt"> | null): boolean {
  if (!policyEnabled || task.archivedAt != null || task.pipelineId || task.pipelineParentId) return false;
  if (task.column !== "ready" && task.column !== "backlog") return false;
  return !run || run.finishedAt != null;
}

/** States in which the Owner can act on the project authorization (authorize, renew). `active` and `off` have nothing to do. */
export function authorizationNeedsAction(state: HandsoffAuthorizationState): boolean {
  return state === "not-authorized" || state === "needs-renewal" || state === "expired" || state === "exhausted" || state === "revoked";
}

export function authorizationTone(state: HandsoffAuthorizationState): HandsoffTone {
  if (state === "active") return "success";
  if (state === "needs-renewal" || state === "expired" || state === "exhausted") return "warning";
  if (state === "not-authorized" || state === "revoked") return "warning";
  return "muted";
}

/** "more accounts, applying the result to the project folder": the fields that widened, in plain words. */
export function renewalReasonsText(reasons: readonly string[]): string {
  return reasons.map((reason) => {
    const mapped = tr(key(`handsoff.auth.renew_reason.${reason}`));
    return mapped && mapped !== `handsoff.auth.renew_reason.${reason}` ? mapped : reason;
  }).join(", ");
}
