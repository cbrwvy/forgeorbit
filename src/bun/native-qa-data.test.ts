import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareNativeQaData } from "./native-qa-data.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo013a1-stored-")));
  const home = path.join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const db = new Database(":memory:");
  db.exec("CREATE TABLE harnesses(id TEXT, kind TEXT, home TEXT, bin TEXT, env_json TEXT); CREATE TABLE tasks(workdir TEXT); CREATE TABLE projects(path TEXT); INSERT INTO harnesses VALUES('../untrusted-id', 'codex', NULL, NULL, '{}')");
  return { root, home, db };
}

function privateDir(parent: string, name: string) {
  const dir = path.join(parent, name);
  mkdirSync(dir, { mode: 0o700 });
  return realpathSync(dir);
}

test("default harness homes are explicitly isolated and restart is idempotent", () => {
  const { root, home, db } = fixture();
  try {
    prepareNativeQaData(db, root, home);
    const before = db.query("SELECT home FROM harnesses").get() as { home: string };
    expect(before.home.startsWith(home + "/qa-harnesses/")).toBe(true);
    prepareNativeQaData(db, root, home);
    expect(db.query("SELECT home FROM harnesses").get()).toEqual(before);
  } finally { db.close(); }
});

test("a private Codex or Claude profile directory under the QA home is kept and home stays null", () => {
  const { root, home, db } = fixture();
  const codex = privateDir(home, "codex-a");
  const claude = privateDir(home, "claude-a");
  try {
    db.run("INSERT INTO harnesses VALUES (?, 'codex', NULL, NULL, ?)", ["codex-profile-a", JSON.stringify({ CODEX_HOME: codex })]);
    db.run("INSERT INTO harnesses VALUES (?, 'claude-code', NULL, NULL, ?)", ["claude-profile-b", JSON.stringify({ CLAUDE_CONFIG_DIR: claude })]);
    prepareNativeQaData(db, root, home);
    const stored = db.query<{ id: string; home: string | null; env_json: string }, []>("SELECT id, home, env_json FROM harnesses WHERE id LIKE '%-profile-%' ORDER BY id").all();
    expect(stored).toEqual([
      { id: "claude-profile-b", home: null, env_json: JSON.stringify({ CLAUDE_CONFIG_DIR: claude }) },
      { id: "codex-profile-a", home: null, env_json: JSON.stringify({ CODEX_HOME: codex }) },
    ]);
    prepareNativeQaData(db, root, home);
    expect(db.query<{ id: string; home: string | null }, []>("SELECT id, home FROM harnesses WHERE id = 'codex-profile-a'").get()).toEqual({ id: "codex-profile-a", home: null });
  } finally { db.close(); }
});

test("profile env outside the home, symlinks, extra keys, wrong kinds, and open directories stay refused", () => {
  const outside = privateDir(realpathSync(mkdtempSync(path.join(tmpdir(), "fo013a1-outside-"))), "profile");
  const cases: Array<(root: string, home: string, db: Database) => void> = [
    (_root, home, db) => db.run("INSERT INTO harnesses VALUES ('codex-profile-a', 'codex', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: outside })]),
    (root, home, db) => {
      const target = privateDir(home, "real");
      const link = path.join(home, "linked");
      symlinkSync(target, link);
      db.run("INSERT INTO harnesses VALUES ('codex-profile-a', 'codex', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: link })]);
      void root;
    },
    (_root, home, db) => {
      const dir = privateDir(home, "wide");
      db.run("INSERT INTO harnesses VALUES ('codex-profile-a', 'codex', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: dir, PATH: "/usr/bin" })]);
    },
    (_root, home, db) => {
      const dir = privateDir(home, "wrong-kind");
      db.run("INSERT INTO harnesses VALUES ('codex', 'codex', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: dir })]);
    },
    (_root, home, db) => {
      const dir = privateDir(home, "open");
      chmodSync(dir, 0o755);
      db.run("INSERT INTO harnesses VALUES ('codex-profile-a', 'codex', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: dir })]);
    },
    (_root, home, db) => {
      const dir = privateDir(home, "wrong-kind");
      db.run("INSERT INTO harnesses VALUES ('codex-profile-a', 'claude-code', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: dir })]);
    },
    (_root, home, db) => db.run("INSERT INTO harnesses VALUES ('codex-profile-a', 'codex', NULL, NULL, ?)", [JSON.stringify({ CODEX_HOME: home })]),
  ];
  for (const apply of cases) {
    const { root, home, db } = fixture();
    try {
      apply(root, home, db);
      expect(() => prepareNativeQaData(db, root, home)).toThrow();
    } finally { db.close(); }
  }
});

test("stored external homes, commands, env and project/task paths refuse before recovery", () => {
  for (const sql of [
    "UPDATE harnesses SET home='/synthetic-outside'",
    "UPDATE harnesses SET bin='/usr/bin/true'",
    `UPDATE harnesses SET env_json='{"HOME":"/synthetic-outside"}'`,
    "INSERT INTO tasks VALUES('/synthetic-outside')",
    "INSERT INTO projects VALUES('/synthetic-outside')",
  ]) {
    const { root, home, db } = fixture();
    try { db.exec(sql); expect(() => prepareNativeQaData(db, root, home)).toThrow(); }
    finally { db.close(); }
  }
});
