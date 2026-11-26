/**
 * FO-P2-005-A — durable journal schema, fail-closed behavior and the typed
 * service API. Uses real restored candidates and real state files; no mocks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  realpathSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ProfileActivationService, resolveStartupProfile } from "./profile-activation.ts";
import { activationControlDir, canonicalizeProfilePath, readProfileSelection } from "./profile-paths.ts";
import { readTransitionJournal } from "./profile-transition-journal.ts";
import {
  createSyntheticProfile,
  createVerifiedSnapshot,
  ensureDir,
  isolatedProbeEnv,
  makeRoot,
  readJson,
  restoreCandidate,
  runProbeSync,
  sha256Bytes,
  writeJson,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const TEST_ROOT = makeRoot("fo-p2-005a-journal-");
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
  createSyntheticProfile(base, { tasks: [{ id: "base-task" }] });
  return base;
}

async function newCandidate(root: string): Promise<string> {
  return (
    await restoreCandidate({
      snapshot,
      parent: path.join(root, "restores"),
      name: `restored-${crypto.randomUUID().slice(0, 8)}`,
    })
  ).destinationPath;
}

function readPreparedJournal(base: string): Record<string, unknown> {
  return readJson(path.join(activationControlDir(base), "transition.json"));
}

function writeRawJournal(base: string, value: unknown, mode = 0o600): string {
  const controlDir = ensureDir(activationControlDir(base));
  const file = path.join(controlDir, "transition.json");
  writeJson(file, value, mode);
  return file;
}

function startupError(base: string): { code: string; message: string } | null {
  try {
    resolveStartupProfile({ baseDataDir: base });
    return null;
  } catch (error) {
    const record = error as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : "UNKNOWN",
      message: typeof record.message === "string" ? record.message : String(error),
    };
  }
}

describe("FO-P2-005-A transition journal", () => {
  test("1. an ordinary startup with no activation state is unchanged and creates no control directory", async () => {
    const scope = makeRoot("fo-p2-005a-journal-normal-");
    try {
      const base = newBase(scope.root);
      const env = isolatedProbeEnv({ baseDataDir: base });
      const opened = runProbeSync("open-db", env);
      expect(opened.exitCode).toBe(0);
      const payload = opened.json as Record<string, unknown>;
      expect(canonicalizeProfilePath(String(payload.dataDir))).toBe(canonicalizeProfilePath(base));
      expect(payload.taskCount).toBe(1);
      expect((payload.startup as Record<string, unknown>).recovered).toBe(false);
      expect((payload.startup as Record<string, unknown>).pendingTransition).toBeNull();
      expect(existsSync(activationControlDir(base))).toBe(false);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("2. invalid JSON fails closed and preserves the journal evidence", async () => {
    const scope = makeRoot("fo-p2-005a-journal-json-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      const file = path.join(controlDir, "transition.json");
      writeFileSync(file, "{not-json", { mode: 0o600 });
      chmodSync(file, 0o600);
      const error = startupError(base);
      expect(error?.code).toBe("JOURNAL_CORRUPT");
      expect(readFileSync(file, "utf8")).toBe("{not-json");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("3. unknown journal fields fail closed", async () => {
    const scope = makeRoot("fo-p2-005a-journal-fields-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journal = readPreparedJournal(base);
      journal.surprise = "unexpected";
      const file = writeRawJournal(base, journal);
      expect(startupError(base)?.code).toBe("JOURNAL_CORRUPT");
      expect(readJson(file).surprise).toBe("unexpected");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("4. an identity that does not match its path fails closed", async () => {
    const scope = makeRoot("fo-p2-005a-journal-identity-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journal = readPreparedJournal(base);
      (journal.candidate as Record<string, unknown>).identity = "0".repeat(64);
      writeRawJournal(base, journal);
      expect(startupError(base)?.code).toBe("JOURNAL_CORRUPT");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("5. an unresolved state with a resolution timestamp fails closed", async () => {
    const scope = makeRoot("fo-p2-005a-journal-resolved-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journal = readPreparedJournal(base);
      journal.resolvedAt = Date.now();
      writeRawJournal(base, journal);
      expect(startupError(base)?.code).toBe("JOURNAL_CORRUPT");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("6. a rollback_required journal without an error record fails closed", async () => {
    const scope = makeRoot("fo-p2-005a-journal-noerr-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journal = readPreparedJournal(base);
      journal.state = "rollback_required";
      journal.error = null;
      writeRawJournal(base, journal);
      expect(startupError(base)?.code).toBe("JOURNAL_CORRUPT");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("7. a symlinked journal file is rejected without following it", async () => {
    const scope = makeRoot("fo-p2-005a-journal-symlink-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      const outside = path.join(scope.root, "outside.json");
      writeJson(outside, { version: 1 });
      symlinkSync(outside, path.join(controlDir, "transition.json"));
      expect(startupError(base)?.code).toBe("JOURNAL_UNTRUSTED");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("8. journal files with group/other access are rejected", async () => {
    const scope = makeRoot("fo-p2-005a-journal-perms-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const file = path.join(activationControlDir(base), "transition.json");
      chmodSync(file, 0o644);
      expect(startupError(base)?.code).toBe("JOURNAL_UNTRUSTED");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("9. a corrupt selection fails closed", async () => {
    const scope = makeRoot("fo-p2-005a-journal-selection-");
    try {
      const base = newBase(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      writeFileSync(path.join(controlDir, "selection.json"), "{oops", { mode: 0o600 });
      chmodSync(path.join(controlDir, "selection.json"), 0o600);
      expect(startupError(base)?.code).toBe("SELECTION_CORRUPT");
    } finally {
      scope.cleanup();
    }
  }, 60_000);

  test("10. a selection whose transition does not match the journal fails closed", async () => {
    const scope = makeRoot("fo-p2-005a-journal-mismatch-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journal = readPreparedJournal(base);
      journal.transitionId = crypto.randomUUID();
      writeRawJournal(base, journal);
      // A committed selection that names a different transition must never be
      // reconciled against this journal.
      writeJson(path.join(activationControlDir(base), "selection.json"), {
        version: 1,
        generation: 1,
        activeProfilePath: base,
        activeProfileIdentity: sha256Bytes(`forgeorbit-profile\0${base}`),
        previousProfilePath: null,
        previousProfileIdentity: null,
        transitionId: crypto.randomUUID(),
        updatedAt: Date.now(),
      });
      expect(startupError(base)?.code).toBe("SELECTION_CORRUPT");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("11. a failed preflight never persists an activation request", async () => {
    const scope = makeRoot("fo-p2-005a-journal-reject-");
    try {
      const base = newBase(scope.root);
      const empty = ensureDir(path.join(scope.root, "not-a-profile"));
      const before = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      let code: string | null = null;
      try {
        service.prepareActivation({ candidatePath: empty });
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("DATABASE_MISSING");
      expect(existsSync(path.join(activationControlDir(base), "transition.json"))).toBe(false);
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(before);
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("12. activation and rollback requests are mutually exclusive while one is pending", async () => {
    const scope = makeRoot("fo-p2-005a-journal-exclusive-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const otherCandidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      let prepareCode: string | null = null;
      try {
        service.prepareActivation({ candidatePath: otherCandidate });
      } catch (error) {
        prepareCode = (error as { code?: string }).code ?? null;
      }
      expect(prepareCode).toBe("ACTIVATION_PENDING");
      let rollbackCode: string | null = null;
      try {
        service.requestRollback();
      } catch (error) {
        rollbackCode = (error as { code?: string }).code ?? null;
      }
      expect(rollbackCode).toBe("ACTIVATION_PENDING");
      expect(service.getPendingTransition()?.state).toBe("prepared");
      const journalText = readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8");
      expect(journalText).not.toContain("stack");
      expect(journalText).not.toContain("\n    at ");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("13. rollback is unavailable before any activation and after a completed rollback", async () => {
    const scope = makeRoot("fo-p2-005a-journal-unavailable-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      expect(service.getRollbackAvailability().available).toBe(false);
      let code: string | null = null;
      try {
        service.requestRollback();
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("ROLLBACK_NOT_AVAILABLE");
      service.prepareActivation({ candidatePath: candidate });
      resolveStartupProfile({ baseDataDir: base });
      const activated = new ProfileActivationService({ activeDataDir: candidate, baseDataDir: base });
      const availability = activated.getRollbackAvailability();
      expect(availability.available).toBe(true);
      expect(realpathSync(String(availability.targetPath))).toBe(realpathSync(base));
      activated.requestRollback();
      resolveStartupProfile({ baseDataDir: base });
      const rolledBack = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      expect(rolledBack.getRollbackAvailability().available).toBe(false);
      let againCode: string | null = null;
      try {
        rolledBack.requestRollback();
      } catch (error) {
        againCode = (error as { code?: string }).code ?? null;
      }
      expect(againCode).toBe("ROLLBACK_NOT_AVAILABLE");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("14. terminal journals are preserved in history and rollback returns to the last active profile", async () => {
    const scope = makeRoot("fo-p2-005a-journal-history-");
    try {
      const base = newBase(scope.root);
      const first = await newCandidate(scope.root);
      const second = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: first });
      resolveStartupProfile({ baseDataDir: base });
      const firstJournal = readTransitionJournal(activationControlDir(base))!;
      expect(firstJournal.state).toBe("active");
      const secondService = new ProfileActivationService({ activeDataDir: first, baseDataDir: base });
      secondService.prepareActivation({ candidatePath: second });
      const history = path.join(activationControlDir(base), "history");
      expect(existsSync(history)).toBe(true);
      expect(readdirSync(history)).toContain(`${firstJournal.transitionId}.json`);
      expect(readJson(path.join(history, `${firstJournal.transitionId}.json`)).state).toBe("active");
      const current = readTransitionJournal(activationControlDir(base))!;
      expect(current.state).toBe("prepared");
      expect(current.previousTransitionId).toBe(firstJournal.transitionId);
      resolveStartupProfile({ baseDataDir: base });
      expect(readTransitionJournal(activationControlDir(base))?.state).toBe("active");
      const activeAfterSecond = new ProfileActivationService({ activeDataDir: second, baseDataDir: base });
      expect(activeAfterSecond.getRollbackAvailability().targetPath).toBe(first);
      activeAfterSecond.requestRollback();
      resolveStartupProfile({ baseDataDir: base });
      expect(readProfileSelection(activationControlDir(base))?.activeProfilePath).toBe(first);
    } finally {
      scope.cleanup();
    }
  }, 240_000);

  test("15. a malformed journal error record is rejected, never merged into state", async () => {
    const scope = makeRoot("fo-p2-005a-journal-error-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      const journal = readPreparedJournal(base);
      journal.state = "rollback_required";
      journal.error = { code: "not valid!", message: "line one\nline two\n    at foo (bar.ts:1)" };
      const file = writeRawJournal(base, journal);
      const error = startupError(base);
      expect(error?.code).toBe("JOURNAL_CORRUPT");
      // Rejected file evidence is preserved verbatim for diagnosis; nothing was
      // silently normalized into a state the process would act on.
      expect(readJson(file).state).toBe("rollback_required");
      expect(String((readJson(file).error as Record<string, unknown>).message)).toContain("\n");
    } finally {
      scope.cleanup();
    }
  }, 120_000);

  test("16. a prepared activation does not copy credentials or modify the candidate", async () => {
    const scope = makeRoot("fo-p2-005a-journal-intact-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const candidateDb = sha256Bytes(readFileSync(path.join(candidate, "agetor.sqlite")));
      const service = new ProfileActivationService({ activeDataDir: base, baseDataDir: base });
      service.prepareActivation({ candidatePath: candidate });
      expect(sha256Bytes(readFileSync(path.join(candidate, "agetor.sqlite")))).toBe(candidateDb);
      expect(existsSync(path.join(candidate, "github-tokens.json"))).toBe(false);
      expect(existsSync(path.join(candidate, "agetor-core.json"))).toBe(false);
      expect(readProfileSelection(activationControlDir(base))).toBeNull();
    } finally {
      scope.cleanup();
    }
  }, 120_000);
});
