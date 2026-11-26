/**
 * FO-UPGRADE02 regression: importing a snapshot that is older than the
 * Owner-trust migrations must leave a profile that opens through the current
 * schema.
 *
 * Restore used to seal the restored database by creating the Owner-trust tables
 * in their current shape (including `signing_cert_sha256`) while `_migrations`
 * still named an older schema. Migration 136 then did nothing and migration 137
 * failed with "duplicate column name: signing_cert_sha256", so the first open of
 * the restored copy never started.
 *
 * The cases use the normal import path (`BackupService`: create -> verify ->
 * restore), the activation preflight, and the real headless core as the
 * opener. A snapshot at 119 carries a "running" run and approved grants, a
 * snapshot at 136 carries an active Owner enrollment, and a current snapshot
 * keeps its normal sealing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { activationControlDir } from "./profile-paths.ts";
import { inspectCandidateForActivation } from "./profile-activation-preflight.ts";
import { migrations } from "./migrations/index.ts";
import { isolatedCoreEnv, REPO_ROOT, writeFxStubBin } from "../../e2e/isolated-env.ts";
import {
  createSyntheticProfile,
  createVerifiedSnapshot,
  ensureDir,
  makeRoot,
  restoreCandidate,
  type VerifiedSnapshot,
} from "./fixtures/profile-activation-test-util.ts";

const PREV_FORGEORBIT_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
const PREV_AGETOR_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ROOT = makeRoot("fo-upgrade02-restore-");
process.env.FORGEORBIT_DATA_DIR = path.join(ROOT.root, "parent-base");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
ensureDir(process.env.FORGEORBIT_DATA_DIR);

const services: VerifiedSnapshot[] = [];
afterAll(async () => {
  for (const snapshot of services) await snapshot.service.dispose().catch(() => {});
  ROOT.cleanup();
  if (PREV_FORGEORBIT_DATA_DIR === undefined) delete process.env.FORGEORBIT_DATA_DIR;
  else process.env.FORGEORBIT_DATA_DIR = PREV_FORGEORBIT_DATA_DIR;
  if (PREV_AGETOR_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = PREV_AGETOR_DATA_DIR;
});

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Digest of every file in a folder (relative names included). */
function folderDigest(dir: string, rel = ""): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(rel, entry.name);
    if (entry.isDirectory()) hash.update(`${relative}/${folderDigest(dir, relative)};`);
    else hash.update(`${relative}:${lstatSync(path.join(dir, relative)).isSymbolicLink() ? "link" : sha(readFileSync(path.join(dir, relative)))};`);
  }
  return hash.digest("hex");
}

const LAST_119 = "119_native_computer_agent_grants";
const LAST_136 = "136_owner_trust";
const hex64 = (char: string) => char.repeat(64);

/** Data an interrupted profile can hold: a live-looking run and unused grants. */
function seedWork(db: Database, now: number): void {
  db.run(`UPDATE tasks SET "column" = 'running', run_id = 'run-live' WHERE id = 'task-a'`);
  db.run("INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('run-live', 'task-a', 'claude-code', 'running', ?)", [now]);
  db.run("INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code) VALUES ('run-done', 'task-b', 'claude-code', 'succeeded', ?, ?, 0)", [now - 5000, now - 4000]);
  db.run(
    `INSERT INTO browser_agent_grants (id, manager_kind, project_path, session_id, observation_id, observed_at, observation_json, approved_origins_json, allowed_actions_json, max_actions, status, approved_by, created_at, expires_at)
     VALUES (?, 'head-of-pm', NULL, 'session', 'observation', ?, '{}', '[]', '[]', 1, 'approved', 'owner', ?, ?)`,
    [hex64("a"), now, now, now + 3_600_000],
  );
  db.run(
    `INSERT INTO native_computer_agent_grants (id, manager_kind, project_path, session_id, observation_id, bundle_id, pid, start_sec, start_usec, window_id, observed_at, observation_json, allowed_actions_json, max_actions, status, approved_by, created_at, expires_at)
     VALUES (?, 'head-of-pm', NULL, 'session', 'observation', 'com.example.app', 1, 1, 1, 1, ?, '{}', '[]', 1, 'approved', 'owner', ?, ?)`,
    [hex64("b"), now, now, now + 3_600_000],
  );
}

function seedEnrollment(db: Database, now: number, withCertColumn: boolean): void {
  db.run("INSERT INTO owner_trust_profile (id, data_dir_hash, machine_binding, sealed) VALUES (1, 'source-profile-hash', 'machine', 0)");
  db.run(
    `INSERT INTO owner_trust_enrollments (id, trust_class, application_identity, public_key_spki, key_protection, authority_state, created_at, rotated_at, label${withCertColumn ? ", signing_cert_sha256" : ""})
     VALUES ('enrollment-1', 'production', 'identity', 'spki-key', 'secure-enclave-user-presence', 'active', ?, NULL, 'Owner'${withCertColumn ? ", 'cert'" : ""})`,
    [now],
  );
}

type Source = { name: string; through?: string; seed: (db: Database, now: number) => void };

async function importSnapshot(source: Source): Promise<{ snapshot: VerifiedSnapshot; snapshotDigest: string; restored: string }> {
  const dataDir = path.join(ROOT.root, `source-${source.name}`);
  const profile = createSyntheticProfile(dataDir, {
    tasks: [{ id: "task-a" }, { id: "task-b" }],
    throughMigration: source.through,
    seed: source.seed,
  });
  const snapshot = await createVerifiedSnapshot({ source: profile, root: path.join(ROOT.root, source.name), parent: path.join(ROOT.root, source.name, "snapshots") });
  services.push(snapshot);
  const snapshotDigest = folderDigest(snapshot.snapshotPath);
  const restored = await restoreCandidate({ snapshot, parent: path.join(ROOT.root, source.name, "restores"), name: `restored-${source.name}` });
  return { snapshot, snapshotDigest, restored: restored.destinationPath };
}

function read<T>(dataDir: string, fn: (db: Database) => T): T {
  const db = new Database(path.join(dataDir, "agetor.sqlite"), { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const tableNames = (db: Database) => new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
const columns = (db: Database, table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
const scalar = (db: Database, sql: string) => (db.query(sql).get() as Record<string, number>)["n"]!;

let nextPort = 46100 + Math.floor(Math.random() * 400);

/** Open a data directory with the real headless core, return its log. */
async function openWithCore(dataDir: string): Promise<{ log: string; tasks: number }> {
  const port = nextPort++;
  const token = "t".repeat(32);
  const fx = writeFxStubBin(path.join(ROOT.root, "fx-stub"));
  const child = spawn("bun", ["src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    env: isolatedCoreEnv({ dataDir, apiPort: port, apiToken: token, fxBin: fx }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += String(chunk); });
  child.stderr?.on("data", (chunk) => { log += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
      if (!healthy) {
        if (child.exitCode !== null) throw new Error(`core exited early (${child.exitCode}): ${log.slice(-1500)}`);
        await Bun.sleep(150);
      }
    }
    if (!healthy) throw new Error(`core did not become healthy: ${log.slice(-1500)}`);
    const tasks = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()) as unknown[];
    return { log, tasks: tasks.length };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(20_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }
}

describe("FO-UPGRADE02: restoring a snapshot older than the Owner-trust migrations", () => {
  test("a schema-119 snapshot imports, opens through 142 and reopens without migrating again", async () => {
    const { snapshot, snapshotDigest, restored } = await importSnapshot({ name: "s119", through: LAST_119, seed: seedWork });

    // 1. The import itself: faithful data, and no schema ahead of the migrations.
    read(restored, (db) => {
      expect(db.query("SELECT id FROM _migrations ORDER BY id DESC LIMIT 1").get()).toEqual({ id: LAST_119 });
      expect(scalar(db, "SELECT COUNT(*) AS n FROM _migrations")).toBe(migrations.findIndex((m) => m.id === LAST_119) + 1);
      expect([...tableNames(db)].filter((name) => name.startsWith("owner_trust"))).toEqual([]);
      expect(scalar(db, "SELECT COUNT(*) AS n FROM tasks")).toBe(2);
      expect(scalar(db, "SELECT COUNT(*) AS n FROM runs")).toBe(2);
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    });
    expect(folderDigest(snapshot.snapshotPath)).toBe(snapshotDigest);

    // 2. The shared activation preflight accepts it, read-only, with the pending migrations counted.
    const base = path.join(ROOT.root, "s119", "base");
    createSyntheticProfile(base, { tasks: [{ id: "task-base" }] });
    const before = sha(readFileSync(path.join(restored, "agetor.sqlite")));
    const inspection = inspectCandidateForActivation({ candidatePath: restored, activeDataDir: base, baseDataDir: base, controlDir: activationControlDir(base), now: Date.now() });
    expect(inspection.ok).toBe(true);
    expect(inspection.pendingMigrationCount).toBe(migrations.length - (migrations.findIndex((m) => m.id === LAST_119) + 1));
    expect(sha(readFileSync(path.join(restored, "agetor.sqlite")))).toBe(before);

    // 3. First open: every pending migration applies, work is not resumed, nothing is authorised.
    const first = await openWithCore(restored);
    expect(first.log).not.toContain("duplicate column");
    expect(first.log).toContain(`applied migrations: ${migrations[migrations.findIndex((m) => m.id === LAST_119) + 1]!.id}`);
    expect(first.log).toContain(migrations[migrations.length - 1]!.id);
    expect(first.tasks).toBe(2);
    const afterFirst = read(restored, (db) => ({
      migrations: scalar(db, "SELECT COUNT(*) AS n FROM _migrations"),
      last: db.query("SELECT id FROM _migrations ORDER BY id DESC LIMIT 1").get(),
      integrity: db.query("PRAGMA integrity_check").get(),
      tasks: scalar(db, "SELECT COUNT(*) AS n FROM tasks"),
      runs: scalar(db, "SELECT COUNT(*) AS n FROM runs"),
      running: scalar(db, "SELECT COUNT(*) AS n FROM runs WHERE status = 'running'"),
      doneRun: db.query("SELECT status FROM runs WHERE id = 'run-done'").get(),
      approvedGrants: scalar(db, "SELECT (SELECT COUNT(*) FROM browser_agent_grants WHERE status = 'approved') + (SELECT COUNT(*) FROM native_computer_agent_grants WHERE status = 'approved') AS n"),
      activeEnrollments: scalar(db, "SELECT COUNT(*) AS n FROM owner_trust_enrollments WHERE authority_state = 'active'"),
      enrollments: scalar(db, "SELECT COUNT(*) AS n FROM owner_trust_enrollments"),
      certColumn: columns(db, "owner_trust_enrollments").includes("signing_cert_sha256"),
    }));
    expect(afterFirst.migrations).toBe(migrations.length);
    expect(afterFirst.last).toEqual({ id: migrations[migrations.length - 1]!.id });
    expect(afterFirst.integrity).toEqual({ integrity_check: "ok" });
    expect(afterFirst.tasks).toBe(2);
    expect(afterFirst.runs).toBe(2); // no new run
    expect(afterFirst.running).toBe(0); // the interrupted run is recorded, not resumed
    expect(afterFirst.doneRun).toEqual({ status: "succeeded" });
    expect(afterFirst.approvedGrants).toBe(0); // unused grants expire on open
    expect(afterFirst.enrollments).toBe(0);
    expect(afterFirst.activeEnrollments).toBe(0); // there was no authority to carry, and none appeared
    expect(afterFirst.certColumn).toBe(true);

    // 4. Second open: no migration runs again and nothing else starts.
    const second = await openWithCore(restored);
    expect(second.log).not.toContain("applied migrations");
    expect(second.tasks).toBe(2);
    const afterSecond = read(restored, (db) => ({
      migrations: scalar(db, "SELECT COUNT(*) AS n FROM _migrations"),
      runs: scalar(db, "SELECT COUNT(*) AS n FROM runs"),
      running: scalar(db, "SELECT COUNT(*) AS n FROM runs WHERE status = 'running'"),
      integrity: db.query("PRAGMA integrity_check").get(),
    }));
    expect(afterSecond).toEqual({ migrations: migrations.length, runs: 2, running: 0, integrity: { integrity_check: "ok" } });

    // 5. The source snapshot never changed.
    expect(folderDigest(snapshot.snapshotPath)).toBe(snapshotDigest);
  }, 240_000);

  test("a schema-136 snapshot keeps its enrollment sealed and still receives migration 137", async () => {
    const { snapshot, snapshotDigest, restored } = await importSnapshot({
      name: "s136",
      through: LAST_136,
      seed: (db, now) => seedEnrollment(db, now, false),
    });
    read(restored, (db) => {
      // Sealed at import, without the 137 column appearing early.
      expect(db.query("SELECT authority_state FROM owner_trust_enrollments").get()).toEqual({ authority_state: "restored-inactive" });
      expect(db.query("SELECT sealed FROM owner_trust_profile WHERE id = 1").get()).toEqual({ sealed: 1 });
      expect(columns(db, "owner_trust_enrollments")).not.toContain("signing_cert_sha256");
      expect(db.query("SELECT id FROM _migrations ORDER BY id DESC LIMIT 1").get()).toEqual({ id: LAST_136 });
    });
    const opened = await openWithCore(restored);
    expect(opened.log).not.toContain("duplicate column");
    expect(opened.log).toContain("137_owner_trust_signing_cert");
    read(restored, (db) => {
      expect(columns(db, "owner_trust_enrollments")).toContain("signing_cert_sha256");
      expect(db.query("SELECT authority_state FROM owner_trust_enrollments").get()).toEqual({ authority_state: "restored-inactive" });
      expect(scalar(db, "SELECT COUNT(*) AS n FROM owner_trust_enrollments WHERE authority_state = 'active'")).toBe(0);
      expect(db.query("SELECT sealed FROM owner_trust_profile WHERE id = 1").get()).toEqual({ sealed: 1 });
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    });
    expect(folderDigest(snapshot.snapshotPath)).toBe(snapshotDigest);
  }, 240_000);

  test("a current-schema snapshot is sealed exactly as before", async () => {
    const { snapshot, snapshotDigest, restored } = await importSnapshot({
      name: "s142",
      seed: (db, now) => seedEnrollment(db, now, true),
    });
    read(restored, (db) => {
      expect(db.query("SELECT authority_state FROM owner_trust_enrollments").get()).toEqual({ authority_state: "restored-inactive" });
      expect(db.query("SELECT sealed FROM owner_trust_profile WHERE id = 1").get()).toEqual({ sealed: 1 });
    });
    const opened = await openWithCore(restored);
    expect(opened.log).not.toContain("applied migrations");
    read(restored, (db) => {
      expect(db.query("SELECT authority_state FROM owner_trust_enrollments").get()).toEqual({ authority_state: "restored-inactive" });
      expect(db.query("SELECT sealed FROM owner_trust_profile WHERE id = 1").get()).toEqual({ sealed: 1 });
    });
    expect(folderDigest(snapshot.snapshotPath)).toBe(snapshotDigest);
    expect(existsSync(path.join(restored, ".forgeorbit-recovery.json"))).toBe(true);
  }, 240_000);
});
