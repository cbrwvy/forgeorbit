/**
 * Brain 2.0 Local Semantic Search & Vector Embedding Types (FO-BRAIN04).
 */

import type { BrainKind, BrainScopeKind, BrainStatusValue } from "./document.ts";

export type SearchMode = "hybrid" | "semantic" | "lexical";

export interface SemanticSearchQuery {
  scopeKind: BrainScopeKind;
  projectPath?: string;
  inheritCompany?: boolean;
  text: string;
  mode?: SearchMode;
  status?: BrainStatusValue;
  limit?: number;
  minSimilarity?: number;
}

export interface SemanticSearchResult {
  id: string;
  title: string;
  kind: BrainKind;
  status: BrainStatusValue;
  scopeKind: BrainScopeKind;
  scopeId: string;
  revision: number;
  snippet: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  provenanceSource: string;
  updatedAt: number;
}

export interface RelatedMemoryItem {
  id: string;
  title: string;
  kind: BrainKind;
  similarity: number;
  scopeKind: BrainScopeKind;
  scopeId: string;
}

export interface EmbeddingEngineStatus {
  enabled: boolean;
  engine: "transformers-local" | "native-apple" | "lexical-fallback" | "test-mock";
  model: string;
  dimension: number;
  indexedCount: number;
  activeCount: number;
  coveragePercent: number;
  lastRebuiltAt: number | null;
}
