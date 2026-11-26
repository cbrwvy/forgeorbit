// Subprocess-only synthetic profile probe. The caller supplies an isolated HOME
// before any backend import. Never starts a server, provider or background loop.
import { statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../data-dir.ts";
import { resolveActiveDataDir } from "../profile-activation-state.ts";

export async function probeProfile() {
  const { db, dataDir, credsFilePath, pidFilePath } = await import("../db.ts");
  const { coreCredsPath, readCoreCreds, writeCoreCreds, removeCoreCreds } = await import("../core-creds.ts");
  const { githubTokensPath, listGitHubTokens } = await import("../github-tokens.ts");
  const { daemonLogPath } = await import("../daemon-log.ts");
  const { tmuxSocketName } = await import("../tmux-resolution.ts");
  const { ActivityJournalCore } = await import("../activity-journal-core.ts");
  const migrationsBefore = db.query("SELECT * FROM _migrations ORDER BY id").all();
  const existingTasks = db.query("SELECT id FROM tasks ORDER BY id").all();
  const tokensBefore = listGitHubTokens();
  const credsBefore = readCoreCreds();
  db.run(`INSERT OR IGNORE INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at)
    VALUES('profile-task','Profile sentinel','Synthetic only','review','claude-code',?,1,1)`, [process.env.HOME!]);
  db.run(`INSERT OR IGNORE INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code)
    VALUES('profile-run','profile-task','claude-code','succeeded',1,2,0)`);
  const event = new ActivityJournalCore(db).record({ eventType: "task.assignment.approved", actorType: "owner",
    targetType: "task", targetId: "profile-task", taskId: "profile-task", idempotencyKey: "profile-fixture",
    payload: { note: "Synthetic profile persistence" } }, { notify: false });
  writeCoreCreds({ port: 49841, token: "profile-fixture-inert", pid: process.pid, kind: "app", version: "test", startedAt: 1 });
  const modeEntry = (rel: string, file: string) => {
    const mode = statSync(file).mode & 0o777;
    return [rel, mode] as const;
  };
  const result = { dataDir, resolver: resolveActiveDataDir(), baseResolver: resolveDataDir(), credsFilePath, coreCredsPath: coreCredsPath(),
    githubTokensPath: githubTokensPath(),
    daemonLogPath, pidFilePath, socket: tmuxSocketName(), tokensBefore, credsBefore, existingTasks,
    migrations: db.query("SELECT * FROM _migrations ORDER BY id").all(), migrationsBefore,
    tasks: db.query("SELECT * FROM tasks ORDER BY id").all(), runs: db.query("SELECT * FROM runs ORDER BY id").all(),
    journal: db.query("SELECT * FROM activity_events ORDER BY sequence_id").all(), eventCreated: event.created,
    integrity: db.query("PRAGMA integrity_check").all(), foreignKeys: db.query("PRAGMA foreign_key_check").all(),
    journalMode: db.query("PRAGMA journal_mode").get(),
    modes: Object.fromEntries([
      modeEntry(".", dataDir),
      modeEntry("agetor.sqlite", path.join(dataDir, "agetor.sqlite")),
      ...(existsSync(path.join(dataDir, "agetor.sqlite-wal"))
        ? [modeEntry("agetor.sqlite-wal", path.join(dataDir, "agetor.sqlite-wal"))]
        : []),
      ...(existsSync(path.join(dataDir, "agetor.sqlite-shm"))
        ? [modeEntry("agetor.sqlite-shm", path.join(dataDir, "agetor.sqlite-shm"))]
        : []),
      modeEntry("agetor-core.json", coreCredsPath(dataDir)),
    ]),
  };
  removeCoreCreds();
  db.close();
  console.log("PROFILE_RESULT " + JSON.stringify(result));
}

if (import.meta.main) {
  if (process.argv[2] === "daemon") {
    const { isolatedCoreEnv, writeFxStubBin } = await import("../../../e2e/isolated-env.ts");
    const env = isolatedCoreEnv({ dataDir: process.env.TMPDIR!, apiPort: 0,
      apiToken: "profile-daemon-inert", fxBin: writeFxStubBin(process.env.TMPDIR!),
      extra: { HOME: process.env.HOME!, NODE_ENV: "production", SHELL: "/bin/sh" } });
    delete env.FORGEORBIT_DATA_DIR; delete env.AGETOR_DATA_DIR;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    const { spawnDaemon, ensureCore, stopDaemon } = await import("../../cli/daemon/supervisor.ts");
    const { readCoreCreds, coreCredsPath, isPidAlive } = await import("../core-creds.ts");
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reserve.port!; reserve.stop(true);
    const dir = resolveDataDir();
    let pid: number | undefined;
    try {
      const core = await spawnDaemon({ port, dataDir: dir }); pid = core.pid;
      const discovered = await ensureCore({ noDaemon: true });
      const response = await fetch(`http://127.0.0.1:${port}/defaults`, { headers: { Authorization: `Bearer ${core.token}` } });
      const defaults = await response.json() as { dataDir: string };
      const modes = Object.fromEntries([dir, path.join(dir, "daemon.log"), path.join(dir, "agetor.sqlite")]
        .map(file => [path.relative(dir, file) || ".", statSync(file).mode & 0o777]));
      if (!await stopDaemon()) throw new Error("Owned daemon shutdown failed");
      for (let i = 0; i < 100 && isPidAlive(pid); i++) await Bun.sleep(50);
      if (isPidAlive(pid) || readCoreCreds()) throw new Error("Owned daemon did not retire");
      console.log("PROFILE_RESULT " + JSON.stringify({ dataDir: dir, defaults: defaults.dataDir,
        discoveredSamePid: discovered.pid === pid, kind: core.kind, modes,
        credsPath: coreCredsPath(), ownedPidAbsent: true, credsRemoved: true }));
    } finally {
      if (pid && isPidAlive(pid)) await stopDaemon(dir);
    }
  } else if (process.argv[2] === "seed") {
    const { Database } = await import("bun:sqlite");
    const { migrate } = await import("../migrate.ts");
    const { migrations } = await import("../migrations/index.ts");
    const { ensurePrivateDataDir, createPrivateSqliteFile } = await import("../private-storage.ts");
    const dir = resolveDataDir(); ensurePrivateDataDir(dir); createPrivateSqliteFile(path.join(dir, "agetor.sqlite"));
    const db = new Database(path.join(dir, "agetor.sqlite"));
    // Synthetic pre-journal database tests forward migration only after an
    // explicit legacy selection. It carries durable task and Run identities.
    migrate(db, migrations.slice(0, migrations.findIndex(m => m.id === "092_company_activity_journal")));
    db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,created_at,updated_at)
      VALUES('legacy-task','Legacy sentinel','Synthetic only','review','claude-code',?,1,1)`, [process.env.HOME!]);
    db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code)
      VALUES('legacy-run','legacy-task','claude-code','succeeded',1,2,0)`);
    db.close();
    writeFileSync(path.join(dir, "github-tokens.json"), JSON.stringify({ tokens: [{ host: "legacy.invalid", token: "synthetic-legacy-only", label: "sentinel" }] }));
    console.log("Synthetic legacy profile seeded");
  } else await probeProfile();
}
