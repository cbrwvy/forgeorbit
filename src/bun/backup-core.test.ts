import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  BackupCore,
  BackupCoreError,
  createDatabaseBackup,
  verifyDatabaseIntegrity,
  type BackupResult,
} from "./backup-core.ts";

describe("SQLite Online Backup Core (FO-P2-001)", () => {
  let testDir: string;
  let prevForgeorbit: string | undefined;
  let prevAgetor: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "forgeorbit-backup-test-"));
    prevForgeorbit = process.env.FORGEORBIT_DATA_DIR;
    prevAgetor = process.env.AGETOR_DATA_DIR;
    process.env.FORGEORBIT_DATA_DIR = testDir;
    process.env.AGETOR_DATA_DIR = testDir;
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
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  });

  function createSourceDb(filename = "source.sqlite"): {
    db: Database;
    dbPath: string;
  } {
    const dbPath = path.join(testDir, filename);
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE projects (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        column_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_tasks_col ON tasks(column_id);
    `);
    db.run(
      "INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)",
      ["/code/project-alpha", "Alpha", 1000],
    );
    db.run(
      "INSERT INTO tasks (id, title, column_id, created_at) VALUES (?, ?, ?, ?)",
      ["t-1", "First task", "ready", 1001],
    );
    db.run(
      "INSERT INTO tasks (id, title, column_id, created_at) VALUES (?, ?, ?, ?)",
      ["t-2", "Second task", "running", 1002],
    );
    return { db, dbPath };
  }

  test("creates a verified, point-in-time backup of an active SQLite database in WAL mode", async () => {
    const { db, dbPath } = createSourceDb();
    const backupPath = path.join(testDir, "backup-target.sqlite");

    const result = await createDatabaseBackup(db, backupPath);

    expect(result.path).toBe(path.resolve(backupPath));
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.createdAt).toBeGreaterThan(0);

    // Verify sha256 checksum matches actual file on disk
    const actualBytes = readFileSync(backupPath);
    const expectedSha256 = createHash("sha256").update(actualBytes).digest("hex");
    expect(result.sha256).toBe(expectedSha256);

    // Source database must still be open, accessible, and unmodified
    const sourceProjects = db.query("SELECT * FROM projects").all();
    expect(sourceProjects.length).toBe(1);

    // Backup file must be independently openable and contain identical data
    const backupDb = new Database(backupPath, { readonly: true });
    const backupProjects = backupDb.query("SELECT * FROM projects").all();
    const backupTasks = backupDb.query("SELECT * FROM tasks ORDER BY id").all();
    expect(backupProjects).toEqual(sourceProjects);
    expect(backupTasks.length).toBe(2);
    backupDb.close();

    // Independent integrity verification must report ok
    const integrity = verifyDatabaseIntegrity(backupPath);
    expect(integrity.ok).toBe(true);
    expect(integrity.issues).toEqual([]);

    db.close();
  });

  test("captures uncheckpointed WAL frames from independent database connections", async () => {
    const { db: conn1, dbPath } = createSourceDb();

    // Open a second connection to the same physical database and write to WAL
    const conn2 = new Database(dbPath);
    conn2.run(
      "INSERT INTO tasks (id, title, column_id, created_at) VALUES (?, ?, ?, ?)",
      ["t-wal", "Uncheckpointed WAL task", "review", 2000],
    );

    // Verify WAL file exists on disk
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const backupPath = path.join(testDir, "wal-backup.sqlite");
    const result = await createDatabaseBackup(conn1, backupPath);

    expect(result.bytes).toBeGreaterThan(0);

    // Reopen backup and verify that the uncheckpointed WAL row is captured
    const backupDb = new Database(backupPath, { readonly: true });
    const walTask = backupDb
      .query<{ id: string; title: string }, [string]>(
        "SELECT id, title FROM tasks WHERE id = ?",
      )
      .get("t-wal");

    expect(walTask).not.toBeNull();
    expect(walTask?.title).toBe("Uncheckpointed WAL task");

    // The backup must be clean and standalone: no backup WAL file should exist
    expect(existsSync(`${backupPath}-wal`)).toBe(false);

    backupDb.close();
    conn2.close();
    conn1.close();
  });

  test("preserves point-in-time snapshot consistency while independent connection writes concurrently", async () => {
    const { db: conn1, dbPath } = createSourceDb();
    const conn2 = new Database(dbPath);
    const backupPath = path.join(testDir, "concurrent-backup.sqlite");

    // Hook called after VACUUM INTO writes the snapshot but before verification/publish
    let concurrentWriteSucceeded = false;
    const afterVacuum = () => {
      conn2.run(
        "INSERT INTO tasks (id, title, column_id, created_at) VALUES (?, ?, ?, ?)",
        ["t-concurrent", "Concurrent task created mid-backup", "done", 3000],
      );
      concurrentWriteSucceeded = true;
    };

    const result = await createDatabaseBackup(conn1, backupPath, { afterVacuum });

    expect(concurrentWriteSucceeded).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    // The backup must NOT contain the concurrent row (point-in-time snapshot)
    const backupDb = new Database(backupPath, { readonly: true });
    const concurrentInBackup = backupDb
      .query("SELECT * FROM tasks WHERE id = 't-concurrent'")
      .get();
    expect(concurrentInBackup).toBeNull();
    backupDb.close();

    // Source database MUST contain the concurrent row
    const concurrentInSource = conn1
      .query("SELECT * FROM tasks WHERE id = 't-concurrent'")
      .get();
    expect(concurrentInSource).not.toBeNull();

    conn2.close();
    conn1.close();
  });

  test("refuses to overwrite an existing backup destination file", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "existing.sqlite");

    // Pre-create destination file with dummy content
    writeFileSync(backupPath, "pre-existing-content-do-not-stomp");

    await expect(createDatabaseBackup(db, backupPath)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "TARGET_EXISTS",
    });

    // Content of existing file must be preserved
    expect(readFileSync(backupPath, "utf8")).toBe(
      "pre-existing-content-do-not-stomp",
    );

    db.close();
  });

  test("refuses when destination file is created concurrently right before publication", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "race-target.sqlite");

    // Hook called after verification succeeds, right before atomic renameSync
    const afterVerify = () => {
      writeFileSync(backupPath, "racing-creation");
    };

    await expect(
      createDatabaseBackup(db, backupPath, { afterVerify }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "TARGET_EXISTS",
    });

    // Existing racing file must be preserved and no temporary files leaked
    expect(readFileSync(backupPath, "utf8")).toBe("racing-creation");
    const remainingFiles = readdirSync(testDir);
    expect(remainingFiles.filter((f) => f.endsWith(".tmp"))).toEqual([]);

    db.close();
  });

  test("cleans up temporary files when integrity verification fails", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "corrupted-target.sqlite");

    // Corrupt the temporary file after VACUUM INTO finishes
    const afterVacuum = (tempPath: string) => {
      // Corrupt database header bytes
      const bytes = readFileSync(tempPath);
      bytes[16] = 0x00; // Invalidate page size
      bytes[17] = 0x00;
      writeFileSync(tempPath, bytes);
    };

    await expect(
      createDatabaseBackup(db, backupPath, { afterVacuum }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "VERIFICATION_FAILED",
    });

    // Destination must NOT exist
    expect(existsSync(backupPath)).toBe(false);

    // Temporary files must have been cleaned up
    const remainingFiles = readdirSync(testDir);
    expect(remainingFiles.filter((f) => f.includes(".tmp"))).toEqual([]);

    db.close();
  });

  test("cleans up temporary files when an unexpected error occurs during backup", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "interrupted-target.sqlite");

    const afterVacuum = () => {
      throw new Error("Simulated disk error or process interruption");
    };

    await expect(
      createDatabaseBackup(db, backupPath, { afterVacuum }),
    ).rejects.toThrow("Simulated disk error");

    // No leftover temporary files
    expect(existsSync(backupPath)).toBe(false);
    const remainingFiles = readdirSync(testDir);
    expect(remainingFiles.filter((f) => f.includes(".tmp"))).toEqual([]);

    db.close();
  });

  test("refuses invalid destination paths (empty, directory, null bytes)", async () => {
    const { db } = createSourceDb();

    // Empty path
    await expect(createDatabaseBackup(db, "")).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "INVALID_PATH",
    });

    // Path ending in slash (directory indicator)
    await expect(createDatabaseBackup(db, `${testDir}/`)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "INVALID_PATH",
    });

    // Existing directory
    await expect(createDatabaseBackup(db, testDir)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "INVALID_PATH",
    });

    // Null bytes
    await expect(
      createDatabaseBackup(db, `${testDir}/bad\0path.sqlite`),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "INVALID_PATH",
    });

    db.close();
  });

  test("refuses when parent directory does not exist and createDirectory is false", async () => {
    const { db } = createSourceDb();
    const missingDir = path.join(testDir, "nested-missing", "backup.sqlite");

    await expect(
      createDatabaseBackup(db, missingDir, { createDirectory: false }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "DIRECTORY_NOT_FOUND",
    });

    db.close();
  });

  test("automatically creates parent directory when createDirectory is true", async () => {
    const { db } = createSourceDb();
    const nestedDir = path.join(testDir, "auto-created-dir");
    const backupPath = path.join(nestedDir, "backup.sqlite");

    expect(existsSync(nestedDir)).toBe(false);

    const result = await createDatabaseBackup(db, backupPath, {
      createDirectory: true,
    });

    expect(existsSync(nestedDir)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(verifyDatabaseIntegrity(backupPath).ok).toBe(true);

    // Verify parent directory has 0o700 permissions on POSIX
    if (process.platform !== "win32") {
      const dirMode = statSync(nestedDir).mode & 0o777;
      expect(dirMode).toBe(0o700);
    }

    db.close();
  });

  test("refuses to backup onto the source database file itself", async () => {
    const { db, dbPath } = createSourceDb();

    await expect(createDatabaseBackup(db, dbPath)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "SAME_AS_SOURCE",
    });

    db.close();
  });

  test("enforces restrictive 0o600 file permissions on published backup", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "perm-test.sqlite");

    await createDatabaseBackup(db, backupPath);

    if (process.platform !== "win32") {
      const mode = statSync(backupPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    db.close();
  });

  test("works with in-memory SQLite database", async () => {
    const memDb = new Database(":memory:");
    memDb.exec("CREATE TABLE memory_items (key TEXT PRIMARY KEY, val TEXT);");
    memDb.run("INSERT INTO memory_items VALUES (?, ?)", ["k1", "v1"]);

    const backupPath = path.join(testDir, "from-memory.sqlite");
    const result = await createDatabaseBackup(memDb, backupPath);

    expect(result.bytes).toBeGreaterThan(0);

    const backupDb = new Database(backupPath, { readonly: true });
    const row = backupDb
      .query<{ key: string; val: string }, []>("SELECT * FROM memory_items")
      .get();
    expect(row).toEqual({ key: "k1", val: "v1" });
    backupDb.close();

    memDb.close();
  });

  test("verifyDatabaseIntegrity independently checks database files", () => {
    const { db, dbPath } = createSourceDb();

    // Valid database
    expect(verifyDatabaseIntegrity(dbPath)).toEqual({ ok: true, issues: [] });

    // Missing file
    const missing = verifyDatabaseIntegrity(path.join(testDir, "does-not-exist.sqlite"));
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]).toContain("File not found");

    // Directory
    const dirCheck = verifyDatabaseIntegrity(testDir);
    expect(dirCheck.ok).toBe(false);
    expect(dirCheck.issues[0]).toContain("is a directory");

    // Non-sqlite text file
    const textPath = path.join(testDir, "sample.txt");
    writeFileSync(textPath, "not an sqlite database file");
    const textCheck = verifyDatabaseIntegrity(textPath);
    expect(textCheck.ok).toBe(false);
    expect(textCheck.issues.length).toBeGreaterThan(0);

    db.close();
  });

  test("BackupCore class supports dependency injection and custom options", async () => {
    const { db } = createSourceDb();
    const customTime = 1777000000000;
    const backupDir = path.join(testDir, "class-options-dir");
    const backupPath = path.join(backupDir, "class-backup.sqlite");

    const core = new BackupCore(db, {
      createDirectory: true,
      now: () => customTime,
    });

    const result = await core.createBackup(backupPath);

    expect(result.createdAt).toBe(customTime);
    expect(result.bytes).toBeGreaterThan(0);
    expect(core.verifyIntegrity(backupPath).ok).toBe(true);

    db.close();
  });

  test("refuses destination path that is a dangling symlink", async () => {
    const { db } = createSourceDb();
    const danglingPath = path.join(testDir, "dangling.sqlite");
    const { symlinkSync } = await import("node:fs");

    symlinkSync(path.join(testDir, "target-does-not-exist"), danglingPath);

    await expect(createDatabaseBackup(db, danglingPath)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "TARGET_EXISTS",
    });

    db.close();
  });

  test("cleanupOrphanTemporaryFiles removes manager-owned temp files and preserves unrelated files", async () => {
    const { cleanupOrphanTemporaryFiles, writeStagingOwnershipMetadata } = await import("./backup-core.ts");
    const regularFile = path.join(testDir, "regular.sqlite");
    const unrelatedTmp = path.join(testDir, "unrelated.tmp");
    const orphanTmp = path.join(testDir, ".database.12345678-1234-1234-1234-123456789abc.tmp");

    mkdirSync(orphanTmp, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(orphanTmp, {
      version: 1,
      subsystem: "backup-core",
      operationId: "12345678-1234-1234-1234-123456789abc",
      pid: 99999999,
      createdAt: Date.now() - 60000,
      state: "writing",
    }, false);

    writeFileSync(regularFile, "sqlite");
    writeFileSync(unrelatedTmp, "other");

    const result = cleanupOrphanTemporaryFiles(testDir);

    expect(result.cleaned).toEqual([orphanTmp]);
    expect(result.errors).toEqual([]);

    expect(existsSync(orphanTmp)).toBe(false);
    expect(existsSync(regularFile)).toBe(true);
    expect(existsSync(unrelatedTmp)).toBe(true);
  });

  test("publication fallback handles EXDEV and correctly uses COPYFILE_EXCL to refuse overwriting", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "fallback-target.sqlite");

    // Pre-create the destination file to simulate concurrent creation
    writeFileSync(backupPath, "pre-existing content");

    // Force linkSync to fail with EXDEV so fallback COPYFILE_EXCL is exercised
    await expect(
      createDatabaseBackup(db, backupPath, {
        fs: {
          link: () => {
            const err = new Error("EXDEV: cross-device link not permitted");
            (err as { code?: string }).code = "EXDEV";
            throw err;
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "TARGET_EXISTS",
    });

    // Content of existing file must be untouched
    expect(readFileSync(backupPath, "utf8")).toBe("pre-existing content");
    db.close();
  });

  test("publication fallback cleans up partial destination file when copy fails mid-way (P1-3)", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "partial-failure-target.sqlite");

    // Force linkSync to fail with EXDEV to trigger copyFileSync fallback,
    // then simulate copyFileSync failing halfway through (e.g. disk full ENOSPC) after writing partial bytes.
    await expect(
      createDatabaseBackup(db, backupPath, {
        fs: {
          link: () => {
            const err = new Error("EXDEV: cross-device link not permitted");
            (err as { code?: string }).code = "EXDEV";
            throw err;
          },
          copyFile: (_src, dest) => {
            // Emulate partial write to destination before I/O error / disk full
            writeFileSync(dest, "corrupt partial SQLite data...");
            const err = new Error("ENOSPC: no space left on device");
            (err as { code?: string }).code = "ENOSPC";
            throw err;
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "IO_ERROR",
    });

    // CRITICAL: The partial destination file must NOT remain on disk!
    expect(existsSync(backupPath)).toBe(false);

    // Staging temp files must be completely cleaned up
    const filesInDir = readdirSync(testDir);
    const orphanTemps = filesInDir.filter((f) => f.startsWith("."));
    expect(orphanTemps).toHaveLength(0);

    db.close();
  });

  test("verifyIntegrity rejects FIFO special file without hanging (P2-9)", () => {
    const fifoPath = path.join(testDir, "test-database.fifo");
    const mkfifoRes = spawnSync("mkfifo", [fifoPath]);
    expect(mkfifoRes.status).toBe(0);

    // Must return immediately without hanging
    const started = performance.now();
    const result = verifyDatabaseIntegrity(fifoPath);
    const duration = performance.now() - started;

    expect(duration).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("not a regular file"))).toBe(true);
  });

  test("verifyIntegrity rejects symbolic link to database (P2-9)", () => {
    const { db, dbPath } = createSourceDb();
    const symlinkPath = path.join(testDir, "db-symlink.sqlite");
    symlinkSync(dbPath, symlinkPath);

    const result = verifyDatabaseIntegrity(symlinkPath);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("symbolic link"))).toBe(true);

    db.close();
  });

  test("verifyIntegrity detects orphaned or invalid foreign key relationships and returns structured errors (P2-8)", () => {
    const invalidDbPath = path.join(testDir, "invalid-fk.sqlite");
    const db = new Database(invalidDbPath);
    db.run("PRAGMA foreign_keys = OFF;");
    db.run("CREATE TABLE parent (id TEXT PRIMARY KEY, name TEXT);");
    db.run("CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));");
    db.run("INSERT INTO child VALUES ('c1', 'missing-parent');");
    db.close();

    const result = verifyDatabaseIntegrity(invalidDbPath);
    expect(result.ok).toBe(false);
    expect(result.foreignKeyViolations).toBeDefined();
    expect(result.foreignKeyViolations?.length).toBe(1);
    expect(result.foreignKeyViolations?.[0]).toEqual({
      table: "child",
      rowid: 1,
      parent: "parent",
      fkid: 0,
    });
    expect(
      result.issues.some(
        (i) =>
          i.includes("Foreign key violation in table 'child'") &&
          i.includes("parent table 'parent'") &&
          i.includes("rowid: 1"),
      ),
    ).toBe(true);
  });

  test("createBackup fails and cleans up temporary files when database contains foreign key violations (P2-8)", async () => {
    const invalidDbPath = path.join(testDir, "invalid-fk-backup.sqlite");
    const db = new Database(invalidDbPath);
    db.run("PRAGMA foreign_keys = OFF;");
    db.run("CREATE TABLE categories (id TEXT PRIMARY KEY);");
    db.run("CREATE TABLE items (id TEXT PRIMARY KEY, cat_id TEXT REFERENCES categories(id));");
    db.run("INSERT INTO items VALUES ('item-1', 'nonexistent-cat');");

    const core = new BackupCore(db);
    const destPath = path.join(testDir, "backup-dest.sqlite");

    await expect(core.createBackup(destPath)).rejects.toThrow("Foreign key violation in table 'items'");
    expect(existsSync(destPath)).toBe(false);

    // No orphan temp files left behind
    const orphanTemps = readdirSync(testDir).filter((f) => f.startsWith("."));
    expect(orphanTemps).toHaveLength(0);

    db.close();
  });

  // FO-P2-003-R2B Hardening Regressions

  test("P2-1: file synchronization failure fails closed and cleans up staging (Finding 1)", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "sync-fail-file.sqlite");

    await expect(
      createDatabaseBackup(db, backupPath, {
        fs: {
          syncFile: () => {
            throw new Error("Simulated EIO on fsync");
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "IO_ERROR",
    });

    expect(existsSync(backupPath)).toBe(false);
    const files = readdirSync(testDir);
    expect(files.filter((f) => f.startsWith("."))).toHaveLength(0);
    db.close();
  });

  test("P2-1: directory synchronization failure after publication fails closed and reports IO_ERROR", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "sync-fail-dir.sqlite");

    await expect(
      createDatabaseBackup(db, backupPath, {
        fs: {
          syncDirectory: () => {
            throw new Error("Simulated directory fsync failure");
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "IO_ERROR",
    });

    db.close();
  });

  test("P2-10: private 0o700 staging directory and 0o600 temporary SQLite permissions (Finding 3)", async () => {
    const { db } = createSourceDb();
    const backupPath = path.join(testDir, "private-perms.sqlite");

    let stagingDirPerms = 0;
    let tempDbPerms = 0;

    await createDatabaseBackup(db, backupPath, {
      beforeVacuum: (stagingDir) => {
        stagingDirPerms = statSync(stagingDir).mode & 0o777;
      },
      afterVacuum: (tempPath) => {
        tempDbPerms = statSync(tempPath).mode & 0o777;
      },
    });

    // Staging directory must be private from inception
    expect(stagingDirPerms).toBe(0o700);
    // SQLite snapshot must have restrictive permissions
    expect(tempDbPerms).toBe(0o600);
    // Final published file must have restrictive 0o600 permissions
    const finalPerms = statSync(backupPath).mode & 0o777;
    expect(finalPerms).toBe(0o600);

    db.close();
  });

  test("P2-2: cleanupOrphanTemporaryFiles preserves active operations holding locks", async () => {
    const { cleanupOrphanTemporaryFiles, writeStagingOwnershipMetadata, tryAcquireFlock, STAGING_LOCK_FILENAME } =
      await import("./backup-core.ts");
    const activeStagingDir = path.join(testDir, ".active.fo-core.12345678-1234-1234-1234-123456789abc.tmp");
    mkdirSync(activeStagingDir, { recursive: true, mode: 0o700 });

    writeStagingOwnershipMetadata(activeStagingDir, {
      version: 1,
      subsystem: "backup-core",
      operationId: "12345678-1234-1234-1234-123456789abc",
      pid: process.pid,
      createdAt: Date.now(),
      state: "writing",
    }, false);

    const lockFd = openSync(path.join(activeStagingDir, STAGING_LOCK_FILENAME), constants.O_RDWR | constants.O_CREAT, 0o600);
    const locked = tryAcquireFlock(lockFd);
    expect(locked).toBe(true);

    const result = cleanupOrphanTemporaryFiles(testDir);
    expect(result.cleaned).not.toContain(activeStagingDir);
    expect(existsSync(activeStagingDir)).toBe(true);

    closeSync(lockFd);
    rmSync(activeStagingDir, { recursive: true, force: true });
  });

  test("P2-2: cleanupOrphanTemporaryFiles preserves directories with missing or malformed metadata", async () => {
    const { cleanupOrphanTemporaryFiles, writeStagingOwnershipMetadata } = await import("./backup-core.ts");

    // 1. Missing metadata
    const noMetaDir = path.join(testDir, ".no-meta.fo-core.11111111-1111-1111-1111-111111111111.tmp");
    mkdirSync(noMetaDir, { recursive: true, mode: 0o700 });

    // 2. Corrupt metadata JSON
    const corruptDir = path.join(testDir, ".corrupt.fo-core.22222222-2222-2222-2222-222222222222.tmp");
    mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(corruptDir, ".forgeorbit-ownership.json"), "{ invalid json");

    // 3. Stale dead directory (should be cleaned)
    const deadDir = path.join(testDir, ".dead.fo-core.33333333-3333-3333-3333-333333333333.tmp");
    mkdirSync(deadDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(deadDir, {
      version: 1,
      subsystem: "backup-core",
      operationId: "33333333-3333-3333-3333-333333333333",
      pid: 99999999,
      createdAt: Date.now() - 100000,
      state: "failed",
    }, false);

    const result = cleanupOrphanTemporaryFiles(testDir);
    expect(result.cleaned).toEqual([deadDir]);
    expect(existsSync(noMetaDir)).toBe(true);
    expect(existsSync(corruptDir)).toBe(true);
    expect(existsSync(deadDir)).toBe(false);

    rmSync(noMetaDir, { recursive: true, force: true });
    rmSync(corruptDir, { recursive: true, force: true });
  });

  test("P2-2: cleanupOrphanTemporaryFiles preserves artifacts owned by other subsystems", async () => {
    const { cleanupOrphanTemporaryFiles, writeStagingOwnershipMetadata } = await import("./backup-core.ts");

    // Staging owned by BackupManager
    const managerDir = path.join(testDir, ".mgr.fo-core.44444444-4444-4444-4444-444444444444.tmp");
    mkdirSync(managerDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(managerDir, {
      version: 1,
      subsystem: "backup-manager",
      operationId: "44444444-4444-4444-4444-444444444444",
      pid: 99999999,
      createdAt: Date.now() - 100000,
      state: "writing",
    }, false);

    // Staging owned by BackupRestore
    const restoreDir = path.join(testDir, ".rst.fo-core.55555555-5555-5555-5555-555555555555.tmp");
    mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(restoreDir, {
      version: 1,
      subsystem: "backup-restore",
      operationId: "55555555-5555-5555-5555-555555555555",
      pid: 99999999,
      createdAt: Date.now() - 100000,
      state: "writing",
    }, false);

    const result = cleanupOrphanTemporaryFiles(testDir);
    expect(result.cleaned).toHaveLength(0);
    expect(existsSync(managerDir)).toBe(true);
    expect(existsSync(restoreDir)).toBe(true);

    rmSync(managerDir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  });

  test("P2-2: cleanupOrphanTemporaryFiles refuses symlinked root directory without traversing", async () => {
    const { cleanupOrphanTemporaryFiles } = await import("./backup-core.ts");
    const realDir = path.join(testDir, "real-cleanup-dir");
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    const symlinkDir = path.join(testDir, "symlink-cleanup-dir");
    symlinkSync(realDir, symlinkDir);

    const result = cleanupOrphanTemporaryFiles(symlinkDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Directory is a symbolic link");
    expect(result.cleaned).toHaveLength(0);
  });
});
