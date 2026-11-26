/**
 * FO-P2-005-A — trusted activation preflight.
 *
 * Candidates are produced by the real BackupService workflow
 * (create → verify → inactive restore) with synthetic SQLite profiles under a
 * temporary root. Assertions cover every readiness class that must be
 * rejected and the hostile path classes that must never reach activation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { BackupManager } from "./backup-manager.ts";
import { activationControlDir } from "./profile-paths.ts";
import { inspectCandidateForActivation } from "./profile-activation-preflight.ts";
import { ProfileActivationService } from "./profile-activation.ts";
import {
  createSyntheticProfile,
  createVerifiedSnapshot,
  ensureDir,
  makeBackupService,
  makeRoot,
  restoreCandidate,
  runProbeSync,
  sha256Bytes,
  isolatedProbeEnv,
  waitForOperation,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const TEST_ROOT = makeRoot("fo-p2-005a-preflight-");
process.env.FORGEORBIT_DATA_DIR = path.join(TEST_ROOT.root, "parent-base");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
ensureDir(process.env.FORGEORBIT_DATA_DIR);

let snapshot: VerifiedSnapshot;

beforeAll(async () => {
  const source = createSyntheticProfile(path.join(TEST_ROOT.root, "source"), {
    tasks: [{ id: "task-valid", refs: ["attachments/note.txt"] }],
    attachment: { relativePath: "attachments/note.txt", bytes: "synthetic attachment\n" },
    knowledge: { title: "Synthetic note", body: "# Synthetic knowledge\n\nSynthetic only.\n" },
  });
  snapshot = await createVerifiedSnapshot({
    source,
    root: TEST_ROOT.root,
    parent: path.join(TEST_ROOT.root, "snapshots"),
  });
}, 120_000);

afterAll(async () => {
  await snapshot?.service.dispose().catch(() => {});
  TEST_ROOT.cleanup();
  // `bun test` shares one process across files; never leak this fixture's
  // root (which is deleted) into an unrelated later test file.
  if (PREV_FORGEORBIT_DATA_DIR === undefined) delete process.env.FORGEORBIT_DATA_DIR;
  else process.env.FORGEORBIT_DATA_DIR = PREV_FORGEORBIT_DATA_DIR;
  if (PREV_AGETOR_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = PREV_AGETOR_DATA_DIR;
});

function newBase(root: string): string {
  const base = path.join(root, "base");
  createSyntheticProfile(base, { tasks: [{ id: "task-base" }] });
  return base;
}

async function validCandidate(root: string): Promise<string> {
  const restored = await restoreCandidate({
    snapshot,
    parent: path.join(root, "restores"),
    name: `restored-${crypto.randomUUID().slice(0, 8)}`,
  });
  return restored.destinationPath;
}

function inspect(base: string, candidate: string) {
  return inspectCandidateForActivation({
    candidatePath: candidate,
    activeDataDir: base,
    baseDataDir: base,
    controlDir: activationControlDir(base),
    now: Date.now(),
  });
}

/**
 * Rewrite a real restored candidate's recorded readiness and re-bind the
 * confirmation marker to the new report bytes. This is a negative fixture: the
 * preflight must still reject or independently verify the profile.
 */
function rewriteReadiness(candidate: string, readiness: string): void {
  const reportPath = path.join(candidate, ".forgeorbit-recovery.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  report.activationReadiness = readiness;
  const markerPath = path.join(candidate, ".forgeorbit-restore-confirmed.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  chmodSync(reportPath, 0o600);
  marker.recoveryReportSha256 = sha256Bytes(readFileSync(reportPath));
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
  chmodSync(markerPath, 0o600);
}

describe("FO-P2-005-A activation preflight", () => {
  test("1. a valid restored candidate passes and reports ready", async () => {
    const scope = makeRoot("fo-p2-005a-valid-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const result = inspect(base, candidate);
      expect(result.ok).toBe(true);
      expect(result.code).toBeNull();
      expect(result.readiness).toBe("ready");
      expect(result.manifestVersion).toBe(4);
      expect(result.databaseSha256).toHaveLength(64);
      expect(result.checks.some((check) => check.id === "restore-confirmed")).toBe(true);
      expect(result.checks.some((check) => check.id === "database-integrity")).toBe(true);
      expect(result.checks.some((check) => check.id === "knowledge-consistent")).toBe(true);
      expect(result.checks.some((check) => check.id === "internal-references-present")).toBe(true);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("2. a corrupt SQLite candidate is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-corrupt-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const dbPath = path.join(candidate, "agetor.sqlite");
      const bytes = Buffer.from(readFileSync(dbPath));
      // Destroy the SQLite file header (magic + page size). The file size is
      // unchanged, so this is a content-corruption test, not a truncation.
      bytes.fill(0, 0, Math.min(100, bytes.length));
      writeFileSync(dbPath, bytes);
      chmodSync(dbPath, 0o600);
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(["DATABASE_INTEGRITY", "DATABASE_UNREADABLE"]).toContain(result.code!);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("3. a missing referenced asset is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-missing-asset-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      unlinkSync(path.join(candidate, "attachments", "note.txt"));
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INTERNAL_REFERENCE_MISSING");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("4. the active profile cannot be its own candidate", async () => {
    const scope = makeRoot("fo-p2-005a-active-");
    try {
      const base = newBase(scope.root);
      const result = inspect(base, base);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CANDIDATE_ACTIVE");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("5. a candidate overlapping the active profile is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-overlap-");
    try {
      const base = newBase(scope.root);
      const nested = ensureDir(path.join(base, "nested-profile"));
      const result = inspect(base, nested);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CANDIDATE_ACTIVE");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("6. a symlinked candidate is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-symlink-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const link = path.join(scope.root, "candidate-link");
      symlinkSync(candidate, link);
      const result = inspect(base, link);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CANDIDATE_SYMLINK");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("7. a candidate inside a foreign ForgeOrbit profile is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-foreign-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const foreign = path.join(scope.root, "foreign-profile");
      createSyntheticProfile(foreign, { tasks: [{ id: "foreign-task" }] });
      const nested = path.join(foreign, "nested-candidate");
      rmSync(nested, { recursive: true, force: true });
      // Copy the restored candidate (contents only) under the foreign profile.
      mkdirSync(nested, { recursive: true, mode: 0o700 });
      const { copyProfile } = await import("./fixtures/profile-activation-test-util.ts");
      copyProfile(candidate, nested);
      const result = inspect(base, nested);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("FOREIGN_PROFILE_CONFLICT");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("8. a legacy-unverified candidate is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-legacy-");
    try {
      const base = newBase(scope.root);
      const source = createSyntheticProfile(path.join(scope.root, "legacy-source"), {
        tasks: [{ id: "legacy-task" }],
      });
      const db = new Database(source.dbPath);
      const manager = new BackupManager({ db, dataDir: source.dataDir });
      const legacyParent = ensureDir(path.join(scope.root, "snapshots"));
      const legacy = await manager.createSnapshot({
        destinationDir: legacyParent,
        manifestVersion: 1,
      });
      db.close();
      const service = makeBackupService(source, scope.root);
      try {
        service.issueSnapshotSelection(legacy.path);
        const verified = await waitForOperation(service, service.startVerify(legacy.path).id);
        expect(verified.state).toBe("completed");
        const grant = service.issueDestinationGrant(ensureDir(path.join(scope.root, "restores")), "restore-parent");
        const restored = await waitForOperation(
          service,
          service.startRestore({
            snapshotPath: legacy.path,
            grantId: grant.id,
            verificationId: verified.id,
            destinationName: "legacy-restored",
          }).id,
        );
        expect(restored.state).toBe("completed");
        const result = inspect(base, restored.destinationPath!);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("LEGACY_UNVERIFIED");
      } finally {
        await service.dispose();
      }
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("9. a requires-external-recovery candidate is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-external-");
    try {
      const base = newBase(scope.root);
      const foreign = createSyntheticProfile(path.join(scope.root, "foreign-profile"), {
        tasks: [{ id: "foreign-task" }],
      });
      ensureDir(path.join(foreign.dataDir, "attachments"));
      writeFileSync(path.join(foreign.dataDir, "attachments", "foreign.pdf"), "foreign bytes\n", {
        mode: 0o600,
      });
      const source = createSyntheticProfile(path.join(scope.root, "external-source"), {
        tasks: [
          {
            id: "external-task",
            refs: [path.join(foreign.dataDir, "attachments", "foreign.pdf")],
          },
        ],
      });
      const externalSnapshot = await createVerifiedSnapshot({
        source,
        root: scope.root,
        parent: path.join(scope.root, "snapshots"),
      });
      try {
        const restored = await restoreCandidate({
          snapshot: externalSnapshot,
          parent: path.join(scope.root, "restores"),
          name: "external-restored",
        });
        const result = inspect(base, restored.destinationPath);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("REQUIRES_EXTERNAL_RECOVERY");
      } finally {
        await externalSnapshot.service.dispose();
      }
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("10. a published-but-unconfirmed candidate (no confirmation marker) is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-unconfirmed-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      unlinkSync(path.join(candidate, ".forgeorbit-restore-confirmed.json"));
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("RESTORE_MARKER_MISSING");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("11. a candidate whose recovery report is structurally invalid is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-badreport-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      writeFileSync(path.join(candidate, ".forgeorbit-recovery.json"), "{not-json", { mode: 0o600 });
      chmodSync(path.join(candidate, ".forgeorbit-recovery.json"), 0o600);
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("RECOVERY_REPORT_INVALID");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("12. a candidate database modified after restore is rejected by digest", async () => {
    const scope = makeRoot("fo-p2-005a-digest-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const dbPath = path.join(candidate, "agetor.sqlite");
      const db = new Database(dbPath);
      db.run("INSERT OR IGNORE INTO preferences (key, value, updated_at) VALUES ('synthetic-write', '1', 1);");
      db.close();
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("RECOVERY_REPORT_HASH_MISMATCH");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("13. a tampered 'ready' report cannot hide external dependencies", async () => {
    const scope = makeRoot("fo-p2-005a-tamper-");
    try {
      const base = newBase(scope.root);
      const foreign = createSyntheticProfile(path.join(scope.root, "foreign-profile"), {
        tasks: [{ id: "foreign-task" }],
      });
      const source = createSyntheticProfile(path.join(scope.root, "tamper-source"), {
        tasks: [{ id: "tamper-task", refs: [path.join(foreign.dataDir, "missing.pdf")] }],
      });
      const tamperSnapshot = await createVerifiedSnapshot({
        source,
        root: scope.root,
        parent: path.join(scope.root, "snapshots"),
      });
      try {
        const restored = await restoreCandidate({
          snapshot: tamperSnapshot,
          parent: path.join(scope.root, "restores"),
          name: "tamper-restored",
        });
        const reportPath = path.join(restored.destinationPath, ".forgeorbit-recovery.json");
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
        report.activationReadiness = "ready";
        const markerPath = path.join(restored.destinationPath, ".forgeorbit-restore-confirmed.json");
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
        chmodSync(reportPath, 0o600);
        marker.recoveryReportSha256 = sha256Bytes(readFileSync(reportPath));
        writeFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
        chmodSync(markerPath, 0o600);
        const result = inspect(base, restored.destinationPath);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("REQUIRES_EXTERNAL_RECOVERY");
      } finally {
        await tamperSnapshot.service.dispose();
      }
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("14. preparing activation never modifies the active SQLite database", async () => {
    const scope = makeRoot("fo-p2-005a-prepare-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const before = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      const prepared = service.prepareActivation({ candidatePath: candidate });
      expect(prepared.requiresRestart).toBe(true);
      expect(prepared.state).toBe("prepared");
      const after = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      expect(after).toBe(before);
      // Preparation must not select the candidate yet.
      expect(service.inspectActiveProfile().activeDataDir).toBe(base);
      const journal = JSON.parse(
        readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8"),
      ) as { state: string; action: string };
      expect(journal.state).toBe("prepared");
      expect(journal.action).toBe("activate");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("15. prepare is refused while a conflicting operation is running", async () => {
    const scope = makeRoot("fo-p2-005a-busy-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      const service = new ProfileActivationService({
        activeDataDir: base,
        baseDataDir: base,
        isConflictingOperationRunning: () => true,
      });
      let code: string | null = null;
      try {
        service.prepareActivation({ candidatePath: candidate });
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("CONFLICTING_OPERATION");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("18. a recorded requires-reference-repair state is surfaced, never accepted as ready", async () => {
    const scope = makeRoot("fo-p2-005a-needs-repair-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      rewriteReadiness(candidate, "requires-reference-repair");
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("REQUIRES_REFERENCE_REPAIR");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("19. a not-ready candidate is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-not-ready-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      rewriteReadiness(candidate, "not-ready");
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("NOT_READY");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("16. a candidate owned by another OS user or with loose permissions is rejected", async () => {
    const scope = makeRoot("fo-p2-005a-perms-");
    try {
      const base = newBase(scope.root);
      const candidate = await validCandidate(scope.root);
      chmodSync(candidate, 0o755);
      const result = inspect(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CANDIDATE_PERMISSIONS");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("17. no credentials are copied into or read from the candidate", async () => {
    const scope = makeRoot("fo-p2-005a-creds-");
    try {
      const base = newBase(scope.root);
      writeFileSync(path.join(base, "github-tokens.json"), JSON.stringify({ tokens: [{ host: "x", token: "SECRET_SENTINEL", label: null }] }), { mode: 0o600 });
      chmodSync(path.join(base, "github-tokens.json"), 0o600);
      writeFileSync(path.join(base, "agetor-core.json"), JSON.stringify({ port: 1, token: "SECRET_CORE", pid: 999999, kind: "app", version: "x", startedAt: 1 }), { mode: 0o600 });
      chmodSync(path.join(base, "agetor-core.json"), 0o600);
      const candidate = await validCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journalText = readFileSync(
        path.join(activationControlDir(base), "transition.json"),
        "utf8",
      );
      expect(journalText).not.toContain("SECRET_SENTINEL");
      expect(journalText).not.toContain("SECRET_CORE");
      expect(existsSync(path.join(candidate, "github-tokens.json"))).toBe(false);
      expect(existsSync(path.join(candidate, "agetor-core.json"))).toBe(false);
      expect(existsSync(path.join(candidate, "desktop-instance.lock"))).toBe(false);
    } finally {
      scope.cleanup();
    }
  }, 120_000);
});
