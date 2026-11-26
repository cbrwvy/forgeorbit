/**
 * FO-P2-004-R1 / F3: snapshot content identity and preview/restore binding.
 *
 * Every test uses a real isolated worker against a real synthetic profile.
 * The cache is keyed by verified content identity, not by path, and a restore
 * must match the identity the user previewed.
 */

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  FORGEORBIT_DATA_DIR: process.env.FORGEORBIT_DATA_DIR,
  AGETOR_DATA_DIR: process.env.AGETOR_DATA_DIR,
};
const ROOT = mkdtempSync(path.join(tmpdir(), "fo-r1-f3-"));
const HOME = path.join(ROOT, "home");
const ENV_DATA = path.join(ROOT, "env-profile");
for (const dir of [HOME, ENV_DATA, path.join(ROOT, "tmp")]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
process.env.HOME = HOME;
process.env.TMPDIR = path.join(ROOT, "tmp");
process.env.FORGEORBIT_DATA_DIR = ENV_DATA;
process.env.AGETOR_DATA_DIR = ENV_DATA;

const { migrate } = await import("./migrate.ts");
const { migrations } = await import("./migrations/index.ts");
const { BackupService, BackupServiceError } = await import("./backup-service.ts");

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createProfile(root: string): { dbPath: string; dataDir: string } {
  const dataDir = path.join(root, "dataDir");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const category of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
    mkdirSync(path.join(dataDir, category), { recursive: true, mode: 0o700 });
  }
  writeFileSync(path.join(dataDir, "attachments", "note.bin"), "original-attachment-content");
  const dbPath = path.join(dataDir, "agetor.sqlite");
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  migrate(db, migrations);
  db.close();
  return { dbPath, dataDir };
}

interface Fixture {
  service: InstanceType<typeof BackupService>;
  profile: { dbPath: string; dataDir: string };
  backups: string;
  restores: string;
  snapshotPath: string;
  verificationId: string;
}

async function waitForOperation(service: InstanceType<typeof BackupService>, operationId: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const operation = service.getOperation(operationId);
    if (
      operation.state === "completed" ||
      operation.state === "cancelled-before-publication" ||
      operation.state === "published-unconfirmed" ||
      operation.state === "indeterminate" ||
      operation.state === "verification-failed" ||
      operation.state === "failed-before-publication"
    ) {
      return operation;
    }
    if (Date.now() > deadline) throw new Error("operation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function createVerifiedFixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(ROOT, "case-"));
  const profile = createProfile(root);
  const backups = path.join(root, "backups");
  const restores = path.join(root, "restores");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  mkdirSync(restores, { recursive: true, mode: 0o700 });
  const service = new BackupService({
    dataDir: profile.dataDir,
    dbPath: profile.dbPath,
    registryPath: path.join(root, "registry", "backup-registry.json"),
  });
  const grant = service.issueDestinationGrant(backups, "backup-parent");
  const created = await waitForOperation(service, service.startCreate(grant.id).id);
  expect(created.state).toBe("completed");
  const snapshotPath = created.snapshotPath!;
  const verified = await waitForOperation(service, service.startVerify(snapshotPath).id);
  expect(verified.state).toBe("completed");
  expect(verified.verify?.ok).toBe(true);
  expect(verified.verify?.contentIdentity).toMatch(/^[0-9a-f]{64}$/);
  return {
    service,
    profile,
    backups,
    restores,
    snapshotPath,
    verificationId: verified.id,
  };
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: string,
): Promise<InstanceType<typeof BackupServiceError>> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BackupServiceError);
    expect((err as InstanceType<typeof BackupServiceError>).code).toBe(code);
    return err as InstanceType<typeof BackupServiceError>;
  }
  throw new Error(`expected ${code}, but the call resolved`);
}

test("F3: changing the database after verification invalidates the cached preview", async () => {
  const fixture = await createVerifiedFixture();
  try {
    const preview = await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
    expect(preview.verification.ok).toBe(true);
    expect(preview.verification.contentIdentity).toMatch(/^[0-9a-f]{64}$/);

    appendFileSync(path.join(fixture.snapshotPath, "database.sqlite"), "tampered");
    await expectServiceError(
      fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId),
      "SNAPSHOT_CHANGED",
    );
    // The stale verification record is gone: the next attempt needs a new verify.
    await expectServiceError(
      fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId),
      "VERIFICATION_REQUIRED",
    );
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: changing an attachment after verification invalidates the cached preview", async () => {
  const fixture = await createVerifiedFixture();
  try {
    await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
    writeFileSync(path.join(fixture.snapshotPath, "attachments", "note.bin"), "changed-attachment");
    await expectServiceError(
      fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId),
      "SNAPSHOT_CHANGED",
    );
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: changing the manifest after verification invalidates the cached preview", async () => {
  const fixture = await createVerifiedFixture();
  try {
    await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
    const manifestPath = path.join(fixture.snapshotPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.appVersion = "tampered-manifest";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await expectServiceError(
      fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId),
      "SNAPSHOT_CHANGED",
    );
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: a different valid snapshot substituted at the same path is rejected", async () => {
  const fixture = await createVerifiedFixture();
  try {
    await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);

    // Build a second, genuinely valid snapshot in another parent.
    const otherParent = path.join(ROOT, "other-parent", `case-${Date.now()}`);
    mkdirSync(otherParent, { recursive: true, mode: 0o700 });
    const grant = fixture.service.issueDestinationGrant(otherParent, "backup-parent");
    const other = await waitForOperation(fixture.service, fixture.service.startCreate(grant.id).id);
    expect(other.state).toBe("completed");
    const replacement = other.snapshotPath!;
    expect(replacement).not.toBe(fixture.snapshotPath);

    // Swap it into the approved path. It is a valid snapshot — only identity differs.
    const parked = `${fixture.snapshotPath}.approved`;
    renameSync(fixture.snapshotPath, parked);
    renameSync(replacement, fixture.snapshotPath);

    // Restoring must not silently accept the substituted bundle: the restore
    // worker re-verifies and compares the actual identity to the preview.
    const restoreGrant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    const operation = fixture.service.startRestore({
      snapshotPath: fixture.snapshotPath,
      grantId: restoreGrant.id,
      verificationId: fixture.verificationId,
      destinationName: "substituted",
    });
    const settled = await waitForOperation(fixture.service, operation.id);
    expect(settled.state).toBe("failed-before-publication");
    expect(settled.error?.code).toBe("SNAPSHOT_CHANGED");
    expect(existsSync(path.join(fixture.restores, "substituted"))).toBe(false);

    // The stale approval is gone; another preview needs a fresh verification.
    try {
      await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
      throw new Error("preview unexpectedly succeeded");
    } catch (err) {
      expect(err).toBeInstanceOf(BackupServiceError);
      expect(["SNAPSHOT_CHANGED", "VERIFICATION_REQUIRED"]).toContain(
        (err as InstanceType<typeof BackupServiceError>).code,
      );
    }
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: symlink substitution at the snapshot path is rejected", async () => {
  const fixture = await createVerifiedFixture();
  try {
    const parked = `${fixture.snapshotPath}.real`;
    renameSync(fixture.snapshotPath, parked);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(parked, fixture.snapshotPath);
    await expectServiceError(
      fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId),
      "UNTRUSTED_SYMLINK",
    );
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: a change between preview and restore aborts and requires a new preview", async () => {
  const fixture = await createVerifiedFixture();
  try {
    await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
    // Mutate after the user's preview, before the restore request.
    appendFileSync(path.join(fixture.snapshotPath, "database.sqlite"), "changed-before-restore");
    const restoreGrant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    const operation = fixture.service.startRestore({
      snapshotPath: fixture.snapshotPath,
      grantId: restoreGrant.id,
      verificationId: fixture.verificationId,
      destinationName: "changed-after-preview",
    });
    const settled = await waitForOperation(fixture.service, operation.id);
    expect(settled.state).toBe("failed-before-publication");
    expect(settled.error?.code).toBe("SNAPSHOT_CHANGED");
    expect(existsSync(path.join(fixture.restores, "changed-after-preview"))).toBe(false);
    // The approval cache was invalidated, so another restore needs verification.
    const secondGrant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    expect(() =>
      fixture.service.startRestore({
        snapshotPath: fixture.snapshotPath,
        grantId: secondGrant.id,
        verificationId: fixture.verificationId,
        destinationName: "changed-again",
      }),
    ).toThrow(/verify|changed/i);
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: an unchanged approved snapshot restores successfully and leaves source/snapshot untouched", async () => {
  const fixture = await createVerifiedFixture();
  try {
    const sourceBefore = sha256File(fixture.profile.dbPath);
    const snapshotDbBefore = sha256File(path.join(fixture.snapshotPath, "database.sqlite"));
    const preview = await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
    const approvedIdentity = preview.verification.contentIdentity;
    const grant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    const operation = fixture.service.startRestore({
      snapshotPath: fixture.snapshotPath,
      grantId: grant.id,
      verificationId: fixture.verificationId,
      destinationName: "unchanged-approved",
    });
    const settled = await waitForOperation(fixture.service, operation.id);
    expect(settled.state).toBe("completed");
    expect(settled.integrity).toBe("verified");
    const destination = settled.destinationPath!;
    expect(existsSync(path.join(destination, "agetor.sqlite"))).toBe(true);
    expect(settled.restore?.activated).toBe(false);
    expect(sha256File(fixture.profile.dbPath)).toBe(sourceBefore);
    expect(sha256File(path.join(fixture.snapshotPath, "database.sqlite"))).toBe(snapshotDbBefore);
    expect(approvedIdentity).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

test("F3: a concurrent restore cannot overwrite an existing destination", async () => {
  const fixture = await createVerifiedFixture();
  try {
    await fixture.service.previewRestore(fixture.snapshotPath, fixture.verificationId);
    const grant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    const first = fixture.service.startRestore({
      snapshotPath: fixture.snapshotPath,
      grantId: grant.id,
      verificationId: fixture.verificationId,
      destinationName: "raced-destination",
    });
    const secondGrant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    expect(() =>
      fixture.service.startRestore({
        snapshotPath: fixture.snapshotPath,
        grantId: secondGrant.id,
        verificationId: fixture.verificationId,
        destinationName: "raced-destination",
      }),
    ).toThrow(/already in progress|operation/i);
    const settled = await waitForOperation(fixture.service, first.id);
    expect(settled.state).toBe("completed");
    const restaurant = path.join(fixture.restores, "raced-destination");
    const before = readFileSync(path.join(restaurant, "agetor.sqlite"));
    const thirdGrant = fixture.service.issueDestinationGrant(fixture.restores, "restore-parent");
    await expectServiceError(
      Promise.resolve().then(() =>
        fixture.service.startRestore({
          snapshotPath: fixture.snapshotPath,
          grantId: thirdGrant.id,
          verificationId: fixture.verificationId,
          destinationName: "raced-destination",
        }),
      ),
      "TARGET_EXISTS",
    );
    expect(readFileSync(path.join(restaurant, "agetor.sqlite"))).toEqual(before);
  } finally {
    await fixture.service.dispose();
  }
}, 120_000);

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});
