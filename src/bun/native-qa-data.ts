import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { assertNativeQaStub, assertStoredQaHarnessEnv, isInsideNativeQaRoot } from "./native-qa-environment.ts";

/** Runs after isolated migrations, before importing SDK/recovery. Never
 * follows a stored account HOME or executes a stored binary/env override.
 * A Codex or Claude profile may keep the one directory AccountCore stored,
 * and only when that directory is a private subdirectory of this QA home.
 * Profile rows keep `home` null; assigning one would invalidate the binding.
 */
export function prepareNativeQaData(db: Database, root: string, home: string): void {
  const rows = db.query<{ id: string; kind: string; home: string | null; bin: string | null; env_json: string }, []>(
    "SELECT id, kind, home, bin, env_json FROM harnesses",
  ).all();
  const profiles = new Set<string>();
  for (const row of rows) {
    if (row.home && !isInsideNativeQaRoot(root, row.home)) throw new Error("External QA harness home");
    if (row.bin) assertNativeQaStub(root, row.bin);
    const stored = assertStoredQaHarnessEnv(root, home, row);
    if (stored === "profile") {
      if (row.home) throw new Error("QA profile harness must not store a home override");
      profiles.add(row.id);
    }
  }
  for (const row of db.query<{ workdir: string }, []>("SELECT workdir FROM tasks").all()) {
    if (!isInsideNativeQaRoot(root, row.workdir)) throw new Error("External QA task directory");
  }
  for (const row of db.query<{ path: string }, []>("SELECT path FROM projects").all()) {
    if (!isInsideNativeQaRoot(root, row.path)) throw new Error("External QA project directory");
  }
  for (const row of rows) {
    if (row.home || profiles.has(row.id)) continue;
    // Never use the stored id as a path component.
    const dir = path.join(home, "qa-harnesses", Buffer.from(row.id).toString("hex"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    db.run("UPDATE harnesses SET home = ? WHERE id = ?", [dir, row.id]);
  }
}
