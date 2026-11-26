/**
 * FO-HEAD03 — factual initiative status answers from persisted records (no inferred AI progress).
 */

import { listHeadPmInitiatives } from "./head-pm-initiative.ts";
import type { HeadPmInitiativeView } from "../shared/head-pm-initiative.ts";

function findInitiative(message: string, items: HeadPmInitiativeView[]): HeadPmInitiativeView | null {
  const lower = message.toLowerCase();
  const active = items.filter((i) => i.status !== "cancelled");
  const byTitle = active.find((i) => lower.includes(i.title.toLowerCase()));
  if (byTitle) return byTitle;
  if (/(authentication|auth initiative|cross-project initiative)/i.test(message) && active.length === 1) return active[0]!;
  return null;
}

function blockedContributions(view: HeadPmInitiativeView): string[] {
  return view.contributions
    .filter((c) => c.progress === "needs_owner" || c.blockers.length > 0)
    .map((c) => `${c.projectName}: ${c.blockers[0] ?? c.progress}`);
}

function pendingPmPrep(view: HeadPmInitiativeView): string[] {
  return view.contributions
    .filter((c) => c.progress === "pending_delegation" || c.progress === "delegated" || c.progress === "preparing_tasks")
    .filter((c) => c.taskIds.length === 0 && !c.delegationId)
    .map((c) => c.projectName);
}

function ownerNeeds(view: HeadPmInitiativeView): string[] {
  const lines: string[] = view.blockers.filter(b => b.startsWith("Coordination:"));
  for (const c of view.contributions) {
    if (c.blockers.some((b) => b.includes("QC PASS"))) lines.push(`${c.projectName}: accept QC PASS in Review.`);
    if (c.blockers.some((b) => b.includes("Bounded batch"))) lines.push(`${c.projectName}: bounded batch needs attention.`);
    if (c.progress === "awaiting_delegation_approval") lines.push(`${c.projectName}: approve the prepared delegation.`);
    if (c.progress === "pending_delegation") lines.push(`${c.projectName}: prepare a delegation for the project manager.`);
  }
  if (view.status === "awaiting_delegation_approval") lines.push("Approve pending delegations before PMs can act.");
  return [...new Set(lines)];
}

function statusSummary(view: HeadPmInitiativeView): string {
  const parts = [
    `Initiative “${view.title}” — status ${view.status}.`,
    `${view.contributions.length} project contribution(s).`,
  ];
  for (const c of view.contributions) {
    parts.push(`${c.projectName}: ${c.progress}${c.pmName ? ` (PM ${c.pmName})` : ""}.`);
  }
  const blockers = blockedContributions(view);
  if (blockers.length > 0) parts.push(`Blockers: ${blockers.join("; ")}.`);
  return parts.join(" ");
}

/** Returns a factual reply when the owner asks about initiative progress; null → run the model. */
export function tryAnswerInitiativeStatusQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const statusCue = /(status|progress|blocked|complete|completed|need from me|what do you need|which project|which pm|prepared tasks|authentication initiative|initiative)/i;
  if (!statusCue.test(trimmed)) return null;

  const initiatives = listHeadPmInitiatives();
  if (initiatives.length === 0) {
    return "There are no cross-project initiatives on record yet. Describe a multi-project goal and I can propose one for your approval.";
  }

  const view = findInitiative(trimmed, initiatives);
  if (!view && initiatives.length > 1 && !/(all initiatives|every initiative)/i.test(trimmed)) {
    const names = initiatives.slice(0, 6).map((i) => `“${i.title}” (${i.status})`).join(", ");
    return `Which initiative do you mean? Active: ${names}.`;
  }
  const target = view ?? initiatives[0]!;

  if (/what do you need from me|need from me/i.test(trimmed)) {
    const needs = ownerNeeds(target);
    return needs.length > 0
      ? `For “${target.title}”: ${needs.join(" ")}`
      : `For “${target.title}” nothing is waiting on you right now. Current status: ${target.status}.`;
  }
  if (/which project is blocked|who is blocked|blocked project/i.test(trimmed)) {
    const blocked = blockedContributions(target);
    return blocked.length > 0
      ? `Blocked or needing you on “${target.title}”: ${blocked.join("; ")}.`
      : `No project contribution on “${target.title}” is marked blocked right now. Status: ${target.status}.`;
  }
  if (/which pm|project manager.*not|not prepared tasks/i.test(trimmed)) {
    const pending = pendingPmPrep(target);
    const noPm = target.contributions.filter((c) => !c.pmName).map((c) => c.projectName);
    const parts: string[] = [];
    if (noPm.length > 0) parts.push(`Projects without a PM identity: ${noPm.join(", ")}.`);
    if (pending.length > 0) parts.push(`Contributions still waiting for delegation/task prep: ${pending.join(", ")}.`);
    return parts.length > 0 ? parts.join(" ") : `Every contribution on “${target.title}” has a PM and an active delegation or tasks.`;
  }
  if (/all projects completed|everyone finished|all complete/i.test(trimmed)) {
    const done = target.contributions.every((c) => c.progress === "completed" || c.progress === "closed_by_owner");
    return done
      ? `Yes — every contribution on “${target.title}” is completed or closed by you.`
      : `Not yet — “${target.title}” is ${target.status}. ${statusSummary(target)}`;
  }
  if (/status|progress|authentication initiative/i.test(trimmed) || view) {
    return statusSummary(target);
  }
  if (lower.includes("initiative")) return statusSummary(target);
  return null;
}
