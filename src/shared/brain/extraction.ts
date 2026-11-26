/**
 * Brain 2.0 Automatic Knowledge Extraction Types (FO-BRAIN04).
 */

import type { BrainKind, BrainScopeKind } from "./document.ts";

export const EXTRACTION_EVENT_KINDS = [
  "completed_task",
  "successful_run",
  "qc_review",
  "rework_resolved",
  "owner_decision",
  "head_decision",
  "milestone",
] as const;

export type ExtractionEventKind = (typeof EXTRACTION_EVENT_KINDS)[number];

export type CandidateStatus = "candidate" | "approved" | "rejected" | "archived";

export interface CandidateQualityAssessment {
  pass: boolean;
  issues: string[];
  duplicateType: "none" | "exact" | "near";
  duplicateMemoryId?: string | null;
  relationship: "new" | "near_duplicate" | "correction";
  supersedesMemoryId?: string | null;
  confidence: number;
}

export interface BrainExtractionCandidate {
  id: string;
  status: CandidateStatus;
  sourceEventKind: ExtractionEventKind;
  sourceEventId: string;
  sourceRecordIds: string[];
  scopeKind: BrainScopeKind;
  scopeId: string;
  title: string;
  kind: BrainKind;
  content: string;
  confidence: number;
  extractionMethod: "heuristic" | "model-assisted";
  quality: CandidateQualityAssessment;
  supersedesMemoryId: string | null;
  relatedMemoryIds: string[];
  memoryId: string | null;
  decisionReason: string | null;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
}

export interface CandidateListQuery {
  scopeKind?: BrainScopeKind;
  projectPath?: string;
  status?: CandidateStatus | "all";
  sourceEventKind?: ExtractionEventKind;
  limit?: number;
}

export interface CandidateDecisionInput {
  decision: "approve" | "reject";
  reason?: string;
  title?: string;
  kind?: BrainKind;
  content?: string;
}

export interface CandidateEditInput {
  title?: string;
  kind?: BrainKind;
  content?: string;
}
