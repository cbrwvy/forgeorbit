import type { RunTermination, TerminationState } from "../../shared/run-termination.ts";
import { terminationState } from "../../shared/run-termination.ts";
import type { TranslationKey } from "@/i18n/core";

export type TerminationRole = "developer" | "reviewer";

export interface TerminationNotice {
  state: TerminationState;
  tone: "info" | "success" | "warning";
  headline: { key: TranslationKey; params: Record<string, string> };
  next: TranslationKey | null;
}

/** What to tell the Owner about one run's stop or time limit. Pure; null when nothing applies. */
export function terminationNotice(termination: RunTermination | null | undefined, runStatus: string, role: TerminationRole): TerminationNotice | null {
  const state = terminationState(termination, runStatus);
  if (!state || !termination) return null;
  const reason = termination.reason === "time-limit" ? "time-limit" : "manual";
  const params = { seconds: String(termination.limitSeconds ?? ""), pid: String(termination.processId ?? "") };
  const settledNext: TranslationKey = role === "reviewer" ? "stop.next.reviewer" : "stop.next.developer";
  switch (state) {
    case "armed":
      return { state, tone: "info", headline: { key: "stop.state.armed", params }, next: null };
    case "stopping":
      return { state, tone: "info", headline: { key: `stop.state.stopping.${reason}`, params }, next: null };
    case "exited":
      return { state, tone: "success", headline: { key: `stop.state.exited.${reason}`, params }, next: runStatus === "running" ? null : settledNext };
    case "unconfirmed":
      return { state, tone: "warning", headline: { key: `stop.state.unconfirmed.${reason}`, params }, next: "stop.next.unconfirmed" };
    case "not-reported":
      return { state, tone: "warning", headline: { key: `stop.state.not-reported.${reason}`, params }, next: runStatus === "running" ? null : settledNext };
    case "not-launched":
      return { state, tone: "info", headline: { key: "stop.state.not-launched", params }, next: settledNext };
    case "recovered-gone":
      return { state, tone: "info", headline: { key: "stop.state.recovered-gone", params }, next: settledNext };
    case "recovered-alive":
      return { state, tone: "warning", headline: { key: "stop.state.recovered-alive", params }, next: "stop.next.recovered" };
    case "recovered-unknown":
      return { state, tone: "warning", headline: { key: "stop.state.recovered-unknown", params }, next: "stop.next.recovered" };
  }
}

/** The one-line toast for a Stop click. */
export function stopToast(result: { cancelled: boolean; termination: RunTermination | null }, runStatus = "running"): { key: TranslationKey; tone: "success" | "warning" | "info" } {
  if (!result.cancelled) return { key: "stop.toast.nothing", tone: "info" };
  const state = terminationState(result.termination, runStatus);
  if (state === "unconfirmed") return { key: "stop.toast.unconfirmed", tone: "warning" };
  if (state === "not-reported") return { key: "stop.toast.not-reported", tone: "warning" };
  return { key: "stop.toast.exited", tone: "success" };
}
