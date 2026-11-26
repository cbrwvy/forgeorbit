import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  approveExtractionCandidate,
  editExtractionCandidate,
  ingestExtractionEvent,
  listExtractionCandidates,
  readExtractionCandidate,
  rejectExtractionCandidate,
  setBrainStoreGetter,
} from "./brain-extractor.ts";
import { openBrainStore } from "./brain-store.ts";
import { db } from "./db.ts";

describe("Brain 2.0 Automatic Knowledge Extractor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fo-brain-extractor-test-"));
    const store = openBrainStore(tmpDir, { isRegistered: () => true });
    setBrainStoreGetter(() => store);
  });

  afterEach(() => {
    setBrainStoreGetter(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ingests completed task event and queues pending candidate", async () => {
    const candidate = await ingestExtractionEvent({
      kind: "completed_task",
      taskId: "task-auto-01",
      runId: "run-01",
      taskTitle: "Implement Bun SQLite busy timeout handler",
      prompt: "Configure SQLite PRAGMA busy_timeout to 2000ms to eliminate locking errors.",
      solutionSummary: "Added busy_timeout = 2000 in openBrainStore initialization.",
      projectPath: "/Users/qa/project-alpha",
      completedAt: Date.now(),
    });

    expect(candidate).not.toBeNull();
    expect(candidate!.status).toBe("candidate");
    expect(candidate!.sourceEventKind).toBe("completed_task");
    expect(candidate!.sourceEventId).toBe("task-auto-01");
    expect(candidate!.scopeId).toBe("/Users/qa/project-alpha");
    expect(candidate!.title).toContain("Task completed: Implement Bun SQLite busy timeout handler");
    expect(candidate!.content).toContain("Added busy_timeout = 2000");
  });

  test("idempotently ignores second ingestion of the same durable event", async () => {
    const event = {
      kind: "completed_task" as const,
      taskId: "task-idempotent-01",
      taskTitle: "Refactor database migration ordering",
      prompt: "Ensure migration numbers are strictly sequential.",
      projectPath: "/Users/qa/project-alpha",
      completedAt: Date.now(),
    };

    const first = await ingestExtractionEvent(event);
    expect(first).not.toBeNull();

    // Ingesting the identical event again
    const second = await ingestExtractionEvent(event);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);

    // Verify in database that only one row exists for this event
    const all = listExtractionCandidates({ sourceEventKind: "completed_task" });
    const matches = all.filter((c) => c.sourceEventId === "task-idempotent-01");
    expect(matches.length).toBe(1);
  });

  test("extracts QC review defect patterns when review requests rework", async () => {
    const candidate = await ingestExtractionEvent({
      kind: "qc_review",
      taskId: "task-qc-01",
      runId: "run-qc-01",
      reviewId: "review-qc-01",
      verdict: "rework",
      summary: "Unit tests failed because port 4318 was already occupied.",
      failurePattern: "Port collision: Address already in use 4318",
      projectPath: "/Users/qa/project-alpha",
      reviewedAt: Date.now(),
    });

    expect(candidate).not.toBeNull();
    expect(candidate!.kind).toBe("observation");
    expect(candidate!.title).toContain("Known failure pattern: Port collision");
    expect(candidate!.content).toContain("Address already in use");
  });

  test("extracts resolved issue from rework history", async () => {
    const candidate = await ingestExtractionEvent({
      kind: "rework_resolved",
      taskId: "task-rework-01",
      priorError: "Database locked error under concurrent read/write",
      fixSummary: "Enabled WAL journal mode in Database pragma.",
      projectPath: "/Users/qa/project-alpha",
      resolvedAt: Date.now(),
    });

    expect(candidate).not.toBeNull();
    expect(candidate!.title).toContain("Resolved issue: Database locked");
    expect(candidate!.content).toContain("Enabled WAL journal mode");
  });

  test("allows owner to edit, approve, and convert candidate into verified Brain memory with embedding", async () => {
    const candidate = await ingestExtractionEvent({
      kind: "owner_decision",
      decisionId: "decision-arch-01",
      title: "Use local embeddings model",
      content: "All vector embeddings must use local Xenova multilingual model with zero external network access.",
      decidedAt: Date.now(),
    });

    expect(candidate).not.toBeNull();

    // Owner edits candidate draft
    const edited = editExtractionCandidate(candidate!.id, {
      title: "Local Multilingual Embeddings Standard",
      content: "All vector embeddings must run locally on Apple Silicon via Xenova with zero external API calls.",
    });
    expect(edited.title).toBe("Local Multilingual Embeddings Standard");

    // Owner approves candidate
    const approval = await approveExtractionCandidate(candidate!.id);
    expect(approval.candidate.status).toBe("approved");
    expect(approval.candidate.memoryId).toBeDefined();

    // Verify durable memory was created in BrainStore
    expect(approval.memory.title).toBe("Local Multilingual Embeddings Standard");
    expect(approval.memory.origin).toBe("automatic-extraction");
    expect(approval.memory.provenance.source).toBe("automatic-extraction");
  });

  test("allows owner to reject candidate", async () => {
    const candidate = await ingestExtractionEvent({
      kind: "successful_run",
      taskId: "task-reject-01",
      runId: "run-reject-01",
      agent: "developer",
      projectPath: "/Users/qa/project-alpha",
      approachSummary: "Temporary patch for test runner.",
      endedAt: Date.now(),
    });

    expect(candidate).not.toBeNull();
    const rejected = rejectExtractionCandidate(candidate!.id, "Not a reusable standard");
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionReason).toBe("Not a reusable standard");
  });
});
