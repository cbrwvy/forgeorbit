import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openBrainStore } from "./brain-store.ts";
import { prepareSpecialistBrainContext, recordRunSpecialistBrainContext } from "./specialist-brain-context.ts";
import { queryHeadBrainMemories } from "./head-brain-retrieval.ts";
import { db, runs, tasks } from "./db.ts";
import { makeTask } from "../cli/test-fixtures.ts";
import type { HeadScopeSnapshot } from "../shared/head-pm-scope.ts";

const PROJECT_ALPHA = "/Users/qa/alpha-app";
const PROJECT_BETA = "/Users/qa/beta-app";

describe("Brain 2.0 Specialist & Head of PM Scoped Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fo-brain-spec-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Developer specialist receives scoped, revision-frozen coding conventions and earlier fixes", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    // Company memory
    store.create({
      scopeKind: "company",
      title: "Company Error Handling Standard",
      kind: "decision",
      content: "All operational errors must be wrapped with typed error codes.",
    });

    // Project Alpha memory
    const alphaFix = store.create({
      scopeKind: "project",
      projectPath: PROJECT_ALPHA,
      title: "Alpha SQLite Busy Timeout Fix",
      kind: "fact",
      content: "Set busy_timeout to 2000ms on Bun sqlite initialization.",
    });

    // Project Beta memory (unrelated project!)
    store.create({
      scopeKind: "project",
      projectPath: PROJECT_BETA,
      title: "Beta Secret Algorithm",
      kind: "decision",
      content: "Beta uses quantum search algorithm.",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Prepare context for Developer working on Alpha
    const context = await prepareSpecialistBrainContext(
      {
        role: "developer",
        projectPath: PROJECT_ALPHA,
        taskId: "task-dev-01",
        taskPrompt: "Fix SQLite database locked error in storage layer",
      },
      store,
    );

    expect(context.role).toBe("developer");
    expect(context.projectPath).toBe(PROJECT_ALPHA);
    expect(context.memories.length).toBeGreaterThan(0);

    // Alpha fix should be present
    expect(context.memories.find((m) => m.id === alphaFix.memory.id)).toBeDefined();

    // Beta memory MUST NOT be included (Project Isolation!)
    expect(context.memories.find((m) => m.title.includes("Beta Secret"))).toBeUndefined();

    // Verify frozen revisions
    expect(context.provenance.memories.length).toBe(context.memories.length);
    expect(context.provenance.memories[0]?.revision).toBeGreaterThanOrEqual(1);
    expect(context.provenance.memories[0]?.contentSha256).toBeDefined();

    // Rendered markdown should carry the read-only warning
    expect(context.renderedMarkdown).toContain("Read-Only Reference Data");
    expect(context.renderedMarkdown).toContain("Alpha SQLite Busy Timeout Fix");

    // Record provenance into a run
    tasks.insert(makeTask({
      id: "task-dev-01",
      title: "Fix SQLite database locked error",
      workdir: PROJECT_ALPHA,
      prompt: "Fix database locked error",
      column: "ready",
      agent: "developer",
    }));

    const testRunId = "run-spec-01";
    runs.insert({
      id: testRunId,
      taskId: "task-dev-01",
      agent: "developer",
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });

    recordRunSpecialistBrainContext(testRunId, context);

    const savedSnapshot = runs.readBrainContextSnapshot(testRunId);
    expect(savedSnapshot).not.toBeNull();
    const parsed = JSON.parse(savedSnapshot!);
    expect(parsed.role).toBe("developer");
    expect(parsed.taskId).toBe("task-dev-01");
    expect(parsed.memories.length).toBe(context.memories.length);

    store.close();
  });

  test("Reviewer specialist receives QC history and failure patterns for their project", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    store.create({
      scopeKind: "project",
      projectPath: PROJECT_ALPHA,
      title: "Known failure pattern: Port collision",
      kind: "observation",
      content: "Tests fail if port 4318 is not released before dev server startup.",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const context = await prepareSpecialistBrainContext(
      {
        role: "reviewer",
        projectPath: PROJECT_ALPHA,
        taskId: "task-qc-01",
        taskPrompt: "Verify test suite execution on port binding",
      },
      store,
    );

    expect(context.role).toBe("reviewer");
    expect(context.memories.length).toBeGreaterThan(0);
    expect(context.memories[0]?.title).toContain("Known failure pattern");

    store.close();
  });

  test("Head of PM retrieves relevant historical solutions within permitted scope with explanations and citations", async () => {
    const store = openBrainStore(tmpDir, { isRegistered: () => true });

    // Ingest memory from automatic extraction with source record IDs
    store.createFromExtraction(
      {
        scopeKind: "project",
        projectPath: PROJECT_ALPHA,
        title: "Resolved memory leak in event listener",
        kind: "fact",
        content: "Cleanup event handlers on component unmount to prevent leaks.",
      },
      {
        source: "automatic-extraction",
        approval: "explicit",
        approvedBy: "owner",
        sourceEventKind: "completed_task",
        sourceRecordIds: ["task-leak-99", "run-leak-99"],
        extractionMethod: "heuristic",
        confidence: 0.95,
        note: "Extracted from task-leak-99. Approved by Owner.",
      },
    );

    // Beta memory (unrelated project)
    store.create({
      scopeKind: "project",
      projectPath: PROJECT_BETA,
      title: "Beta unmount pattern",
      kind: "fact",
      content: "Beta memory leak fix.",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Head scoped to Project Alpha
    const headAlphaScope: HeadScopeSnapshot = {
      scope: { kind: "project", path: PROJECT_ALPHA },
      label: "Alpha App",
      projectPath: PROJECT_ALPHA,
      projectAddedAt: Date.now(),
      clusterId: null,
    };

    const res = await queryHeadBrainMemories(headAlphaScope, "memory leak cleanup on unmount", store);

    expect(res.hits.length).toBeGreaterThan(0);
    const hit = res.hits[0];
    expect(hit).toBeDefined();
    if (!hit) throw new Error("Expected hit");
    expect(hit.memory.title).toBe("Resolved memory leak in event listener");

    // Check source attribution and citation
    expect(hit.sourceAttribution.source).toBe("automatic-extraction");
    expect(hit.sourceAttribution.sourceRecordIds).toContain("task-leak-99");

    // Word overlap on a non-exact title is capped at 0.3. That lexical score
    // stays separate from semantic similarity. With no embedding, rank is the
    // lexical score; with a vector, rank is the hybrid and still lists both.
    expect(hit.relevanceReason).toContain("Alpha App");
    expect(hit.lexicalScore).toBe(0.3);
    expect(hit.semanticScore).toBeGreaterThanOrEqual(0);
    expect(hit.semanticScore).toBeLessThanOrEqual(1);
    const ranked = hit.semanticScore === 0
      ? hit.lexicalScore
      : Math.round((0.65 * hit.semanticScore + 0.35 * hit.lexicalScore) * 1000) / 1000;
    expect(hit.relevanceScore).toBe(ranked);
    expect(hit.relevanceReason).toContain(`semantic: ${hit.semanticScore}`);
    expect(hit.relevanceReason).toContain(`lexical: ${hit.lexicalScore}`);
    expect(res.hits.every((item, index) => index === 0 || item.relevanceScore <= hit.relevanceScore)).toBe(true);
    expect(res.hits.some((item) => item.memory.title === "Beta unmount pattern")).toBe(false);

    // Summary formatting includes citation
    expect(res.renderedSummary).toContain("task-leak-99");
    expect(res.renderedSummary).not.toContain(PROJECT_BETA);

    store.close();
  });
});
