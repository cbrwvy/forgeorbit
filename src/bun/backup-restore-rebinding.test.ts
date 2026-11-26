/**
 * Regression and Contract Verification Tests for FO-P2-003-R5B:
 * Portable Internal References and Safe Restore Rebinding.
 *
 * All tests use isolated synthetic profiles, temporary test directories,
 * and assert that the real user profile is never touched.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BackupManager,
  sha256Hex,
  type SnapshotManifest,
} from "./backup-manager.ts";
import {
  restoreBackupSnapshot,
} from "./backup-restore.ts";
import { BackupProcessRunner } from "./backup-runner.ts";
import { setupIsolatedTestProfile, type IsolatedTestProfile } from "./test-isolation.ts";

function computeHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function initSyntheticDatabase(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES ('095_task_queue_progression', 1000);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      column TEXT NOT NULL,
      agent TEXT NOT NULL,
      workdir TEXT NOT NULL,
      isolation TEXT NOT NULL DEFAULT 'worktree',
      branch TEXT,
      worktree_path TEXT,
      refs TEXT NOT NULL DEFAULT '[]',
      attachments TEXT NOT NULL DEFAULT '[]',
      sent_files TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      home TEXT,
      bin TEXT,
      env_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS environment_profiles (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      project_path TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      tags_json TEXT NOT NULL DEFAULT '[]',
      sensitive INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      content_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, revision)
    );
  `);
}

async function createSnapshotFromProfile(srcProfile: string, db: Database, manifestVersion: 1 | 2 | 3 | 4 = 4) {
  const manager = new BackupManager({ db, dataDir: srcProfile });
  const snapshotsDir = path.join(path.dirname(srcProfile), "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
  return manager.createSnapshot({
    destinationDir: snapshotsDir,
    createDirectory: true,
    manifestVersion,
  });
}

describe("FO-P2-003-R5B: Portable Internal References and Safe Restore Rebinding", () => {
  let isolatedProfile: IsolatedTestProfile;
  let testRoot: string;

  beforeEach(() => {
    isolatedProfile = setupIsolatedTestProfile("fo-r5b-suite-");
    testRoot = path.join(isolatedProfile.root, "workspace");
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    isolatedProfile.cleanup();
  });

  // ── 1. Same-Mac restore into a different application data directory ─────────
  test("1. Same-Mac restore into a different application data directory rebinds internal references", async () => {
    const srcProfile = path.join(testRoot, "src-profile-1");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const attFile = path.join(srcProfile, "attachments", "report.pdf");
    writeFileSync(attFile, "pdf report content", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-1",
        "Task 1",
        "Prompt",
        "ready",
        "claude-code",
        "/external/code",
        JSON.stringify([{ path: attFile, isDirectory: false }]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-profile-1");
    const restoreRes = await restoreBackupSnapshot(snap.path, destProfile, {
      requireCompleteProfile: true,
      rebindInternalReferences: true,
    });

    expect(restoreRes.databaseTransformed).toBe(true);
    expect(restoreRes.rebindingStats?.rebound).toBe(1);
    expect(restoreRes.rebindingStats?.discovered).toBe(1);
    expect(restoreRes.activationReadiness).toBe("requires-external-recovery"); // /external/code not on disk

    // Verify rewritten reference in restored SQLite database
    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("task-1");
    restoredDb.close();

    expect(row).toBeDefined();
    const refs = JSON.parse(row!.refs);
    expect(refs[0].path).toBe(path.join(destProfile, "attachments", "report.pdf"));
    expect(existsSync(refs[0].path)).toBe(true);
    expect(readFileSync(refs[0].path, "utf8")).toBe("pdf report content");
  });

  // ── 2. Cross-Mac-style restore into a different username/root path ──────────
  test("2. Cross-Mac-style restore into a different username/root path rebinds cleanly", async () => {
    const srcProfile = path.join(testRoot, "alice-profile");
    mkdirSync(path.join(srcProfile, "screenshots"), { recursive: true });
    const scrFile = path.join(srcProfile, "screenshots", "screen.png");
    writeFileSync(scrFile, "image data", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-cross",
        "Cross Task",
        "Prompt",
        "ready",
        "claude-code",
        "/Users/alice/projects/app",
        JSON.stringify([{ path: scrFile, isDirectory: false }]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const bobProfile = path.join(testRoot, "bob-profile");
    const restoreRes = await restoreBackupSnapshot(snap.path, bobProfile, {
      rebindInternalReferences: true,
    });

    expect(restoreRes.rebindingStats?.rebound).toBe(1);
    const restoredDb = new Database(path.join(bobProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("task-cross");
    restoredDb.close();

    const refs = JSON.parse(row!.refs);
    expect(refs[0].path).toBe(path.join(bobProfile, "screenshots", "screen.png"));
    expect(existsSync(refs[0].path)).toBe(true);
  });

  // ── 3. Multiple internal references in a single JSON field ──────────────────
  test("3. Multiple internal references in a single JSON field are all rebound with locators", async () => {
    const srcProfile = path.join(testRoot, "multi-ref-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    mkdirSync(path.join(srcProfile, "screenshots"), { recursive: true });

    const f1 = path.join(srcProfile, "attachments", "1.pdf");
    const f2 = path.join(srcProfile, "attachments", "2.pdf");
    const f3 = path.join(srcProfile, "screenshots", "shot.png");
    writeFileSync(f1, "1", { mode: 0o600 });
    writeFileSync(f2, "2", { mode: 0o600 });
    writeFileSync(f3, "3", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-multi",
        "Multi",
        "Prompt",
        "ready",
        "claude-code",
        "/code",
        JSON.stringify([
          { path: f1, isDirectory: false },
          { path: f2, isDirectory: false },
          { path: f3, isDirectory: false },
        ]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-multi");
    const restoreRes = await restoreBackupSnapshot(snap.path, destProfile, {
      rebindInternalReferences: true,
    });

    expect(restoreRes.rebindingStats?.rebound).toBe(3);
    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("task-multi");
    restoredDb.close();

    const refs = JSON.parse(row!.refs);
    expect(refs[0].path).toBe(path.join(destProfile, "attachments", "1.pdf"));
    expect(refs[1].path).toBe(path.join(destProfile, "attachments", "2.pdf"));
    expect(refs[2].path).toBe(path.join(destProfile, "screenshots", "shot.png"));
  });

  // ── 4. Mixed internal and external references in the same field ─────────────
  test("4. Mixed internal and external references preserve external paths unchanged", async () => {
    const srcProfile = path.join(testRoot, "mixed-ref-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const intFile = path.join(srcProfile, "attachments", "internal.txt");
    writeFileSync(intFile, "int", { mode: 0o600 });
    const extFile = "/some/external/repo/src/main.ts";

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-mixed",
        "Mixed",
        "Prompt",
        "ready",
        "claude-code",
        "/some/external/repo",
        JSON.stringify([
          { path: intFile, isDirectory: false },
          { path: extFile, isDirectory: false },
        ]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-mixed");
    const restoreRes = await restoreBackupSnapshot(snap.path, destProfile, {
      rebindInternalReferences: true,
    });

    expect(restoreRes.rebindingStats?.rebound).toBe(1);
    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("task-mixed");
    restoredDb.close();

    const refs = JSON.parse(row!.refs);
    expect(refs[0].path).toBe(path.join(destProfile, "attachments", "internal.txt"));
    expect(refs[1].path).toBe(extFile); // preserved unchanged!
  });

  // ── 5. Nested structured references supported by current schema ─────────────
  test("5. Nested structured references in refs, attachments, and sent_files preserve extra properties", async () => {
    const srcProfile = path.join(testRoot, "nested-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const attFile = path.join(srcProfile, "attachments", "legacy.png");
    const sentFile = path.join(srcProfile, "attachments", "delivered.zip");
    writeFileSync(attFile, "img", { mode: 0o600 });
    writeFileSync(sentFile, "zip", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-struct",
        "Struct",
        "Prompt",
        "ready",
        "claude-code",
        "/code",
        "[]",
        JSON.stringify([{ name: "legacy", path: attFile, mimeType: "image/png" }]),
        JSON.stringify([{ path: sentFile, filename: "delivered.zip", mimeType: "application/zip", sizeBytes: 3, sentAt: 12345 }]),
        1000,
        1000,
      ],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-struct");
    const restoreRes = await restoreBackupSnapshot(snap.path, destProfile, {
      rebindInternalReferences: true,
    });

    expect(restoreRes.rebindingStats?.rebound).toBe(2);
    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ attachments: string; sent_files: string }, [string]>(
      "SELECT attachments, sent_files FROM tasks WHERE id = ?;",
    ).get("task-struct");
    restoredDb.close();

    const atts = JSON.parse(row!.attachments);
    expect(atts[0].name).toBe("legacy");
    expect(atts[0].mimeType).toBe("image/png");
    expect(atts[0].path).toBe(path.join(destProfile, "attachments", "legacy.png"));

    const sents = JSON.parse(row!.sent_files);
    expect(sents[0].filename).toBe("delivered.zip");
    expect(sents[0].sizeBytes).toBe(3);
    expect(sents[0].sentAt).toBe(12345);
    expect(sents[0].path).toBe(path.join(destProfile, "attachments", "delivered.zip"));
  });

  // ── 6. Exact reference locator mismatch ─────────────────────────────────────
  test("6. Exact reference locator hash mismatch fails restore closed", async () => {
    const srcProfile = path.join(testRoot, "mismatch-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const attFile = path.join(srcProfile, "attachments", "data.txt");
    writeFileSync(attFile, "data", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-mis", "Mis", "P", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    // Tamper manifest internalReferences hash to cause a mismatch
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.internalReferences![0]!.rawRefSha256 = "0000000000000000000000000000000000000000000000000000000000000000";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const destProfile = path.join(testRoot, "dest-mismatch");
    await expect(
      restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true }),
    ).rejects.toThrow();

    expect(existsSync(destProfile)).toBe(false);
  });

  // ── 7. Missing referenced file ──────────────────────────────────────────────
  test("7. Missing referenced file fails restore closed", async () => {
    const srcProfile = path.join(testRoot, "missing-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const attFile = path.join(srcProfile, "attachments", "exist.txt");
    writeFileSync(attFile, "exist", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-miss", "Miss", "P", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    // Delete the file from the snapshot folder
    rmSync(path.join(snap.path, "attachments", "exist.txt"), { force: true });

    const destProfile = path.join(testRoot, "dest-missing");
    await expect(
      restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true }),
    ).rejects.toThrow();

    expect(existsSync(destProfile)).toBe(false);
  });

  // ── 8. Tampered mapping metadata ────────────────────────────────────────────
  test("8. Tampered mapping metadata (unapproved table or column) is rejected", async () => {
    const srcProfile = path.join(testRoot, "tamper-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const attFile = path.join(srcProfile, "attachments", "file.txt");
    writeFileSync(attFile, "file", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-tamper", "Tamper", "P", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.internalReferences![0]!.table = "arbitrary_table";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const destProfile = path.join(testRoot, "dest-tamper");
    await expect(
      restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true }),
    ).rejects.toThrow(/Unsupported table/);

    expect(existsSync(destProfile)).toBe(false);
  });

  // ── 9. Ambiguous original reference values ──────────────────────────────────
  test("9. Ambiguous original reference values without jsonPath locator fail closed", async () => {
    const srcProfile = path.join(testRoot, "ambig-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const attFile = path.join(srcProfile, "attachments", "ambig.txt");
    writeFileSync(attFile, "ambig", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    // Duplicate identical path in refs array
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-ambig", "Ambig", "P", "ready", "claude-code", "/code", JSON.stringify([attFile, attFile]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    // Remove jsonPath to simulate an ambiguous/unlocatable entry
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.internalReferences![0]!.jsonPath;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const destProfile = path.join(testRoot, "dest-ambig");
    await expect(
      restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true }),
    ).rejects.toThrow(/jsonPath/);

    expect(existsSync(destProfile)).toBe(false);
  });

  // ── 10. Invalid manifest version or unsupported mapping ─────────────────────
  test("10. Invalid manifest version is rejected", async () => {
    const srcProfile = path.join(testRoot, "inv-ver-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.manifestVersion = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const destProfile = path.join(testRoot, "dest-inv-ver");
    await expect(
      restoreBackupSnapshot(snap.path, destProfile),
    ).rejects.toThrow(/unsupported manifestVersion/i);
  });

  // ── 11. Valid legacy snapshot with no automatic rebinding ───────────────────
  test("11. Valid legacy snapshot restores without rebinding and reports legacy-unverified", async () => {
    const srcProfile = path.join(testRoot, "legacy-snap-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-leg", "Legacy", "P", "ready", "claude-code", "/code", "[]", "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 1);
    db.close();

    const destProfile = path.join(testRoot, "dest-legacy-restore");
    const restoreRes = await restoreBackupSnapshot(snap.path, destProfile);

    expect(restoreRes.databaseTransformed).toBe(false);
    expect(restoreRes.rebindingStats?.rebound).toBe(0);
    expect(restoreRes.activationReadiness).toBe("legacy-unverified");
  });

  // ── 12. Internal attachments and screenshots ────────────────────────────────
  test("12. Internal attachments and screenshots categories rebind correctly", async () => {
    const srcProfile = path.join(testRoot, "att-scr-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    mkdirSync(path.join(srcProfile, "screenshots"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "doc.pdf");
    const scr = path.join(srcProfile, "screenshots", "pic.png");
    writeFileSync(att, "pdf", { mode: 0o600 });
    writeFileSync(scr, "png", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-att-scr", "Task", "P", "ready", "claude-code", "/code", JSON.stringify([att, scr]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-att-scr");
    const res = await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    expect(res.rebindingStats?.rebound).toBe(2);
    expect(existsSync(path.join(destProfile, "attachments", "doc.pdf"))).toBe(true);
    expect(existsSync(path.join(destProfile, "screenshots", "pic.png"))).toBe(true);
  });

  // ── 13. Issue-thread and pipeline references ────────────────────────────────
  test("13. Issue-thread and pipeline references rebind correctly", async () => {
    const srcProfile = path.join(testRoot, "iss-pipe-profile");
    mkdirSync(path.join(srcProfile, "issue-threads", "t-iss"), { recursive: true });
    mkdirSync(path.join(srcProfile, "pipeline-runs", "t-iss"), { recursive: true });
    const iss = path.join(srcProfile, "issue-threads", "t-iss", "thread.md");
    const pipe = path.join(srcProfile, "pipeline-runs", "t-iss", "handoff.json");
    writeFileSync(iss, "# Thread", { mode: 0o600 });
    writeFileSync(pipe, JSON.stringify({ done: true }), { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-iss", "Iss Pipe", "P", "ready", "claude-code", "/code", JSON.stringify([iss, pipe]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-iss-pipe");
    const res = await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    expect(res.rebindingStats?.rebound).toBe(2);
    expect(existsSync(path.join(destProfile, "issue-threads", "t-iss", "thread.md"))).toBe(true);
    expect(existsSync(path.join(destProfile, "pipeline-runs", "t-iss", "handoff.json"))).toBe(true);
  });

  // ── 14. Existing external project paths preserved unchanged ─────────────────
  test("14. Existing external project paths in projects table and workdir are preserved unchanged", async () => {
    const srcProfile = path.join(testRoot, "ext-proj-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    const externalProject = path.join(testRoot, "external-project-repo");
    db.run("INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)", [externalProject, "My Repo", 1000]);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-ext", "Ext", "P", "ready", "claude-code", externalProject, "[]", "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-ext-proj");
    await restoreBackupSnapshot(snap.path, destProfile);

    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const projRow = restoredDb.query<{ path: string; name: string }, []>("SELECT path, name FROM projects;").get();
    const taskRow = restoredDb.query<{ workdir: string }, []>("SELECT workdir FROM tasks;").get();
    restoredDb.close();

    expect(projRow?.path).toBe(externalProject);
    expect(taskRow?.workdir).toBe(externalProject);
  });

  // ── 15. Worktree paths preserved and reported as requiring recovery ─────────
  test("15. Worktree paths are preserved unchanged and reported in recovery preview", async () => {
    const srcProfile = path.join(testRoot, "wt-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    const wtPath = "/external/code/.git/worktrees/task-wt";
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, worktree_path, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-wt", "Task WT", "P", "ready", "claude-code", "/external/code", wtPath, "[]", "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-wt");
    const res = await restoreBackupSnapshot(snap.path, destProfile);

    expect(res.recoveryPreview?.worktrees.length).toBe(1);
    expect(res.recoveryPreview?.worktrees[0]?.worktreePath).toBe(wtPath);
    expect(res.recoveryPreview?.worktrees[0]?.status).toBe("missing-disposable");

    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ worktree_path: string }, []>("SELECT worktree_path FROM tasks;").get();
    restoredDb.close();
    expect(row?.worktree_path).toBe(wtPath);
  });

  // ── 16. Activity Journal append-only invariants preserved ───────────────────
  test("16. Activity Journal append-only records are strictly preserved without modification", async () => {
    const srcProfile = path.join(testRoot, "journal-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO activity_events (id, event_type, project_path, actor_type, actor_id, target_type, target_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ev-1", "task-created", "/old/path/project", "owner", "owner-1", "task", "t-1", JSON.stringify({ oldPath: "/old/path/project" }), 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-journal");
    await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const event = restoredDb.query<{ id: string; project_path: string; payload_json: string }, []>(
      "SELECT id, project_path, payload_json FROM activity_events;",
    ).get();
    restoredDb.close();

    expect(event?.id).toBe("ev-1");
    expect(event?.project_path).toBe("/old/path/project"); // unchanged!
    expect(JSON.parse(event!.payload_json).oldPath).toBe("/old/path/project");
  });

  // ── 17. SQLite transaction failure and rollback ─────────────────────────────
  test("17. SQLite transaction failure during rebinding rolls back and leaves no destination", async () => {
    const srcProfile = path.join(testRoot, "tx-fail-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "test.pdf");
    writeFileSync(att, "pdf", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-tx", "Tx", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-tx-fail");
    // Intercept during restore with beforePublish throwing
    await expect(
      restoreBackupSnapshot(snap.path, destProfile, {
        rebindInternalReferences: true,
        beforePublish: () => {
          throw new Error("Simulated failure after rebinding before publish");
        },
      }),
    ).rejects.toThrow("Simulated failure after rebinding before publish");

    expect(existsSync(destProfile)).toBe(false);
  });

  // ── 18. SQLite integrity and foreign-key validation after transformation ────
  test("18. Transformed database passes PRAGMA integrity_check and foreign_key_check", async () => {
    const srcProfile = path.join(testRoot, "integrity-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "att.pdf");
    writeFileSync(att, "pdf", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-int", "Int", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-integrity");
    const res = await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    expect(res.validationStatus).toBe("valid");

    // Independently check integrity of published database
    const publishedDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const integrity = publishedDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
    const fk = publishedDb.query<unknown, []>("PRAGMA foreign_key_check;").all();
    publishedDb.close();

    expect(integrity?.integrity_check).toBe("ok");
    expect(fk.length).toBe(0);
  });

  // ── 19. Knowledge consistency after transformation ──────────────────────────
  test("19. Knowledge document and revision invariants remain consistent after transformation", async () => {
    const srcProfile = path.join(testRoot, "kn-profile");
    const docId = "11111111-2222-3333-4444-555555555555";
    mkdirSync(path.join(srcProfile, "knowledge", "bodies", docId), { recursive: true });
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });

    const knContent = "# Knowledge Document\nConsistent body text.";
    writeFileSync(path.join(srcProfile, "knowledge", "bodies", docId, "1.md"), knContent, { mode: 0o600 });
    const att = path.join(srcProfile, "attachments", "ref.txt");
    writeFileSync(att, "hello", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    const knBytes = Buffer.from(knContent);
    const knHash = sha256Hex(knBytes);
    db.run(
      `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [docId, "project", "p-1", "Kn Doc", 1, 1000, 1000, knHash, knBytes.length],
    );
    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, content_sha256, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [docId, 1, knHash, knBytes.length, 1000],
    );
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-kn", "Kn Task", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-kn");
    const res = await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    expect(res.knowledgeDocumentCount).toBe(1);
    expect(res.knowledgeRevisionCount).toBe(1);
    expect(existsSync(path.join(destProfile, "knowledge", "bodies", docId, "1.md"))).toBe(true);
  });

  // ── 20. Final destination paths embedded in restored database, not staging paths
  test("20. Restored database contains final destination path and never staging .tmp path", async () => {
    const srcProfile = path.join(testRoot, "staging-path-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "test.txt");
    writeFileSync(att, "hello", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-stg", "Stg", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-staging-test");
    await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    const restoredDb = new Database(path.join(destProfile, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, []>("SELECT refs FROM tasks;").get();
    restoredDb.close();

    expect(row?.refs).not.toContain(".tmp");
    expect(row?.refs).not.toContain(".restore.");
    expect(row?.refs).toContain(path.resolve(destProfile));
  });

  // ── 21. Failure before publication leaves no destination ────────────────────
  test("21. Pre-publication failure leaves no destination directory", async () => {
    const srcProfile = path.join(testRoot, "pre-pub-fail-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "dest-pre-pub-fail");
    await expect(
      restoreBackupSnapshot(snap.path, destProfile, {
        beforePublish: () => {
          throw new Error("Abort right before publish");
        },
      }),
    ).rejects.toThrow("Abort right before publish");

    expect(existsSync(destProfile)).toBe(false);
  });

  // ── 22. Existing destination collision is rejected ──────────────────────────
  test("22. Existing destination collision is rejected fail-closed with TARGET_EXISTS", async () => {
    const srcProfile = path.join(testRoot, "collision-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const destProfile = path.join(testRoot, "existing-dest");
    mkdirSync(destProfile, { recursive: true });
    writeFileSync(path.join(destProfile, "keep.txt"), "precious");

    await expect(
      restoreBackupSnapshot(snap.path, destProfile),
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });

    // Ensure pre-existing file was never modified or deleted
    expect(readFileSync(path.join(destProfile, "keep.txt"), "utf8")).toBe("precious");
  });

  // ── 23. Snapshot contents and SHA-256 unchanged by restore ──────────────────
  test("23. Snapshot contents and file SHA-256 digests remain 100% unchanged after restore", async () => {
    const srcProfile = path.join(testRoot, "snap-immutable-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "test.txt");
    writeFileSync(att, "immutable", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-imm", "Imm", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    // Record hashes of snapshot contents before restore
    const snapFiles = ["manifest.json", "database.sqlite", "attachments/test.txt"];
    const hashesBefore = snapFiles.map((f) => computeHash(path.join(snap.path, f)));

    const destProfile = path.join(testRoot, "dest-immutable");
    await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    // Verify hashes after restore are identical
    const hashesAfter = snapFiles.map((f) => computeHash(path.join(snap.path, f)));
    expect(hashesAfter).toEqual(hashesBefore);
  });

  // ── 24. Original versus transformed database SHA-256 recorded correctly ─────
  test("24. Original versus transformed database SHA-256 digests are recorded correctly", async () => {
    const srcProfile = path.join(testRoot, "sha-distinction-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "sample.txt");
    writeFileSync(att, "hello", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-sha", "Sha", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    const manifestDbSha = snap.manifest.files.find((f) => f.path === "database.sqlite")!.sha256;

    const destProfile = path.join(testRoot, "dest-sha-distinction");
    const res = await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    expect(res.originalDatabaseSha256).toBe(manifestDbSha);
    expect(res.databaseTransformed).toBe(true);
    expect(res.databaseSha256).not.toBe(manifestDbSha);
    expect(res.databaseSha256).toBe(computeHash(path.join(destProfile, "agetor.sqlite")));
  });

  // ── 25. R4A bounded IPC unchanged ───────────────────────────────────────────
  test("25. R4A bounded IPC framing remains intact with rebinding summaries", async () => {
    const srcProfile = path.join(testRoot, "runner-ipc-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "ipc.pdf");
    writeFileSync(att, "ipc content", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-ipc", "IPC", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );
    db.close();

    const runner = new BackupProcessRunner({ maxConcurrency: 1 });
    try {
      const snapDir = path.join(testRoot, "snapshots");
      mkdirSync(snapDir, { recursive: true });
      const snap = await runner.createSnapshot(dbPath, snapDir, {
        dataDir: srcProfile,
        manifestVersion: 4,
        createDirectory: true,
      });

      const destProfile = path.join(testRoot, "dest-runner-ipc");
      const restoreResult = await runner.restoreSnapshot(snap.path, destProfile, {
        rebindInternalReferences: true,
        createDirectory: true,
      });

      expect(restoreResult.databaseTransformed).toBe(true);
      expect(restoreResult.internalReferencesRebound).toBe(1);
      expect(restoreResult.validationStatus).toBe("valid");
      expect(restoreResult.originalDatabaseSha256).toBeDefined();
      expect(restoreResult.databaseSha256).toBeDefined();
    } finally {
      await runner.dispose();
    }
  });

  // ── 26. R4B cancellation and cleanup unchanged ──────────────────────────────
  test("26. R4B cancellation terminates restore worker and cleans staging", async () => {
    const srcProfile = path.join(testRoot, "cancel-profile");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.close();

    const runner = new BackupProcessRunner({ maxConcurrency: 1 });
    try {
      const snapDir = path.join(testRoot, "snapshots");
      mkdirSync(snapDir, { recursive: true });
      const snap = await runner.createSnapshot(dbPath, snapDir, {
        dataDir: srcProfile,
        manifestVersion: 4,
        createDirectory: true,
      });

      const destProfile = path.join(testRoot, "dest-cancelled");
      const restorePromise = runner.restoreSnapshot(snap.path, destProfile, {
        createDirectory: true,
      });

      // Cancel while running
      const ops = runner.listOperations();
      if (ops.length > 0) {
        await runner.cancel(ops[0]!.operationId, { force: true });
      }

      await expect(restorePromise).rejects.toThrow();
      expect(existsSync(destProfile)).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  // ── 27. Main event-loop responsiveness ──────────────────────────────────────
  test("27. Event loop remains responsive during restore rebinding", async () => {
    const srcProfile = path.join(testRoot, "event-loop-profile");
    mkdirSync(path.join(srcProfile, "attachments"), { recursive: true });
    const att = path.join(srcProfile, "attachments", "responsive.txt");
    writeFileSync(att, "hello", { mode: 0o600 });

    const dbPath = path.join(srcProfile, "agetor.sqlite");
    const db = new Database(dbPath);
    initSyntheticDatabase(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-loop", "Loop", "P", "ready", "claude-code", "/code", JSON.stringify([att]), "[]", null, 1000, 1000],
    );

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 10);

    const destProfile = path.join(testRoot, "dest-event-loop");
    await restoreBackupSnapshot(snap.path, destProfile, { rebindInternalReferences: true });

    clearInterval(interval);
    expect(ticks).toBeGreaterThan(0);
  });

  // ── 28. No real profile or project repository access ────────────────────────
  test("28. Attempting to restore into real profile data directory is blocked fail-closed", async () => {
    const srcProfile = path.join(testRoot, "safe-src");
    const dbPath = path.join(srcProfile, "agetor.sqlite");
    mkdirSync(srcProfile, { recursive: true });
    const db = new Database(dbPath);
    initSyntheticDatabase(db);

    const snap = await createSnapshotFromProfile(srcProfile, db, 4);
    db.close();

    // Attempting to restore directly into active data dir
    const activeDir = isolatedProfile.dataDir;
    await expect(
      restoreBackupSnapshot(snap.path, activeDir),
    ).rejects.toMatchObject({ code: "ACTIVE_PROFILE_PROTECTED" });
  });
});
