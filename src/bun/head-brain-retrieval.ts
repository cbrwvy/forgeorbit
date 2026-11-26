/**
 * Brain 2.0 Head of PM Retrieval & Scoped Context Integration (FO-BRAIN04).
 *
 * Provides bounded, relevant memory retrieval for the unified Head of PM dock
 * across workspace, cluster, project, and task scopes with semantic ranking,
 * source record citations, relevance explanations, and strict project isolation.
 */

import type { HeadScopeSnapshot } from "../shared/head-pm-scope.ts";
import type { BrainStore } from "./brain-store.ts";
import type { SemanticSearchResult } from "../shared/brain/embeddings.ts";
import { snippetOf, type BrainKind, type BrainOrigin, type BrainScope, type BrainScopeKind } from "../shared/brain/document.ts";
import { db } from "./db.ts";

export interface HeadBrainPromptMemory {
  id: string;
  revision: number;
  title: string;
  kind: BrainKind;
  scope: BrainScope;
  origin: BrainOrigin;
  content: string;
  snippet: string;
  contentSha256: string;
}

export interface HeadBrainMemoryHit {
  memory: HeadBrainPromptMemory;
  relevanceScore: number;
  semanticScore: number;
  lexicalScore: number;
  relevanceReason: string;
  sourceAttribution: {
    source: string;
    sourceRecordIds: string[];
    sourceEventKind?: string;
  };
}

export interface HeadBrainQueryResult {
  scopeLabel: string;
  hits: HeadBrainMemoryHit[];
  totalFound: number;
  renderedSummary: string;
}

export const HEAD_BRAIN_LIMITS = {
  defaultMaxMemories: 4,
  maxChars: 2500,
} as const;

export async function queryHeadBrainMemories(
  headScope: HeadScopeSnapshot,
  queryText: string,
  store: BrainStore,
  options: { maxMemories?: number; maxChars?: number } = {},
): Promise<HeadBrainQueryResult> {
  const maxMemories = options.maxMemories ?? HEAD_BRAIN_LIMITS.defaultMaxMemories;
  const maxChars = options.maxChars ?? HEAD_BRAIN_LIMITS.maxChars;

  // Determine authorized scopes
  const authorizedProjectPaths: string[] = [];
  let allowCompany = true;

  if (headScope.projectPath) {
    authorizedProjectPaths.push(headScope.projectPath);
  } else if (headScope.clusterId) {
    const members = db.query<{ project_path: string }, [string]>(
      "SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ?",
    ).all(headScope.clusterId);
    for (const m of members) authorizedProjectPaths.push(m.project_path);
  }

  const allHits: SemanticSearchResult[] = [];

  // 1. Search company memories
  if (allowCompany) {
    const compHits = await store.searchSemantic({
      scopeKind: "company",
      text: queryText,
      mode: "hybrid",
      status: "active",
      limit: maxMemories * 2,
    });
    allHits.push(...compHits);
  }

  // 2. Search authorized project memories
  for (const path of authorizedProjectPaths) {
    const projHits = await store.searchSemantic({
      scopeKind: "project",
      projectPath: path,
      inheritCompany: false, // already searched above
      text: queryText,
      mode: "hybrid",
      status: "active",
      limit: maxMemories * 2,
    });
    allHits.push(...projHits);
  }

  // Deduplicate and rank by combined score
  allHits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  const seenIds = new Set<string>();
  const topHits: SemanticSearchResult[] = [];
  for (const hit of allHits) {
    if (!seenIds.has(hit.id)) {
      seenIds.add(hit.id);
      topHits.push(hit);
    }
  }

  const results: HeadBrainMemoryHit[] = [];
  let accumulatedChars = 0;

  for (const hit of topHits) {
    if (results.length >= maxMemories) break;

    const memory = store.read(hit.id);
    if (!memory || memory.status !== "active") continue;

    // Strict scope boundary validation
    if (memory.scope.kind === "project" && !authorizedProjectPaths.includes(memory.scope.id)) {
      continue;
    }

    const itemChars = memory.content.length + memory.title.length + 60;
    if (accumulatedChars + itemChars > maxChars && results.length > 0) {
      break;
    }
    accumulatedChars += itemChars;

    let sourceRecordIds: string[] = [];
    let sourceEventKind: string | undefined;

    if (memory.provenance.source === "automatic-extraction") {
      sourceRecordIds = memory.provenance.sourceRecordIds;
      sourceEventKind = memory.provenance.sourceEventKind;
    } else if (memory.provenance.source === "owner-approved-proposal") {
      sourceRecordIds = [memory.provenance.proposalId];
    }

    const reason = `Relevant to scope "${headScope.label}" (score: ${hit.score}; semantic: ${hit.semanticScore}, lexical: ${hit.lexicalScore}).`;

    results.push({
      memory: {
        id: memory.id,
        revision: memory.revision,
        title: memory.title,
        kind: memory.kind,
        scope: memory.scope,
        origin: memory.origin,
        content: memory.content,
        snippet: snippetOf(memory.content),
        contentSha256: memory.contentSha256,
      },
      relevanceScore: hit.score,
      semanticScore: hit.semanticScore,
      lexicalScore: hit.lexicalScore,
      relevanceReason: reason,
      sourceAttribution: {
        source: memory.origin,
        sourceRecordIds,
        sourceEventKind,
      },
    });
  }

  // Format concise summary
  const summaryLines: string[] = [];
  if (results.length > 0) {
    summaryLines.push(`Retrieved ${results.length} relevant historical memory record(s) for ${headScope.label}:`);
    for (const h of results) {
      const cite = h.sourceAttribution.sourceRecordIds.length > 0
        ? ` [source: ${h.sourceAttribution.sourceRecordIds.join(", ")}]`
        : "";
      summaryLines.push(`• [${h.memory.kind}] "${h.memory.title}" (rev: ${h.memory.revision})${cite} — ${h.relevanceReason}`);
    }
  }

  return {
    scopeLabel: headScope.label,
    hits: results,
    totalFound: results.length,
    renderedSummary: summaryLines.join("\n"),
  };
}
