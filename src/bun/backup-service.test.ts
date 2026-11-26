/**
 * FO-P2-004 backend integration tests.
 *
 * Every profile here is synthetic and isolated in a temp directory. The real
 * ForgeOrbit profile, credentials and external projects are never read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupManager } from "./backup-manager.ts";
import { BackupService, BackupServiceError, type BackupRunnerLike } from "./backup-service.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import type { BackupOperationView } from "../shared/backup.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "fo-p2-004-service-"));
process.env.FORGEORBIT_DATA_DIR = path.join(ROOT, "env-profile");
process.env.AGETOR_DATA_DIR = path.join(ROOT, "env-profile");
mkdirSync(process.env.FORGEORBIT_DATA_DIR, { recursive: true, mode: 0o700 });

const SOURCE = path.join(ROOT, "profile");
const BACKUPS = path.join(ROOT, "backups");
const RESTORES = path.join(ROOT, "restores");
const REGISTRY = path.join(ROOT, "registry", "backup-registry.json");

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function createProfile(root: string, options: { tasks?: { id: string; refs: string[] }[] } = {}): {
  dbPath: string;
  dataDir: string;
} {
  const dataDir = path.join(root, "dataDir");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const category of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
    mkdirSync(path.join(dataDir, category), { recursive: true, mode: 0o700 });
  }
  const dbPath = path.join(dataDir, "agetor.sqlite");
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  migrate(db, migrations);
  for (const task of options.tasks ?? []) {
    const now = Date.now();
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, created_at, updated_at) VALUES (?, ?, ?, 'backlog', 'claude-code', ?, ?, ?, ?);",
      [task.id, `Synthetic task ${task.id}`, "Synthetic prompt", dataDir, JSON.stringify(task.refs), now, now],
    );
  }
  db.close();
  return { dbPath, dataDir };
}

async function waitForOperation(
  service: BackupService,
  operationId: string,
  timeoutMs = 60_000,
): Promise<BackupOperationView> {
  const deadline = Date.now() + timeoutMs;
  let last = service.getOperation(operationId);
  while (Date.now() < deadline) {
    last = service.getOperation(operationId);
    if (
      last.state === "completed" ||
      last.state === "cancelled-before-publication" ||
      last.state === "published-unconfirmed" ||
      last.state === "indeterminate" ||
      last.state === "verification-failed" ||
      last.state === "failed-before-publication"
    ) {
      return last;
    }
    await Bun.sleep(50);
  }
  throw new Error(`operation ${operationId} did not settle: ${last.state}`);
}

function makeService(profile: { dbPath: string; dataDir: string }): BackupService {
  return new BackupService({
    dataDir: profile.dataDir,
    dbPath: profile.dbPath,
    registryPath: REGISTRY,
  });
}

function freshService(): { service: BackupService; profile: { dbPath: string; dataDir: string } } {
  const root = mkdtempSync(path.join(ROOT, "case-"));
  const profile = createProfile(root);
  return { service: makeService(profile), profile };
}

beforeAll(() => {
  mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  mkdirSync(RESTORES, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(REGISTRY), { recursive: true, mode: 0o700 });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("BackupService complete-profile round trip", () => {
  test("create → independent verify → history → preview → inactive restore", async () => {
    const { service, profile } = freshService();
    const beforeDb = readFileSync(profile.dbPath);
    const info = service.getProfileInfo();
    expect(info.profileRoot).toBe(profile.dataDir);
    expect(info.databaseFilename).toBe("agetor.sqlite");
    expect(info.manifestVersion).toBe(4);
    expect(info.coverage).toBe("complete-profile");
    expect(info.notIncluded).toContain("external-git-repositories");

    const createGrant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const createOp = service.startCreate(createGrant.id);
    const created = await waitForOperation(service, createOp.id);
    expect(created.state).toBe("completed");
    expect(created.integrity).toBe("not_verified");
    expect(created.snapshotPath).not.toBeNull();
    const snapshotPath = created.snapshotPath!;
    expect(existsSync(path.join(snapshotPath, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(snapshotPath, "database.sqlite"))).toBe(true);
    expect(created.create?.snapshot.manifestVersion).toBe(4);
    expect(created.create?.snapshot.coverage).toBe("complete-profile");
    expect(created.create?.snapshot.legacy).toBe(false);
    expect(created.create?.snapshot.databaseSha256).toMatch(/^[0-9a-f]{64}$/);

    // Independent verification is a separate, isolated operation.
    const verifyOp = service.startVerify(snapshotPath);
    const verified = await waitForOperation(service, verifyOp.id);
    expect(verified.state).toBe("completed");
    expect(verified.integrity).toBe("verified");
    expect(verified.verify?.ok).toBe(true);
    expect(verified.verify?.manifestVersion).toBe(4);
    expect(verified.verify?.issues).toEqual([]);

    // The create record now reflects the separate verification result, but the
    // artifact's own history entry carries the verdict too.
    const createAgain = service.getOperation(createOp.id);
    expect(createAgain.integrity).toBe("verified");

    const history = service.listHistory();
    expect(history.locations).toContain(realpathSync(BACKUPS));
    const entry = history.entries.find((candidate) => candidate.snapshotPath === snapshotPath);
    expect(entry).toBeDefined();
    expect(entry!.integrity).toBe("verified");
    expect(entry!.manifestVersion).toBe(4);
    expect(entry!.coverage).toBe("complete-profile");
    expect(entry!.lastVerificationOk).toBe(true);

    const preview = await service.previewRestore(snapshotPath, verified.id);
    expect(preview.snapshot.legacy).toBe(false);
    expect(preview.recovery.readiness).toBe("ready");
    expect(preview.recovery.readinessAdvisory).toBe(true);
    expect(preview.recovery.internalReferencesExpected).toBe(0);
    expect(preview.verification.ok).toBe(true);

    const restoreGrant = service.issueDestinationGrant(RESTORES, "restore-parent");
    const restoreOp = service.startRestore({
      snapshotPath,
      grantId: restoreGrant.id,
      verificationId: verified.id,
      destinationName: "restored-profile",
    });
    const restored = await waitForOperation(service, restoreOp.id);
    expect(restored.state).toBe("completed");
    expect(restored.integrity).toBe("verified");
    const destination = restored.destinationPath!;
    expect(destination).toBe(path.join(realpathSync(RESTORES), "restored-profile"));
    expect(existsSync(path.join(destination, "agetor.sqlite"))).toBe(true);
    expect(restored.restore?.activated).toBe(false);
    expect(restored.restore?.activationReadiness).toBe("ready");
    expect(existsSync(restored.restore!.recoveryReportPath)).toBe(true);

    // The source profile and the snapshot are unchanged by restore.
    expect(sha256(readFileSync(profile.dbPath))).toBe(sha256(beforeDb));
    expect(readFileSync(path.join(snapshotPath, "manifest.json")).length).toBeGreaterThan(0);
    expect(sha256(readFileSync(path.join(snapshotPath, "database.sqlite")))).toBe(
      created.create!.snapshot.databaseSha256!,
    );
    // The restored DB is a new independent file.
    expect(lstatSync(path.join(destination, "agetor.sqlite")).isFile()).toBe(true);
    expect(existsSync(path.join(destination, ".forgeorbit-recovery.json"))).toBe(true);
  }, 120_000);
});

describe("BackupService path and permission validation", () => {
  test("the webview cannot choose the source profile or a destination inside it", () => {
    const { service, profile } = freshService();
    expect(() => service.issueDestinationGrant(profile.dataDir, "backup-parent")).toThrow(
      /active profile|destination/i,
    );
    expect(() => service.issueDestinationGrant(profile.dataDir, "restore-parent")).toThrow(
      /active profile|destination/i,
    );
    expect(() => service.startCreate("not-a-grant")).toThrow(BackupServiceError);
  });

  test("a restore requires fresh successful verification", async () => {
    const { service, profile } = freshService();
    const createGrant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const created = await waitForOperation(service, service.startCreate(createGrant.id).id);
    const snapshotPath = created.snapshotPath!;
    const restoreGrant = service.issueDestinationGrant(RESTORES, "restore-parent");
    expect(() =>
      service.startRestore({
        snapshotPath,
        grantId: restoreGrant.id,
        verificationId: "missing",
        destinationName: `nope-${randomUUID().slice(0, 8)}`,
      }),
    ).toThrow(/verify/i);
    await expect(service.previewRestore(snapshotPath, "missing")).rejects.toThrow(/verify/i);
    expect(profile.dbPath).toBeDefined();
  });

  test("an existing restore destination is rejected and nothing is overwritten", async () => {
    const { service } = freshService();
    const createGrant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const created = await waitForOperation(service, service.startCreate(createGrant.id).id);
    const snapshotPath = created.snapshotPath!;
    const verified = await waitForOperation(service, service.startVerify(snapshotPath).id);
    const existingName = `existing-${randomUUID().slice(0, 8)}`;
    const existing = path.join(RESTORES, existingName);
    mkdirSync(existing, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(existing, "keep.txt"), "do not overwrite");
    const restoreGrant = service.issueDestinationGrant(RESTORES, "restore-parent");
    expect(() =>
      service.startRestore({
        snapshotPath,
        grantId: restoreGrant.id,
        verificationId: verified.id,
        destinationName: existingName,
      }),
    ).toThrow(/already exists/i);
    expect(readFileSync(path.join(existing, "keep.txt"), "utf8")).toBe("do not overwrite");
  });

  test("another profile and a snapshot bundle are rejected as destinations", async () => {
    const { service } = freshService();
    const foreign = path.join(ROOT, `foreign-profile-${randomUUID().slice(0, 8)}`);
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(foreign, "agetor.sqlite"), "not a real db");
    expect(() => service.issueDestinationGrant(foreign, "restore-parent")).toThrow(/profile/i);

    const createGrant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const created = await waitForOperation(service, service.startCreate(createGrant.id).id);
    expect(() => service.issueDestinationGrant(created.snapshotPath!, "backup-parent")).toThrow(
      /snapshot/i,
    );
  });

  test("a destination grant is single-use and purpose-bound", () => {
    const { service } = freshService();
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    expect(() => service.addLocation(grant.id)).toThrow(/expired|invalid/i);
  });
});

describe("BackupService truthful ambiguous outcomes", () => {
  class StubRunner implements BackupRunnerLike {
    constructor(
      private readonly behavior: {
        create?: (
          emit: (
            operationId: string,
            state: "running" | "verifying" | "publishing",
            progress?: {
              phase?: string;
              bytesProcessed?: number;
              totalBytes?: number;
              filesProcessed?: number;
              totalFiles?: number;
              timestamp: number;
            },
          ) => void,
        ) => Promise<never>;
        verify?: () => Promise<never>;
        cancel?: () => Promise<{
          outcome:
            | "cancelled_before_execution"
            | "cancelled_before_publication"
            | "publication_committed"
            | "publication_unresolved"
            | "already_completed"
            | "already_failed"
            | "not_found";
          cancelled: boolean;
          accepted: boolean;
          operationId: string;
        }>;
      },
      private readonly onStateChange?: (status: {
        operationId: string;
        type: "create-snapshot";
        state: "running";
        targetPath: string | null;
        startedAt: number;
        updatedAt: number;
      }) => void,
    ) {}
    createSnapshot(): Promise<never> {
      const emit = (
        operationId: string,
        state: "running" | "verifying" | "publishing" = "running",
        progress?: {
          phase?: string;
          bytesProcessed?: number;
          totalBytes?: number;
          filesProcessed?: number;
          totalFiles?: number;
          timestamp: number;
        },
      ) => {
        this.onStateChange?.({
          operationId,
          type: "create-snapshot",
          state,
          targetPath: null,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          progress,
        } as any);
      };
      return (this.behavior.create ?? (() => Promise.reject(new Error("unused"))))(emit);
    }
    verifySnapshot(): Promise<never> {
      return (this.behavior.verify ?? (() => Promise.reject(new Error("unused"))))();
    }
    restoreSnapshot(): Promise<never> {
      return Promise.reject(new Error("unused"));
    }
    requestCancellation(operationId: string) {
      return (
        this.behavior.cancel?.() ??
        Promise.resolve({
          outcome: "not_found" as const,
          cancelled: false,
          accepted: false,
          operationId,
        })
      );
    }
    async dispose(): Promise<void> {}
  }

  function serviceWithStub(
    behavior: ConstructorParameters<typeof StubRunner>[0],
    profile: { dbPath: string; dataDir: string },
  ): BackupService {
    return new BackupService({
      dataDir: profile.dataDir,
      dbPath: profile.dbPath,
      registryPath: REGISTRY,
      runnerFactory: (onStateChange) =>
        new StubRunner(behavior, onStateChange as unknown as ConstructorParameters<typeof StubRunner>[1]),
    });
  }

  test("PUBLISHED_UNCONFIRMED is preserved and never reported as completed", async () => {
    const root = mkdtempSync(path.join(ROOT, "ambiguous-"));
    const profile = createProfile(root);
    const destination = path.join(BACKUPS, "unconfirmed-artifact");
    const service = serviceWithStub(
      {
        create: async (emit) => {
          emit("stub-create-unconfirmed", "running");
          throw new BackupRunnerError("destination was published but unconfirmed", "PUBLISHED_UNCONFIRMED", {
            details: { publicationOutcome: "committed", destinationPath: destination },
          });
        },
      },
      profile,
    );
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const operation = await waitForOperation(service, service.startCreate(grant.id).id);
    expect(operation.state).toBe("published-unconfirmed");
    expect(operation.integrity).toBe("not_verified");
    expect(operation.error?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(operation.snapshotPath).toBe(destination);
  });

  test("INDETERMINATE is preserved and never retried automatically", async () => {
    const root = mkdtempSync(path.join(ROOT, "indeterminate-"));
    const profile = createProfile(root);
    let calls = 0;
    const service = serviceWithStub(
      {
        create: async (emit) => {
          calls++;
          emit("stub-create-indeterminate", "running");
          throw new BackupRunnerError("publication unresolved", "INDETERMINATE", {
            details: { publicationOutcome: "unresolved", destinationPath: path.join(BACKUPS, "maybe") },
          });
        },
      },
      profile,
    );
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const operation = await waitForOperation(service, service.startCreate(grant.id).id);
    expect(operation.state).toBe("indeterminate");
    expect(operation.integrity).toBe("not_verified");
    expect(calls).toBe(1);
  });

  test("a published snapshot that fails integrity is verification-failed", async () => {
    const root = mkdtempSync(path.join(ROOT, "integrity-"));
    const profile = createProfile(root);
    const snapshotPath = path.join(BACKUPS, "corrupt-snapshot");
    mkdirSync(snapshotPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(snapshotPath, "manifest.json"),
      JSON.stringify({
        manifestVersion: 4,
        snapshotId: "corrupt",
        appVersion: "1.0.3",
        schemaVersion: "1",
        createdAt: Date.now(),
        verified: false,
        coverage: "complete-profile",
        files: [],
        stats: { totalBytes: 0, fileCount: 0, knowledgeDocumentCount: 0, knowledgeRevisionCount: 0 },
      }),
    );
    writeFileSync(path.join(snapshotPath, "database.sqlite"), "not a sqlite database");
    const service = serviceWithStub(
      {
        verify: async () => {
          throw new BackupRunnerError("checksum mismatch", "VERIFICATION_FAILED", {
            details: { verificationFailed: true, publicationOutcome: "committed" },
          });
        },
      },
      profile,
    );
    const operation = await waitForOperation(service, service.startVerify(snapshotPath).id);
    expect(operation.state).toBe("verification-failed");
    expect(operation.integrity).toBe("failed");
    expect(operation.error?.code).toBe("VERIFICATION_FAILED");
  });

  test("cancellation before publication is truthful and clears the busy slot", async () => {
    const root = mkdtempSync(path.join(ROOT, "cancel-"));
    const profile = createProfile(root);
    let resolveNever: () => void = () => {};
    const service = serviceWithStub(
      {
        create: (emit) => {
          emit("stub-create-cancel", "running");
          return new Promise<never>(() => {
            resolveNever = () => {};
          });
        },
        cancel: async () => ({
          outcome: "cancelled_before_publication",
          cancelled: true,
          accepted: true,
          operationId: "stub-create-cancel",
        }),
      },
      profile,
    );
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const operation = service.startCreate(grant.id);
    await Bun.sleep(10);
    const result = await service.cancelOperation(operation.id);
    expect(result.operation.state).toBe("cancelled-before-publication");
    expect(result.operation.integrity).toBe("not_verified");
    expect(result.operation.cancellable).toBe(false);
    // The next operation can start because the busy slot was released. It is
    // cancelled immediately so the stub does not stay active.
    const grant2 = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const next = service.startCreate(grant2.id);
    expect(["queued", "running"]).toContain(next.state);
    await service.cancelOperation(next.id);
    resolveNever();
  });

  test("cancellation with a committed publication never claims cancellation", async () => {
    const root = mkdtempSync(path.join(ROOT, "cancel-committed-"));
    const profile = createProfile(root);
    const service = serviceWithStub(
      {
        create: async (emit) => {
          emit("stub-create-committed", "running");
          return new Promise<never>(() => {});
        },
        cancel: async () => ({
          outcome: "publication_committed",
          cancelled: false,
          accepted: false,
          operationId: "x",
        }),
      },
      profile,
    );
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const operation = service.startCreate(grant.id);
    // The stub never emits a state callback, so inject a runner id through the
    // cancellation path by using an operation that reported one.
    // The service exposes no direct setter; this test only asserts the initial
    // cancellation request is recorded and no success is claimed.
    const result = await service.cancelOperation(operation.id);
    const current = service.getOperation(operation.id);
    expect(result.cancellation?.outcome).toBe("publication_committed");
    expect(current.state).toBe("published-unconfirmed");
    expect(current.state === "completed").toBe(false);
    expect(current.integrity).toBe("not_verified");
  });

  test("progress and phase propagate into the operation view and history", async () => {
    const root = mkdtempSync(path.join(ROOT, "progress-"));
    const profile = createProfile(root);
    const service = serviceWithStub(
      {
        create: async (emit) => {
          emit("stub-progress", "running", {
            phase: "copying",
            bytesProcessed: 5,
            totalBytes: 10,
            filesProcessed: 2,
            totalFiles: 4,
            timestamp: Date.now(),
          });
          await Bun.sleep(40);
          throw new Error("synthetic stop");
        },
      },
      profile,
    );
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const operation = service.startCreate(grant.id);
    await Bun.sleep(10);
    const current = service.getOperation(operation.id);
    expect(current.state).toBe("running");
    expect(current.phase).toBe("copying");
    expect(current.progress?.bytesProcessed).toBe(5);
    expect(current.progress?.totalBytes).toBe(10);
    expect(current.progress?.filesProcessed).toBe(2);
    expect(service.listOperations().some((entry) => entry.id === operation.id)).toBe(true);
    const settled = await waitForOperation(service, operation.id);
    expect(settled.state).toBe("failed-before-publication");
  });
});

describe("BackupService legacy and unresolved references", () => {
  test("legacy v1 snapshots stay legacy-unverified and are previewed as such", async () => {
    const root = mkdtempSync(path.join(ROOT, "legacy-"));
    const profile = createProfile(root);
    const manager = new BackupManager({ db: new Database(profile.dbPath), dataDir: profile.dataDir });
    const legacy = await manager.createSnapshot({ destinationDir: BACKUPS, manifestVersion: 1 });
    const service = makeService(profile);
    service.issueSnapshotSelection(legacy.path);
    const verified = await waitForOperation(service, service.startVerify(legacy.path).id);
    expect(verified.state).toBe("completed");
    expect(verified.verify?.legacy).toBe(true);
    expect(verified.verify?.manifestVersion).toBe(1);
    const preview = await service.previewRestore(legacy.path, verified.id);
    expect(preview.snapshot.legacy).toBe(true);
    expect(preview.snapshot.coverage).toBe("legacy-database-knowledge");
    expect(preview.recovery.readiness).toBe("legacy-unverified");
    expect(preview.recovery.legacy).toBe(true);
    expect(service.inspectSnapshot(legacy.path).legacy).toBe(true);
  }, 60_000);

  test("missing external and cross-profile references surface in the preview", async () => {
    const root = mkdtempSync(path.join(ROOT, "refs-"));
    const foreign = path.join(root, "foreign-profile");
    mkdirSync(path.join(foreign, "attachments"), { recursive: true, mode: 0o700 });
    const foreignDb = new Database(path.join(foreign, "agetor.sqlite"));
    foreignDb.run("CREATE TABLE tasks (id TEXT PRIMARY KEY);");
    foreignDb.close();

    const profile = createProfile(root, {
      tasks: [
        {
          id: "task-refs",
          refs: [
            path.join(foreign, "attachments", "foreign.pdf"),
            path.join(root, "not-a-repository", "operational.bin"),
          ],
        },
      ],
    });
    const service = makeService(profile);
    const grant = service.issueDestinationGrant(BACKUPS, "backup-parent");
    const created = await waitForOperation(service, service.startCreate(grant.id).id);
    expect(created.state).toBe("completed");
    const verified = await waitForOperation(service, service.startVerify(created.snapshotPath!).id);
    expect(verified.state).toBe("completed");
    const preview = await service.previewRestore(created.snapshotPath!, verified.id);
    expect(preview.recovery.unresolvedCrossProfileReferences).toBeGreaterThanOrEqual(1);
    expect(preview.recovery.unresolvedExternalReferences).toBeGreaterThanOrEqual(1);
    expect(preview.recovery.crossProfileDependencies.some((entry) => entry.includes("foreign.pdf"))).toBe(true);
    expect(preview.recovery.readiness).toBe("requires-external-recovery");
    expect(preview.recovery.readinessAdvisory).toBe(true);
  }, 90_000);
});

describe("BackupService error privacy", () => {
  test("validation errors are bounded and never carry database content", () => {
    const { service } = freshService();
    expect(() => service.startVerify(path.join(BACKUPS, "missing-snapshot"))).toThrow(BackupServiceError);
    const history = service.listHistory();
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain("SELECT");
    expect(serialized).not.toContain("Cannot find module");
  });
});
