/**
 * FO-P2-005-A — offline activation, rollback, crash windows and process
 * exclusivity.
 *
 * Every activation/rollback step in these tests runs in a real OS child
 * process (`bun fixtures/profile-activation-probe.ts`) against real SQLite
 * profiles under a temporary root. Crash points are real `SIGKILL`s, not thrown
 * exceptions.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  realpathSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { activationControlDir } from "./profile-paths.ts";
import { acquireNativeInstanceLock } from "./native-instance-lock.ts";
import {
  createSyntheticProfile,
  createVerifiedSnapshot,
  ensureDir,
  isolatedProbeEnv,
  makeRoot,
  readJson,
  restoreCandidate,
  runProbeSync,
  startLockHolder,
  sha256Bytes,
  writeJson,
  type ProbeResult,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const TEST_ROOT = makeRoot("fo-p2-005a-lifecycle-");
process.env.FORGEORBIT_DATA_DIR = path.join(TEST_ROOT.root, "parent-base");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
ensureDir(process.env.FORGEORBIT_DATA_DIR);

let snapshot: VerifiedSnapshot;

beforeAll(async () => {
  const source = createSyntheticProfile(path.join(TEST_ROOT.root, "source"), {
    tasks: [
      { id: "task-valid", refs: ["attachments/note.txt"] },
      { id: "task-extra" },
    ],
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
  const restored = await restoreCandidate({
    snapshot,
    parent: path.join(root, "restores"),
    name: `restored-${crypto.randomUUID().slice(0, 8)}`,
  });
  return restored.destinationPath;
}

interface ProbeOptions {
  crashAt?: string;
  extraEnv?: Record<string, string | undefined>;
  timeoutMs?: number;
}

function probe(
  mode: string,
  base: string,
  argument?: string,
  options: ProbeOptions = {},
): ProbeResult {
  const env = isolatedProbeEnv({
    baseDataDir: base,
    extra: {
      ...(options.crashAt ? { FORGEORBIT_ACTIVATION_CRASH_POINT: options.crashAt } : {}),
      ...(options.extraEnv ?? {}),
    },
  });
  return runProbeSync(mode, env, argument);
}

function expectOk(result: ProbeResult): Record<string, unknown> {
  if (result.exitCode !== 0 || !result.json) {
    throw new Error(
      `probe failed (exit ${result.exitCode}, signal ${result.signalCode ?? "none"}): ${result.stderr.slice(-1_200)}`,
    );
  }
  return result.json as Record<string, unknown>;
}

function expectCrash(result: ProbeResult): void {
  if (!(result.exitCode === 137 || result.signalCode === "SIGKILL" || result.exitCode !== 0)) {
    throw new Error(`expected a crash, got exit ${result.exitCode}: ${result.stdout.slice(-500)}`);
  }
}

function samePath(actual: unknown, expected: string): void {
  expect(realpathSync(String(actual))).toBe(realpathSync(expected));
}

function journalOf(base: string): Record<string, unknown> | null {
  const file = path.join(activationControlDir(base), "transition.json");
  return existsSync(file) ? readJson(file) : null;
}

function selectionOf(base: string): Record<string, unknown> | null {
  const file = path.join(activationControlDir(base), "selection.json");
  return existsSync(file) ? readJson(file) : null;
}

function collectTreeFiles(absolute: string, relative: string, output: string[]): void {
  if (!existsSync(absolute)) {
    output.push(`${relative}:missing`);
    return;
  }
  const st = lstatSync(absolute);
  if (st.isDirectory()) {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      collectTreeFiles(path.join(absolute, entry.name), `${relative}/${entry.name}`, output);
    }
    return;
  }
  output.push(`${relative}\0${sha256Bytes(readFileSync(absolute))}`);
}

function hashTreeFiles(root: string, relativePaths: string[]): string {
  const parts: string[] = [];
  for (const relative of relativePaths) collectTreeFiles(path.join(root, relative), relative, parts);
  return sha256Bytes(parts.join("\n"));
}

describe("FO-P2-005-A offline activation and rollback", () => {
  test("1. prepare → restart → successful offline activation (fresh candidate selected exactly once)", async () => {
    const scope = makeRoot("fo-p2-005a-activate-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseDbHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      const candidateSnapshot = hashTreeFiles(candidate, [
        "agetor.sqlite",
        ".forgeorbit-recovery.json",
        ".forgeorbit-restore-confirmed.json",
      ]);

      const prepared = expectOk(probe("prepare", base, candidate));
      expect(prepared.state).toBe("prepared");
      expect(prepared.requiresRestart).toBe(true);
      expect(journalOf(base)?.state).toBe("prepared");
      expect(selectionOf(base)).toBeNull();

      // Preparation must not modify either profile.
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseDbHash);
      expect(
        hashTreeFiles(candidate, [
          "agetor.sqlite",
          ".forgeorbit-recovery.json",
          ".forgeorbit-restore-confirmed.json",
        ]),
      ).toBe(candidateSnapshot);

      const opened = expectOk(probe("open-db", base));
      samePath(opened.dataDir, candidate);
      expect(opened.baseDataDir).toBe(base);
      expect(opened.taskCount).toBe(2);
      const journal = journalOf(base);
      expect(journal?.state).toBe("active");
      expect(journal?.action).toBe("activate");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
      // The original profile is untouched and still carries its own task.
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseDbHash);
      expect(existsSync(path.join(candidate, "agetor-core.json"))).toBe(false);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("2. a durable journal survives process restart before the next startup", async () => {
    const scope = makeRoot("fo-p2-005a-durable-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const before = readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8");
      // A completely separate process reads the same journal without preparing
      // anything again.
      const startup = expectOk(probe("startup", base));
      samePath(startup.activeDataDir, candidate);
      expect((startup.journal as Record<string, unknown>)?.state).toBe("active");
      const after = readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8");
      expect(after).not.toBe(before);
      expect(JSON.parse(after).state).toBe("active");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("3. simultaneous startup attempts resolve exactly one active profile", async () => {
    const scope = makeRoot("fo-p2-005a-simultaneous-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const env = isolatedProbeEnv({ baseDataDir: base });
      const children = Array.from({ length: 3 }, () =>
        Bun.spawn({
          cmd: [process.execPath, path.join(import.meta.dir, "fixtures", "profile-activation-probe.ts"), "startup"],
          cwd: scope.root,
          env,
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const outputs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
      const statuses = await Promise.all(children.map((child) => child.exited));
      for (let index = 0; index < children.length; index += 1) {
        expect(statuses[index]).toBe(0);
        const line = outputs[index]!.split("\n").find((entry) => entry.startsWith("ACTIVATION_PROBE "))!;
        const payload = JSON.parse(line.slice("ACTIVATION_PROBE ".length)) as { activeDataDir: string };
        samePath(payload.activeDataDir, candidate);
      }
      expect(journalOf(base)?.state).toBe("active");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("4. activation is refused while another process holds the transition lock", async () => {
    const scope = makeRoot("fo-p2-005a-lock-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      ensureDir(activationControlDir(base));
      const holder = await startLockHolder(isolatedProbeEnv({ baseDataDir: base }));
      try {
        const prepare = probe("prepare", base, candidate);
        expect(prepare.exitCode).not.toBe(0);
        expect(prepare.error?.code).toBe("TRANSITION_LOCKED");
        expect(existsSync(path.join(activationControlDir(base), "transition.json"))).toBe(false);
        const startup = probe("startup", base);
        expect(startup.exitCode).not.toBe(0);
        expect(startup.error?.code).toBe("TRANSITION_LOCKED");
      } finally {
        holder.stop();
        for (let index = 0; index < 100; index += 1) {
          try {
            process.kill(holder.pid, 0);
            await Bun.sleep(20);
          } catch {
            break;
          }
        }
      }
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("5. crash before the activation request is saved leaves no journal and no selection", async () => {
    const scope = makeRoot("fo-p2-005a-crash-before-request-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const crashed = probe("prepare", base, candidate, { crashAt: "before_prepare_journal" });
      expectCrash(crashed);
      expect(journalOf(base)).toBeNull();
      expect(selectionOf(base)).toBeNull();
      expect(journalOf(base) === null || journalOf(base)?.state === "prepared").toBe(true);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("6. crash after the prepared journal recovers to a clean activation", async () => {
    const scope = makeRoot("fo-p2-005a-crash-prepared-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const crashed = probe("prepare", base, candidate, { crashAt: "after_prepare_journal" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("prepared");
      expect(selectionOf(base)).toBeNull();
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, candidate);
      expect((recovered.journal as Record<string, unknown>)?.state).toBe("active");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("7. crash before the selection update leaves the old profile selected", async () => {
    const scope = makeRoot("fo-p2-005a-crash-before-selection-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "before_selection_write" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("switching");
      expect(selectionOf(base)).toBeNull();
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, candidate);
      expect(journalOf(base)?.state).toBe("active");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("8. crash after the selection update but before the journal update is reconciled", async () => {
    const scope = makeRoot("fo-p2-005a-crash-after-selection-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "after_selection_update" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("switching");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, candidate);
      expect(journalOf(base)?.state).toBe("active");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("9. crash before startup validation resumes and activates", async () => {
    const scope = makeRoot("fo-p2-005a-crash-pending-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "after_pending_journal" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("pending_startup_validation");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, candidate);
      expect((recovered.journal as Record<string, unknown>)?.state).toBe("active");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("10. crash during startup validation replays idempotently", async () => {
    const scope = makeRoot("fo-p2-005a-crash-validation-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "during_startup_validation" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("pending_startup_validation");
      const attemptsAfterCrash = journalOf(base)?.startupAttempts as number;
      expect(attemptsAfterCrash).toBeGreaterThanOrEqual(1);
      // Two clean replays must not create a second transition or advance the
      // selection generation forever.
      const first = expectOk(probe("startup", base));
      samePath(first.activeDataDir, candidate);
      const activeJournal = readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8");
      const second = expectOk(probe("startup", base));
      samePath(second.activeDataDir, candidate);
      expect(readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8")).toBe(activeJournal);
      expect(selectionOf(base)?.generation).toBe(1);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("11. crash immediately after activation leaves a terminal active journal", async () => {
    const scope = makeRoot("fo-p2-005a-crash-active-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "after_active_journal" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("active");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
      const startup = expectOk(probe("startup", base));
      samePath(startup.activeDataDir, candidate);
      expect((startup.journal as Record<string, unknown>)?.state).toBe("active");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("12. failed post-selection validation rolls back to the intact original", async () => {
    const scope = makeRoot("fo-p2-005a-rollback-failed-validation-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "after_selection_update" });
      expectCrash(crashed);
      samePath(selectionOf(base)?.activeProfilePath, candidate);
      // Corrupt the candidate after it was selected; the next startup's
      // validation fails and must roll back rather than open it.
      const dbPath = path.join(candidate, "agetor.sqlite");
      const bytes = Buffer.from(readFileSync(dbPath));
      bytes.fill(0, 0, Math.min(100, bytes.length));
      writeFileSync(dbPath, bytes, { mode: 0o600 });
      chmodSync(dbPath, 0o600);
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      expect(journalOf(base)?.error).toBeTruthy();
      samePath(selectionOf(base)?.activeProfilePath, base);
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
      // The rejected candidate remains available for investigation.
      expect(existsSync(path.join(candidate, ".forgeorbit-recovery.json"))).toBe(true);
      const opened = expectOk(probe("open-db", base));
      samePath(opened.dataDir, base);
      expect(opened.taskCount).toBe(1);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("13. crash during rollback resumes deterministically", async () => {
    const scope = makeRoot("fo-p2-005a-crash-rollback-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      expectOk(probe("prepare", base, candidate));
      expectOk(probe("startup", base));
      expect(journalOf(base)?.state).toBe("active");
      expectOk(probe("rollback", base));
      expect(journalOf(base)?.action).toBe("rollback");
      expect(journalOf(base)?.state).toBe("prepared");
      const crashed = probe("startup", base, undefined, { crashAt: "after_rolling_back_journal" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("rolling_back");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      samePath(selectionOf(base)?.activeProfilePath, base);
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
      // The activated profile is deliberately preserved.
      expect(existsSync(path.join(candidate, "agetor.sqlite"))).toBe(true);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("14. explicit rollback after a successful activation preserves the old database byte for byte", async () => {
    const scope = makeRoot("fo-p2-005a-explicit-rollback-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      const baseFiles = hashTreeFiles(base, [
        "agetor.sqlite",
        "knowledge",
        "attachments",
        "screenshots",
        "issue-threads",
        "pipeline-runs",
      ]);
      // Drop a sentinel in the candidate so we can prove it is untouched by rollback.
      const candidateSentinel = path.join(candidate, "attachments", "sentinel.txt");
      writeFileSync(candidateSentinel, "candidate sentinel\n", { mode: 0o600 });
      expectOk(probe("prepare", base, candidate));
      const opened = expectOk(probe("open-db", base));
      samePath(opened.dataDir, candidate);
      const rollback = expectOk(probe("rollback", base));
      expect(rollback.action).toBe("rollback");
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
      expect(
        hashTreeFiles(base, [
          "agetor.sqlite",
          "knowledge",
          "attachments",
          "screenshots",
          "issue-threads",
          "pipeline-runs",
        ]),
      ).toBe(baseFiles);
      expect(readFileSync(candidateSentinel, "utf8")).toBe("candidate sentinel\n");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("15. a corrupt rollback target is rejected rather than activated", async () => {
    const scope = makeRoot("fo-p2-005a-bad-rollback-target-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      expectOk(probe("startup", base));
      expect(journalOf(base)?.state).toBe("active");
      const baseDb = path.join(base, "agetor.sqlite");
      const bytes = Buffer.from(readFileSync(baseDb));
      bytes.fill(0, 0, Math.min(100, bytes.length));
      writeFileSync(baseDb, bytes, { mode: 0o600 });
      chmodSync(baseDb, 0o600);
      const rollback = probe("rollback", base);
      expect(rollback.exitCode).not.toBe(0);
      expect(["ROLLBACK_CANDIDATE_INVALID", "DATABASE_UNREADABLE", "DATABASE_INTEGRITY"]).toContain(
        rollback.error?.code ?? "",
      );
      // No rollback journal was written; the activated profile stays selected.
      expect(journalOf(base)?.action).toBe("activate");
      samePath(selectionOf(base)?.activeProfilePath, candidate);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("16. a corrupt journal fails closed without opening any profile", async () => {
    const scope = makeRoot("fo-p2-005a-corrupt-journal-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const controlDir = activationControlDir(base);
      const journalPath = path.join(controlDir, "transition.json");
      writeJson(journalPath, { version: 1, transitionId: "not-a-uuid" });
      chmodSync(journalPath, 0o600);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      const opened = probe("open-db", base);
      expect(opened.exitCode).not.toBe(0);
      expect(opened.error?.code).toBe("JOURNAL_CORRUPT");
      // Fail closed: no database was opened or migrated under either root.
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
      expect(selectionOf(base)).toBeNull();
      // Corrupt evidence is preserved, never deleted.
      expect(readJson(journalPath).transitionId).toBe("not-a-uuid");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("17. a selection without a matching journal fails closed", async () => {
    const scope = makeRoot("fo-p2-005a-orphan-selection-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const controlDir = ensureDir(activationControlDir(base));
      writeJson(path.join(controlDir, "selection.json"), {
        version: 1,
        generation: 1,
        activeProfilePath: candidate,
        activeProfileIdentity: sha256Bytes(`forgeorbit-profile\0${candidate}`),
        previousProfilePath: null,
        previousProfileIdentity: null,
        transitionId: crypto.randomUUID(),
        updatedAt: Date.now(),
      });
      const opened = probe("open-db", base);
      expect(opened.exitCode).not.toBe(0);
      expect(opened.error?.code).toBe("SELECTION_WITHOUT_JOURNAL");
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("18. no unrelated user directory is modified by activation or rollback", async () => {
    const scope = makeRoot("fo-p2-005a-unrelated-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const unrelated = ensureDir(path.join(scope.root, "unrelated"));
      const unrelatedFile = path.join(unrelated, "sentinel.txt");
      writeFileSync(unrelatedFile, "unrelated sentinel\n", { mode: 0o600 });
      const before = sha256Bytes(readFileSync(unrelatedFile));
      // Materialize the probe HOME/TMPDIR first so only activation state can
      // appear as a new root entry.
      isolatedProbeEnv({ baseDataDir: base });
      const entriesBefore = new Set(readdirSync(scope.root).sort());
      expectOk(probe("prepare", base, candidate));
      expectOk(probe("startup", base));
      expectOk(probe("rollback", base));
      expectOk(probe("startup", base));
      expect(sha256Bytes(readFileSync(unrelatedFile))).toBe(before);
      const entriesAfter = new Set(readdirSync(scope.root).sort());
      const newEntries = [...entriesAfter].filter((entry) => !entriesBefore.has(entry));
      // Only the activation control directory may appear at the root level.
      expect(newEntries).toEqual([`.${path.basename(base)}.forgeorbit-activation`]);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("20. a database-open/migration failure is recorded and rolled back on the next startup", async () => {
    const scope = makeRoot("fo-p2-005a-open-failure-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      expectOk(probe("prepare", base, candidate));
      const crashed = probe("startup", base, undefined, { crashAt: "after_pending_journal" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("pending_startup_validation");
      const { markProfileStartupFailure } = await import("./profile-activation.ts");
      markProfileStartupFailure(new Error("synthetic migration failure"), { baseDataDir: base });
      expect(journalOf(base)?.state).toBe("rollback_required");
      expect(journalOf(base)?.error).toBeTruthy();
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      // Replaying the terminal journal is idempotent: no new transition, no
      // automatic rollback loop, and the same profile every time.
      const replayJournal = readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8");
      for (let index = 0; index < 2; index += 1) {
        const replay = expectOk(probe("startup", base));
        samePath(replay.activeDataDir, base);
      }
      expect(readFileSync(path.join(activationControlDir(base), "transition.json"), "utf8")).toBe(replayJournal);
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("21. crash after the rollback selection change completes the rollback without touching either profile", async () => {
    const scope = makeRoot("fo-p2-005a-crash-rollback-selection-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));
      expectOk(probe("prepare", base, candidate));
      expectOk(probe("startup", base));
      expectOk(probe("rollback", base));
      const crashed = probe("startup", base, undefined, { crashAt: "after_selection_update" });
      expectCrash(crashed);
      expect(journalOf(base)?.state).toBe("rolling_back");
      samePath(selectionOf(base)?.activeProfilePath, base);
      const recovered = expectOk(probe("startup", base));
      samePath(recovered.activeDataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
      expect(existsSync(path.join(candidate, "agetor.sqlite"))).toBe(true);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("22. activation is rejected before the switch when the current profile cannot be a rollback candidate", async () => {
    const scope = makeRoot("fo-p2-005a-corrupt-original-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const baseDb = path.join(base, "agetor.sqlite");
      const bytes = Buffer.from(readFileSync(baseDb));
      bytes.fill(0, 0, Math.min(100, bytes.length));
      writeFileSync(baseDb, bytes, { mode: 0o600 });
      chmodSync(baseDb, 0o600);
      const startup = expectOk(probe("startup", base));
      samePath(startup.activeDataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      expect(journalOf(base)?.error).toBeTruthy();
      samePath(selectionOf(base)?.activeProfilePath, base);
      // The candidate was never selected or opened.
      expect(existsSync(path.join(candidate, "agetor-core.json"))).toBe(false);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("23. every backend path store resolves the activated profile, not the base", async () => {
    const scope = makeRoot("fo-p2-005a-paths-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      expectOk(probe("startup", base));
      const paths = expectOk(probe("paths", base));
      samePath(paths.dataDir, candidate);
      for (const key of ["credsFilePath", "coreCredsPath", "githubTokensPath", "daemonLogPath", "pidFilePath"]) {
        samePath(path.dirname(String(paths[key])), candidate);
      }
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("24. the desktop instance lock held by this startup is not mistaken for another owner", async () => {
    const scope = makeRoot("fo-p2-005a-instance-lock-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      const release = acquireNativeInstanceLock(base);
      try {
        const activated = expectOk(probe("startup", base));
        samePath(activated.activeDataDir, candidate);
        expect(journalOf(base)?.state).toBe("active");
        expectOk(probe("rollback", base));
        const rolledBack = expectOk(probe("startup", base));
        samePath(rolledBack.activeDataDir, base);
        expect(journalOf(base)?.state).toBe("rolled_back");
      } finally {
        release();
      }
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("25. a vanished activated database rolls back to the original and is never recreated empty", async () => {
    const scope = makeRoot("fo-p2-005a-lost-active-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      expectOk(probe("prepare", base, candidate));
      expectOk(probe("startup", base));
      expect(journalOf(base)?.state).toBe("active");
      unlinkSync(path.join(candidate, "agetor.sqlite"));
      const recovered = expectOk(probe("open-db", base));
      samePath(recovered.dataDir, base);
      expect(journalOf(base)?.state).toBe("rolled_back");
      expect(existsSync(path.join(candidate, "agetor.sqlite"))).toBe(false);
    } finally {
      scope.cleanup();
    }
  }, 180_000);

  test("19. full synthetic round trip: backup → verify → restore → prepare → offline activate → rollback", async () => {
    const scope = makeRoot("fo-p2-005a-roundtrip-");
    try {
      const base = newBase(scope.root);
      const candidate = await newCandidate(scope.root);
      const baseHash = sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")));

      // backup + verify + inactive restore already happened in newCandidate();
      // confirm the restored profile carries the verified trust metadata.
      const marker = readJson(path.join(candidate, ".forgeorbit-restore-confirmed.json"));
      const report = readJson(path.join(candidate, ".forgeorbit-recovery.json"));
      expect(marker.snapshotId).toBe(report.snapshotId);
      expect(marker.databaseSha256).toBe(report.databaseSha256);

      const prepared = expectOk(probe("prepare", base, candidate));
      expect(prepared.snapshotId).toBe(report.snapshotId);
      const activated = expectOk(probe("open-db", base));
      samePath(activated.dataDir, candidate);
      const restoredTask = (activated as { taskCount: number }).taskCount;
      expect(restoredTask).toBe(2);

      const rollbackAvailability = expectOk(probe("inspect-active", base));
      expect(rollbackAvailability.rollbackAvailable).toBe(true);
      expect(realpathSync(String(rollbackAvailability.rollbackTargetPath))).toBe(realpathSync(base));
      const rollback = expectOk(probe("rollback", base));
      expect(realpathSync(String(rollback.targetPath))).toBe(realpathSync(base));
      // Rollback itself performed no writes to the original database. (Opening
      // it afterwards is ordinary authorized startup and switches journal mode.)
      expect(sha256Bytes(readFileSync(path.join(base, "agetor.sqlite")))).toBe(baseHash);
      const back = expectOk(probe("open-db", base));
      samePath(back.dataDir, base);
      expect(back.taskCount).toBe(1);
      const finalJournal = journalOf(base);
      expect(finalJournal?.state).toBe("rolled_back");
      expect(finalJournal?.action).toBe("rollback");
      expect(existsSync(path.join(activationControlDir(base), "history"))).toBe(true);
      const history = readdirSync(path.join(activationControlDir(base), "history"));
      expect(history.length).toBeGreaterThanOrEqual(1);
      // Restored profile remains available for investigation.
      expect(existsSync(path.join(candidate, "agetor.sqlite"))).toBe(true);
      expect(lstatSync(candidate).isDirectory()).toBe(true);
    } finally {
      scope.cleanup();
    }
  }, 240_000);
});
