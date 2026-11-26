/**
 * Brain 2.0 Candidate Quality & Deduplication Pipeline (FO-BRAIN04).
 *
 * Enforces quality standards, credential exclusion, exact/near deduplication,
 * correction vs new fact classification, stale information protection, and
 * strict project/cluster isolation.
 */

import { Database } from "bun:sqlite";
import { containsCredentialMaterial, snippetOf } from "../shared/brain/document.ts";
import type { CandidateQualityAssessment } from "../shared/brain/extraction.ts";
import { cosineSimilarity, readEmbedding } from "./brain-embeddings.ts";

export interface QualityCandidateInput {
  title: string;
  content: string;
  scopeKind: "company" | "project";
  scopeId: string;
  sourceTimestamps: { eventAt: number; extractedAt: number };
  candidateEmbedding?: number[];
}

const LOW_INFO_PHRASES = [
  "done",
  "wip",
  "todo",
  "fixed issue",
  "task completed",
  "fixed",
  "test",
  "n/a",
  "none",
  "ok",
  "see log",
  "as discussed",
  "no error",
  "success",
];

export function isLowInformation(title: string, content: string): { lowInfo: boolean; reason?: string } {
  const cleanTitle = title.trim();
  const cleanContent = content.trim();

  if (cleanTitle.length < 3) {
    return { lowInfo: true, reason: "Title is too short (< 3 characters)" };
  }
  if (cleanContent.length < 10) {
    return { lowInfo: true, reason: "Content is too short (< 10 characters)" };
  }

  const words = cleanContent.split(/\s+/).filter(Boolean);
  if (words.length < 3) {
    return { lowInfo: true, reason: "Content lacks sufficient descriptive words (< 3 words)" };
  }

  const normalizedLower = cleanContent.toLowerCase().replace(/[^a-z0-9а-яё]/gi, " ").trim();
  for (const phrase of LOW_INFO_PHRASES) {
    if (normalizedLower === phrase) {
      return { lowInfo: true, reason: `Content is a generic placeholder phrase: "${phrase}"` };
    }
  }

  return { lowInfo: false };
}

interface ExistingMemoryRecord {
  id: string;
  title: string;
  body: string;
  content_sha256: string;
  revision: number;
  updated_at: number;
}

export function evaluateCandidateQuality(
  db: Database,
  candidate: QualityCandidateInput,
): CandidateQualityAssessment {
  const issues: string[] = [];

  // 1. Low-information check
  const lowInfo = isLowInformation(candidate.title, candidate.content);
  if (lowInfo.lowInfo) {
    issues.push(lowInfo.reason ?? "Low information");
  }

  // 2. Secret & Credential check
  if (containsCredentialMaterial(`${candidate.title}\n${candidate.content}`)) {
    issues.push("Credential or private authentication material detected");
  }

  // If already failed fundamental checks, return early
  if (issues.length > 0) {
    return {
      pass: false,
      issues,
      duplicateType: "none",
      relationship: "new",
      confidence: 0,
    };
  }

  // Fetch active committed memories strictly in the same scope (project isolation)
  let existingMemories: ExistingMemoryRecord[] = [];
  if (db) {
    try {
      existingMemories = db.query<ExistingMemoryRecord, [string, string]>(`
        SELECT id, title, body, content_sha256, revision, updated_at
        FROM brain_memories
        WHERE scope_kind = ? AND scope_id = ? AND status = 'active' AND durability = 'committed'
      `).all(candidate.scopeKind, candidate.scopeId);
    } catch {
      existingMemories = [];
    }
  }

  // Exact duplicate check
  const normTitle = candidate.title.trim().toLowerCase();
  const normContent = candidate.content.trim().toLowerCase();

  for (const mem of existingMemories) {
    const memTitle = mem.title.trim().toLowerCase();
    const memContent = mem.body.trim().toLowerCase();

    if (normTitle === memTitle && normContent === memContent) {
      return {
        pass: true,
        issues: ["Exact duplicate memory already exists in this scope"],
        duplicateType: "exact",
        duplicateMemoryId: mem.id,
        relationship: "near_duplicate",
        confidence: 0.95,
      };
    }
  }

  // Near-duplicate and correction evaluation using embeddings (if candidate vector supplied)
  let bestSim = 0;
  let bestMatch: ExistingMemoryRecord | null = null;

  if (candidate.candidateEmbedding && candidate.candidateEmbedding.length > 0) {
    for (const mem of existingMemories) {
      const memVec = readEmbedding(db, mem.id, mem.revision);
      if (memVec) {
        const sim = cosineSimilarity(candidate.candidateEmbedding, memVec);
        if (sim > bestSim) {
          bestSim = sim;
          bestMatch = mem;
        }
      }
    }
  }

  // Very high semantic similarity (>= 0.88) -> near duplicate
  if (bestSim >= 0.88 && bestMatch) {
    return {
      pass: true,
      issues: [`Near duplicate of existing memory ${bestMatch.id} (similarity: ${Math.round(bestSim * 100)}%)`],
      duplicateType: "near",
      duplicateMemoryId: bestMatch.id,
      relationship: "near_duplicate",
      confidence: Math.round(bestSim * 100) / 100,
    };
  }

  // Correction vs New Fact classification
  // If similarity is moderate-to-high (>= 0.65) or titles share core subject
  const isCorrectionTitle = /\b(update|fix|corrected|replacement|supersede|change|revised|обновлен|исправлен)/i.test(candidate.title);

  if (bestMatch && (bestSim >= 0.65 || isCorrectionTitle)) {
    // Check stale information: candidate must not be older than existing memory
    if (candidate.sourceTimestamps.eventAt < bestMatch.updated_at) {
      return {
        pass: false,
        issues: [`Stale override rejected: candidate event is older than existing memory ${bestMatch.id}`],
        duplicateType: "none",
        relationship: "correction",
        supersedesMemoryId: bestMatch.id,
        confidence: 0.3,
      };
    }

    return {
      pass: true,
      issues: [],
      duplicateType: "none",
      relationship: "correction",
      supersedesMemoryId: bestMatch.id,
      confidence: Math.round(Math.max(0.75, bestSim) * 100) / 100,
    };
  }

  return {
    pass: true,
    issues: [],
    duplicateType: "none",
    relationship: "new",
    confidence: 0.9,
  };
}
