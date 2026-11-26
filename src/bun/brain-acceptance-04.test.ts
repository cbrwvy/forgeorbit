import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { openBrainStore } from "./brain-store.ts";
import {
  approveExtractionCandidate,
  ingestExtractionEvent,
  listExtractionCandidates,
  readExtractionCandidate,
  setBrainStoreGetter,
} from "./brain-extractor.ts";
import { prepareSpecialistBrainContext } from "./specialist-brain-context.ts";
import { queryHeadBrainMemories } from "./head-brain-retrieval.ts";
import { BackupManager } from "./backup-manager.ts";
import { restoreBackupSnapshot } from "./backup-restore.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { db, runs, taskQualityReviews, tasks } from "./db.ts";
import { makeTask } from "../cli/test-fixtures.ts";
import type { HeadScopeSnapshot } from "../shared/head-pm-scope.ts";

const PROJ_ALPHA = "/Users/qa/synthetic-alpha";
const PROJ_BETA = "/Users/qa/synthetic-beta";

describe("FO-BRAIN04 Acceptance: 15-Step End-to-End Verification", () => {
  let tmpRoot: string;
  let brainDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fo-brain04-accept-"));
    brainDir = path.join(tmpRoot, "brain");
    fs.mkdirSync(brainDir, { recursive: true });
    const store = openBrainStore(brainDir, {
      isRegistered: (p) => p === PROJ_ALPHA || p === PROJ_BETA,
    });
    setBrainStoreGetter(() => store);
  });

  afterEach(() => {
    setBrainStoreGetter(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("15-step end-to-end Brain 2.0 functional acceptance walkthrough", async () => {
    const store = openBrainStore(brainDir, {
      isRegistered: (p) => p === PROJ_ALPHA || p === PROJ_BETA,
    });
    setBrainStoreGetter(() => store);

    // =========================================================================
    // Step 1: Complete a synthetic Developer task
    // =========================================================================
    const taskId = "task-synth-001";
    const runId = "run-synth-001";
    const task = tasks.insert(makeTask({
      id: taskId,
      title: "Configure SQLite Busy Timeout and WAL Mode",
      prompt: "Configure SQLite with PRAGMA busy_timeout = 2000 and PRAGMA journal_mode = WAL to prevent locked errors.",
      column: "ready",
      workdir: PROJ_ALPHA,
      agent: "developer",
    }));
    expect(task.id).toBe(taskId);

    // Developer executes and finishes successfully
    runs.insert({
      id: runId,
      taskId,
      agent: "developer",
      status: "succeeded",
      startedAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });

    // =========================================================================
    // Step 2: Persist Developer and QC results
    // =========================================================================
    const qcReviewId = "qc-synth-001";
    taskQualityReviews.insert({
      id: qcReviewId,
      taskId,
      projectPath: PROJ_ALPHA,
      round: 1,
      reviewerHarness: "codex",
      reviewerModel: "fake-qc-model",
      reviewerEmployeeId: null,
      reviewerRoleSlug: "reviewer",
      reviewerProfileId: null,
      implementationRunId: runId,
      savedTaskJson: JSON.stringify({}),
      status: "pending",
      findings: [],
      requestedAt: Date.now() - 500,
    });
    taskQualityReviews.complete(qcReviewId, {
      status: "complete",
      verdict: "PASS",
      summary: "SQLite concurrency settings verified: WAL mode and busy_timeout=2000 active.",
      findings: [],
      feedback: "All concurrency tests passed without locking.",
      completedAt: Date.now(),
    });

    tasks.update(taskId, { column: "done" });
    const completedTask = tasks.get(taskId)!;
    expect(completedTask.column).toBe("done");

    // =========================================================================
    // Step 3: Automatically create a useful memory candidate
    // =========================================================================
    const candidate = await ingestExtractionEvent({
      kind: "completed_task",
      taskId,
      runId,
      taskTitle: completedTask.title,
      prompt: completedTask.prompt,
      solutionSummary: "Set SQLite PRAGMA busy_timeout = 2000ms and WAL journal mode in Database pragma.",
      projectPath: PROJ_ALPHA,
      completedAt: Date.now(),
    });

    expect(candidate).not.toBeNull();
    expect(candidate!.status).toBe("candidate");
    expect(candidate!.title).toContain("Configure SQLite Busy Timeout");
    expect(candidate!.content).toContain("busy_timeout = 2000ms");

    // =========================================================================
    // Step 4: Verify provenance and project scope
    // =========================================================================
    expect(candidate!.scopeKind).toBe("project");
    expect(candidate!.scopeId).toBe(PROJ_ALPHA);
    expect(candidate!.sourceEventKind).toBe("completed_task");
    expect(candidate!.sourceEventId).toBe(taskId);
    expect(candidate!.sourceRecordIds).toContain(taskId);
    expect(candidate!.sourceRecordIds).toContain(runId);
    expect(candidate!.confidence).toBeGreaterThan(0.7);

    // =========================================================================
    // Step 5: Approve the candidate using the Owner interface
    // =========================================================================
    const approval = await approveExtractionCandidate(candidate!.id, {
      title: "SQLite Concurrency Resolution Standard",
      kind: "decision",
      content: "When using Bun SQLite, always initialize with busy_timeout = 2000 and WAL journal mode.",
    });

    expect(approval.candidate.status).toBe("approved");
    expect(approval.candidate.memoryId).toBeDefined();
    const memoryId = approval.candidate.memoryId!;

    const memory = store.read(memoryId);
    expect(memory.id).toBe(memoryId);
    expect(memory.title).toBe("SQLite Concurrency Resolution Standard");
    expect(memory.origin).toBe("automatic-extraction");
    expect(memory.provenance.source).toBe("automatic-extraction");

    // =========================================================================
    // Step 6: Generate a real local embedding
    // =========================================================================
    // Check that vector embedding was persisted locally in SQLite
    const embeddingStatus = store.getEmbeddingStatus();
    expect(embeddingStatus.enabled).toBe(true);
    expect(embeddingStatus.indexedCount).toBeGreaterThanOrEqual(1);
    expect(embeddingStatus.dimension).toBe(384);
    expect(embeddingStatus.model).toContain("paraphrase-multilingual");

    // =========================================================================
    // Step 7: Retrieve memory through semantically related query with different wording
    // =========================================================================
    // Different wording: "handling database locked error in sqlite"
    const searchHits = await store.searchSemantic({
      scopeKind: "project",
      projectPath: PROJ_ALPHA,
      text: "handling database locked contention error",
      mode: "semantic",
    });

    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits[0]?.id).toBe(memoryId);
    expect(searchHits[0]?.semanticScore).toBeGreaterThan(0.25);

    // =========================================================================
    // Step 8: Verify exact source attribution
    // =========================================================================
    const topHitId = searchHits[0]?.id;
    expect(topHitId).toBeDefined();
    const retrieved = store.read(topHitId!);
    expect(retrieved.provenance.source).toBe("automatic-extraction");
    if (retrieved.provenance.source === "automatic-extraction") {
      expect(retrieved.provenance.sourceEventKind).toBe("completed_task");
      expect(retrieved.provenance.sourceRecordIds).toContain(taskId);
      expect(retrieved.provenance.approvedBy).toBe("owner");
    }

    // =========================================================================
    // Step 9: Verify Head retrieves relevant memory only within permitted scopes
    // =========================================================================
    const headAlphaScope: HeadScopeSnapshot = {
      scope: { kind: "project", path: PROJ_ALPHA },
      label: "Synthetic Alpha",
      projectPath: PROJ_ALPHA,
      projectAddedAt: Date.now(),
      clusterId: null,
    };

    const headRes = await queryHeadBrainMemories(headAlphaScope, "sqlite locking solution", store);
    expect(headRes.hits.length).toBeGreaterThan(0);
    expect(headRes.hits[0]?.memory.id).toBe(memoryId);
    expect(headRes.hits[0]?.relevanceReason).toContain("Synthetic Alpha");
    expect(headRes.hits[0]?.sourceAttribution.sourceRecordIds).toContain(taskId);

    // =========================================================================
    // Step 10: Verify specialist receives only authorized memory
    // =========================================================================
    const specialistContext = await prepareSpecialistBrainContext(
      {
        role: "developer",
        projectPath: PROJ_ALPHA,
        taskId: "task-next-002",
        taskPrompt: "Fix database locking during concurrent writes",
      },
      store,
    );

    expect(specialistContext.role).toBe("developer");
    expect(specialistContext.projectPath).toBe(PROJ_ALPHA);
    expect(specialistContext.memories.some((m) => m.id === memoryId)).toBe(true);
    expect(specialistContext.provenance.memories.some((m) => m.id === memoryId)).toBe(true);

    // =========================================================================
    // Step 11: Process same source event again without creating duplicates (Idempotency)
    // =========================================================================
    const repeatCandidate = await ingestExtractionEvent({
      kind: "completed_task",
      taskId,
      runId,
      taskTitle: completedTask.title,
      prompt: completedTask.prompt,
      projectPath: PROJ_ALPHA,
      completedAt: Date.now(),
    });

    expect(repeatCandidate).not.toBeNull();
    expect(repeatCandidate!.id).toBe(candidate!.id);
    // Candidate count should not have grown
    const alphaCandidates = listExtractionCandidates({ projectPath: PROJ_ALPHA, status: "all" });
    expect(alphaCandidates.filter((c) => c.sourceEventId === taskId).length).toBe(1);

    // =========================================================================
    // Step 12: Update original memory and refresh its embedding
    // =========================================================================
    const updated = store.update(memoryId, {
      expectedRevision: 1,
      content: "When using Bun SQLite, always initialize with busy_timeout = 2500ms and WAL journal mode.",
    });
    expect(updated.revision).toBe(2);

    // Verify search reflects updated revision
    const afterUpdateHits = await store.searchSemantic({
      scopeKind: "project",
      projectPath: PROJ_ALPHA,
      text: "busy_timeout",
    });
    expect(afterUpdateHits[0]?.revision).toBe(2);

    // =========================================================================
    // Step 13: Restart backend (reopen SQLite store) and verify persistence
    // =========================================================================
    store.close();

    const reopenedStore = openBrainStore(brainDir, {
      isRegistered: (p) => p === PROJ_ALPHA || p === PROJ_BETA,
    });
    const reopenedMemory = reopenedStore.read(memoryId);
    expect(reopenedMemory.id).toBe(memoryId);
    expect(reopenedMemory.revision).toBe(2);
    expect(reopenedMemory.content).toContain("2500ms");

    const reopenedEmbStatus = reopenedStore.getEmbeddingStatus();
    expect(reopenedEmbStatus.indexedCount).toBeGreaterThanOrEqual(1);

    // =========================================================================
    // Step 14: Restore an isolated snapshot and verify memory integrity and search availability
    // =========================================================================
    const profileDir = path.join(tmpRoot, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const profileDbPath = path.join(profileDir, "agetor.sqlite");
    const profileDb = new Database(profileDbPath);
    profileDb.exec("PRAGMA journal_mode = WAL;");
    profileDb.exec("PRAGMA foreign_keys = ON;");
    migrate(profileDb, migrations);
    fs.cpSync(brainDir, path.join(profileDir, "brain"), { recursive: true });

    const backupManager = new BackupManager({ db: profileDb, dataDir: profileDir });
    const snapDir = path.join(tmpRoot, "snaps");
    const snap = await backupManager.createSnapshot({
      destinationDir: snapDir,
      createDirectory: true,
      manifestVersion: 4,
    });
    expect(snap.path).toBeDefined();

    const restoreTarget = path.join(tmpRoot, "restored");
    await restoreBackupSnapshot(snap.path, restoreTarget);

    const restoredBrainDir = path.join(restoreTarget, "brain");
    expect(fs.existsSync(restoredBrainDir)).toBe(true);

    const restoredStore = openBrainStore(restoredBrainDir, {
      isRegistered: (p) => p === PROJ_ALPHA || p === PROJ_BETA,
    });
    const restoredMem = restoredStore.read(memoryId);
    expect(restoredMem.id).toBe(memoryId);
    expect(restoredMem.title).toBe("SQLite Concurrency Resolution Standard");

    const restoredHits = await restoredStore.searchSemantic({
      scopeKind: "project",
      projectPath: PROJ_ALPHA,
      text: "sqlite busy timeout concurrency",
    });
    expect(restoredHits.length).toBeGreaterThan(0);
    expect(restoredHits[0]?.id).toBe(memoryId);
    restoredStore.close();
    profileDb.close();

    // =========================================================================
    // Step 15: Verify unrelated project knowledge stays isolated
    // =========================================================================
    // Querying from Project Beta MUST NOT return Project Alpha memories
    const betaHits = await reopenedStore.searchSemantic({
      scopeKind: "project",
      projectPath: PROJ_BETA,
      inheritCompany: false,
      text: "sqlite concurrency standard",
    });
    expect(betaHits.find((h) => h.id === memoryId)).toBeUndefined();

    // Specialist for Beta must not receive Alpha memories
    const betaSpecialist = await prepareSpecialistBrainContext(
      {
        role: "developer",
        projectPath: PROJ_BETA,
        taskId: "task-beta-001",
        taskPrompt: "sqlite concurrency solution",
      },
      reopenedStore,
    );
    expect(betaSpecialist.memories.find((m) => m.id === memoryId)).toBeUndefined();

    // Head scoped to Project Beta must not receive Alpha memories
    const headBetaScope: HeadScopeSnapshot = {
      scope: { kind: "project", path: PROJ_BETA },
      label: "Synthetic Beta",
      projectPath: PROJ_BETA,
      projectAddedAt: Date.now(),
      clusterId: null,
    };
    const headBetaRes = await queryHeadBrainMemories(headBetaScope, "sqlite concurrency", reopenedStore);
    expect(headBetaRes.hits.find((h) => h.memory.id === memoryId)).toBeUndefined();

    reopenedStore.close();
  });
});
