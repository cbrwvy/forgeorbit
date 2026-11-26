/**
 * AI Project Team Builder & Hiring Proposals (FO-014C).
 *
 * Types for Project Manager team recommendations, hiring proposals,
 * append-only owner decision provenance, and local scenario runbooks.
 */

import { MAX_PROMPT_BYTES } from "../employees/profile-types.ts";

export const HIRING_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "stale",
] as const;
export type HiringProposalStatus = (typeof HIRING_PROPOSAL_STATUSES)[number];

export const HIRING_PROPOSAL_AUTHORS = ["owner", "project-manager"] as const;
export type HiringProposalAuthor = (typeof HIRING_PROPOSAL_AUTHORS)[number];

export const HIRING_PROPOSAL_ACTORS = ["owner", "project-manager", "system"] as const;
export type HiringProposalActor = (typeof HIRING_PROPOSAL_ACTORS)[number];

export const HIRING_PROPOSAL_ACTIONS = [
  "created",
  "approved",
  "rejected",
  "withdrawn",
  "stale",
  "updated",
] as const;
export type HiringProposalAction = (typeof HIRING_PROPOSAL_ACTIONS)[number];

export const HIRING_PROPOSAL_LIMITS = {
  name: 120,
  title: 120,
  slug: 120,
  justification: 2000,
  competencies: 20,
  competencyChars: 80,
  relatedTasks: 20,
  promptBytes: MAX_PROMPT_BYTES, // 512 KB (524,288 UTF-8 bytes) - unified contract with Employee Profile
  pendingPerProject: 50,
  perReply: 10,
  list: 200,
  history: 100,
  bodyBytes: 600 * 1024, // 600 KB - accommodates 512 KB prompt plus JSON structure
} as const;

export interface HiringProposalTemplateInfo {
  slug: string;
  name: string;
  description: string;
  division: string;
  color: string;
  emoji: string;
  vibe?: string;
  sourcePath: string;
  sourceCommit: string;
  sha256: string;
  sizeBytes: number;
  originalMarkdown?: string;
}

export interface HiringProposal {
  id: string;
  projectPath: string;
  projectName?: string | null;
  proposedName: string;
  kind: "worker";
  professionalTitle: string;
  catalogRoleSlug: string;
  templateSha256: string;
  promptMarkdown: string;
  justification: string;
  competencies: string[];
  relatedTasks: string[];
  proposedBy: {
    kind: HiringProposalAuthor;
    employeeId: string | null;
    employeeName?: string | null;
  };
  sourceMessageId: string | null;
  legacyNormalization?: {
    reason: string; normalizedAt: number;
    canonicalPendingId: string | null; canonicalMessageId: string | null;
    originalProposal: Record<string, unknown>; originalEvents: unknown[];
  };
  status: HiringProposalStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decidedFromRevision: number | null;
  decisionNote: string | null;
  staleReason: string | null;
  createdEmployeeId: string | null;
  template?: HiringProposalTemplateInfo | null;
  duplicateWarning?: string | null;
}

export interface HiringProposalEvent {
  id: number;
  proposalId: string;
  projectPath: string;
  action: HiringProposalAction;
  actor: HiringProposalActor;
  proposalRevision: number;
  createdEmployeeId: string | null;
  note: string | null;
  createdAt: number;
}

export interface HiringProposalProjectSummary {
  projectPath: string;
  projectName: string;
  pending: number;
  latestAt: number | null;
}

export interface HiringProposalSummary {
  pendingTotal: number;
  projects: HiringProposalProjectSummary[];
}

export interface ApproveHiringProposalRequest {
  expectedRevision: number;
  proposedName?: string;
  professionalTitle?: string;
  promptMarkdown?: string;
  changeNote?: string;
}

export interface UpdateHiringProposalRequest {
  expectedRevision: number;
  proposedName?: string;
  professionalTitle?: string;
  promptMarkdown?: string;
  justification?: string;
  competencies?: string[];
  relatedTasks?: string[];
  changeNote?: string;
}

export interface RejectHiringProposalRequest {
  expectedRevision: number;
  note?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Runbooks
 * ────────────────────────────────────────────────────────────────────────── */

export interface RunbookRosterAgentSummary {
  slug: string;
  name: string;
  division: string;
  color: string;
  emoji: string;
  vibe?: string;
  description: string;
}

export interface RunbookRosterGroup {
  group: string;
  activation: string;
  agents: string[];
}

export interface RunbookSummary {
  slug: string;
  title: string;
  mode: string;
  duration: string;
  summary: string;
  doc: string;
  totalAgents: number;
  groups: {
    group: string;
    activation: string;
    count: number;
  }[];
}

export interface RunbookDetail extends RunbookSummary {
  roster: {
    group: string;
    activation: string;
    agents: RunbookRosterAgentSummary[];
  }[];
}
