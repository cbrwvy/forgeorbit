/**
 * Dedicated isolated worker process for Backup/Restore operations (FO-P2-003-R4A).
 *
 * Runs inside a standalone Bun child process.
 * Never imports db.ts or starts servers.
 * Communicates via typed line-delimited JSON over stdio.
 * Emits strictly bounded compact result summaries.
 * Never emits premature "completed" state; parent remains the authority.
 */

import { Database } from "bun:sqlite";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { BackupCore, BackupCoreError, computeFileSha256, verifyDatabaseIntegrity } from "./backup-core.ts";
import { serializeBackupError, serializeWorkerErrorFrame } from "./backup-ipc.ts";
import {
  BackupManager,
  BackupManagerError,
  verifyBackupSnapshot,
} from "./backup-manager.ts";
import { BackupRestore, RestoreError } from "./backup-restore.ts";
import { buildSnapshotRecoveryPreview } from "./backup-preview.ts";
import type {
  BackupOperationRequest,
  BoundedBackupResultPayload,
  CompactBackupDatabaseResult,
  CompactCreateSnapshotResult,
  CompactRestoreSnapshotResult,
  CompactVerifyDatabaseResult,
  CompactVerifySnapshotResult,
  ParentToWorkerMessage,
  SerializedBackupError,
  SnapshotManifestSummary,
  WorkerOperationState,
  WorkerToParentMessage,
} from "./backup-runner-types.ts";

// Ensure worker stdout is exclusively reserved for JSON protocol frames
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

// Enforce private file creation inside isolated worker process (FO-P2-003-R4D)
try {
  process.umask(0o077);
} catch {
  /* best effort */
}

let activeOperationId: string | null = null;
let isCancelled = false;
let isTerminating = false;
let activeStagingDir: string | null = null;
let dbToClose: Database | null = null;

function cleanupActiveWorkerResources(): void {
  if (dbToClose) {
    try {
      dbToClose.close();
    } catch {
      /* ignore */
    }
    dbToClose = null;
  }
  if (activeStagingDir) {
    try {
      if (existsSync(activeStagingDir)) {
        rmSync(activeStagingDir, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
    activeStagingDir = null;
  }
}

// Sequential async write queue with bounded backpressure handling
let writeQueue: Promise<void> = Promise.resolve();

function emitMessage(message: WorkerToParentMessage): Promise<boolean> {
  if (isTerminating && message.type === "state") {
    return Promise.resolve(false);
  }

  const next = writeQueue.then(async () => {
    if (!process.stdout.writable || process.stdout.destroyed) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      try {
        const line = JSON.stringify(message) + "\n";
        const canWrite = process.stdout.write(line, "utf8", (err) => {
          if (err) {
            resolve(false);
          } else {
            resolve(true);
          }
        });

        if (!canWrite) {
          const onDrain = () => {
            cleanup();
            resolve(true);
          };
          const onError = () => {
            cleanup();
            resolve(false);
          };
          const cleanup = () => {
            process.stdout.removeListener("drain", onDrain);
            process.stdout.removeListener("error", onError);
          };
          process.stdout.once("drain", onDrain);
          process.stdout.once("error", onError);
        }
      } catch {
        resolve(false);
      }
    });
  });

  writeQueue = next.then(() => {}, () => {});
  return next;
}

/** Emits an already-serialized, pre-bounded line through the same write queue. */
function emitRawFrame(line: string): Promise<boolean> {
  const next = writeQueue.then(async () => {
    if (!process.stdout.writable || process.stdout.destroyed) return false;
    return new Promise<boolean>((resolve) => {
      try {
        const canWrite = process.stdout.write(line, "utf8", (err) => {
          resolve(!err);
        });
        if (!canWrite) {
          const onDrain = () => {
            cleanup();
            resolve(true);
          };
          const onError = () => {
            cleanup();
            resolve(false);
          };
          const cleanup = () => {
            process.stdout.removeListener("drain", onDrain);
            process.stdout.removeListener("error", onError);
          };
          process.stdout.once("drain", onDrain);
          process.stdout.once("error", onError);
        }
      } catch {
        resolve(false);
      }
    });
  });
  writeQueue = next.then(() => {}, () => {});
  return next;
}

function emitState(state: WorkerOperationState, stagingDir?: string): void {
  if (stagingDir) {
    activeStagingDir = stagingDir;
  }
  if (!activeOperationId || isTerminating) return;
  emitMessage({
    type: "state",
    operationId: activeOperationId,
    state,
    stagingDir,
    progress: {
      phase: state,
      timestamp: Date.now(),
    },
  }).catch(() => {
    /* ignore pipe errors during non-critical state updates */
  });
}

async function emitPublished(targetPath: string): Promise<boolean> {
  if (!activeOperationId || isTerminating) return false;
  return emitMessage({
    type: "published",
    operationId: activeOperationId,
    targetPath,
    publishedAt: Date.now(),
  });
}

function serializeError(err: unknown): SerializedBackupError {
  if (err instanceof BackupCoreError) {
    return serializeBackupError(err, "backup-core");
  }
  if (err instanceof BackupManagerError) {
    return serializeBackupError(err, "backup-manager");
  }
  if (err instanceof RestoreError) {
    return serializeBackupError(err, "backup-restore");
  }
  return serializeBackupError(err);
}

async function finishWithResult(result: BoundedBackupResultPayload): Promise<void> {
  isTerminating = true;
  await emitMessage({
    type: "result",
    operationId: activeOperationId!,
    result,
  });
  await writeQueue;
  // Yield one event-loop tick to allow kernel stream buffer flushing before exit
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(0);
}

async function finishWithError(err: unknown): Promise<void> {
  isTerminating = true;
  const serialized = serializeError(err);
  await emitRawFrame(serializeWorkerErrorFrame(activeOperationId ?? "unknown", serialized));
  await writeQueue;
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(1);
}

async function handleStart(request: BackupOperationRequest): Promise<void> {
  activeOperationId = request.operationId;
  const { payload } = request;

  emitState("running");

  try {
    switch (payload.type) {
      case "backup-database": {
        const db = new Database(payload.dbPath, { readonly: true });
        dbToClose = db;
        try {
          db.run("PRAGMA busy_timeout = 10000;");
        } catch {
          /* best effort */
        }
        const core = new BackupCore(db);

        const rawResult = await core.createBackup(payload.destinationPath, {
          runnerOperationId: request.operationId,
          createDirectory: payload.createDirectory,
          beforeVacuum: async (stagingDir) => {
            if (isCancelled) throw new BackupCoreError("Operation was cancelled", "CANCELLED");
            emitState("running", stagingDir);
          },
          afterVacuum: async () => {
            if (isCancelled) throw new BackupCoreError("Operation was cancelled", "CANCELLED");
            emitState("verifying");
          },
          afterVerify: async () => {
            if (isCancelled) throw new BackupCoreError("Operation was cancelled", "CANCELLED");
            emitState("publishing");
          },
          afterPublish: async (destPath) => {
            await emitPublished(destPath);
          },
        });

        db.close();
        dbToClose = null;

        const compactResult: CompactBackupDatabaseResult = {
          type: "backup-database",
          operationId: request.operationId,
          path: rawResult.path,
          bytes: rawResult.bytes,
          sha256: rawResult.sha256,
          durationMs: rawResult.durationMs,
          createdAt: rawResult.createdAt,
          publicationReceipt: rawResult.publicationReceipt
            ? rawResult.publicationReceipt.ok
              ? {
                  written: true,
                  directorySynced: rawResult.publicationReceipt.directorySynced,
                }
              : {
                  written: false,
                  code: rawResult.publicationReceipt.code,
                  message: rawResult.publicationReceipt.message.slice(0, 500),
                }
            : undefined,
        };

        await finishWithResult(compactResult);
        break;
      }

      case "verify-database": {
        if (isCancelled) throw new BackupCoreError("Operation was cancelled", "CANCELLED");
        emitState("verifying");
        const rawResult = verifyDatabaseIntegrity(payload.filePath);
        let sha256: string | undefined;
        let bytes: number | undefined;
        if (rawResult.ok) {
          try {
            const st = statSync(payload.filePath);
            bytes = st.size;
            sha256 = await computeFileSha256(payload.filePath);
          } catch {
            /* best effort */
          }
        }

        const compactResult: CompactVerifyDatabaseResult = {
          type: "verify-database",
          operationId: request.operationId,
          filePath: path.resolve(payload.filePath),
          ok: rawResult.ok,
          sha256,
          bytes,
          issues: rawResult.issues.slice(0, 20),
          foreignKeyViolations: rawResult.foreignKeyViolations?.slice(0, 20),
        };

        await finishWithResult(compactResult);
        break;
      }

      case "create-snapshot": {
        const db = new Database(payload.dbPath, { readonly: true });
        dbToClose = db;
        try {
          db.run("PRAGMA busy_timeout = 10000;");
        } catch {
          /* best effort */
        }
        const manager = new BackupManager({
          db,
          knowledgeRootDir: payload.knowledgeRootDir,
          dataDir: payload.dataDir,
          attachmentsRootDir: payload.attachmentsRootDir,
          screenshotsRootDir: payload.screenshotsRootDir,
          issueThreadsRootDir: payload.issueThreadsRootDir,
          pipelineRunsRootDir: payload.pipelineRunsRootDir,
        });

        const rawResult = await manager.createSnapshot({
          runnerOperationId: request.operationId,
          destinationDir: payload.snapshotDestinationDir,
          destinationPath: payload.destinationPath,
          createDirectory: payload.createDirectory,
          maxRetries: payload.maxRetries,
          manifestVersion: payload.manifestVersion,
          manifestMetadata: {
            ...payload.manifestMetadata,
            runnerOperationId: request.operationId,
          },
          onStagingPrepared: async (stagingDir) => {
            if (isCancelled) throw new BackupManagerError("Operation was cancelled", "CANCELLED");
            emitState("running", stagingDir);
          },
          afterDatabaseBackup: async (stagingDir) => {
            if (isCancelled) throw new BackupManagerError("Operation was cancelled", "CANCELLED");
            emitState("running", stagingDir);
          },
          afterKnowledgeCopy: async (stagingDir) => {
            if (isCancelled) throw new BackupManagerError("Operation was cancelled", "CANCELLED");
            emitState("verifying", stagingDir);
          },
          beforePublish: async (stagingDir) => {
            if (isCancelled) throw new BackupManagerError("Operation was cancelled", "CANCELLED");
            emitState("publishing", stagingDir);
          },
          afterPublish: async (destPath) => {
            await emitPublished(destPath);
          },
        });

        db.close();
        dbToClose = null;

        const manifest = rawResult.manifest;
        const dbFile = manifest.files.find((f) => f.path === "database.sqlite");

        const compactResult: CompactCreateSnapshotResult = {
          type: "create-snapshot",
          operationId: request.operationId,
          path: rawResult.path,
          snapshotId: rawResult.snapshotId,
          databaseSha256: dbFile?.sha256 ?? "",
          databaseBytes: dbFile?.bytes ?? 0,
          totalFiles: manifest.stats.fileCount,
          totalBytes: manifest.stats.totalBytes,
          schemaVersion: manifest.schemaVersion,
          appVersion: manifest.appVersion,
          createdAt: manifest.createdAt,
          durationMs: rawResult.durationMs,
          coverage: manifest.coverage,
          manifest: {
            manifestVersion: manifest.manifestVersion,
            snapshotId: manifest.snapshotId,
            appVersion: manifest.appVersion,
            schemaVersion: manifest.schemaVersion,
            createdAt: manifest.createdAt,
            verified: manifest.verified,
            coverage: manifest.coverage,
            stats: {
              totalBytes: manifest.stats.totalBytes,
              fileCount: manifest.stats.fileCount,
              knowledgeDocumentCount: manifest.stats.knowledgeDocumentCount,
              knowledgeRevisionCount: manifest.stats.knowledgeRevisionCount,
              attachmentCount: manifest.stats.attachmentCount,
              screenshotCount: manifest.stats.screenshotCount,
              issueThreadCount: manifest.stats.issueThreadCount,
              pipelineRunCount: manifest.stats.pipelineRunCount,
            },
            origin: manifest.origin,
            brain: manifest.brain ? { ...manifest.brain, projectScopes: [] } : undefined,
          },
        };

        await finishWithResult(compactResult);
        break;
      }

      case "verify-snapshot": {
        if (isCancelled) throw new BackupManagerError("Operation was cancelled", "CANCELLED");
        emitState("verifying");
        const rawResult = await verifyBackupSnapshot(payload.snapshotPath);

        let manifestSummary: SnapshotManifestSummary | undefined;
        let dbSha256: string | undefined;
        let dbBytes: number | undefined;

        if (rawResult.manifest) {
          const m = rawResult.manifest;
          const dbFile = m.files.find((f) => f.path === "database.sqlite");
          dbSha256 = dbFile?.sha256;
          dbBytes = dbFile?.bytes;
          manifestSummary = {
            manifestVersion: m.manifestVersion,
            snapshotId: m.snapshotId,
            appVersion: m.appVersion,
            schemaVersion: m.schemaVersion,
            createdAt: m.createdAt,
            verified: m.verified,
            coverage: m.coverage,
            stats: {
              totalBytes: m.stats.totalBytes,
              fileCount: m.stats.fileCount,
              knowledgeDocumentCount: m.stats.knowledgeDocumentCount,
              knowledgeRevisionCount: m.stats.knowledgeRevisionCount,
              attachmentCount: m.stats.attachmentCount,
              screenshotCount: m.stats.screenshotCount,
              issueThreadCount: m.stats.issueThreadCount,
              pipelineRunCount: m.stats.pipelineRunCount,
            },
            origin: m.origin,
            brain: m.brain ? { ...m.brain, projectScopes: [] } : undefined,
          };
        }

        // The recovery preview is built here, inside the isolated worker, from
        // the same verified snapshot. The trusted main process never opens an
        // untrusted snapshot SQLite database.
        let preview: CompactVerifySnapshotResult["preview"];
        if (payload.includePreview && rawResult.ok && rawResult.manifest) {
          const resolvedSnap = path.resolve(payload.snapshotPath);
          const previewDbPath = path.join(resolvedSnap, "database.sqlite");
          let previewDb: Database | null = null;
          try {
            previewDb = new Database(previewDbPath, { readonly: true });
            preview = buildSnapshotRecoveryPreview(
              resolvedSnap,
              rawResult.coverage !== "complete-profile",
              previewDb,
              rawResult.manifest,
            );
          } catch (previewErr) {
            throw new BackupManagerError(
              `Could not read the snapshot database for a recovery preview: ${(previewErr as Error).message}`,
              "PREVIEW_FAILED",
            );
          } finally {
            if (previewDb) {
              try {
                previewDb.close();
              } catch {
                /* ignore */
              }
            }
          }
        }

        const compactResult: CompactVerifySnapshotResult = {
          type: "verify-snapshot",
          operationId: request.operationId,
          snapshotPath: path.resolve(payload.snapshotPath),
          ok: rawResult.ok,
          coverage: rawResult.coverage,
          snapshotId: rawResult.snapshotId,
          manifestVersion: rawResult.manifestVersion,
          appVersion: rawResult.appVersion,
          schemaVersion: rawResult.schemaVersion,
          createdAt: rawResult.createdAt,
          databaseSha256: dbSha256,
          databaseBytes: dbBytes,
          filesChecked: rawResult.filesChecked,
          totalBytes: rawResult.totalBytes,
          issues: rawResult.issues.slice(0, 20),
          manifest: manifestSummary,
          contentIdentity: rawResult.contentIdentity,
          preview,
        };

        await finishWithResult(compactResult);
        break;
      }

      case "restore-snapshot": {
        const restore = new BackupRestore();

        const rawResult = await restore.restore(
          payload.snapshotPath,
          payload.destinationDir,
          {
            runnerOperationId: request.operationId,
            dbFilename: payload.dbFilename,
            createDirectory: payload.createDirectory,
            requireCompleteProfile: payload.requireCompleteProfile,
            rebindInternalReferences: payload.rebindInternalReferences,
            expectedContentIdentity: payload.expectedContentIdentity,
            beforeExtract: async () => {
              if (isCancelled) throw new RestoreError("Operation was cancelled", "CANCELLED");
              emitState("verifying");
            },
            onStagingPrepared: async (stagingDir) => {
              if (isCancelled) throw new RestoreError("Operation was cancelled", "CANCELLED");
              emitState("running", stagingDir);
            },
            afterExtract: async (stagingDir) => {
              if (isCancelled) throw new RestoreError("Operation was cancelled", "CANCELLED");
              emitState("verifying", stagingDir);
            },
            beforePublish: async (stagingDir) => {
              if (isCancelled) throw new RestoreError("Operation was cancelled", "CANCELLED");
              emitState("publishing", stagingDir);
            },
            afterPublish: async (destPath) => {
              await emitPublished(destPath);
            },
          },
        );

        const compactResult: CompactRestoreSnapshotResult = {
          type: "restore-snapshot",
          operationId: request.operationId,
          destinationPath: rawResult.destinationPath,
          snapshotId: rawResult.snapshotId,
          manifestVersion: rawResult.manifestVersion,
          appVersion: rawResult.appVersion,
          schemaVersion: rawResult.schemaVersion,
          dbFilename: rawResult.dbFilename,
          databaseBytes: rawResult.databaseBytes,
          originalDatabaseSha256: rawResult.originalDatabaseSha256,
          databaseSha256: rawResult.databaseSha256,
          databaseTransformed: rawResult.databaseTransformed,
          knowledgeDocumentCount: rawResult.knowledgeDocumentCount,
          knowledgeRevisionCount: rawResult.knowledgeRevisionCount,
          attachmentCount: rawResult.attachmentCount,
          screenshotCount: rawResult.screenshotCount,
          issueThreadCount: rawResult.issueThreadCount,
          pipelineRunCount: rawResult.pipelineRunCount,
          filesRestored: rawResult.filesRestored,
          totalBytesRestored: rawResult.totalBytesRestored,
          durationMs: rawResult.durationMs,
          restoredAt: rawResult.restoredAt,
          coverage: rawResult.coverage,
          internalReferencesDiscovered: rawResult.rebindingStats?.discovered,
          internalReferencesRebound: rawResult.rebindingStats?.rebound,
          internalReferencesUnchanged: rawResult.rebindingStats?.unchanged,
          internalReferencesUnresolved: rawResult.rebindingStats?.unresolved,
          unresolvedCrossProfileReferences: rawResult.unresolvedCrossProfileReferences,
          crossProfileDependencies: rawResult.crossProfileDependencies,
          unresolvedExternalReferences: rawResult.unresolvedExternalReferences,
          unresolvedExternalDependencies: rawResult.unresolvedExternalDependencies,
          externalProjectsRequiringAttention: rawResult.externalProjectsRequiringAttention,
          validationStatus: rawResult.validationStatus,
          activationReadiness: rawResult.activationReadiness,
        };

        await finishWithResult(compactResult);
        break;
      }

      default: {
        throw new Error(`Unknown operation payload type: ${(payload as { type: string }).type}`);
      }
    }
  } catch (err) {
    if (dbToClose) {
      try {
        dbToClose.close();
      } catch {
        /* best effort */
      }
      dbToClose = null;
    }
    await finishWithError(err);
  }
}

// ── Lifecycle & Process Event Handlers ───────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("[backup-worker] unhandled rejection:", reason);
  cleanupActiveWorkerResources();
  finishWithError(reason).finally(() => process.exit(1));
});

process.on("uncaughtException", (err) => {
  console.error("[backup-worker] uncaught exception:", err);
  cleanupActiveWorkerResources();
  finishWithError(err).finally(() => process.exit(1));
});

// Safe handling for broken pipes and parent process termination
process.stdout.on("error", (err: unknown) => {
  const code = (err as { code?: string })?.code;
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
    isCancelled = true;
    cleanupActiveWorkerResources();
    process.exit(1);
  }
});

process.on("SIGPIPE", () => {
  isCancelled = true;
  cleanupActiveWorkerResources();
  process.exit(1);
});

process.on("SIGTERM", () => {
  isCancelled = true;
  cleanupActiveWorkerResources();
  process.exit(1);
});

process.stdin.on("end", () => {
  // Parent disconnected or terminated
  isCancelled = true;
  cleanupActiveWorkerResources();
  process.exit(1);
});

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("close", () => {
  isCancelled = true;
  cleanupActiveWorkerResources();
  process.exit(1);
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as ParentToWorkerMessage;
    if (msg.type === "cancel") {
      isCancelled = true;
    } else if (msg.type === "start") {
      handleStart(msg.operation).catch((err) => {
        console.error("[backup-worker] execution error:", err);
      });
    }
  } catch (parseErr) {
    console.error("[backup-worker] malformed message:", parseErr);
  }
});
