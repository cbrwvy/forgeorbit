import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  cosineSimilarity,
  dotProduct,
  embeddingCacheReady,
  generateEmbedding,
  normL2,
  resolveEmbeddingModelRoot,
  setForceLexicalEmbeddingsForTest,
} from "./brain-embeddings.ts";
import { openBrainStore } from "./brain-store.ts";

describe("Brain 2.0 Semantic Embeddings & Retrieval", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fo-brain-embed-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("vector math functions correctly compute L2 norm, dot product, and cosine similarity", () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    const v3 = [0, 1, 0];
    const v4 = [-1, 0, 0];

    expect(dotProduct(v1, v2)).toBe(1);
    expect(dotProduct(v1, v3)).toBe(0);
    expect(normL2(v1)).toBe(1);
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(v1, v3)).toBeCloseTo(0.0, 5);
    expect(cosineSimilarity(v1, v4)).toBeCloseTo(-1.0, 5);
  });

  test("real local embedding engine generates normalized 384-dimension vectors for English and Russian", async () => {
    const enText = "Database connection pool timeout configuration";
    const ruText = "Настройка тайм-аута пула подключений к базе данных";

    const enResult = await generateEmbedding(enText);
    expect(enResult).not.toBeNull();
    expect(enResult!.dimension).toBe(384);
    expect(enResult!.vector.length).toBe(384);
    expect(normL2(enResult!.vector)).toBeCloseTo(1.0, 2);

    const ruResult = await generateEmbedding(ruText);
    expect(ruResult).not.toBeNull();
    expect(ruResult!.dimension).toBe(384);
    expect(ruResult!.vector.length).toBe(384);
    expect(normL2(ruResult!.vector)).toBeCloseTo(1.0, 2);

    // Cross-lingual semantic similarity between English and Russian on the same topic!
    const sim = cosineSimilarity(enResult!.vector, ruResult!.vector);
    expect(sim).toBeGreaterThan(0.60);
  });

  test("semantic search retrieves semantically related memory with different wording", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    // Insert a memory about SQLite busy timeout
    const created = store.create({
      scopeKind: "company",
      title: "SQLite Concurrency Resolution",
      kind: "decision",
      content: "When encountering database locked errors in SQLite, set busy_timeout to 2000ms and use WAL journal mode.",
    });

    // Wait a brief tick for async embedding write
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Query using completely different wording: "SQL contention workaround"
    const results = await store.searchSemantic({
      scopeKind: "company",
      text: "SQL contention lock issue workaround",
      mode: "semantic",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe(created.memory.id);
    expect(results[0]?.semanticScore).toBeGreaterThan(0.35);

    store.close();
  });

  test("search combines semantic and lexical relevance and respects active/archived status", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    const mem1 = store.create({
      scopeKind: "company",
      title: "Authentication Token Handling",
      kind: "decision",
      content: "All bearer tokens must be verified before decoding json body payload.",
    });

    const mem2 = store.create({
      scopeKind: "company",
      title: "UI Design Color Palette",
      kind: "observation",
      content: "Primary colors follow the ForgeOrbit dark slate theme.",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Hybrid search
    const hybrid = await store.searchSemantic({
      scopeKind: "company",
      text: "bearer token security",
      mode: "hybrid",
    });

    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid[0]?.id).toBe(mem1.memory.id);

    // Archive mem1
    store.archive(mem1.memory.id, 1);

    // Searching active memories should no longer return archived mem1
    const activeSearch = await store.searchSemantic({
      scopeKind: "company",
      text: "bearer token",
      status: "active",
    });
    expect(activeSearch.find((r) => r.id === mem1.memory.id)).toBeUndefined();

    // Searching archived memories should find it
    const archivedSearch = await store.searchSemantic({
      scopeKind: "company",
      text: "bearer token",
      status: "archived",
    });
    expect(archivedSearch.find((r) => r.id === mem1.memory.id)).toBeDefined();

    store.close();
  });

  test("findRelated identifies sibling memories with high similarity", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    const mem1 = store.create({
      scopeKind: "company",
      title: "Database connection tuning",
      kind: "fact",
      content: "SQLite connections should have 2000ms busy timeout to prevent lock failures.",
    });

    const mem2 = store.create({
      scopeKind: "company",
      title: "WAL mode optimization",
      kind: "decision",
      content: "Enable WAL mode on sqlite databases for concurrent read access.",
    });

    const mem3 = store.create({
      scopeKind: "company",
      title: "Frontend Typography",
      kind: "observation",
      content: "Geist Variable font is used for headers and monospace code blocks.",
    });

    // Allow embeddings to persist
    await new Promise((resolve) => setTimeout(resolve, 80));

    const related = store.findRelated(mem1.memory.id);
    expect(related.length).toBeGreaterThan(0);
    // mem2 should be related (both database), mem3 should not be in related
    expect(related.find((r) => r.id === mem2.memory.id)).toBeDefined();
    expect(related.find((r) => r.id === mem3.memory.id)).toBeUndefined();

    store.close();
  });

  test("status reports coverage and rebuildEmbeddings restores missing vector records", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    store.create({
      scopeKind: "company",
      title: "Fact A",
      kind: "fact",
      content: "Fact content for first test item.",
    });

    store.create({
      scopeKind: "company",
      title: "Fact B",
      kind: "fact",
      content: "Fact content for second test item.",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const status1 = store.getEmbeddingStatus();
    expect(status1.enabled).toBe(true);
    expect(status1.activeCount).toBe(2);

    const rebuildResult = await store.rebuildEmbeddings();
    expect(rebuildResult.total).toBe(2);
    expect(rebuildResult.embedded).toBe(2);

    store.close();
  });

  test("semantic mode does not answer with lexical overlap when the model is inactive", async () => {
    setForceLexicalEmbeddingsForTest(true);
    try {
      const store = openBrainStore(tmpDir, { isRegistered: () => true });
      store.create({
        scopeKind: "company",
        title: "Exact lexical title",
        kind: "fact",
        content: "Exact lexical title is stored without a vector.",
      });
      const status = store.getEmbeddingStatus();
      expect(status.enabled).toBe(false);
      expect(status.engine).toBe("lexical-fallback");
      expect(status.model).toBe("none");
      const report = await store.searchReport({
        scopeKind: "company",
        text: "Exact lexical title",
        mode: "semantic",
      });
      expect(report.mode).toBe("lexical");
      expect(report.results).toEqual([]);
      store.close();
    } finally {
      setForceLexicalEmbeddingsForTest(false);
    }
  });
});

describe("embedding model root", () => {
  test("a pinned root is used only when the quantized model is present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fo-embed-root-"));
    const model = path.join(root, "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
    fs.mkdirSync(path.join(model, "onnx"), { recursive: true });
    fs.writeFileSync(path.join(model, "onnx/model_quantized.onnx"), "onnx");
    fs.writeFileSync(path.join(model, "tokenizer.json"), "{}");
    expect(embeddingCacheReady(root)).toBe(true);
    expect(resolveEmbeddingModelRoot({ env: { FORGEORBIT_EMBEDDING_MODEL_ROOT: root }, execPath: "/nope", cwd: "/nope" })).toBe(root);
    expect(resolveEmbeddingModelRoot({ env: { FORGEORBIT_EMBEDDING_MODEL_ROOT: path.join(root, "missing") }, execPath: "/nope", cwd: "/nope" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the packaged Resources/app/models directory wins over a user cache", () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "fo-embed-app-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fo-embed-home-"));
    const place = (base: string) => {
      const model = path.join(base, "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
      fs.mkdirSync(path.join(model, "onnx"), { recursive: true });
      fs.writeFileSync(path.join(model, "onnx/model_quantized.onnx"), "onnx");
      fs.writeFileSync(path.join(model, "tokenizer.json"), "{}");
    };
    const bundled = path.join(app, "Contents/Resources/app/models");
    place(bundled);
    place(path.join(home, ".cache/forgeorbit-models"));
    const execPath = path.join(app, "Contents/MacOS/bun");
    expect(resolveEmbeddingModelRoot({ env: { HOME: home }, execPath, cwd: "/elsewhere" })).toBe(bundled);
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
