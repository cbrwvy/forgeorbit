/**
 * Brain 2.0 Local Semantic Retrieval & Vector Embeddings (FO-BRAIN04).
 *
 * Real local semantic layer powered by a lightweight multilingual ONNX model
 * (Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384 dimensions, Apache 2.0)
 * executing locally on Apple Silicon / macOS via @xenova/transformers.
 * The model is resolved from the app bundle, then a profile or developer cache.
 * If that model cannot run, search stays lexical and the status says so.
 * Apple NLEmbedding is not used: its vectors are a different width and would
 * be reported as this multilingual model.
 *
 * Embeddings are persisted in SQLite (index.sqlite) alongside memory records
 * and frozen to exact memory IDs and revisions.
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import type {
  EmbeddingEngineStatus,
  RelatedMemoryItem,
  SearchMode,
  SemanticSearchQuery,
  SemanticSearchResult,
} from "../shared/brain/embeddings.ts";
import type { BrainMemory, BrainScopeKind, BrainStatusValue } from "../shared/brain/document.ts";
import { brainCompanyScope, snippetOf } from "../shared/brain/document.ts";
import type { BrainLayout } from "./brain-files.ts";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIMENSION = 384;
const MODEL_REL = path.join("Xenova", "paraphrase-multilingual-MiniLM-L12-v2");

/** A cache root is usable only when the quantized multilingual model is present. */
export function embeddingCacheReady(root: string): boolean {
  return fs.existsSync(path.join(root, MODEL_REL, "onnx", "model_quantized.onnx"))
    && fs.existsSync(path.join(root, MODEL_REL, "tokenizer.json"));
}

/**
 * App-owned locations come first. An explicit `FORGEORBIT_EMBEDDING_MODEL_ROOT`
 * does not fall through to another cache: a missing pin means the model is absent.
 */
export function resolveEmbeddingModelRoot(input?: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  cwd?: string;
}): string | null {
  const env = input?.env ?? process.env;
  const execPath = input?.execPath ?? process.execPath;
  const cwd = input?.cwd ?? process.cwd();
  const pinned = env.FORGEORBIT_EMBEDDING_MODEL_ROOT;
  if (pinned) return embeddingCacheReady(pinned) ? pinned : null;
  const data = env.FORGEORBIT_DATA_DIR || env.AGETOR_DATA_DIR || "";
  const candidates = [
    path.join(path.dirname(execPath), "..", "Resources", "app", "models"),
    data ? path.join(data, "models") : "",
    path.join(cwd, "node_modules", "@xenova", "transformers", ".cache"),
    path.join(env.HOME ?? "", ".cache", "forgeorbit-models"),
    path.join(env.HOME ?? "", ".cache", "xenova"),
  ].filter((item) => item.length > 0);
  for (const candidate of candidates) {
    if (embeddingCacheReady(candidate)) return candidate;
  }
  return null;
}

export const BRAIN_EMBEDDINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brain_embeddings (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  model TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, revision),
  FOREIGN KEY (memory_id) REFERENCES brain_memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_brain_embeddings_lookup
  ON brain_embeddings(memory_id, revision);
`;

export function ensureEmbeddingsSchema(db: Database): void {
  db.run(BRAIN_EMBEDDINGS_SCHEMA_SQL);
}

export function dotProduct(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai !== undefined && bi !== undefined) {
      sum += ai * bi;
    }
  }
  return sum;
}

export function normL2(a: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai !== undefined) {
      sum += ai * ai;
    }
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const normA = normL2(a);
  const normB = normL2(b);
  if (normA === 0 || normB === 0) return 0;
  return dotProduct(a, b) / (normA * normB);
}

type ExtractorFn = (text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>;

let extractorInstance: ExtractorFn | null = null;
let extractorLoading: Promise<ExtractorFn | null> | null = null;
let loadFailed = false;
let forceLexical = false;
let lastRebuiltTimestamp: number | null = null;
let testMockVectorGenerator: ((text: string) => number[]) | null = null;

export function setTestMockEmbeddingGenerator(fn: ((text: string) => number[]) | null): void {
  testMockVectorGenerator = fn;
}

/** Test seam. Does not change which files the packaged app searches. */
export function setForceLexicalEmbeddingsForTest(on: boolean): void {
  forceLexical = on;
}

export function reportedEmbeddingEngine(): EmbeddingEngineStatus["engine"] {
  if (testMockVectorGenerator) return "test-mock";
  if (forceLexical || loadFailed) return "lexical-fallback";
  if (extractorInstance || resolveEmbeddingModelRoot()) return "transformers-local";
  return "lexical-fallback";
}

async function getExtractor(): Promise<ExtractorFn | null> {
  if (testMockVectorGenerator || forceLexical) return null;
  if (extractorInstance) return extractorInstance;
  if (extractorLoading) return extractorLoading;

  extractorLoading = (async () => {
    try {
      const root = resolveEmbeddingModelRoot();
      if (!root) throw new Error("local multilingual embedding model is not installed");
      const { pipeline, env } = await import("@xenova/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = root;

      const extractor = (await pipeline("feature-extraction", DEFAULT_EMBEDDING_MODEL, {
        quantized: true,
      })) as unknown as ExtractorFn;

      extractorInstance = extractor;
      loadFailed = false;
      return extractor;
    } catch (err) {
      console.warn("[Brain Embeddings] Local transformers unavailable:", (err as Error).message);
      loadFailed = true;
      return null;
    }
  })();

  return extractorLoading;
}

export async function generateEmbedding(text: string): Promise<{ vector: number[]; dimension: number; model: string } | null> {
  const cleanText = text.trim();
  if (cleanText.length === 0) return null;

  if (testMockVectorGenerator) {
    const vec = testMockVectorGenerator(cleanText);
    return { vector: vec, dimension: vec.length, model: "test-mock-driver" };
  }

  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const output = await extractor(cleanText, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data);
    if (vector.length !== EMBEDDING_DIMENSION) return null;
    return {
      vector,
      dimension: vector.length,
      model: DEFAULT_EMBEDDING_MODEL,
    };
  } catch (err) {
    console.warn("[Brain Embeddings] Inference error:", (err as Error).message);
    return null;
  }
}

export async function storeEmbedding(
  db: Database,
  memoryId: string,
  revision: number,
  contentSha256: string,
  title: string,
  content: string,
): Promise<boolean> {
  try {
    ensureEmbeddingsSchema(db);
    const textToEmbed = `${title}\n${content}`.trim();
    const embedded = await generateEmbedding(textToEmbed);
    if (!embedded) return false;
    if (embedded.model !== "test-mock-driver" && embedded.dimension !== EMBEDDING_DIMENSION) return false;

    const now = Date.now();
    db.run(
      `INSERT INTO brain_embeddings (memory_id, revision, content_sha256, dimension, model, vector_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, revision) DO UPDATE SET
         content_sha256 = excluded.content_sha256,
         dimension = excluded.dimension,
         model = excluded.model,
         vector_json = excluded.vector_json,
         created_at = excluded.created_at`,
      [memoryId, revision, contentSha256, embedded.dimension, embedded.model, JSON.stringify(embedded.vector), now],
    );
    return true;
  } catch {
    return false;
  }
}

export function readEmbedding(db: Database, memoryId: string, revision: number): number[] | null {
  ensureEmbeddingsSchema(db);
  const row = db.query<{ vector_json: string }, [string, number]>(
    "SELECT vector_json FROM brain_embeddings WHERE memory_id = ? AND revision = ?",
  ).get(memoryId, revision);
  if (!row) return null;
  try {
    return JSON.parse(row.vector_json) as number[];
  } catch {
    return null;
  }
}

interface MemorySearchRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  title: string;
  kind: string;
  status: string;
  origin: string;
  provenance_json: string;
  revision: number;
  content_sha256: string;
  body: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  vector_json: string | null;
}

function calculateLexicalScore(needle: string, title: string, body: string): number {
  if (!needle) return 0;
  const q = needle.toLowerCase();
  const t = title.toLowerCase();
  const b = body.toLowerCase();

  let score = 0;
  if (t === q) score += 1.0;
  else if (t.includes(q)) score += 0.7;

  if (b.includes(q)) score += 0.4;

  const words = q.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 0) {
    let matchedWords = 0;
    for (const w of words) {
      if (t.includes(w) || b.includes(w)) matchedWords++;
    }
    score += (matchedWords / words.length) * 0.3;
  }

  return Math.min(1.0, score);
}

export async function searchMemories(
  db: Database,
  query: SemanticSearchQuery,
): Promise<{ results: SemanticSearchResult[]; mode: SearchMode; total: number }> {
  ensureEmbeddingsSchema(db);
  const mode: SearchMode = query.mode ?? "hybrid";
  const status: BrainStatusValue = query.status ?? "active";
  const limit = Math.min(50, Math.max(1, query.limit ?? 20));
  const minSimilarity = query.minSimilarity ?? 0.15;

  let queryVector: number[] | null = null;
  if (mode !== "lexical" && query.text.trim().length > 0) {
    const embedded = await generateEmbedding(query.text);
    if (embedded) queryVector = embedded.vector;
  }
  // A semantic request with no vector is not answered by lexical overlap.
  if (mode === "semantic" && !queryVector) {
    return { results: [], mode: "lexical", total: 0 };
  }

  const companyScope = brainCompanyScope();
  const inherit = query.inheritCompany && query.scopeKind === "project";
  const scopeId = query.scopeKind === "company" ? companyScope.id : (query.projectPath ?? "");

  const rows = db.query<MemorySearchRow, [string, string, string, number, string]>(`
    SELECT m.*, e.vector_json
    FROM brain_memories m
    LEFT JOIN brain_embeddings e
      ON e.memory_id = m.id AND e.revision = m.revision
    WHERE m.durability = 'committed' AND m.status = ?
      AND (
        (m.scope_kind = ? AND m.scope_id = ?)
        OR (? = 1 AND m.scope_kind = 'company' AND m.scope_id = ?)
      )
    ORDER BY m.updated_at DESC
  `).all(status, query.scopeKind, scopeId, inherit ? 1 : 0, companyScope.id);

  const scoredResults: SemanticSearchResult[] = [];

  for (const row of rows) {
    if (!row.vector_json && queryVector) {
      await storeEmbedding(db, row.id, row.revision, row.content_sha256, row.title, row.body);
      const reRead = readEmbedding(db, row.id, row.revision);
      if (reRead) {
        row.vector_json = JSON.stringify(reRead);
      }
    }

    let semanticScore = 0;
    if (queryVector && row.vector_json) {
      try {
        const memVector = JSON.parse(row.vector_json) as number[];
        semanticScore = Math.max(0, cosineSimilarity(queryVector, memVector));
      } catch {
        semanticScore = 0;
      }
    }

    const lexicalScore = calculateLexicalScore(query.text, row.title, row.body);

    let finalScore = 0;
    if (mode === "semantic") {
      finalScore = queryVector ? semanticScore : lexicalScore;
    } else if (mode === "lexical") {
      finalScore = lexicalScore;
    } else {
      // Hybrid
      if (queryVector) {
        finalScore = 0.65 * semanticScore + 0.35 * lexicalScore;
      } else {
        finalScore = lexicalScore;
      }
    }

    if (query.text.trim().length > 0 && finalScore < minSimilarity && lexicalScore === 0) {
      continue;
    }

    let provSource = "owner";
    try {
      const p = JSON.parse(row.provenance_json);
      provSource = p.source ?? "owner";
    } catch {
      // default
    }

    scoredResults.push({
      id: row.id,
      title: row.title,
      kind: row.kind as any,
      status: row.status as any,
      scopeKind: row.scope_kind as any,
      scopeId: row.scope_id,
      revision: row.revision,
      snippet: snippetOf(row.body),
      score: Math.round(finalScore * 1000) / 1000,
      semanticScore: Math.round(semanticScore * 1000) / 1000,
      lexicalScore: Math.round(lexicalScore * 1000) / 1000,
      provenanceSource: provSource,
      updatedAt: row.updated_at,
    });
  }

  scoredResults.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  const truncated = scoredResults.slice(0, limit);

  return {
    results: truncated,
    mode: queryVector ? mode : "lexical",
    total: scoredResults.length,
  };
}

export function findRelatedMemories(
  db: Database,
  memoryId: string,
  scopeKind: BrainScopeKind,
  scopeId: string,
  limit = 5,
): RelatedMemoryItem[] {
  ensureEmbeddingsSchema(db);
  const targetRow = db.query<MemorySearchRow, [string]>(`
    SELECT m.*, e.vector_json
    FROM brain_memories m
    LEFT JOIN brain_embeddings e ON e.memory_id = m.id AND e.revision = m.revision
    WHERE m.id = ? AND m.durability = 'committed'
  `).get(memoryId);

  if (!targetRow || !targetRow.vector_json) return [];

  let targetVector: number[];
  try {
    targetVector = JSON.parse(targetRow.vector_json) as number[];
  } catch {
    return [];
  }

  const siblings = db.query<MemorySearchRow, [string, string, string]>(`
    SELECT m.*, e.vector_json
    FROM brain_memories m
    LEFT JOIN brain_embeddings e ON e.memory_id = m.id AND e.revision = m.revision
    WHERE m.id != ? AND m.status = 'active' AND m.durability = 'committed'
      AND m.scope_kind = ? AND m.scope_id = ? AND e.vector_json IS NOT NULL
  `).all(memoryId, scopeKind, scopeId);

  const related: RelatedMemoryItem[] = [];

  for (const s of siblings) {
    if (!s.vector_json) continue;
    try {
      const vec = JSON.parse(s.vector_json) as number[];
      const sim = cosineSimilarity(targetVector, vec);
      if (sim >= 0.40) {
        related.push({
          id: s.id,
          title: s.title,
          kind: s.kind as any,
          similarity: Math.round(sim * 1000) / 1000,
          scopeKind: s.scope_kind as any,
          scopeId: s.scope_id,
        });
      }
    } catch {
      // skip
    }
  }

  related.sort((a, b) => b.similarity - a.similarity);
  return related.slice(0, limit);
}

export async function rebuildEmbeddings(
  db: Database,
): Promise<{ total: number; embedded: number; failed: number }> {
  ensureEmbeddingsSchema(db);
  const rows = db.query<{ id: string; revision: number; content_sha256: string; title: string; body: string }, []>(`
    SELECT id, revision, content_sha256, title, body
    FROM brain_memories
    WHERE durability = 'committed' AND status = 'active'
  `).all();

  let embedded = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      const ok = await storeEmbedding(db, r.id, r.revision, r.content_sha256, r.title, r.body);
      if (ok) embedded++;
      else failed++;
    } catch {
      failed++;
    }
  }

  lastRebuiltTimestamp = Date.now();
  return { total: rows.length, embedded, failed };
}

export function getEmbeddingStatus(db: Database): EmbeddingEngineStatus {
  ensureEmbeddingsSchema(db);
  const activeCount = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM brain_memories WHERE durability = 'committed' AND status = 'active'",
  ).get()?.count ?? 0;

  const indexedCount = db.query<{ count: number }, []>(
    "SELECT COUNT(DISTINCT memory_id) as count FROM brain_embeddings",
  ).get()?.count ?? 0;

  const coveragePercent = activeCount > 0 ? Math.round((indexedCount / activeCount) * 100) : 100;
  const engine = reportedEmbeddingEngine();
  const model = engine === "transformers-local"
    ? DEFAULT_EMBEDDING_MODEL
    : engine === "test-mock"
      ? "test-mock-driver"
      : "none";

  return {
    enabled: engine === "transformers-local" || engine === "test-mock",
    engine,
    model,
    dimension: engine === "lexical-fallback" ? 0 : EMBEDDING_DIMENSION,
    indexedCount,
    activeCount,
    coveragePercent,
    lastRebuiltAt: lastRebuiltTimestamp,
  };
}
