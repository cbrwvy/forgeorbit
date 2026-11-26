import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateSqliteFile, ensurePrivateDataDir } from "./private-storage.ts";

test("new directory, SQLite and WAL/SHM are private even with umask 022", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo013a1-modes-"));
  const dir = path.join(root, "data");
  const old = process.umask(0o022);
  let db: Database | undefined;
  try {
    ensurePrivateDataDir(dir);
    const file = path.join(dir, "agetor.sqlite");
    createPrivateSqliteFile(file);
    db = new Database(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1)");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const suffix of ["", "-wal", "-shm"]) expect(statSync(file + suffix).mode & 0o777).toBe(0o600);
  } finally { db?.close(); process.umask(old); }
});

test("existing synthetic owner permissions are not changed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo013a1-existing-"));
  chmodSync(dir, 0o755);
  const file = path.join(dir, "agetor.sqlite");
  createPrivateSqliteFile(file); chmodSync(file, 0o644);
  ensurePrivateDataDir(dir); createPrivateSqliteFile(file);
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  expect(statSync(file).mode & 0o777).toBe(0o644);
});
