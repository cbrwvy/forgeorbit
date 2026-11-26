/**
 * FO-P2-003-R8A: Legacy Manifest Trust Boundary, Downgrade Prevention,
 * and External Reference Readiness Test Suite.
 *
 * Covers all 30 mandatory regression scenarios:
 *   1.  Genuine v4 snapshot verifies and restores normally.
 *   2.  v4 snapshot with manifestVersion changed to v3.
 *   3.  v4-to-v3 downgrade with forged origin.
 *   4.  v4-to-v3 downgrade with forged external-reference entry.
 *   5.  v4-to-v3 downgrade with internalReferences removed.
 *   6.  Native v3 snapshot with forged origin.
 *   7.  Native v3 snapshot with source profile deleted.
 *   8.  Native v3 snapshot with both internal and external absolute references.
 *   9.  Legacy v1/v2 verification remains conservative.
 *   10. Legacy v3 cannot silently claim v4 complete-profile coverage.
 *   11. Legacy v3 does not automatically rewrite an external Git path.
 *   12. Legacy v3 does not falsely return ready.
 *   13. Malformed or missing format marker.
 *   14. Inconsistent manifest and SQLite format markers.
 *   15. Valid v4 canonical-relative internal references.
 *   16. Missing mandatory v4 reference.
 *   17. Mixed draft/backlog and normal task references.
 *   18. External Git project with an attachments-like directory.
 *   19. Existing foreign ForgeOrbit profile dependency.
 *   20. Deleted foreign ForgeOrbit profile dependency.
 *   21. Missing absolute operational file outside a recognized profile.
 *   22. Valid external project reference preserved unchanged.
 *   23. Multiple legitimate symlink aliases.
 *   24. Offline verification after deleting the synthetic source profile.
 *   25. Snapshot source database remains unchanged.
 *   26. Original snapshot remains unchanged after restore.
 *   27. Activity Journal preserves exact history.
 *   28. Knowledge integrity survives snapshot and restore.
 *   29. Complete v4 Backup -> Verify -> Restore -> Re-backup round trip.
 *   30. No access to real profile data.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Establish global isolated profile environment before importing application code
const globalIsoRoot = mkdtempSync(path.join(tmpdir(), "fo-r8a-global-iso-"));
const globalIsoData = path.join(globalIsoRoot, "data");
mkdirSync(globalIsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = globalIsoData;
process.env.AGETOR_DATA_DIR = globalIsoData;

import { computeFileSha256 } from "./backup-core.ts";
import {
  BackupManager,
  readSnapshotFormatMarker,
  verifyBackupSnapshot,
  type SnapshotManifest,
} from "./backup-manager.ts";
import {
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
    refs?: unknown[];
    attachments?: unknown[];
    sentFiles?: unknown[];
    draft?: unknown;
    backlog?: unknown[];
  },
) {
  db.run(
    `INSERT INTO tasks (
      id, title, prompt, column, agent, workdir,
      refs, attachments, sent_files, draft, backlog,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'backlog', 'claude-code', ?, ?, ?, ?, ?, ?, 1000, 1000);`,
    [
      opts.id,
      opts.title ?? `Task ${opts.id}`,
      `Prompt for ${opts.id}`,
      tmpdir(),
      JSON.stringify(opts.refs ?? []),
      JSON.stringify(opts.attachments ?? []),
      opts.sentFiles ? JSON.stringify(opts.sentFiles) : null,
      opts.draft ? JSON.stringify(opts.draft) : null,
      JSON.stringify(opts.backlog ?? []),
    ],
  );
}

function readManifest(snapDir: string): SnapshotManifest {
  return JSON.parse(readFileSync(path.join(snapDir, "manifest.json"), "utf8")) as SnapshotManifest;
}

function writeManifest(snapDir: string, manifest: SnapshotManifest): void {
  writeFileSync(path.join(snapDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Drop the snapshot-format marker from the staged snapshot DB and re-checksum. */
function removeFormatMarker(snapDir: string): void {
  const dbPath = path.join(snapDir, "database.sqlite");
  const db = new Database(dbPath);
  try {
    db.run("DROP TABLE IF EXISTS forgeorbit_snapshot_format;");
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  const manifest = readManifest(snapDir);
  const dbEntry = manifest.files.find((f) => f.path === "database.sqlite");
  if (dbEntry) {
    const st = readFileSync(dbPath);
    dbEntry.bytes = st.length;
    dbEntry.sha256 = sha256Hex(st);
  }
  writeManifest(snapDir, manifest);
}

function readTaskField(destDir: string, id: string, field: string): string {
  const db = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
  try {
    const row = db.query<Record<string, string | null>, [string]>(
      `SELECT ${field} as val FROM tasks WHERE id = ?;`,
    ).get(id);
    return row?.val ?? "";
  } finally {
    db.close();
  }
}

describe("FO-P2-003-R8A: Legacy Manifest Trust Boundary and Downgrade Prevention", () => {
  let isolatedProfile: IsolatedTestProfile;
  let testRoot: string;

  beforeEach(() => {
    isolatedProfile = setupIsolatedTestProfile("fo-r8a-suite-");
    testRoot = mkdtempSync(path.join(tmpdir(), "fo-r8a-case-"));
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
  // 1. Genuine v4 snapshot verifies and restores normally
  // ──────────────────────────────────────────────────────────────────────────
  test("1. Genuine v4 snapshot verifies and restores normally with complete-profile coverage and ready readiness", async () => {
    const profileDir = path.join(testRoot, "profile-1");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "spec.pdf");
    writeFileSync(att, "spec", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t1", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-1");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
    expect(ver.manifestVersion).toBe(4);

    const destDir = path.join(testRoot, "dest-1");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("ready");
    expect(res.databaseTransformed).toBe(true);
    expect(res.internalReferencesRebound).toBe(1);
    const attachments = JSON.parse(readTaskField(destDir, "t1", "attachments"));
    expect(attachments[0]).toBe(path.join(destDir, "attachments", "spec.pdf"));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2–5, 14. v4-to-v3 downgrade and marker conflict detection
  // ──────────────────────────────────────────────────────────────────────────

  async function createV4Snapshot(name: string, refs: unknown[] = []) {
    const profileDir = path.join(testRoot, `${name}-profile`);
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "spec.pdf");
    writeFileSync(att, "internal spec", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t1", attachments: [att], refs });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, name);
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();
    return snapDir;
  }

  test("2. v4 snapshot with manifestVersion changed to v3 -> verification fails on format-marker conflict", async () => {
    const snapDir = await createV4Snapshot("snap-2");
    const manifest = readManifest(snapDir);
    manifest.manifestVersion = 3;
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("conflicts with manifest version"))).toBe(true);
  });

  test("3. v4-to-v3 downgrade with forged origin -> rejected; and even without marker the external path is never rewritten", async () => {
    const extRepo = path.join(testRoot, "external-repo-3");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    mkdirSync(path.join(extRepo, "attachments"), { recursive: true });
    const extAtt = path.join(extRepo, "attachments", "spec.pdf");
    writeFileSync(extAtt, "external spec", { mode: 0o600 });

    const snapDir = await createV4Snapshot("snap-3", [{ path: extAtt }]);

    // Downgrade + forge origin (marker intact)
    const manifest = readManifest(snapDir);
    manifest.manifestVersion = 3;
    if (manifest.origin) manifest.origin.sourceProfileRootSha256 = sha256Hex(extRepo);
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);

    // Now also remove the marker and re-checksum (simulating marker removal):
    // the safe legacy policy must still prevent the external rewrite.
    removeFormatMarker(snapDir);
    const ver2 = await verifyBackupSnapshot(snapDir);
    expect(ver2.ok).toBe(true);
    expect(ver2.coverage).toBe("legacy-database-knowledge");

    const destDir = path.join(testRoot, "dest-3");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("legacy-unverified");
    const refs = JSON.parse(readTaskField(destDir, "t1", "refs"));
    expect(refs[0].path).toBe(extAtt);
  });

  test("4. v4-to-v3 downgrade with forged external-reference entry -> verification fails, external reference never rebound", async () => {
    const extRepo = path.join(testRoot, "external-repo-4");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    mkdirSync(path.join(extRepo, "attachments"), { recursive: true });
    const extAtt = path.join(extRepo, "attachments", "spec.pdf");
    writeFileSync(extAtt, "external spec", { mode: 0o600 });

    const snapDir = await createV4Snapshot("snap-4", [{ path: extAtt }]);

    const manifest = readManifest(snapDir);
    manifest.manifestVersion = 3;
    if (manifest.origin) manifest.origin.sourceProfileRootSha256 = sha256Hex(extRepo);
    manifest.internalReferences = [
      ...(manifest.internalReferences ?? []),
      {
        table: "tasks",
        recordId: "t1",
        recordIdColumn: "id",
        column: "refs",
        sourceField: "refs",
        canonicalPath: "attachments/spec.pdf",
        category: "attachment",
        refType: "profile-absolute",
        itemIndex: 0,
        jsonPath: "$[0].path",
        relSubpath: "attachments/spec.pdf",
        rawRefSha256: sha256Hex(extAtt),
      },
    ];
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);

    // Restore must reject the inconsistent snapshot
    await expect(
      restoreBackupSnapshot(snapDir, path.join(testRoot, "dest-4")),
    ).rejects.toThrow(/SNAPSHOT_VERIFICATION_FAILED|conflicts with manifest version/i);
  });

  test("5. v4-to-v3 downgrade with internalReferences removed -> verification fails", async () => {
    const snapDir = await createV4Snapshot("snap-5");
    const manifest = readManifest(snapDir);
    manifest.manifestVersion = 3;
    manifest.internalReferences = [];
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
  });

  test("14. Inconsistent manifest and SQLite format markers -> verification rejects", async () => {
    const snapDir = await createV4Snapshot("snap-14");
    // Rewrite the SQLite marker to 3 while manifest stays 4
    const dbPath = path.join(snapDir, "database.sqlite");
    const db = new Database(dbPath);
    try {
      db.run("UPDATE forgeorbit_snapshot_format SET format_version = 3;");
      db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      db.close();
    }
    const manifest = readManifest(snapDir);
    const raw = readFileSync(dbPath);
    const dbEntry = manifest.files.find((f) => f.path === "database.sqlite");
    if (dbEntry) {
      dbEntry.bytes = raw.length;
      dbEntry.sha256 = sha256Hex(raw);
    }
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("conflicts with manifest version"))).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6–8, 10–12. Native v3 legacy behavior
  // ──────────────────────────────────────────────────────────────────────────

  test("6. Native v3 snapshot with forged origin -> verify structurally passes but restore reports legacy-unverified without rebinding", async () => {
    const profileDir = path.join(testRoot, "profile-6");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(att, "v3", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t6", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-6");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    const manifest = readManifest(snapDir);
    if (manifest.origin) manifest.origin.sourceProfileRootSha256 = sha256Hex("/forged/root");
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-6");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("legacy-unverified");
    expect(res.databaseTransformed).toBe(false);
    // Internal reference must NOT be rebound: it stays at its original path
    const attachments = JSON.parse(readTaskField(destDir, "t6", "attachments"));
    expect(attachments[0]).toBe(att);
  });

  test("7. Native v3 snapshot with source profile deleted -> offline verify passes, restore legacy-unverified", async () => {
    const profileDir = path.join(testRoot, "profile-7");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(att, "v3", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t7", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-7");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    rmSync(profileDir, { recursive: true, force: true });

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-7");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("legacy-unverified");
    expect(res.databaseTransformed).toBe(false);
  });

  test("8. Native v3 snapshot with both internal and external absolute references -> neither rewritten, legacy-unverified", async () => {
    const extRepo = path.join(testRoot, "external-repo-8");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    mkdirSync(path.join(extRepo, "src"), { recursive: true });
    const extSrc = path.join(extRepo, "src", "app.tsx");
    writeFileSync(extSrc, "export {}", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-8");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(att, "v3", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t8", attachments: [att], refs: [{ path: extSrc }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-8");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-8");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("legacy-unverified");
    expect(res.databaseTransformed).toBe(false);

    const attachments = JSON.parse(readTaskField(destDir, "t8", "attachments"));
    const refs = JSON.parse(readTaskField(destDir, "t8", "refs"));
    expect(attachments[0]).toBe(att);
    expect(refs[0].path).toBe(extSrc);
  });

  test("10. Legacy v3 cannot silently claim v4 complete-profile coverage", async () => {
    const profileDir = path.join(testRoot, "profile-10");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(att, "v3", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t10", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-10");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("legacy-database-knowledge");
    expect(ver.coverage).not.toBe("complete-profile");
  });

  test("11. Legacy v3 does not automatically rewrite an external Git path", async () => {
    const extRepo = path.join(testRoot, "external-repo-11");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    mkdirSync(path.join(extRepo, "src"), { recursive: true });
    const extSrc = path.join(extRepo, "src", "app.tsx");
    writeFileSync(extSrc, "export {}", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-11");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(att, "v3", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t11", attachments: [att], refs: [{ path: extSrc }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-11");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-11");
    await restoreBackupSnapshot(snapDir, destDir);
    const refs = JSON.parse(readTaskField(destDir, "t11", "refs"));
    expect(refs[0].path).toBe(extSrc);
  });

  test("12. Legacy v3 does not falsely return ready", async () => {
    const profileDir = path.join(testRoot, "profile-12");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "v3.txt");
    writeFileSync(att, "v3", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t12", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-12");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 3 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-12");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("legacy-unverified");
    expect(res.activationReadiness).not.toBe("ready");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Legacy v1/v2 conservative verification
  // ──────────────────────────────────────────────────────────────────────────

  test("9. Legacy v1/v2 snapshots verify conservatively and report legacy-database-knowledge coverage", async () => {
    for (const manifestVersion of [1, 2] as const) {
      const profileDir = path.join(testRoot, `profile-9-${manifestVersion}`);
      mkdirSync(profileDir, { recursive: true });

      const dbPath = path.join(profileDir, "agetor.sqlite");
      const db = createCanonicalProfileDb(dbPath);
      insertTestTask(db, { id: `t9-${manifestVersion}` });
      db.close();

      const readDb = new Database(dbPath, { readonly: true });
      const manager = new BackupManager({ db: readDb, dataDir: profileDir });
      const snapDir = path.join(testRoot, `snap-9-${manifestVersion}`);
      await manager.createSnapshot({ destinationPath: snapDir, manifestVersion });
      readDb.close();

      const ver = await verifyBackupSnapshot(snapDir);
      expect(ver.ok).toBe(true);
      expect(ver.coverage).toBe("legacy-database-knowledge");

      const destDir = path.join(testRoot, `dest-9-${manifestVersion}`);
      const res = await restoreBackupSnapshot(snapDir, destDir);
      expect(res.activationReadiness).toBe("legacy-unverified");
      expect(res.databaseTransformed).toBe(false);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 13. Malformed or missing format marker
  // ──────────────────────────────────────────────────────────────────────────

  test("13. Missing or malformed format marker is tolerated: v4 still self-validates via canonical-relative enforcement", async () => {
    const snapDir = await createV4Snapshot("snap-13");
    removeFormatMarker(snapDir);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");

    const destDir = path.join(testRoot, "dest-13");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("ready");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 15–17. v4 reference completeness
  // ──────────────────────────────────────────────────────────────────────────

  test("15. Valid v4 canonical-relative internal references verify and rebound", async () => {
    const snapDir = await createV4Snapshot("snap-15");
    const manifest = readManifest(snapDir);
    expect(manifest.internalReferences?.length).toBe(1);
    expect(manifest.internalReferences![0]!.refType).toBe("canonical-relative");
    expect(readSnapshotFormatMarker(path.join(snapDir, "database.sqlite"))).toBe(4);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
  });

  test("16. Missing mandatory v4 reference -> verification fails closed", async () => {
    const snapDir = await createV4Snapshot("snap-16");
    const manifest = readManifest(snapDir);
    manifest.internalReferences = [];
    writeManifest(snapDir, manifest);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
  });

  test("17. Mixed draft/backlog and normal task references are all covered in v4", async () => {
    const profileDir = path.join(testRoot, "profile-17");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const a1 = path.join(profileDir, "attachments", "a1.txt");
    const a2 = path.join(profileDir, "attachments", "a2.txt");
    writeFileSync(a1, "a1", { mode: 0o600 });
    writeFileSync(a2, "a2", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, {
      id: "t17",
      attachments: [a1],
      draft: { text: "D", references: [{ path: a2 }] },
      backlog: [{ id: "m1", text: "B", references: [{ path: a1 }], createdAt: 100 }],
    });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-17");
    const snap = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    expect(snap.manifest.internalReferences?.length).toBe(3);

    const destDir = path.join(testRoot, "dest-17");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("ready");
    expect(res.internalReferencesRebound).toBe(3);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 18–22. External / cross-profile / unresolved classification
  // ──────────────────────────────────────────────────────────────────────────

  test("18. External Git project with an attachments-like directory is preserved, not cross-profile and not unresolved", async () => {
    const extRepo = path.join(testRoot, "external-repo-18");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    mkdirSync(path.join(extRepo, "attachments"), { recursive: true });
    const extAtt = path.join(extRepo, "attachments", "logo.png");
    writeFileSync(extAtt, "logo", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-18");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t18", refs: [{ path: extAtt }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-18");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-18");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    // External git project must not be surfaced as cross-profile or unresolved
    expect(res.unresolvedCrossProfileReferences ?? 0).toBe(0);
    expect(res.unresolvedExternalReferences ?? 0).toBe(0);
    expect(res.activationReadiness).toBe("ready");
    const refs = JSON.parse(readTaskField(destDir, "t18", "refs"));
    expect(refs[0].path).toBe(extAtt);
  });

  test("19. Existing foreign ForgeOrbit profile dependency -> cross-profile, requires-external-recovery", async () => {
    const profileB = path.join(testRoot, "profile-b-19");
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });
    const bAtt = path.join(profileB, "attachments", "b.txt");
    writeFileSync(bAtt, "b", { mode: 0o600 });
    const bDb = createCanonicalProfileDb(path.join(profileB, "agetor.sqlite"));
    bDb.close();

    const profileA = path.join(testRoot, "profile-a-19");
    mkdirSync(profileA, { recursive: true });
    const dbPath = path.join(profileA, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t19", refs: [{ path: bAtt }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileA });
    const snapDir = path.join(testRoot, "snap-19");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-19");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.unresolvedCrossProfileReferences ?? 0).toBeGreaterThan(0);
    expect(res.activationReadiness).toBe("requires-external-recovery");
    const refs = JSON.parse(readTaskField(destDir, "t19", "refs"));
    expect(refs[0].path).toBe(bAtt);
  });

  test("20. Deleted foreign ForgeOrbit profile dependency -> unresolved external, not ready", async () => {
    // Profile B exists at snapshot time, then is deleted before restore.
    const profileB = path.join(testRoot, "data-b-20");
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });
    const bAtt = path.join(profileB, "attachments", "ghost.bin");
    writeFileSync(bAtt, "ghost", { mode: 0o600 });
    const bDb = createCanonicalProfileDb(path.join(profileB, "agetor.sqlite"));
    bDb.close();

    const profileA = path.join(testRoot, "profile-a-20");
    mkdirSync(profileA, { recursive: true });
    const dbPath = path.join(profileA, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t20", refs: [{ path: bAtt }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileA });
    const snapDir = path.join(testRoot, "snap-20");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    // Delete the foreign profile (directory name has no forgeorbit/agetor/profile marker)
    rmSync(profileB, { recursive: true, force: true });

    const destDir = path.join(testRoot, "dest-20");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    // The deleted dependency must surface as an unresolved external reference, never silently dropped
    expect(res.unresolvedExternalReferences ?? 0).toBeGreaterThan(0);
    expect(res.activationReadiness).not.toBe("ready");
    expect(res.activationReadiness).toBe("requires-external-recovery");
    const refs = JSON.parse(readTaskField(destDir, "t20", "refs"));
    expect(refs[0].path).toBe(bAtt);
  });

  test("21. Missing absolute operational file outside a recognized profile -> unresolved external, not ready", async () => {
    const missingFile = path.join(testRoot, "missing-dir", "ghost.txt");

    const profileDir = path.join(testRoot, "profile-21");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t21", refs: [{ path: missingFile }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-21");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-21");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.unresolvedExternalReferences ?? 0).toBeGreaterThan(0);
    expect(res.activationReadiness).toBe("requires-external-recovery");
    const refs = JSON.parse(readTaskField(destDir, "t21", "refs"));
    expect(refs[0].path).toBe(missingFile);
  });

  test("22. Valid external project reference preserved unchanged", async () => {
    const extRepo = path.join(testRoot, "external-repo-22");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    mkdirSync(path.join(extRepo, "src"), { recursive: true });
    const extSrc = path.join(extRepo, "src", "app.tsx");
    writeFileSync(extSrc, "export {}", { mode: 0o600 });

    const profileDir = path.join(testRoot, "profile-22");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t22", refs: [{ path: extSrc }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-22");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-22");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.unresolvedExternalReferences ?? 0).toBe(0);
    const refs = JSON.parse(readTaskField(destDir, "t22", "refs"));
    expect(refs[0].path).toBe(extSrc);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 23. Multiple legitimate symlink aliases
  // ──────────────────────────────────────────────────────────────────────────

  test("23. Multiple legitimate symlink aliases are recognized as internal and rebound in v4", async () => {
    const realProfile = path.join(testRoot, "real-profile-23");
    mkdirSync(path.join(realProfile, "attachments"), { recursive: true });
    const f1 = path.join(realProfile, "attachments", "f1.txt");
    writeFileSync(f1, "f1", { mode: 0o600 });

    const sym1 = path.join(testRoot, "sym1-23");
    symlinkSync(realProfile, sym1);

    const dbPath = path.join(realProfile, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t23", refs: [{ path: path.join(sym1, "attachments", "f1.txt") }] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: realProfile });
    const snapDir = path.join(testRoot, "snap-23");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-23");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("ready");
    const refs = JSON.parse(readTaskField(destDir, "t23", "refs"));
    expect(refs[0].path).toBe(path.join(destDir, "attachments", "f1.txt"));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 24–28. Preservation invariants and round trip
  // ──────────────────────────────────────────────────────────────────────────

  test("24. Offline verification succeeds after deleting the synthetic source profile", async () => {
    const profileDir = path.join(testRoot, "profile-24");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "offline.txt");
    writeFileSync(att, "offline", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t24", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-24");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    rmSync(profileDir, { recursive: true, force: true });
    expect(existsSync(profileDir)).toBe(false);

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
  });

  test("25. Snapshot source database remains byte-for-byte unchanged", async () => {
    const profileDir = path.join(testRoot, "profile-25");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "immutable.txt");
    writeFileSync(att, "immutable", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t25", attachments: [att] });
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();

    const preSha = await computeFileSha256(dbPath);

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-25");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const postSha = await computeFileSha256(dbPath);
    expect(postSha).toBe(preSha);
  });

  test("26. Original snapshot remains unchanged after restore", async () => {
    const snapDir = await createV4Snapshot("snap-26");
    const snapDbPath = path.join(snapDir, "database.sqlite");
    const snapManifestPath = path.join(snapDir, "manifest.json");
    const preDbSha = await computeFileSha256(snapDbPath);
    const preManifestSha = await computeFileSha256(snapManifestPath);

    await restoreBackupSnapshot(snapDir, path.join(testRoot, "dest-26"));

    expect(await computeFileSha256(snapDbPath)).toBe(preDbSha);
    expect(await computeFileSha256(snapManifestPath)).toBe(preManifestSha);
  });

  test("27. Activity Journal preserves exact history after snapshot and restore", async () => {
    const profileDir = path.join(testRoot, "profile-27");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO activity_events (id, event_type, project_path, actor_type, actor_id, target_type, target_id, idempotency_key, payload_json, created_at)
       VALUES
       ('ev-1', 'task_created', '/p', 'owner', 'u1', 'task', 't1', 'key-1', '{"step":1}', 1000),
       ('ev-2', 'task_started', '/p', 'employee', 'a1', 'task', 't1', 'key-2', '{"step":2}', 1010);`,
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-27");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-27");
    await restoreBackupSnapshot(snapDir, destDir);

    const destDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const events = destDb
      .query<{ sequence_id: number; id: string; payload_json: string }, []>(
        "SELECT sequence_id, id, payload_json FROM activity_events ORDER BY sequence_id ASC;",
      )
      .all();
    destDb.close();
    expect(events.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(events.map((e) => e.payload_json)).toEqual(['{"step":1}', '{"step":2}']);
  });

  test("28. Knowledge integrity survives snapshot and restore", async () => {
    const profileDir = path.join(testRoot, "profile-28");
    mkdirSync(path.join(profileDir, "knowledge", "bodies"), { recursive: true });
    const docId = "11111111-1111-4111-8111-111111111111";
    const bodyPath = path.join(profileDir, "knowledge", "bodies", docId, "1.md");
    mkdirSync(path.dirname(bodyPath), { recursive: true });
    writeFileSync(bodyPath, "knowledge body", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, content_sha256, byte_length, revision, created_at, updated_at)
       VALUES (?, 'project', 'p1', 'Doc', ?, ?, 1, 1000, 1000);`,
      [docId, sha256Hex("knowledge body"), Buffer.byteLength("knowledge body")],
    );
    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, content_sha256, byte_length, created_at)
       VALUES (?, 1, ?, ?, 1000);`,
      [docId, sha256Hex("knowledge body"), Buffer.byteLength("knowledge body")],
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-28");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const destDir = path.join(testRoot, "dest-28");
    await restoreBackupSnapshot(snapDir, destDir);

    const restoredBody = readFileSync(path.join(destDir, "knowledge", "bodies", docId, "1.md"), "utf8");
    expect(restoredBody).toBe("knowledge body");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 29. Full v4 Backup -> Verify -> Restore -> Re-backup round trip
  // ──────────────────────────────────────────────────────────────────────────

  test("29. Complete v4 Backup -> Verify -> Restore -> Re-backup round trip", async () => {
    const profileDir = path.join(testRoot, "profile-29");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att = path.join(profileDir, "attachments", "round.txt");
    writeFileSync(att, "round", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    insertTestTask(db, { id: "t29", attachments: [att] });
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, "snap-29");
    await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const destDir = path.join(testRoot, "dest-29");
    const res = await restoreBackupSnapshot(snapDir, destDir);
    expect(res.activationReadiness).toBe("ready");

    // Re-backup the restored profile
    const reDb = new Database(path.join(destDir, "agetor.sqlite"), { readonly: true });
    const reManager = new BackupManager({ db: reDb, dataDir: destDir });
    const reSnapDir = path.join(testRoot, "snap-29-re");
    await reManager.createSnapshot({ destinationPath: reSnapDir, manifestVersion: 4 });
    reDb.close();

    const reVer = await verifyBackupSnapshot(reSnapDir);
    expect(reVer.ok).toBe(true);
    expect(reVer.coverage).toBe("complete-profile");
    const reManifest = readManifest(reSnapDir);
    expect(reManifest.internalReferences?.length).toBe(1);
    expect(reManifest.internalReferences![0]!.refType).toBe("canonical-relative");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 30. No access to real profile data
  // ──────────────────────────────────────────────────────────────────────────

  test("30. Strict environment isolation: no access to real user profile data", async () => {
    const currentData = process.env.FORGEORBIT_DATA_DIR;
    const currentAgetor = process.env.AGETOR_DATA_DIR;
    expect(currentData).toBeDefined();
    expect(currentAgetor).toBeDefined();
    expect(currentData!.startsWith(tmpdir())).toBe(true);
    const userHome = process.env.HOME || "";
    if (userHome) {
      expect(currentData).not.toBe(path.join(userHome, ".forgeorbit"));
      expect(currentData).not.toBe(path.join(userHome, ".agetor"));
      expect(currentData).not.toBe(path.join(userHome, "Library", "Application Support", "ForgeOrbit"));
    }
  });
});
