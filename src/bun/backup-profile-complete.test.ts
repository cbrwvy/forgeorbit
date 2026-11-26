/**
 * FO-P2-003-R4C Regression Test Suite
 * Complete Persistent Profile Backup and Restore
 *
 * Deterministic tests covering all 21 prompt requirements:
 * 1. Full profile snapshot with SQLite, Knowledge, attachments and issue-thread files.
 * 2. Pipeline artifact inclusion when classified as durable.
 * 3. Additional persistent categories discovered during inventory (screenshots).
 * 4. Database records referencing missing attachments.
 * 5. Concurrent file deletion racing with snapshot creation (bounded retry).
 * 6. File modification racing with snapshot creation (TOCTOU / hash mismatch).
 * 7. Path traversal payloads in attachment records (rejection).
 * 8. External paths referenced by records (never copied into snapshot).
 * 9. Secrets and runtime files present in data directory (excluded).
 * 10. Complete profile restore into an inactive destination directory.
 * 11. Legacy (manifestVersion 1) verification and restore without false complete coverage.
 * 12. Incomplete legacy restore fails when requireCompleteProfile is set.
 * 13. Unmanifested files inserted into snapshot fail verification and restore.
 * 14. Corrupted attachments detected during verification and restoration.
 * 15. Active profile protection and target exists checks.
 * 16. Inactive target publication under concurrent collision.
 * 17. Large profile streaming and bounded memory handling.
 * 18. Manifest bounds enforcement (10 MiB limit).
 * 19. Cancellation during heavy copying with complete staging cleanup.
 * 20. Process failure and crash staging recovery.
 * 21. Independent verifier reporting exact category counts and coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BackupCore,
  publishDirectoryExclusive,
  cleanSubsystemStaging,
} from "./backup-core.ts";
import {
  BackupManager,
  BackupManagerError,
  cleanIncompleteBackupSnapshots,
  createBackupSnapshot,
  getReferencedInternalAssets,
  verifyBackupSnapshot,
  type SnapshotManifest,
} from "./backup-manager.ts";
import {
  BackupRestore,
  cleanIncompleteRestoreStaging,
  restoreBackupSnapshot,
  RestoreError,
} from "./backup-restore.ts";
import {
  BackupProcessRunner,
} from "./backup-runner.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

function sha256Hex(buf: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("FO-P2-003-R4C: Complete Persistent Profile Backup and Restore", () => {
  let testRoot: string;
  let dataDir: string;
  let knowledgeRootDir: string;
  let attachmentsRootDir: string;
  let screenshotsRootDir: string;
  let issueThreadsRootDir: string;
  let pipelineRunsRootDir: string;
  let backupOutputDir: string;
  let restoreOutputDir: string;
  let prevForgeorbit: string | undefined;
  let prevAgetor: string | undefined;

  beforeEach(() => {
    testRoot = mkdtempSync(path.join(tmpdir(), "fo-p2-r4c-test-"));
    dataDir = path.join(testRoot, "data");
    knowledgeRootDir = path.join(dataDir, "knowledge");
    attachmentsRootDir = path.join(dataDir, "attachments");
    screenshotsRootDir = path.join(dataDir, "screenshots");
    issueThreadsRootDir = path.join(dataDir, "issue-threads");
    pipelineRunsRootDir = path.join(dataDir, "pipeline-runs");
    backupOutputDir = path.join(testRoot, "backups");
    restoreOutputDir = path.join(testRoot, "restores");

    prevForgeorbit = process.env.FORGEORBIT_DATA_DIR;
    prevAgetor = process.env.AGETOR_DATA_DIR;
    process.env.FORGEORBIT_DATA_DIR = dataDir;
    process.env.AGETOR_DATA_DIR = dataDir;

    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(knowledgeRootDir, { recursive: true, mode: 0o700 });
    mkdirSync(attachmentsRootDir, { recursive: true, mode: 0o700 });
    mkdirSync(screenshotsRootDir, { recursive: true, mode: 0o700 });
    mkdirSync(issueThreadsRootDir, { recursive: true, mode: 0o700 });
    mkdirSync(pipelineRunsRootDir, { recursive: true, mode: 0o700 });
    mkdirSync(backupOutputDir, { recursive: true, mode: 0o700 });
    mkdirSync(restoreOutputDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    if (prevForgeorbit !== undefined) {
      process.env.FORGEORBIT_DATA_DIR = prevForgeorbit;
    } else {
      delete process.env.FORGEORBIT_DATA_DIR;
    }
    if (prevAgetor !== undefined) {
      process.env.AGETOR_DATA_DIR = prevAgetor;
    } else {
      delete process.env.AGETOR_DATA_DIR;
    }

    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  });

  function setupProfileDatabase(dbFilename = "agetor.sqlite"): {
    db: Database;
    dbPath: string;
  } {
    const dbPath = path.join(dataDir, dbFilename);
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    migrate(db, migrations);

    db.run(
      "INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)",
      ["/code/test-project", "Test Project", 1000],
    );

    return { db, dbPath };
  }

  function addKnowledgeNote(
    db: Database,
    id: string,
    revision: number,
    content: string,
    owner = { kind: "project", id: "/code/test-project" },
  ): { docId: string; revision: number; sha256: string; byteLength: number } {
    const bytes = Buffer.from(content, "utf8");
    const hash = sha256Hex(bytes);
    const byteLength = bytes.length;
    const now = Date.now();

    const docBodiesDir = path.join(knowledgeRootDir, "bodies", id);
    mkdirSync(docBodiesDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(docBodiesDir, `${revision}.md`);
    writeFileSync(filePath, bytes, { mode: 0o600 });

    if (revision === 1) {
      db.run(
        `INSERT INTO knowledge_documents (
           id, owner_kind, owner_id, title, description, category, tags_json, sensitive,
           revision, created_at, updated_at, archived_at, content_sha256, byte_length
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          id,
          owner.kind,
          owner.id,
          `Title for ${id}`,
          "Desc",
          "general",
          "[]",
          0,
          1,
          now,
          now,
          hash,
          byteLength,
        ],
      );
    } else {
      db.run(
        `UPDATE knowledge_documents SET revision = ?, updated_at = ?, content_sha256 = ?, byte_length = ? WHERE id = ?`,
        [revision, now, hash, byteLength, id],
      );
    }

    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, ?, ?, ?, ?)`,
      [id, revision, now, byteLength, hash],
    );

    return { docId: id, revision, sha256: hash, byteLength };
  }

  // ── Test 1: Full profile snapshot with SQLite, Knowledge, attachments, and issue-thread files ─
  test("1. Full profile snapshot captures SQLite, Knowledge, attachments, and issue-thread files", async () => {
    const { db } = setupProfileDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "# Project Documentation\nSome architecture details.");

    const taskId = "task-001";
    const attFilename = "spec.pdf";
    const attPath = path.join(attachmentsRootDir, attFilename);
    writeFileSync(attPath, "binary spec content", { mode: 0o600 });

    const issueThreadDir = path.join(issueThreadsRootDir, taskId);
    mkdirSync(issueThreadDir, { recursive: true, mode: 0o700 });
    const threadPath = path.join(issueThreadDir, "thread.jsonl");
    writeFileSync(threadPath, JSON.stringify({ role: "user", content: "issue context" }) + "\n", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, refs, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        "Analyze spec",
        "Please inspect attachments",
        "ready",
        "claude-code",
        "/code/test-project",
        "worktree",
        JSON.stringify([threadPath]),
        JSON.stringify([attPath]),
        1001,
        1001,
      ],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    expect(existsSync(snap.path)).toBe(true);
    expect([2, 3, 4]).toContain(snap.manifest.manifestVersion);
    expect(snap.manifest.coverage).toBe("complete-profile");
    expect(snap.manifest.stats.attachmentCount).toBe(1);
    expect(snap.manifest.stats.issueThreadCount).toBe(1);
    expect(snap.manifest.stats.knowledgeRevisionCount).toBe(1);
    expect(snap.manifest.stats.knowledgeDocumentCount).toBe(1);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
    expect(ver.issues.length).toBe(0);

    db.close();
  });

  // ── Test 2: Pipeline artifact inclusion when classified as durable ─────────
  test("2. Pipeline artifact inclusion when classified as durable JSON handoffs", async () => {
    const { db } = setupProfileDatabase();
    const parentTaskId = "pipe-parent-01";
    const stepTaskId = "pipe-step-02";

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [parentTaskId, "Pipeline Parent", "Run pipeline", "ready", "claude-code", "/code/test-project", "worktree", 1000, 1000],
    );

    const pipeDir = path.join(pipelineRunsRootDir, parentTaskId);
    mkdirSync(pipeDir, { recursive: true, mode: 0o700 });
    const handoffFile = path.join(pipeDir, "handoff-step1.json");
    writeFileSync(handoffFile, JSON.stringify({ phase: "compile", output: "success" }), { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, refs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [stepTaskId, "Pipeline Step 2", "Continue from step 1", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([handoffFile]), 1001, 1001],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    expect(snap.manifest.stats.pipelineRunCount).toBe(1);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");

    const pipeEntry = snap.manifest.files.find((f) => f.path.startsWith("pipeline-runs/"));
    expect(pipeEntry).toBeDefined();
    expect(pipeEntry?.category).toBe("pipeline-run");

    db.close();
  });

  // ── Test 3: Additional persistent categories discovered during inventory (screenshots) ───
  test("3. Screenshots category is inventoried, packaged, and verified under screenshots/", async () => {
    const { db } = setupProfileDatabase();
    const taskId = "task-ui-review";
    const scrFilename = "mockup-preview.png";
    const scrPath = path.join(screenshotsRootDir, scrFilename);
    writeFileSync(scrPath, "fake png header and bytes", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, "Review UI", "Check attached screenshot", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([scrPath]), 1000, 1000],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    expect(snap.manifest.stats.screenshotCount).toBe(1);

    const scrEntry = snap.manifest.files.find((f) => f.path.startsWith("screenshots/"));
    expect(scrEntry).toBeDefined();
    expect(scrEntry?.category).toBe("screenshot");

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");

    db.close();
  });

  // ── Test 4: Database records referencing missing attachments ───────────────
  test("4. Database record referencing missing attachment fails snapshot creation or verification", async () => {
    const { db } = setupProfileDatabase();
    const missingAtt = path.join(attachmentsRootDir, "ghost-file.pdf");

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-ghost", "Ghost Task", "Refs missing file", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([missingAtt]), 1000, 1000],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    let threw = false;
    try {
      await manager.createSnapshot({ destinationDir: backupOutputDir, maxRetries: 0 });
    } catch (err) {
      threw = true;
      expect((err as BackupManagerError).code).toMatch(/INCONSISTENT_ASSET|FILE_NOT_FOUND/);
    }
    expect(threw).toBe(true);

    db.close();
  });

  // ── Test 5: Concurrent file deletion racing with snapshot creation ────────
  test("5. Concurrent file deletion racing with snapshot creation triggers bounded retry and recovers", async () => {
    const { db } = setupProfileDatabase();
    const taskId = "task-race-delete";
    const att1 = path.join(attachmentsRootDir, "att1.txt");
    writeFileSync(att1, "initial content", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, "Race Task", "Prompt", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([att1]), 1000, 1000],
    );

    let deleteTriggered = false;
    let retryCount = 0;

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({
      destinationDir: backupOutputDir,
      onRetry: () => {
        retryCount++;
      },
      afterDatabaseBackup: async () => {
        if (!deleteTriggered) {
          deleteTriggered = true;
          // Concurrently delete file from disk and update live DB
          unlinkSync(att1);
          db.run("UPDATE tasks SET sent_files = NULL WHERE id = ?", [taskId]);
        }
      },
    });

    expect(retryCount).toBe(1);
    expect(snap.manifest.stats.attachmentCount).toBe(0);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");

    db.close();
  });

  // ── Test 6: File modification racing with snapshot creation ───────────────
  test("6. File modification during copy is detected via stat/hash validation", async () => {
    const { db } = setupProfileDatabase();
    const attPath = path.join(attachmentsRootDir, "mod-race.bin");
    writeFileSync(attPath, "initial stable bytes", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-mod", "Mod task", "Prompt", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([attPath]), 1000, 1000],
    );

    let retryCount = 0;
    let modifyDone = false;

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({
      destinationDir: backupOutputDir,
      onRetry: () => {
        retryCount++;
      },
      duringAssetCopy: async (relPath, sourcePath) => {
        if (!modifyDone && relPath === "attachments/mod-race.bin") {
          modifyDone = true;
          // Mutate source file right after copy to trigger TOCTOU check failure on attempt 1
          writeFileSync(sourcePath, "modified newly written content", { mode: 0o600 });
        }
      },
    });

    expect(retryCount).toBe(1);
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);

    db.close();
  });

  // ── Test 7: Path traversal payloads in attachment records ──────────────────
  test("7. Path traversal payloads in database records are rejected", async () => {
    const { db } = setupProfileDatabase();
    // Path traversal attempting to escape attachments/
    const maliciousRef = "attachments/../some-parent-file.txt";

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-traversal", "Traversal task", "Prompt", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([maliciousRef]), 1000, 1000],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    let threw = false;
    try {
      await manager.createSnapshot({ destinationDir: backupOutputDir, maxRetries: 0 });
    } catch (err) {
      threw = true;
      expect((err as BackupManagerError).code).toBe("INVALID_PATH");
    }
    expect(threw).toBe(true);

    db.close();
  });

  // ── Test 8: External paths referenced by records ───────────────────────────
  test("8. External project repository paths referenced by tasks are never copied into profile snapshot", async () => {
    const { db } = setupProfileDatabase();
    const externalFile = path.join(testRoot, "external-project", "src", "index.ts");
    mkdirSync(path.dirname(externalFile), { recursive: true, mode: 0o700 });
    writeFileSync(externalFile, "console.log('external');", { mode: 0o600 });

    const localAtt = path.join(attachmentsRootDir, "local.txt");
    writeFileSync(localAtt, "local asset content", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, refs, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-ext",
        "External refs task",
        "Prompt",
        "ready",
        "claude-code",
        "/code/test-project",
        "worktree",
        JSON.stringify([externalFile]), // external path outside dataDir
        JSON.stringify([localAtt]),     // internal profile path
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    expect(snap.manifest.coverage).toBe("complete-profile");

    // Verify snapshot does NOT contain external paths
    for (const file of snap.manifest.files) {
      expect(file.path.startsWith("/")).toBe(false);
      expect(file.path.includes("external-project")).toBe(false);
    }

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);

    db.close();
  });

  // ── Test 9: Secrets and runtime files present in data directory ────────────
  test("9. PID files, lock files, credentials, and transient caches are excluded from snapshot", async () => {
    const { db } = setupProfileDatabase();

    // Plant forbidden / transient files directly inside dataDir
    writeFileSync(path.join(dataDir, "agetor.pid"), "12345\n");
    writeFileSync(path.join(dataDir, "forgeorbit.pid"), "12345\n");
    writeFileSync(path.join(dataDir, "agetor.creds.json"), JSON.stringify({ secret: "token-abc" }));
    writeFileSync(path.join(dataDir, "core-creds.json"), JSON.stringify({ secret: "token-def" }));
    writeFileSync(path.join(dataDir, "github-tokens.json"), JSON.stringify({ oauth: "gho_secret" }));
    writeFileSync(path.join(dataDir, "desktop-instance.lock"), "lock");
    writeFileSync(path.join(dataDir, "daemon.log"), "log line 1\n");

    const transientDir = path.join(dataDir, "daemon-logs");
    mkdirSync(transientDir, { recursive: true });
    writeFileSync(path.join(transientDir, "daemon.log"), "transient log\n");

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Verify none of the forbidden files appear in manifest
    for (const f of snap.manifest.files) {
      expect(f.path).not.toMatch(/pid|creds|token|lock|log/i);
    }

    // Verify on disk in snapshot directory
    expect(existsSync(path.join(snap.path, "agetor.pid"))).toBe(false);
    expect(existsSync(path.join(snap.path, "agetor.creds.json"))).toBe(false);
    expect(existsSync(path.join(snap.path, "desktop-instance.lock"))).toBe(false);
    expect(existsSync(path.join(snap.path, "daemon.log"))).toBe(false);
    expect(existsSync(path.join(snap.path, "daemon-logs"))).toBe(false);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);

    db.close();
  });

  // ── Test 10: Complete profile restore into an inactive destination directory 
  test("10. Complete profile restore extracts all persistent asset categories with verified permissions", async () => {
    const { db } = setupProfileDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "# Title\nRestored body content.");

    const taskId = "task-restore-01";
    const attPath = path.join(attachmentsRootDir, "invoice.pdf");
    writeFileSync(attPath, "%PDF-1.4 invoice data", { mode: 0o600 });

    const scrPath = path.join(screenshotsRootDir, "preview.png");
    writeFileSync(scrPath, "png preview data", { mode: 0o600 });

    const threadDir = path.join(issueThreadsRootDir, taskId);
    mkdirSync(threadDir, { recursive: true, mode: 0o700 });
    const threadPath = path.join(threadDir, "thread.jsonl");
    writeFileSync(threadPath, JSON.stringify({ role: "assistant", content: "hello" }) + "\n", { mode: 0o600 });

    const pipeDir = path.join(pipelineRunsRootDir, taskId);
    mkdirSync(pipeDir, { recursive: true, mode: 0o700 });
    const handoffPath = path.join(pipeDir, "step.json");
    writeFileSync(handoffPath, JSON.stringify({ ok: true }), { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, refs, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        "Full task",
        "Task prompt",
        "ready",
        "claude-code",
        "/code/test-project",
        "worktree",
        JSON.stringify([threadPath, handoffPath, scrPath]),
        JSON.stringify([attPath]),
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    const targetRestoreDir = path.join(restoreOutputDir, "restored-profile");
    const restoreResult = await restoreBackupSnapshot(snap.path, targetRestoreDir, {
      requireCompleteProfile: true,
    });

    expect(restoreResult.coverage).toBe("complete-profile");
    expect(restoreResult.attachmentCount).toBe(1);
    expect(restoreResult.screenshotCount).toBe(1);
    expect(restoreResult.issueThreadCount).toBe(1);
    expect(restoreResult.pipelineRunCount).toBe(1);
    expect(restoreResult.knowledgeDocumentCount).toBe(1);
    expect(restoreResult.knowledgeRevisionCount).toBe(1);

    // Verify restored file structure on disk
    expect(existsSync(path.join(targetRestoreDir, "agetor.sqlite"))).toBe(true);
    expect(existsSync(path.join(targetRestoreDir, "attachments", "invoice.pdf"))).toBe(true);
    expect(existsSync(path.join(targetRestoreDir, "screenshots", "preview.png"))).toBe(true);
    expect(existsSync(path.join(targetRestoreDir, "issue-threads", taskId, "thread.jsonl"))).toBe(true);
    expect(existsSync(path.join(targetRestoreDir, "pipeline-runs", taskId, "step.json"))).toBe(true);
    expect(existsSync(path.join(targetRestoreDir, "knowledge", "bodies", docId, "1.md"))).toBe(true);

    // Verify mode 0o600 on restored files
    const stAtt = statSync(path.join(targetRestoreDir, "attachments", "invoice.pdf"));
    expect(stAtt.mode & 0o777).toBe(0o600);
  });

  // ── Test 11: Verification and restoration of legacy (manifestVersion 1) snapshots 
  test("11. Legacy (manifestVersion 1) snapshot verifies and restores with legacy-database-knowledge coverage", async () => {
    const { db } = setupProfileDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "# Legacy doc body");

    const manager = new BackupManager({
      db,
      knowledgeRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir, manifestVersion: 1 });
    db.close();

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("legacy-database-knowledge");

    const targetRestoreDir = path.join(restoreOutputDir, "restored-legacy");
    const restoreResult = await restoreBackupSnapshot(snap.path, targetRestoreDir);

    expect(restoreResult.coverage).toBe("legacy-database-knowledge");
    expect(existsSync(path.join(targetRestoreDir, "agetor.sqlite"))).toBe(true);
    expect(existsSync(path.join(targetRestoreDir, "knowledge", "bodies", docId, "1.md"))).toBe(true);
  });

  // ── Test 12: Incomplete legacy restore fails when requireCompleteProfile is set ─
  test("12. Legacy snapshot restore fails with INCOMPLETE_PROFILE when requireCompleteProfile: true", async () => {
    const { db } = setupProfileDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Legacy note");

    const manager = new BackupManager({ db, knowledgeRootDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir, manifestVersion: 1 });
    db.close();

    const targetRestoreDir = path.join(restoreOutputDir, "fail-legacy");
    let errCode = "";
    try {
      await restoreBackupSnapshot(snap.path, targetRestoreDir, {
        requireCompleteProfile: true,
      });
    } catch (err) {
      errCode = (err as RestoreError).code;
    }
    expect(errCode).toBe("INCOMPLETE_PROFILE");
    expect(existsSync(targetRestoreDir)).toBe(false);
  });

  // ── Test 13: Unmanifested files inserted into snapshot fail verification and restore 
  test("13. Unmanifested files in snapshot fail verification and restore", async () => {
    const { db } = setupProfileDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    // Tamper with snapshot by creating an unmanifested attachment file
    const tamperedFile = path.join(snap.path, "attachments", "unmanifested.png");
    mkdirSync(path.dirname(tamperedFile), { recursive: true });
    writeFileSync(tamperedFile, "tampered unmanifested bytes");

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("Unmanifested file"))).toBe(true);

    const targetRestoreDir = path.join(restoreOutputDir, "tampered-restore");
    let errCode = "";
    try {
      await restoreBackupSnapshot(snap.path, targetRestoreDir);
    } catch (err) {
      errCode = (err as RestoreError).code;
    }
    expect(errCode).toBe("SNAPSHOT_VERIFICATION_FAILED");
    expect(existsSync(targetRestoreDir)).toBe(false);
  });

  // ── Test 14: Corrupted attachments detected during verification and restoration ──
  test("14. Corrupted attachment in snapshot is detected and rejected", async () => {
    const { db } = setupProfileDatabase();
    const attPath = path.join(attachmentsRootDir, "corrupt-target.bin");
    writeFileSync(attPath, "original valid bytes", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-corrupt", "Task", "Prompt", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify([attPath]), 1000, 1000],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    // Corrupt the attachment in the published snapshot
    const snapAtt = path.join(snap.path, "attachments", "corrupt-target.bin");
    writeFileSync(snapAtt, "tampered different bytes");

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.toLowerCase().includes("checksum mismatch"))).toBe(true);

    const targetRestoreDir = path.join(restoreOutputDir, "corrupt-restore");
    let errCode = "";
    try {
      await restoreBackupSnapshot(snap.path, targetRestoreDir);
    } catch (err) {
      errCode = (err as RestoreError).code;
    }
    expect(errCode).toBe("SNAPSHOT_VERIFICATION_FAILED");
    expect(existsSync(targetRestoreDir)).toBe(false);
  });

  // ── Test 15: Restoring into an existing or active profile directory ─────────
  test("15. Restore fails closed if target exists or is an active profile directory", async () => {
    const { db } = setupProfileDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    // 1. Target already exists
    const existingTarget = path.join(restoreOutputDir, "pre-existing");
    mkdirSync(existingTarget, { recursive: true });

    let errCode1 = "";
    try {
      await restoreBackupSnapshot(snap.path, existingTarget);
    } catch (err) {
      errCode1 = (err as RestoreError).code;
    }
    expect(errCode1).toBe("TARGET_EXISTS");

    // 2. Target is inside active data directory
    const activeTarget = path.join(dataDir, "sub-restore");
    let errCode2 = "";
    try {
      process.env.FORGEORBIT_DATA_DIR = dataDir;
      await restoreBackupSnapshot(snap.path, activeTarget);
    } catch (err) {
      errCode2 = (err as RestoreError).code;
    } finally {
      delete process.env.FORGEORBIT_DATA_DIR;
    }
    expect(errCode2).toBe("ACTIVE_PROFILE_PROTECTED");
  });

  // ── Test 16: Inactive target publication under concurrent collision ────────
  test("16. Restore publication fails closed and cleans staging if target is created concurrently before publication", async () => {
    const { db } = setupProfileDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    const targetDir = path.join(restoreOutputDir, "collision-target");

    let errCode = "";
    try {
      await restoreBackupSnapshot(snap.path, targetDir, {
        beforePublish: async () => {
          // Concurrently create target right before publish
          mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        },
      });
    } catch (err) {
      errCode = (err as RestoreError).code;
    }
    expect(errCode).toBe("TARGET_EXISTS");

    // Staging directory must be cleaned up
    const remainingInParent = cleanIncompleteRestoreStaging(restoreOutputDir);
    expect(remainingInParent.cleaned.length).toBe(0);
  });

  // ── Test 17: Large profile handling with streaming and bounded counts ─────
  test("17. Large profiles with many files are created and verified without memory overflow", async () => {
    const { db } = setupProfileDatabase();
    const taskRefs: string[] = [];

    // Create 50 synthetic attachments
    for (let i = 0; i < 50; i++) {
      const name = `asset-${i.toString().padStart(3, "0")}.dat`;
      const fullPath = path.join(attachmentsRootDir, name);
      writeFileSync(fullPath, Buffer.alloc(1024, i % 256), { mode: 0o600 });
      taskRefs.push(fullPath);
    }

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-many", "Many files", "Prompt", "ready", "claude-code", "/code/test-project", "worktree", JSON.stringify(taskRefs), 1000, 1000],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    expect(snap.manifest.stats.attachmentCount).toBe(50);
    expect(snap.manifest.stats.fileCount).toBe(51); // 50 attachments + 1 sqlite db

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");

    db.close();
  });

  // ── Test 18: Manifest bounds enforcement ───────────────────────────────────
  test("18. Corrupted or oversized manifest (>10 MiB) is rejected", async () => {
    const { db } = setupProfileDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    const manifestPath = path.join(snap.path, "manifest.json");
    // Append oversized padding to manifest file to exceed 10 MiB limit
    const fd = Bun.file(manifestPath);
    const original = await fd.text();
    const padding = " ".repeat(10 * 1024 * 1024 + 1024);
    writeFileSync(manifestPath, original + padding);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("exceeds maximum size limit"))).toBe(true);
  });

  // ── Test 19: Cancellation during heavy copying with complete cleanup ───────
  test("19. Cancellation during snapshot creation cleans up staging directory", async () => {
    const { db, dbPath } = setupProfileDatabase();
    // Insert several attachments
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(attachmentsRootDir, `file-${i}.txt`), "data");
    }

    const runner = new BackupProcessRunner();
    const opPromise = runner.createSnapshot(dbPath, backupOutputDir, {
      dataDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
      knowledgeRootDir,
    });

    const active = runner.listOperations();
    expect(active.length).toBeGreaterThanOrEqual(1);
    const opId = active[0]!.operationId;

    const cancelSuccess = await runner.cancel(opId, { force: true });
    expect(cancelSuccess).toBe(true);

    let threw = false;
    try {
      await opPromise;
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/cancel/i);
    }
    expect(threw).toBe(true);

    runner.dispose();
    db.close();

    // Verify staging directory is cleaned up
    const remaining = cleanIncompleteBackupSnapshots(backupOutputDir);
    expect(remaining.cleaned.length).toBe(0);
  });

  // ── Test 20: Crash or process failure with staging cleanup ──────────────────
  test("20. cleanIncompleteBackupSnapshots reclaims staging directories from dead processes", () => {
    // Manually create an orphaned staging directory with dead PID
    const deadOpId = randomUUID();
    const orphanStaging = path.join(backupOutputDir, `.orphaned.fo-snapshot.${deadOpId}.tmp`);
    mkdirSync(orphanStaging, { recursive: true, mode: 0o700 });

    const metadata = {
      version: 1,
      subsystem: "backup-manager",
      operationId: deadOpId,
      pid: 9999999, // non-existent PID
      createdAt: Date.now() - 60000,
      state: "writing",
      targetPath: path.join(backupOutputDir, `snap-${deadOpId}`),
    };
    writeFileSync(path.join(orphanStaging, ".forgeorbit-ownership.json"), JSON.stringify(metadata));

    const scan = cleanIncompleteBackupSnapshots(backupOutputDir);
    expect(scan.cleaned).toContain(orphanStaging);
    expect(existsSync(orphanStaging)).toBe(false);
  });

  // ── Test 21: Independent verification reporting exact category counts and coverage ──
  test("21. Independent verifier reports exact category counts and coverage classification", async () => {
    const { db } = setupProfileDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Doc note 1");
    addKnowledgeNote(db, docId, 2, "Doc note 2");

    const taskId = "task-complete-stats";
    const att1 = path.join(attachmentsRootDir, "a1.txt");
    const att2 = path.join(attachmentsRootDir, "a2.txt");
    writeFileSync(att1, "att 1", { mode: 0o600 });
    writeFileSync(att2, "att 2", { mode: 0o600 });

    const scr1 = path.join(screenshotsRootDir, "s1.png");
    writeFileSync(scr1, "scr 1", { mode: 0o600 });

    const threadDir = path.join(issueThreadsRootDir, taskId);
    mkdirSync(threadDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(threadDir, "t1.jsonl"), "{}\n", { mode: 0o600 });

    const pipeDir = path.join(pipelineRunsRootDir, taskId);
    mkdirSync(pipeDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(pipeDir, "p1.json"), "{}\n", { mode: 0o600 });

    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, refs, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        "Task stats",
        "Prompt",
        "ready",
        "claude-code",
        "/code/test-project",
        "worktree",
        JSON.stringify([path.join(threadDir, "t1.jsonl"), path.join(pipeDir, "p1.json"), scr1]),
        JSON.stringify([att1, att2]),
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({
      db,
      dataDir,
      knowledgeRootDir,
      attachmentsRootDir,
      screenshotsRootDir,
      issueThreadsRootDir,
      pipelineRunsRootDir,
    });

    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    db.close();

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
    expect(ver.manifest).toBeDefined();

    const stats = ver.manifest!.stats;
    expect(stats.attachmentCount).toBe(2);
    expect(stats.screenshotCount).toBe(1);
    expect(stats.issueThreadCount).toBe(1);
    expect(stats.pipelineRunCount).toBe(1);
    expect(stats.knowledgeDocumentCount).toBe(1);
    expect(stats.knowledgeRevisionCount).toBe(2);
    expect(stats.fileCount).toBe(8); // 1 db + 2 revisions + 2 attachments + 1 screenshot + 1 thread + 1 pipe
  });
});
