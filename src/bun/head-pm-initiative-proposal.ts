/**
 * FO-HEAD03 — persist and approve chat-driven initiative proposals.
 */

import { randomUUID } from "node:crypto";
import { headPmInitiativeProposals } from "./db.ts";
import { createHeadPmInitiativeFromProposal, getHeadPmInitiative } from "./head-pm-initiative.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { capText } from "../shared/project-interview.ts";
import { HEAD_PM_INITIATIVE_LIMITS } from "../shared/head-pm-initiative.ts";
import {
  sanitizeHeadPmInitiativeProposal,
  type HeadPmInitiativeProposal,
  type InitiativeProposalDraft,
  type InitiativeProposalStatus,
} from "../shared/head-pm-initiative-proposal.ts";

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function fail<T>(status: number, error: string): Result<T> {
  return { ok: false, status, error };
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadRaw(id: string): HeadPmInitiativeProposal | null {
  return sanitizeHeadPmInitiativeProposal(parseJson(headPmInitiativeProposals.get(id)));
}

function persist(proposal: HeadPmInitiativeProposal): HeadPmInitiativeProposal {
  headPmInitiativeProposals.put(proposal.id, proposal.messageId, proposal.status, JSON.stringify(proposal), proposal.createdAt);
  try {
    broadcastAppEvent({ type: "head_pm_initiative_proposal", proposalId: proposal.id, status: proposal.status, ts: Date.now() });
  } catch { /* best-effort */ }
  return proposal;
}

export function listHeadPmInitiativeProposals(): HeadPmInitiativeProposal[] {
  return headPmInitiativeProposals.list()
    .map((raw) => sanitizeHeadPmInitiativeProposal(parseJson(raw)))
    .filter((item): item is HeadPmInitiativeProposal => item != null);
}

export function getHeadPmInitiativeProposal(id: string): HeadPmInitiativeProposal | null {
  return loadRaw(id);
}

export function getHeadPmInitiativeProposalByMessage(messageId: string): HeadPmInitiativeProposal | null {
  return sanitizeHeadPmInitiativeProposal(parseJson(headPmInitiativeProposals.getByMessageId(messageId)));
}

/** Idempotent: one proposal per portfolio manager message. */
export function saveHeadPmInitiativeProposal(messageId: string, draft: InitiativeProposalDraft): HeadPmInitiativeProposal {
  const existing = getHeadPmInitiativeProposalByMessage(messageId);
  if (existing) return existing;
  const now = Date.now();
  const proposal: HeadPmInitiativeProposal = {
    id: randomUUID(),
    messageId,
    status: "proposed",
    title: draft.title,
    goal: draft.goal,
    description: draft.description,
    contributions: draft.contributions,
    initiativeId: null,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };
  return persist(proposal);
}

export function patchHeadPmInitiativeProposal(
  id: string,
  body: {
    title?: unknown;
    goal?: unknown;
    description?: unknown;
    contributions?: unknown;
  },
): Result<HeadPmInitiativeProposal> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative proposal not found.");
  if (raw.status !== "proposed") return fail(409, `This proposal was already ${raw.status}.`);
  const title = body.title !== undefined ? capText(String(body.title).trim(), HEAD_PM_INITIATIVE_LIMITS.titleChars) : raw.title;
  if (!title) return fail(400, "Title is required.");
  const goal = body.goal !== undefined ? capText(String(body.goal).trim(), HEAD_PM_INITIATIVE_LIMITS.goalChars) : raw.goal;
  const description = body.description !== undefined
    ? capText(String(body.description).trim(), HEAD_PM_INITIATIVE_LIMITS.descriptionChars)
    : raw.description;
  let contributions = raw.contributions;
  if (Array.isArray(body.contributions)) {
    contributions = [];
    for (const item of body.contributions) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.projectPath !== "string") continue;
      const base = raw.contributions.find((c) => c.projectPath === rec.projectPath);
      if (!base) continue;
      contributions.push({
        ...base,
        objective: typeof rec.objective === "string" ? capText(rec.objective.trim(), 300) : base.objective,
        request: typeof rec.request === "string" ? capText(rec.request.trim(), 4000) : base.request,
        reason: typeof rec.reason === "string" ? rec.reason : base.reason,
        contextSummary: typeof rec.contextSummary === "string" ? rec.contextSummary : base.contextSummary,
        expectedOutput: typeof rec.expectedOutput === "string" ? rec.expectedOutput : base.expectedOutput,
      });
    }
    if (contributions.length !== raw.contributions.length) return fail(400, "Contributions must keep the same projects.");
  }
  const next = { ...raw, title, goal, description, contributions, updatedAt: Date.now() };
  return { ok: true, value: persist(next) };
}

export function approveHeadPmInitiativeProposal(id: string): Result<{ proposal: HeadPmInitiativeProposal; initiativeId: string; alreadyCreated: boolean }> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative proposal not found.");
  if (raw.initiativeId) {
    return { ok: true, value: { proposal: raw, initiativeId: raw.initiativeId, alreadyCreated: true } };
  }
  if (raw.status === "rejected" || raw.status === "dismissed") {
    return fail(409, `This proposal was ${raw.status}.`);
  }
  const created = createHeadPmInitiativeFromProposal(raw);
  if (!created.ok) return created;
  const now = Date.now();
  const next: HeadPmInitiativeProposal = {
    ...raw,
    status: "approved",
    initiativeId: created.value.id,
    approvedAt: now,
    updatedAt: now,
  };
  persist(next);
  return { ok: true, value: { proposal: next, initiativeId: created.value.id, alreadyCreated: false } };
}

export function rejectHeadPmInitiativeProposal(id: string): Result<HeadPmInitiativeProposal> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative proposal not found.");
  if (raw.status === "approved") return fail(409, "An approved proposal cannot be rejected.");
  if (raw.status === "rejected" || raw.status === "dismissed") return { ok: true, value: raw };
  const next: HeadPmInitiativeProposal = { ...raw, status: "rejected", updatedAt: Date.now() };
  return { ok: true, value: persist(next) };
}

export function dismissHeadPmInitiativeProposal(id: string): Result<HeadPmInitiativeProposal> {
  const raw = loadRaw(id);
  if (!raw) return fail(404, "Initiative proposal not found.");
  if (raw.status === "approved") return fail(409, "An approved proposal cannot be dismissed.");
  if (raw.status === "dismissed") return { ok: true, value: raw };
  const next: HeadPmInitiativeProposal = { ...raw, status: "dismissed", updatedAt: Date.now() };
  return { ok: true, value: persist(next) };
}

export function initiativeForProposal(proposalId: string) {
  const proposal = loadRaw(proposalId);
  if (!proposal?.initiativeId) return null;
  return getHeadPmInitiative(proposal.initiativeId);
}

export function proposalStatusLabel(status: InitiativeProposalStatus): string {
  switch (status) {
    case "proposed": return "Waiting for your approval";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "dismissed": return "Dismissed";
  }
}
