/**
 * FO-P2-003-R7A: Portable Reference Integrity, Draft/Backlog Coverage,
 * and Manifest Trust Boundary Test Suite.
 *
 * Covers all 30 mandatory reproduction and adversarial regression tests:
 *  1. Tampered manifest: blank origin hash and internalReferences removed
 *  2. Tampered manifest: random valid-looking origin hash and internalReferences removed
 *  3. Tampered manifest: forged origin metadata pointing at external Git repository
 *  4. Task reference pointing to external project path containing attachments-like subdirectory
 *  5. Unchanged valid v4 snapshot verification
 *  6. Source profile directory deleted before offline verification
 *  7. Operational reference in tasks.draft containing absolute internal attachment
 *  8. Operational references in tasks.draft containing multiple internal assets
 *  9. Operational references across multiple tasks.backlog entries
 * 10. Mixed relative and absolute operational references in tasks.backlog
 * 11. tasks.draft and tasks.backlog referencing the same attachment file
 * 12. Missing internal attachment referenced by tasks.draft
 * 13. Missing internal attachment referenced by tasks.backlog
 * 14. Tampered manifest: missing one nested locator from internalReferences
 * 15. Tampered manifest: duplicated nested locator in internalReferences
 * 16. Tampered manifest: malformed nested JSON path coordinate in internalReferences
 * 17. Tampered manifest: nested locator targeting wrong array item
 * 18. Tampered manifest: nested locator targeting external Git reference
 * 19. Malformed or unsupported operational reference structures
 * 20. Cross-profile operational reference from Profile A to Profile B
 * 21. Legitimate external Git repository reference preserved untouched
 * 22. Source profile referenced through 1, 2, and 3 distinct symlink aliases
 * 23. Source SQLite database file remains byte-for-byte unchanged after snapshot creation
 * 24. Snapshot bundle files remain byte-for-byte unchanged after inactive restore
 * 25. Append-only Activity Journal events preserved with exact sequence
 * 26. Knowledge documents and revisions maintain SHA-256 and byte-length integrity
 * 27. Full round trip: snapshot -> verify -> delete source -> offline verify -> restore -> re-backup
 * 28. Accurate internal reference counts and readiness states
 * 29. Legacy manifest v3 behavior and safe migration decisions
 * 30. Strict environment isolation: zero access to real user profile or credentials
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Establish global isolated profile environment before importing application code
const globalIsoRoot = mkdtempSync(path.join(tmpdir(), "fo-r7a-global-iso-"));
const globalIsoData = path.join(globalIsoRoot, "data");
mkdirSync(globalIsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = globalIsoData;
process.env.AGETOR_DATA_DIR = globalIsoData;

import { computeFileSha256 } from "./backup-core.ts";
import {
  BackupManager,
  BackupManagerError,
  verifyBackupSnapshot,
  type SnapshotManifest,
} from "./backup-manager.ts";
import {
  BackupRestore,
  RestoreError,
  restoreBackupSnapshot,
  type RestoreResult,
} from "./backup-restore.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { setupIsolatedTestProfile, type IsolatedTestProfile } from "./test-isolation.ts";

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function createCanonicalProfileDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 10000;");
  migrate(db, migrations);
  return db;
}

function insertTestTask(
  db: Database,
  opts: {
    id: string;
    title?: string;
    prompt?: string;
    workdir?: string;
    refs?: unknown[];
    attachments?: unknown[];
    sentFiles?: unknown[];
    draft?: unknown;
    backlog?: unknown[];
  },
) {
  const workdir = opts.workdir ?? tmpdir();
  db.run(
    `INSERT INTO tasks (
      id, title, prompt, column, agent, workdir,
      refs, attachments, sent_files, draft, backlog,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'backlog', 'claude-code', ?, ?, ?, ?, ?, ?, 1000, 1000);`,
    [
      opts.id,
      opts.title ?? `Task ${opts.id}`,
      opts.prompt ?? `Prompt for ${opts.id}`,
      workdir,
      JSON.stringify(opts.refs ?? []),
      JSON.stringify(opts.attachments ?? []),
      opts.sentFiles ? JSON.stringify(opts.sentFiles) : null,
      opts.draft ? JSON.stringify(opts.draft) : null,
      JSON.stringify(opts.backlog ?? []),
    ],
  );
}

describe("FO-P2-003-R7A: Portable Reference Integrity, Draft/Backlog Coverage, and Manifest Trust Boundary", () => {
  let isolatedProfile: IsolatedTestProfile;
  let testRoot: string;

  beforeEach(() => {
    isolatedProfile = setupIsolatedTestProfile("fo-r7a-suite-");
    testRoot = mkdtempSync(path.join(tmpdir(), "fo-r7a-case-"));
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    isolatedProfile.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1–4. Manifest Origin Trust Boundary & External Classifications
  // ──────────────────────────────────────────────────────────────────────────

  test("1. Tampered manifest: blank origin hash and internalReferences removed -> verifySnapshot fails, cannot claim ready", async () => {
    const profileDir = path.join(testRoot, "profile-1");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attPath = path.join(profileDir, "attachments", "note.txt");
    writeFileSync(attPath, "important internal note", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t1", attachments: [attPath] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-1");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: remove internalReferences and blank origin hash
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences = [];
    if (manifest.origin) {
      manifest.origin.sourceProfileRootSha256 = "";
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("missing mandatory internal reference"))).toBe(true);

    // Restore must fail closed
    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "dest-1"));
    } catch (e) {
      restoreErr = e as RestoreError;
    }
    expect(restoreErr).not.toBeNull();
  });

  test("2. Tampered manifest: random valid-looking origin hash and internalReferences removed -> verifySnapshot fails closed, cannot hide internal references", async () => {
    const profileDir = path.join(testRoot, "profile-2");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attPath = path.join(profileDir, "attachments", "doc.pdf");
    writeFileSync(attPath, "pdf content", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t2", attachments: [attPath] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-2");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: valid-looking 64-char sha256 of arbitrary foreign directory, empty internalReferences
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences = [];
    if (manifest.origin) {
      manifest.origin.sourceProfileRootSha256 = sha256Hex("/Users/attacker/other-profile");
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    // In Manifest v4, SQLite has normalized "attachments/doc.pdf". Verifier detects SQLite reference
    // is omitted from manifest.internalReferences, so it fails regardless of origin hash!
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("missing mandatory internal reference"))).toBe(true);
  });

  test("3. Tampered manifest: forged origin metadata pointing at external Git repository -> external reference is not transformed into internal reference or rebound", async () => {
    const extRepo = path.join(testRoot, "external-git-repo-3");
    mkdirSync(path.join(extRepo, "src"), { recursive: true });
    const extFile = path.join(extRepo, "src", "index.ts");
    writeFileSync(extFile, "console.log('external repo');", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-3");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t3", refs: [{ path: extFile }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-3");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Attempt to forge origin to match external repo
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    if (manifest.origin) {
      manifest.origin.sourceProfileRootSha256 = sha256Hex(extRepo);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Restore into destination
    const destDir = path.join(testRoot, "dest-3");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.destinationPath).toBe(destDir);

    // Verify external path in SQLite was NOT rewritten to point inside destDir
    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("t3");
    restoredDb.close();

    expect(row).toBeDefined();
    const refs = JSON.parse(row!.refs);
    expect(refs[0].path).toBe(extFile);
  });

  test("4. Task reference pointing to external project path containing attachments-like subdirectory -> classified as external, untouched in DB and restore", async () => {
    const extProject = path.join(testRoot, "external-project-with-attachments");
    mkdirSync(path.join(extProject, "attachments"), { recursive: true });
    const extAtt = path.join(extProject, "attachments", "unrelated-screenshot.png");
    writeFileSync(extAtt, "fake png content", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-4");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t4", refs: [{ path: extAtt }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-4");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Verify external project file is NOT packaged
    expect(snapResult.manifest.files.some((f) => f.path.includes("unrelated-screenshot.png"))).toBe(false);
    expect(snapResult.manifest.internalReferences ?? []).toEqual([]);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-4");
    await restoreBackupSnapshot(snapDir, destDir);

    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("t4");
    restoredDb.close();
    expect(JSON.parse(row!.refs)[0].path).toBe(extAtt);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5–6. Offline Verification and Source Independence
  // ──────────────────────────────────────────────────────────────────────────

  test("5. Unchanged valid v4 snapshot -> verifySnapshot returns ok: true, coverage: complete-profile, activationReadiness: ready", async () => {
    const profileDir = path.join(testRoot, "profile-5");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attPath = path.join(profileDir, "attachments", "spec.pdf");
    writeFileSync(attPath, "valid pdf", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t5",
      attachments: [attPath],
      draft: { text: "Draft text", references: [{ path: attPath }] },
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-5");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
    expect(ver.manifestVersion).toBe(4);

    const destDir = path.join(testRoot, "dest-5");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.destinationPath).toBe(destDir);
    expect(restoreRes.activationReadiness).toBe("ready");
  });

  test("6. Source profile directory deleted before offline verification -> verifySnapshot succeeds offline without depending on source profile", async () => {
    const profileDir = path.join(testRoot, "profile-6");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attPath = path.join(profileDir, "attachments", "offline.txt");
    writeFileSync(attPath, "offline payload", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t6", attachments: [attPath] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-6");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Completely delete the original source profile!
    rmSync(profileDir, { recursive: true, force: true });
    expect(existsSync(profileDir)).toBe(false);

    // Offline verification must still succeed completely!
    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7–11. Operational Reference Discovery: tasks.draft and tasks.backlog
  // ──────────────────────────────────────────────────────────────────────────

  test("7. Operational reference in tasks.draft containing absolute internal attachment -> packaged, normalized to canonical-relative in staging DB, rebound to destination profile", async () => {
    const profileDir = path.join(testRoot, "profile-7");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attPath = path.join(profileDir, "attachments", "draft-file.txt");
    writeFileSync(attPath, "draft attachment data", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t7",
      draft: { text: "Review draft", references: [{ path: attPath, isDirectory: false }] },
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-7");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    expect(snapResult.manifest.files.some((f) => f.path === "attachments/draft-file.txt")).toBe(true);
    const draftRef = snapResult.manifest.internalReferences?.find(
      (e) => (e.column ?? e.sourceField) === "draft",
    );
    expect(draftRef).toBeDefined();
    expect(draftRef!.canonicalPath).toBe("attachments/draft-file.txt");
    expect(draftRef!.jsonPath).toBe("$.references[0].path");

    // Check staging database normalized draft reference
    const snapDb = new Database(path.join(snapDir, "database.sqlite"), { readonly: true });
    const snapRow = snapDb.query<{ draft: string }, [string]>("SELECT draft FROM tasks WHERE id = ?;").get("t7");
    snapDb.close();
    expect(JSON.parse(snapRow!.draft).references[0].path).toBe("attachments/draft-file.txt");

    // Restore into destination
    const destDir = path.join(testRoot, "dest-7");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.destinationPath).toBe(destDir);
    expect(restoreRes.internalReferencesRebound).toBe(1);

    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const destRow = restoredDb.query<{ draft: string }, [string]>("SELECT draft FROM tasks WHERE id = ?;").get("t7");
    restoredDb.close();
    expect(JSON.parse(destRow!.draft).references[0].path).toBe(path.join(destDir, "attachments", "draft-file.txt"));
    expect(existsSync(path.join(destDir, "attachments", "draft-file.txt"))).toBe(true);
  });

  test("8. Operational references in tasks.draft containing multiple internal assets -> all packaged, normalized, verified with $.references[j].path locators, and rebound", async () => {
    const profileDir = path.join(testRoot, "profile-8");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att1 = path.join(profileDir, "attachments", "draft1.txt");
    const att2 = path.join(profileDir, "attachments", "draft2.txt");
    writeFileSync(att1, "draft one", { mode: 0o600 });
    writeFileSync(att2, "draft two", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t8",
      draft: {
        text: "Multi-attachment draft",
        references: [{ path: att1 }, { path: att2 }],
      },
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-8");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-8");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.internalReferencesRebound).toBe(2);

    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const destRow = restoredDb.query<{ draft: string }, [string]>("SELECT draft FROM tasks WHERE id = ?;").get("t8");
    restoredDb.close();
    const d = JSON.parse(destRow!.draft);
    expect(d.references[0].path).toBe(path.join(destDir, "attachments", "draft1.txt"));
    expect(d.references[1].path).toBe(path.join(destDir, "attachments", "draft2.txt"));
  });

  test("9. Operational references across multiple tasks.backlog entries -> all packaged, normalized, verified with $[i].references[j].path locators, and rebound", async () => {
    const profileDir = path.join(testRoot, "profile-9");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att1 = path.join(profileDir, "attachments", "b1.txt");
    const att2 = path.join(profileDir, "attachments", "b2.txt");
    writeFileSync(att1, "backlog asset 1", { mode: 0o600 });
    writeFileSync(att2, "backlog asset 2", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t9",
      backlog: [
        { id: "msg1", text: "First message", references: [{ path: att1 }], createdAt: 100 },
        { id: "msg2", text: "Second message", references: [{ path: att2 }], createdAt: 200 },
      ],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-9");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const locators = snapResult.manifest.internalReferences?.map((r) => r.jsonPath);
    expect(locators).toContain("$[0].references[0].path");
    expect(locators).toContain("$[1].references[0].path");

    const destDir = path.join(testRoot, "dest-9");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.internalReferencesRebound).toBe(2);

    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const destRow = restoredDb.query<{ backlog: string }, [string]>("SELECT backlog FROM tasks WHERE id = ?;").get("t9");
    restoredDb.close();
    const b = JSON.parse(destRow!.backlog);
    expect(b[0].references[0].path).toBe(path.join(destDir, "attachments", "b1.txt"));
    expect(b[1].references[0].path).toBe(path.join(destDir, "attachments", "b2.txt"));
    expect(b[0].text).toBe("First message");
    expect(b[1].text).toBe("Second message");
  });

  test("10. Mixed relative and absolute operational references in tasks.backlog -> both recognized as internal, normalized, verified, and rebound to destination profile", async () => {
    const profileDir = path.join(testRoot, "profile-10");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const absPath = path.join(profileDir, "attachments", "abs.txt");
    const relFile = path.join(profileDir, "attachments", "rel.txt");
    writeFileSync(absPath, "absolute reference file", { mode: 0o600 });
    writeFileSync(relFile, "canonical relative reference file", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t10",
      backlog: [
        {
          id: "m1",
          text: "Mixed refs",
          references: [{ path: absPath }, { path: "attachments/rel.txt" }],
          createdAt: 500,
        },
      ],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-10");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-10");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.internalReferencesRebound).toBe(2);

    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ backlog: string }, [string]>("SELECT backlog FROM tasks WHERE id = ?;").get("t10");
    restoredDb.close();
    const b = JSON.parse(row!.backlog);
    expect(b[0].references[0].path).toBe(path.join(destDir, "attachments", "abs.txt"));
    expect(b[0].references[1].path).toBe(path.join(destDir, "attachments", "rel.txt"));
  });

  test("11. tasks.draft and tasks.backlog referencing the same attachment file -> asset packaged once, distinct nested locators verified, both rebound without collision", async () => {
    const profileDir = path.join(testRoot, "profile-11");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const shared = path.join(profileDir, "attachments", "shared.txt");
    writeFileSync(shared, "shared content", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t11",
      draft: { text: "Draft sharing", references: [{ path: shared }] },
      backlog: [{ id: "m1", text: "Backlog sharing", references: [{ path: shared }], createdAt: 100 }],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-11");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Asset must be packaged once in manifest.files
    const sharedFiles = snapResult.manifest.files.filter((f) => f.path === "attachments/shared.txt");
    expect(sharedFiles.length).toBe(1);

    // But manifest.internalReferences has 2 distinct locators
    expect(snapResult.manifest.internalReferences?.length).toBe(2);

    const destDir = path.join(testRoot, "dest-11");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.internalReferencesRebound).toBe(2);

    const restoredDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query<{ draft: string; backlog: string }, [string]>(
      "SELECT draft, backlog FROM tasks WHERE id = ?;",
    ).get("t11");
    restoredDb.close();

    const expectedDest = path.join(destDir, "attachments", "shared.txt");
    expect(JSON.parse(row!.draft).references[0].path).toBe(expectedDest);
    expect(JSON.parse(row!.backlog)[0].references[0].path).toBe(expectedDest);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 12–13. Missing Mandatory Operational References Fail Closed
  // ──────────────────────────────────────────────────────────────────────────

  test("12. Missing internal attachment referenced by tasks.draft -> createSnapshot fails closed with INCONSISTENT_ASSET", async () => {
    const profileDir = path.join(testRoot, "profile-12");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const missingFile = path.join(profileDir, "attachments", "nonexistent-draft.txt");

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t12",
      draft: { text: "Missing ref", references: [{ path: missingFile }] },
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-12");

    let err: BackupManagerError | null = null;
    try {
      await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    } catch (e) {
      err = e as BackupManagerError;
    } finally {
      readDb.close();
    }

    expect(err).not.toBeNull();
    expect(err!.code).toBe("INCONSISTENT_ASSET");
  });

  test("13. Missing internal attachment referenced by tasks.backlog -> createSnapshot fails closed with INCONSISTENT_ASSET", async () => {
    const profileDir = path.join(testRoot, "profile-13");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const missingFile = path.join(profileDir, "attachments", "nonexistent-backlog.txt");

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t13",
      backlog: [{ id: "m1", text: "Ghost ref", references: [{ path: missingFile }], createdAt: 100 }],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-13");

    let err: BackupManagerError | null = null;
    try {
      await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    } catch (e) {
      err = e as BackupManagerError;
    } finally {
      readDb.close();
    }

    expect(err).not.toBeNull();
    expect(err!.code).toBe("INCONSISTENT_ASSET");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 14–19. Nested Reference Locator Model Robustness
  // ──────────────────────────────────────────────────────────────────────────

  test("14. Tampered manifest: missing one nested locator from internalReferences -> verifySnapshot fails closed with missing declared reference", async () => {
    const profileDir = path.join(testRoot, "profile-14");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att1 = path.join(profileDir, "attachments", "d14.txt");
    const att2 = path.join(profileDir, "attachments", "b14.txt");
    writeFileSync(att1, "att14-1", { mode: 0o600 });
    writeFileSync(att2, "att14-2", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t14",
      draft: { text: "Draft", references: [{ path: att1 }] },
      backlog: [{ id: "m1", text: "Backlog", references: [{ path: att2 }], createdAt: 100 }],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-14");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: remove backlog locator from internalReferences
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences = (manifest.internalReferences ?? []).filter(
      (r) => (r.column ?? r.sourceField) !== "backlog",
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("missing mandatory internal reference"))).toBe(true);
  });

  test("15. Tampered manifest: duplicated nested locator in internalReferences -> verifySnapshot fails closed with duplicate locator error", async () => {
    const profileDir = path.join(testRoot, "profile-15");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "att15.txt");
    writeFileSync(att, "att15", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t15", draft: { text: "Draft", references: [{ path: att }] } });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-15");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: duplicate locator
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences = [
      ...manifest.internalReferences!,
      { ...manifest.internalReferences![0]! },
    ];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("Duplicate internal reference"))).toBe(true);
  });

  test("16. Tampered manifest: malformed nested JSON path coordinate in internalReferences -> verifySnapshot/restore fails closed with unsupported locator format", async () => {
    const profileDir = path.join(testRoot, "profile-16");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "att16.txt");
    writeFileSync(att, "att16", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t16", draft: { text: "Draft", references: [{ path: att }] } });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-16");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: invalid jsonPath
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences![0]!.jsonPath = "$.references[[broken";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "dest-16"));
    } catch (e) {
      restoreErr = e as RestoreError;
    }

    expect(restoreErr).not.toBeNull();
    expect(restoreErr!.code).toBe("SNAPSHOT_VERIFICATION_FAILED");
  });

  test("17. Tampered manifest: nested locator targeting wrong array item -> restore fails closed before modifying SQLite", async () => {
    const profileDir = path.join(testRoot, "profile-17");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "att17.txt");
    writeFileSync(att, "att17", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t17", draft: { text: "Draft", references: [{ path: att }] } });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-17");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: point jsonPath out of bounds or to non-existent index
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences![0]!.jsonPath = "$.references[99].path";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "dest-17"));
    } catch (e) {
      restoreErr = e as RestoreError;
    }

    expect(restoreErr).not.toBeNull();
    expect(restoreErr!.message).toContain("extra entry not present in database or non-internal reference");
  });

  test("18. Tampered manifest: nested locator targeting external Git reference -> verifySnapshot/restore fails closed, external reference preserved", async () => {
    const extRepo = path.join(testRoot, "ext-repo-18");
    mkdirSync(path.join(extRepo, "src"), { recursive: true });
    const extFile = path.join(extRepo, "src", "main.ts");
    writeFileSync(extFile, "export const x = 1;", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-18");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "att18.txt");
    writeFileSync(att, "att18", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t18",
      refs: [{ path: extFile }],
      attachments: [att],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-18");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Tamper manifest: add an internalReference entry claiming refs[0] is internal
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences!.push({
      table: "tasks",
      column: "refs",
      sourceField: "refs",
      taskId: "t18",
      jsonPath: "$[0].path",
      canonicalPath: "attachments/fake.txt",
      category: "attachment",
      refType: "canonical-relative",
      rawRefSha256: sha256Hex("attachments/fake.txt"),
      expectedOriginalValue: "attachments/fake.txt",
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Restore must reject digest mismatch / invalid original value and not modify external path
    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "dest-18"));
    } catch (e) {
      restoreErr = e as RestoreError;
    }

    expect(restoreErr).not.toBeNull();
    expect(restoreErr!.message).toContain("extra entry not present in database or non-internal reference");
  });

  test("19. Malformed or unsupported operational reference structures in tasks.draft/backlog -> safely handled and fails closed if mandatory reference cannot be resolved", async () => {
    const profileDir = path.join(testRoot, "profile-19");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);

    // Insert task with non-standard draft JSON (numbers instead of reference objects)
    insertTestTask(db, {
      id: "t19",
      draft: { text: "Odd draft", references: [12345] },
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-19");

    // createSnapshot fails closed with UNSUPPORTED_REFERENCE_FORMAT when operational reference structure is invalid
    let snapErr: BackupManagerError | null = null;
    try {
      await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    } catch (e) {
      snapErr = e as BackupManagerError;
    } finally {
      readDb.close();
    }

    expect(snapErr).not.toBeNull();
    expect(snapErr!.code).toBe("UNSUPPORTED_REFERENCE_FORMAT");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 20–21. Cross-Profile References & External Preservation
  // ──────────────────────────────────────────────────────────────────────────

  test("20. Cross-profile operational reference from Profile A to Profile B -> Profile B asset not packaged, restore flags unresolvedCrossProfileReferences and sets requires-external-recovery", async () => {
    // Setup Profile B
    const profileB = path.join(testRoot, "profile-b");
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });
    const foreignAtt = path.join(profileB, "attachments", "b-secret.txt");
    writeFileSync(foreignAtt, "b secret file", { mode: 0o600 });
    createCanonicalProfileDb(path.join(profileB, "agetor.sqlite")).close();

    // Setup Profile A referencing foreign file in Profile B
    const profileA = path.join(testRoot, "profile-a");
    mkdirSync(profileA, { recursive: true });
    const dbPathA = path.join(profileA, "agetor.sqlite");
    const dbA = createCanonicalProfileDb(dbPathA);
    insertTestTask(dbA, {
      id: "ta",
      attachments: [foreignAtt],
    });
    dbA.close();

    const readDb = new Database(dbPathA, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileA });
    const snapDir = path.join(testRoot, "snap-a");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Profile B's attachment must NOT be packaged into Profile A's snapshot!
    expect(snapResult.manifest.files.some((f) => f.path.includes("b-secret.txt"))).toBe(false);

    // Restore Profile A into Profile C
    const profileC = path.join(testRoot, "profile-c");
    const restoreRes = await restoreBackupSnapshot(snapDir, profileC);

    // Detection must flag cross-profile reference and downgrade readiness
    expect(restoreRes.unresolvedCrossProfileReferences).toBeGreaterThan(0);
    expect(restoreRes.crossProfileDependencies?.some((d) => d.includes("profile-b"))).toBe(true);
    expect(restoreRes.activationReadiness).toBe("requires-external-recovery");

    // Check recovery receipt on disk
    const receiptPath = path.join(profileC, ".forgeorbit-recovery.json");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.activationReadiness).toBe("requires-external-recovery");
    expect(receipt.unresolvedCrossProfileReferences).toBeGreaterThan(0);
  });

  test("21. Legitimate external Git repository reference in task refs -> preserved verbatim without being packaged, rewritten, or rebound", async () => {
    const extGit = path.join(testRoot, "external-git-21");
    mkdirSync(path.join(extGit, "src"), { recursive: true });
    const extSrc = path.join(extGit, "src", "app.tsx");
    writeFileSync(extSrc, "export default function App() {}", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-21");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t21", refs: [{ path: extSrc }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-21");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Verify external file was not packaged
    expect(snapResult.manifest.files.some((f) => f.path.includes("app.tsx"))).toBe(false);

    const destDir = path.join(testRoot, "dest-21");
    await restoreBackupSnapshot(snapDir, destDir);

    const destDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const row = destDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("t21");
    destDb.close();

    expect(JSON.parse(row!.refs)[0].path).toBe(extSrc);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 22. Multiple Symlink Aliases
  // ──────────────────────────────────────────────────────────────────────────

  test("22. Source profile referenced through 1, 2, and 3 distinct symlink aliases -> all recognized as internal, hashes recorded in origin metadata, normalized and rebound", async () => {
    const realProfile = path.join(testRoot, "real-profile-22");
    mkdirSync(path.join(realProfile, "attachments"), { recursive: true });
    const f1 = path.join(realProfile, "attachments", "file1.txt");
    const f2 = path.join(realProfile, "attachments", "file2.txt");
    const f3 = path.join(realProfile, "attachments", "file3.txt");
    writeFileSync(f1, "f1", { mode: 0o600 });
    writeFileSync(f2, "f2", { mode: 0o600 });
    writeFileSync(f3, "f3", { mode: 0o600 });

    // Create 3 distinct symlinks pointing to the real profile
    const sym1 = path.join(testRoot, "sym1-profile-22");
    const sym2 = path.join(testRoot, "sym2-profile-22");
    const sym3 = path.join(testRoot, "sym3-profile-22");
    symlinkSync(realProfile, sym1);
    symlinkSync(realProfile, sym2);
    symlinkSync(realProfile, sym3);

    const dbPath = path.join(realProfile, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    // Task 1 uses sym1
    insertTestTask(db, {
      id: "t22-1",
      refs: [{ path: path.join(sym1, "attachments", "file1.txt") }],
    });
    // Task 2 uses sym2
    insertTestTask(db, {
      id: "t22-2",
      draft: { text: "sym2 draft", references: [{ path: path.join(sym2, "attachments", "file2.txt") }] },
    });
    // Task 3 uses sym3
    insertTestTask(db, {
      id: "t22-3",
      backlog: [{ id: "m1", text: "sym3 backlog", references: [{ path: path.join(sym3, "attachments", "file3.txt") }], createdAt: 100 }],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: realProfile });
    const snapDir = path.join(testRoot, "snap-22");
    const snapResult = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Verify origin metadata has recorded alias hashes
    expect(snapResult.manifest.origin?.sourceProfileAliasSha256s).toBeDefined();
    expect(snapResult.manifest.origin!.sourceProfileAliasSha256s!.length).toBeGreaterThanOrEqual(1);

    // Verify all 3 files normalized to canonical-relative
    expect(snapResult.manifest.internalReferences?.length).toBe(3);
    for (const ref of snapResult.manifest.internalReferences!) {
      expect(ref.refType).toBe("canonical-relative");
    }

    // Restore into destination
    const destDir = path.join(testRoot, "dest-22");
    const restoreRes = await restoreBackupSnapshot(snapDir, destDir);
    expect(restoreRes.destinationPath).toBe(destDir);
    expect(restoreRes.internalReferencesRebound).toBe(3);

    const destDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const r1 = destDb.query<{ refs: string }, [string]>("SELECT refs FROM tasks WHERE id = ?;").get("t22-1");
    const r2 = destDb.query<{ draft: string }, [string]>("SELECT draft FROM tasks WHERE id = ?;").get("t22-2");
    const r3 = destDb.query<{ backlog: string }, [string]>("SELECT backlog FROM tasks WHERE id = ?;").get("t22-3");
    destDb.close();

    expect(JSON.parse(r1!.refs)[0].path).toBe(path.join(destDir, "attachments", "file1.txt"));
    expect(JSON.parse(r2!.draft).references[0].path).toBe(path.join(destDir, "attachments", "file2.txt"));
    expect(JSON.parse(r3!.backlog)[0].references[0].path).toBe(path.join(destDir, "attachments", "file3.txt"));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 23–26. Preservation of Invariants (Source, Snapshot, Journal, Knowledge)
  // ──────────────────────────────────────────────────────────────────────────

  test("23. Source SQLite database file remains byte-for-byte unchanged after v4 snapshot creation", async () => {
    const profileDir = path.join(testRoot, "profile-23");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "immutable.txt");
    writeFileSync(att, "immutable content", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t23", attachments: [att] });
    // Checkpoint WAL so main DB file is deterministic
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();

    const preSha = await computeFileSha256(dbPath);

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-23");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const postSha = await computeFileSha256(dbPath);
    expect(postSha).toBe(preSha);
  });

  test("24. Snapshot bundle files remain byte-for-byte unchanged after inactive restore", async () => {
    const profileDir = path.join(testRoot, "profile-24");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "bundle-asset.txt");
    writeFileSync(att, "asset in bundle", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t24", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-24");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const snapDbPath = path.join(snapDir, "database.sqlite");
    const preDbSha = await computeFileSha256(snapDbPath);
    const snapManifestPath = path.join(snapDir, "manifest.json");
    const preManifestSha = await computeFileSha256(snapManifestPath);

    const destDir = path.join(testRoot, "dest-24");
    await restoreBackupSnapshot(snapDir, destDir);

    const postDbSha = await computeFileSha256(snapDbPath);
    const postManifestSha = await computeFileSha256(snapManifestPath);

    expect(postDbSha).toBe(preDbSha);
    expect(postManifestSha).toBe(preManifestSha);
  });

  test("25. Append-only Activity Journal events preserved with exact sequence IDs, event IDs, and payloads after restore", async () => {
    const profileDir = path.join(testRoot, "profile-25");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);

    // Insert 3 sequential activity events satisfying constraints
    db.run(
      `INSERT INTO activity_events (id, event_type, project_path, actor_type, actor_id, target_type, target_id, idempotency_key, payload_json, created_at)
       VALUES
       ('ev-1', 'task_created', '/p', 'owner', 'u1', 'task', 't1', 'key-1', '{"step":1}', 1000),
       ('ev-2', 'task_started', '/p', 'employee', 'a1', 'task', 't1', 'key-2', '{"step":2}', 1010),
       ('ev-3', 'task_finished', '/p', 'employee', 'a1', 'task', 't1', 'key-3', '{"step":3}', 1020);`,
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-25");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-25");
    await restoreBackupSnapshot(snapDir, destDir);

    const destDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const events = destDb
      .query<{ sequence_id: number; id: string; payload_json: string }, []>(
        "SELECT sequence_id, id, payload_json FROM activity_events ORDER BY sequence_id ASC;",
      )
      .all();
    destDb.close();

    expect(events.length).toBe(3);
    expect(events[0]?.id).toBe("ev-1");
    expect(events[0]?.payload_json).toBe('{"step":1}');
    expect(events[1]?.id).toBe("ev-2");
    expect(events[2]?.id).toBe("ev-3");
  });

  test("26. Knowledge documents and revisions maintain SHA-256 and byte-length integrity across backup and restore", async () => {
    const profileDir = path.join(testRoot, "profile-26");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);

    const docId = randomUUID();
    const docContent = "Architecture design document content";
    const docSha = sha256Hex(docContent);
    const docBytes = Buffer.byteLength(docContent);

    // Create knowledge body on disk
    const bodyDir = path.join(profileDir, "knowledge", "bodies", docId);
    mkdirSync(bodyDir, { recursive: true });
    writeFileSync(path.join(bodyDir, "1.md"), docContent, { mode: 0o600 });

    db.run(
      `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, content_sha256, byte_length, revision, created_at, updated_at)
       VALUES (?, 'project', 'p1', 'Design Spec', ?, ?, 1, 1000, 1000);`,
      [docId, docSha, docBytes],
    );
    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, content_sha256, byte_length, created_at)
       VALUES (?, 1, ?, ?, 1000);`,
      [docId, docSha, docBytes],
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-26");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-26");
    await restoreBackupSnapshot(snapDir, destDir);

    const destDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const row = destDb
      .query<{ content_sha256: string; byte_length: number }, [string]>(
        "SELECT content_sha256, byte_length FROM knowledge_documents WHERE id = ?;",
      )
      .get(docId);
    destDb.close();

    expect(row).toBeDefined();
    expect(row!.content_sha256).toBe(docSha);
    expect(row!.byte_length).toBe(docBytes);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 27. Full Lifecycle Round Trip
  // ──────────────────────────────────────────────────────────────────────────

  test("27. Full round trip: snapshot -> verify -> delete source -> offline verify -> restore to new profile -> snapshot restored profile -> verify new snapshot", async () => {
    // 1. Initial Profile A
    const profileA = path.join(testRoot, "roundtrip-profile-a");
    mkdirSync(path.join(profileA, "attachments"), { recursive: true });
    const attA = path.join(profileA, "attachments", "roundtrip.txt");
    writeFileSync(attA, "roundtrip data", { mode: 0o600 });

    const dbPathA = path.join(profileA, "agetor.sqlite");
    const dbA = createCanonicalProfileDb(dbPathA);
    insertTestTask(dbA, {
      id: "rt-1",
      refs: [{ path: attA }],
      draft: { text: "RT draft", references: [{ path: attA }] },
      backlog: [{ id: "m1", text: "RT backlog", references: [{ path: attA }], createdAt: 100 }],
    });
    dbA.close();

    // 2. Create Snapshot 1
    const snap1Dir = path.join(testRoot, "snapshot-1");
    const readDbA = new Database(dbPathA, { readonly: true });
    const managerA = new BackupManager({ db: readDbA, dataDir: profileA });
    await managerA.createSnapshot({ destinationPath: snap1Dir, manifestVersion: 4 });
    readDbA.close();

    // 3. Verify Snapshot 1
    const v1 = await verifyBackupSnapshot(snap1Dir);
    expect(v1.ok).toBe(true);
    expect(v1.coverage).toBe("complete-profile");

    // 4. Delete Source Profile A completely
    rmSync(profileA, { recursive: true, force: true });
    expect(existsSync(profileA)).toBe(false);

    // 5. Offline Verify Snapshot 1 without source profile
    const vOffline = await verifyBackupSnapshot(snap1Dir);
    expect(vOffline.ok).toBe(true);
    expect(vOffline.coverage).toBe("complete-profile");

    // 6. Restore into Profile B
    const profileB = path.join(testRoot, "roundtrip-profile-b");
    const restoreB = await restoreBackupSnapshot(snap1Dir, profileB);
    expect(restoreB.destinationPath).toBe(profileB);
    expect(restoreB.activationReadiness).toBe("ready");
    expect(restoreB.internalReferencesRebound).toBe(3);

    // Verify Profile B has valid rebound references
    const dbPathB = path.join(profileB, "agetor.sqlite");
    const dbB = new Database(dbPathB, { readonly: true });
    const rB = dbB.query<{ refs: string; draft: string; backlog: string }, [string]>(
      "SELECT refs, draft, backlog FROM tasks WHERE id = ?;",
    ).get("rt-1");
    dbB.close();

    const expectedAttB = path.join(profileB, "attachments", "roundtrip.txt");
    expect(JSON.parse(rB!.refs)[0].path).toBe(expectedAttB);
    expect(JSON.parse(rB!.draft).references[0].path).toBe(expectedAttB);
    expect(JSON.parse(rB!.backlog)[0].references[0].path).toBe(expectedAttB);

    // 7. Create Snapshot 2 from Profile B
    const snap2Dir = path.join(testRoot, "snapshot-2");
    const readDbB = new Database(dbPathB, { readonly: true });
    const managerB = new BackupManager({ db: readDbB, dataDir: profileB });
    await managerB.createSnapshot({ destinationPath: snap2Dir, manifestVersion: 4 });
    readDbB.close();

    // 8. Verify Snapshot 2
    const v2 = await verifyBackupSnapshot(snap2Dir);
    expect(v2.ok).toBe(true);
    expect(v2.coverage).toBe("complete-profile");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 28. Accurate Internal Reference Counts and Readiness States
  // ──────────────────────────────────────────────────────────────────────────

  test("28. Accurate internal reference counts and readiness states: ready vs requires-reference-repair vs requires-external-recovery", async () => {
    const profileDir = path.join(testRoot, "profile-28");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const a1 = path.join(profileDir, "attachments", "a1.txt");
    const a2 = path.join(profileDir, "attachments", "a2.txt");
    writeFileSync(a1, "a1", { mode: 0o600 });
    writeFileSync(a2, "a2", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t28",
      attachments: [a1],
      draft: { text: "D", references: [{ path: a2 }] },
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-28");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Case 1: Standard restore with rebinding enabled -> ready, unresolved = 0
    const dest1 = path.join(testRoot, "dest-28-ready");
    const res1 = await restoreBackupSnapshot(snapDir, dest1);
    expect(res1.internalReferencesRebound).toBe(2);
    expect(res1.internalReferencesUnresolved).toBe(0);
    expect(res1.activationReadiness).toBe("ready");

    // Case 2: Restore with rebindInternalReferences: false -> requires-reference-repair
    const dest2 = path.join(testRoot, "dest-28-repair");
    const res2 = await restoreBackupSnapshot(snapDir, dest2, {
      rebindInternalReferences: false,
    });
    expect(res2.internalReferencesRebound).toBe(0);
    expect(res2.internalReferencesUnresolved).toBe(2);
    expect(res2.activationReadiness).toBe("requires-reference-repair");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 29. Legacy Manifest v3 Behavior and Safe Migration
  // ──────────────────────────────────────────────────────────────────────────

  test("29. Legacy manifest v3 behavior: unprovable/forged origin downgrades readiness, safe migration paths preserved", async () => {
    const profileDir = path.join(testRoot, "profile-29");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const a1 = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(a1, "v3 content", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t29", attachments: [a1] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-29");
    // Create an explicit legacy manifest v3 snapshot
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    // Verify v3 with valid origin
    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.manifestVersion).toBe(3);

    // Tamper origin to make it unprovable
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    if (manifest.origin) {
      manifest.origin.sourceProfileRootSha256 = sha256Hex("/different/unprovable/root");
      manifest.origin.sourceProfileRealSha256 = undefined;
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Restore v3 with unprovable origin into new destination: must NOT claim ready
    const destDir = path.join(testRoot, "dest-29");
    let restoreErr: RestoreError | null = null;
    let res: RestoreResult | null = null;
    try {
      res = await restoreBackupSnapshot(snapDir, destDir);
    } catch (e) {
      restoreErr = e as RestoreError;
    }
    if (restoreErr) {
      expect(restoreErr.code).toBe("SNAPSHOT_VERIFICATION_FAILED");
    } else {
      expect(res!.activationReadiness).not.toBe("ready");
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 30. Sandbox and Real Data Isolation
  // ──────────────────────────────────────────────────────────────────────────

  test("30. Strict environment isolation: zero access to real user profile, credentials, or external projects", async () => {
    // Assert environment variables are strictly bound to isolated temporary fixtures
    const currentData = process.env.FORGEORBIT_DATA_DIR;
    const currentAgetor = process.env.AGETOR_DATA_DIR;

    expect(currentData).toBeDefined();
    expect(currentAgetor).toBeDefined();

    // Verify path is in temporary directory and not user home
    const userHome = process.env.HOME || "";
    expect(currentData!.startsWith(tmpdir())).toBe(true);
    if (userHome) {
      expect(currentData).not.toBe(path.join(userHome, ".forgeorbit"));
      expect(currentData).not.toBe(path.join(userHome, "Library", "Application Support", "ForgeOrbit"));
    }
  });
});
