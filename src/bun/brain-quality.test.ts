import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { evaluateCandidateQuality, isLowInformation } from "./brain-quality.ts";
import { openBrainStore } from "./brain-store.ts";
import { generateEmbedding, storeEmbedding } from "./brain-embeddings.ts";

describe("Brain 2.0 Candidate Quality & Deduplication Pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fo-brain-quality-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rejects empty or low-information memories and placeholder texts", () => {
    expect(isLowInformation("", "").lowInfo).toBe(true);
    expect(isLowInformation("Short", "done").lowInfo).toBe(true);
    expect(isLowInformation("Fix", "fixed issue").lowInfo).toBe(true);
    expect(isLowInformation("Title", "TODO").lowInfo).toBe(true);
    expect(isLowInformation("OK", "n/a").lowInfo).toBe(true);
    expect(isLowInformation("Test", "two words").lowInfo).toBe(true);

    const valid = isLowInformation(
      "SQLite busy timeout configuration",
      "Set busy_timeout to 2000ms to resolve lock contention in concurrent tests.",
    );
    expect(valid.lowInfo).toBe(false);
  });

  test("rejects candidate containing credentials or secrets", () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    const db = (store as any).db;

    const assessment = evaluateCandidateQuality(db, {
      title: "API credentials for deployment",
      content: "Use private key gh_token: ghp_1234567890abcdefghijklmnopqrstuvwxyz for auth.",
      scopeKind: "company",
      scopeId: "company:forgeorbit",
      sourceTimestamps: { eventAt: Date.now(), extractedAt: Date.now() },
    });

    expect(assessment.pass).toBe(false);
    expect(assessment.issues.some((i) => i.includes("Credential"))).toBe(true);

    store.close();
  });

  test("detects exact duplicate in same scope", () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    const db = (store as any).db;

    store.create({
      scopeKind: "company",
      title: "Port Allocation Convention",
      kind: "decision",
      content: "Development port is 4318 for backend API server.",
    });

    const assessment = evaluateCandidateQuality(db, {
      title: "Port Allocation Convention",
      content: "Development port is 4318 for backend API server.",
      scopeKind: "company",
      scopeId: "company:forgeorbit",
      sourceTimestamps: { eventAt: Date.now(), extractedAt: Date.now() },
    });

    expect(assessment.duplicateType).toBe("exact");
    expect(assessment.duplicateMemoryId).toBeDefined();

    store.close();
  });

  test("identifies near-duplicate using semantic embedding similarity", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    const db = (store as any).db;

    const original = store.create({
      scopeKind: "company",
      title: "Database Lock Prevention",
      kind: "decision",
      content: "Configure SQLite busy_timeout to 2000ms to prevent database locked errors.",
    });

    // Compute embedding for original
    await storeEmbedding(db, original.memory.id, 1, original.memory.contentSha256, original.memory.title, original.memory.content);

    // Near-duplicate candidate with very similar meaning
    const candidateText = "Configure SQLite busy_timeout to 2000 milliseconds to avoid database lock failures.";
    const candidateEmb = await generateEmbedding(`Database Lock Prevention\n${candidateText}`);

    const assessment = evaluateCandidateQuality(db, {
      title: "Database Lock Prevention",
      content: candidateText,
      scopeKind: "company",
      scopeId: "company:forgeorbit",
      sourceTimestamps: { eventAt: Date.now(), extractedAt: Date.now() },
      candidateEmbedding: candidateEmb?.vector,
    });

    expect(assessment.duplicateType).toBe("near");
    expect(assessment.duplicateMemoryId).toBe(original.memory.id);

    store.close();
  });

  test("distinguishes new fact from correction of existing fact", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    const db = (store as any).db;

    const baseTime = Date.now() - 10000;
    const original = store.create({
      scopeKind: "project",
      projectPath: "/Users/qa/project-a",
      title: "Server port",
      kind: "decision",
      content: "Default port is 3000 for local dev server.",
    });

    await storeEmbedding(db, original.memory.id, 1, original.memory.contentSha256, original.memory.title, original.memory.content);

    // Newer correction candidate
    const updateTitle = "Updated server port configuration";
    const updateContent = "Changed server port to 4318 to avoid port collision with system services.";
    const updateEmb = await generateEmbedding(`${updateTitle}\n${updateContent}`);

    const assessment = evaluateCandidateQuality(db, {
      title: updateTitle,
      content: updateContent,
      scopeKind: "project",
      scopeId: "/Users/qa/project-a",
      sourceTimestamps: { eventAt: Date.now(), extractedAt: Date.now() },
      candidateEmbedding: updateEmb?.vector,
    });

    expect(assessment.relationship).toBe("correction");
    expect(assessment.supersedesMemoryId).toBe(original.memory.id);

    store.close();
  });

  test("prevents stale candidate from silently overriding newer verified fact", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    const db = (store as any).db;

    const now = Date.now();
    const original = store.create({
      scopeKind: "project",
      projectPath: "/Users/qa/project-a",
      title: "Updated port configuration",
      kind: "decision",
      content: "Changed port to 4318.",
    });

    await storeEmbedding(db, original.memory.id, 1, original.memory.contentSha256, original.memory.title, original.memory.content);

    // Stale candidate with event timestamp in the past
    const staleEmb = await generateEmbedding("Updated port configuration\nReverted port to 3000.");
    const assessment = evaluateCandidateQuality(db, {
      title: "Updated port configuration",
      content: "Reverted port to 3000.",
      scopeKind: "project",
      scopeId: "/Users/qa/project-a",
      sourceTimestamps: { eventAt: now - 50000, extractedAt: now }, // older!
      candidateEmbedding: staleEmb?.vector,
    });

    expect(assessment.pass).toBe(false);
    expect(assessment.issues.some((i) => i.includes("Stale override rejected"))).toBe(true);

    store.close();
  });

  test("guarantees cross-project isolation in deduplication and corrections", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    const db = (store as any).db;

    // Memory in Project A
    const memA = store.create({
      scopeKind: "project",
      projectPath: "/Users/qa/project-a",
      title: "Release tag convention",
      kind: "decision",
      content: "Project A uses v1.0.0 semantic tags.",
    });
    await storeEmbedding(db, memA.memory.id, 1, memA.memory.contentSha256, memA.memory.title, memA.memory.content);

    // Identical candidate in Project B should NOT be marked as duplicate of Project A!
    const embB = await generateEmbedding("Release tag convention\nProject A uses v1.0.0 semantic tags.");
    const assessmentB = evaluateCandidateQuality(db, {
      title: "Release tag convention",
      content: "Project A uses v1.0.0 semantic tags.",
      scopeKind: "project",
      scopeId: "/Users/qa/project-b", // Different project!
      sourceTimestamps: { eventAt: Date.now(), extractedAt: Date.now() },
      candidateEmbedding: embB?.vector,
    });

    // In Project B, it's a new fact, not duplicate of Project A
    expect(assessmentB.duplicateType).toBe("none");
    expect(assessmentB.duplicateMemoryId).toBeUndefined();

    store.close();
  });
});
