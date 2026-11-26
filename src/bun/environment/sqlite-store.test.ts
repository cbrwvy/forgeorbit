import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { toPublicProfile } from "../../shared/environment/present.ts";
import type { StoredEnvironment } from "../../shared/environment/types.ts";
import environmentProfilesSql from "../migrations/069_environment_profiles.sql" with { type: "text" };

const dataDir = mkdtempSync(path.join(tmpdir(), "fo-env-store-"));
process.env.AGETOR_DATA_DIR = dataDir;

function sample(token: string): StoredEnvironment {
  return {
    profile: {
      id: "app",
      projectPath: "/tmp/proj",
      name: "App",
      cwd: "/tmp/proj",
      launch: { kind: "local-process", command: { executable: "/bin/echo", args: ["hi"] } },
      stop: { kind: "signal", signal: "SIGTERM", graceMs: 1000, killAfterGrace: false, processGroup: true },
      expectedPorts: [],
      healthChecks: [],
      urls: [],
      startupTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      env: [{ name: "PORT", from: "inherit" }],
    },
    runtime: {
      phase: "running",
      ownership: {
        kind: "process",
        pid: 42,
        startedAtMs: 1,
        token,
        sessionId: "sess",
        executable: "/bin/echo",
        args: ["hi"],
        cwd: "/tmp/proj",
        processGroup: true,
      },
      ownershipClass: "session",
      lastError: null,
      errorCode: null,
      updatedAt: 10,
      sessionId: "sess",
    },
  };
}

test("profiles round-trip, corrupt rows are skipped, and tokens stay in the row for recovery", async () => {
  const { SqliteEnvironmentStore } = await import("./sqlite-store.ts");
  const database = new Database(":memory:");
  database.exec(environmentProfilesSql);
  const token = "ab".repeat(16);
  const store = new SqliteEnvironmentStore(database);
  await store.save(sample(token));

  const again = new SqliteEnvironmentStore(database);
  const loaded = await again.loadAll();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]?.profile.name).toBe("App");
  expect(loaded[0]?.runtime.phase).toBe("running");
  expect(loaded[0]?.runtime.ownership?.kind).toBe("process");
  if (loaded[0]?.runtime.ownership?.kind === "process") {
    expect(loaded[0].runtime.ownership.token).toBe(token);
  }
  const raw = database.query<{ data: string }, []>(`SELECT data FROM environment_profiles`).get()?.data ?? "";
  expect(raw).toContain(token);
  expect(JSON.stringify(toPublicProfile(loaded[0]!.profile))).not.toContain(token);

  database.run(`INSERT INTO environment_profiles (id, project_path, data, updated_at) VALUES ('bad', '/x', '{', 1)`);
  expect((await again.loadAll()).map((row) => row.profile.id)).toEqual(["app"]);

  await again.remove("app");
  expect(await again.loadAll()).toEqual([]);
});
