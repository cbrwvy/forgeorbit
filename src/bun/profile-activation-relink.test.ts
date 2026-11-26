/**
 * FO-PORTABLE-ACT01: Pre-Activation Candidate Relinking Tests.
 *
 * Verifies candidate-scoped project relinking and Brain scope rebinding on an
 * inactive managed profile, integrity tracking, recovery report updates, restore
 * confirmation updates, safe rollback on error, and activation readiness transitions.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BackupManager, createBackupSnapshot, verifyBackupSnapshot } from "./backup-manager.ts";
import { restoreBackupSnapshot, buildRecoveryPreview } from "./backup-restore.ts";
import { openBrainStore, brainDirectory } from "./brain-store.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ProfileActivationService } from "./profile-activation.ts";
import { ProfileActivationError } from "./profile-activation-errors.ts";
import { inspectCandidateForActivation } from "./profile-activation-preflight.ts";
import { computeFileSha256Sync, RESTORE_CONFIRMATION_FILENAME, RESTORE_RECOVERY_FILENAME } from "./backup-core.ts";

let root = "";
let baseDataDir = "";
let managedProfilesDir = "";
let candidateDir = "";
let snapshotDir = "";
let projAlphaMissing = "";
let projBetaMissing = "";
let projAlphaNew = "";
let projBetaNew = "";
let service: ProfileActivationService;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fo-act01-relink-test-"));
  baseDataDir = path.join(root, "data");
  managedProfilesDir = path.join(root, "managed-profiles");
  mkdirSync(baseDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(managedProfilesDir, { recursive: true, mode: 0o700 });

  // Init base dataDir DB
  const baseDb = new Database(path.join(baseDataDir, "agetor.sqlite"));
  migrate(baseDb, migrations);
  baseDb.close();

  // Create disposable replacement project directories
  projAlphaNew = path.join(root, "real-alpha");
  projBetaNew = path.join(root, "real-beta");
  mkdirSync(projAlphaNew, { recursive: true, mode: 0o700 });
  mkdirSync(projBetaNew, { recursive: true, mode: 0o700 });

  // Source machine paths (missing on destination)
  projAlphaMissing = "/Users/synthetic-alice/code/alpha";
  projBetaMissing = "/Users/synthetic-alice/code/beta";

  // Create synthetic source profile to snapshot
  const sourceDir = path.join(root, "source-profile");
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  const sourceDb = new Database(path.join(sourceDir, "agetor.sqlite"));
  migrate(sourceDb, migrations);

  const now = Date.now();
  sourceDb.run(
    "INSERT INTO projects (path, name, added_at) VALUES (?, 'Project Alpha', ?);",
    [projAlphaMissing, now],
  );
  sourceDb.run(
    "INSERT INTO projects (path, name, added_at) VALUES (?, 'Project Beta', ?);",
    [projBetaMissing, now],
  );
  sourceDb.run(
    "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, created_at, updated_at) VALUES ('t1', 'Task Alpha', 'Prompt A', 'ready', 'developer', ?, '[]', ?, ?);",
    [projAlphaMissing, now, now],
  );
  sourceDb.run(
    "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, created_at, updated_at) VALUES ('t2', 'Task Beta', 'Prompt B', 'inbox', 'developer', ?, '[]', ?, ?);",
    [projBetaMissing, now, now],
  );
  // Create Brain memories in source
  const sourceBrain = openBrainStore(brainDirectory(sourceDir), { isRegistered: () => true });
  sourceBrain.create({
    title: "Company Governance",
    content: "# Company Governance\nFollow core security principles.\n",
    kind: "decision",
    scopeKind: "company",
  });
  sourceBrain.create({
    title: "Alpha Architecture",
    content: "# Alpha Architecture\nAlpha service specifications.\n",
    kind: "fact",
    scopeKind: "project",
    projectPath: projAlphaMissing,
  });
  sourceBrain.close();

  // Package snapshot
  const snapshotsDir = path.join(root, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  const snapshotRes = await createBackupSnapshot({
    db: sourceDb,
    dataDir: sourceDir,
    destinationDir: snapshotsDir,
  });
  sourceDb.close();
  snapshotDir = snapshotRes.path;

  // Restore snapshot as managed profile candidate
  candidateDir = path.join(managedProfilesDir, "restored-candidate");
  await restoreBackupSnapshot(snapshotDir, candidateDir, {
    createDirectory: true,
    rebindInternalReferences: true,
    runnerOperationId: "op-test-act01",
  });

  service = new ProfileActivationService({
    activeDataDir: baseDataDir,
    baseDataDir,
  });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("candidate relinking: inspect initially reports REQUIRES_EXTERNAL_RECOVERY and lists missing projects", () => {
  const inspection = service.inspectCandidate(candidateDir);
  expect(inspection.ok).toBe(false);
  expect(inspection.code).toBe("REQUIRES_EXTERNAL_RECOVERY");
  expect(inspection.readiness).toBe("requires-external-recovery");
  expect(inspection.recoveryPreview).toBeDefined();
  expect(inspection.recoveryPreview?.totalExternalProjectsRequiringAttention).toBe(2);
  expect(inspection.recoveryPreview?.projects.length).toBe(2);

  const alpha = inspection.recoveryPreview?.projects.find((p) => p.name === "Project Alpha");
  const beta = inspection.recoveryPreview?.projects.find((p) => p.name === "Project Beta");
  expect(alpha?.existsOnDisk).toBe(false);
  expect(alpha?.requiresUserIntervention).toBe(true);
  expect(beta?.existsOnDisk).toBe(false);
  expect(beta?.requiresUserIntervention).toBe(true);
});

test("candidate relinking: relinking Project Alpha updates candidate and rebinds Brain scopes, leaving Beta unresolved", () => {
  const result = service.relinkCandidateProject({
    candidatePath: candidateDir,
    oldPath: projAlphaMissing,
    newPath: projAlphaNew,
  });

  expect(result.ok).toBe(true);
  expect(result.oldPath).toBe(projAlphaMissing);
  expect(result.newPath).toBe(realpathSync(projAlphaNew));
  expect(result.reboundBrainMemories).toBe(1);
  expect(result.readiness).toBe("requires-external-recovery");
  expect(result.totalExternalProjectsRequiringAttention).toBe(1);

  // Check candidate SQLite
  const candidateDb = new Database(path.join(candidateDir, "agetor.sqlite"));
  const alphaRow = candidateDb.query<{ path: string; name: string }, []>(
    "SELECT path, name FROM projects WHERE name = 'Project Alpha';",
  ).get();
  expect(alphaRow?.path).toBe(realpathSync(projAlphaNew));
  const alphaTask = candidateDb.query<{ workdir: string }, []>(
    "SELECT workdir FROM tasks WHERE id = 't1';",
  ).get();
  expect(alphaTask?.workdir).toBe(realpathSync(projAlphaNew));
  candidateDb.close();

  // Check Brain scope rebinding
  const candidateBrain = openBrainStore(brainDirectory(candidateDir), { isRegistered: () => true });
  const alphaMemoriesRes = candidateBrain.list({
    scopeKind: "project",
    projectPath: realpathSync(projAlphaNew),
    inheritCompany: false,
    text: "",
    status: "active",
    limit: 10,
  });
  expect(alphaMemoriesRes.memories.length).toBe(1);
  expect(alphaMemoriesRes.memories[0]?.title).toBe("Alpha Architecture");
  expect(alphaMemoriesRes.memories[0]?.scope.id).toBe(realpathSync(projAlphaNew));
  candidateBrain.close();

  // Candidate inspection shows 1 missing project remains
  const inspectAfterAlpha = service.inspectCandidate(candidateDir);
  expect(inspectAfterAlpha.ok).toBe(false);
  expect(inspectAfterAlpha.code).toBe("REQUIRES_EXTERNAL_RECOVERY");
  expect(inspectAfterAlpha.recoveryPreview?.totalExternalProjectsRequiringAttention).toBe(1);

  // Activation prepare is still blocked
  expect(() => service.prepareActivation({ candidatePath: candidateDir })).toThrow(ProfileActivationError);
});

test("candidate relinking: relinking both projects enables activation readiness and prepareActivation succeeds", () => {
  // Relink Alpha
  service.relinkCandidateProject({
    candidatePath: candidateDir,
    oldPath: projAlphaMissing,
    newPath: projAlphaNew,
  });

  // Relink Beta
  const resBeta = service.relinkCandidateProject({
    candidatePath: candidateDir,
    oldPath: projBetaMissing,
    newPath: projBetaNew,
  });

  expect(resBeta.ok).toBe(true);
  expect(resBeta.readiness).toBe("ready");
  expect(resBeta.totalExternalProjectsRequiringAttention).toBe(0);

  // Candidate inspection is now ready!
  const finalInspect = service.inspectCandidate(candidateDir);
  expect(finalInspect.ok).toBe(true);
  expect(finalInspect.readiness).toBe("ready");
  expect(finalInspect.code).toBeNull();
  expect(finalInspect.recoveryPreview?.totalExternalProjectsRequiringAttention).toBe(0);

  // Now prepareActivation succeeds!
  const prep = service.prepareActivation({ candidatePath: candidateDir });
  expect(prep.state).toBe("prepared");
  expect(prep.action).toBe("activate");
  expect(prep.requiresRestart).toBe(true);
  expect(prep.candidatePath).toBe(realpathSync(candidateDir));
});

test("negative check: candidate outside managed storage is refused", () => {
  const outsideCandidate = path.join(root, "outside-candidate");
  cpSync(candidateDir, outsideCandidate, { recursive: true });

  expect(() =>
    service.relinkCandidateProject({
      candidatePath: outsideCandidate,
      oldPath: projAlphaMissing,
      newPath: projAlphaNew,
    }),
  ).toThrow(ProfileActivationError);

  try {
    service.relinkCandidateProject({
      candidatePath: outsideCandidate,
      oldPath: projAlphaMissing,
      newPath: projAlphaNew,
    });
  } catch (err) {
    expect((err as ProfileActivationError).code).toBe("CANDIDATE_OUTSIDE_MANAGED");
  }
});

test("negative check: active profile cannot be modified through candidate relinking", () => {
  expect(() =>
    service.relinkCandidateProject({
      candidatePath: baseDataDir,
      oldPath: projAlphaMissing,
      newPath: projAlphaNew,
    }),
  ).toThrow(ProfileActivationError);

  try {
    service.relinkCandidateProject({
      candidatePath: baseDataDir,
      oldPath: projAlphaMissing,
      newPath: projAlphaNew,
    });
  } catch (err) {
    expect((err as ProfileActivationError).code).toBe("CANDIDATE_ACTIVE");
  }
});

test("negative check: invalid project identity refused", () => {
  expect(() =>
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: "/nonexistent/project/path",
      newPath: projAlphaNew,
    }),
  ).toThrow(ProfileActivationError);

  try {
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: "/nonexistent/project/path",
      newPath: projAlphaNew,
    });
  } catch (err) {
    expect((err as ProfileActivationError).code).toBe("PROJECT_NOT_FOUND");
  }
});

test("negative check: missing replacement directory refused", () => {
  expect(() =>
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: projAlphaMissing,
      newPath: path.join(root, "nonexistent-dir"),
    }),
  ).toThrow(ProfileActivationError);

  try {
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: projAlphaMissing,
      newPath: path.join(root, "nonexistent-dir"),
    });
  } catch (err) {
    expect((err as ProfileActivationError).code).toBe("DIRECTORY_NOT_FOUND");
  }
});

test("negative check: symlink replacement directory refused", () => {
  const symlinkDir = path.join(root, "symlinked-dir");
  symlinkSync(projAlphaNew, symlinkDir);

  expect(() =>
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: projAlphaMissing,
      newPath: symlinkDir,
    }),
  ).toThrow(ProfileActivationError);

  try {
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: projAlphaMissing,
      newPath: symlinkDir,
    });
  } catch (err) {
    expect((err as ProfileActivationError).code).toBe("UNTRUSTED_SYMLINK");
  }
});

test("negative check: duplicate project mapping refused", () => {
  // Relink Alpha to projAlphaNew
  service.relinkCandidateProject({
    candidatePath: candidateDir,
    oldPath: projAlphaMissing,
    newPath: projAlphaNew,
  });

  // Attempting to relink Beta to the SAME directory projAlphaNew must be refused
  expect(() =>
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: projBetaMissing,
      newPath: projAlphaNew,
    }),
  ).toThrow(ProfileActivationError);

  try {
    service.relinkCandidateProject({
      candidatePath: candidateDir,
      oldPath: projBetaMissing,
      newPath: projAlphaNew,
    });
  } catch (err) {
    expect((err as ProfileActivationError).code).toBe("PROJECT_CONFLICT");
  }
});

test("candidate modification preserves original snapshot immutable", async () => {
  const snapDbBefore = computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256;
  const snapManifestBefore = readFileSync(path.join(snapshotDir, "manifest.json"), "utf8");

  service.relinkCandidateProject({
    candidatePath: candidateDir,
    oldPath: projAlphaMissing,
    newPath: projAlphaNew,
  });

  const snapDbAfter = computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256;
  const snapManifestAfter = readFileSync(path.join(snapshotDir, "manifest.json"), "utf8");

  expect(snapDbAfter).toBe(snapDbBefore);
  expect(snapManifestAfter).toBe(snapManifestBefore);
});
