import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";
import { HiringProposalCore } from "./hiring-proposal-core.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Approval workers timed out");
    await Bun.sleep(5);
  }
}
for (const legacy of [false, true]) {
  test(`FO-INT02: overlapping two-process approvals (${legacy ? "088 duplicate roles" : "089 same proposal"}) create one employee`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-int02-race-"));
    const filename = path.join(dir, "test.sqlite");
    const db = new Database(filename);
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    let locked = false;
    try {
      db.run("PRAGMA journal_mode = WAL");
      migrate(db, legacy ? migrations.filter((m) => m.id < "088a") : migrations);
      db.run("INSERT INTO projects (path, name, added_at) VALUES ('/work/project', 'Race', 1)");
      const core = new HiringProposalCore(db);
      const proposal = core.create("/work/project", { roleSlug: "engineering-frontend-developer", justification: "Concurrent approval acceptance" });
      let secondId = proposal.id;
      if (legacy) {
        // 088 legally admits these rows; do not remove a 089 index to seed them.
        const row = db.query<Record<string, string | number | null>, []>("SELECT * FROM hiring_proposals").get()!;
        secondId = randomUUID();
        row.id = secondId;
        const keys = Object.keys(row);
        db.run(`INSERT INTO hiring_proposals (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, Object.values(row));
      }
      const gate = path.join(dir, "go");
      for (const [i, id] of [proposal.id, secondId].entries()) {
        children.push(Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/approval-race-worker.ts"), filename, id, gate, path.join(dir, String(i))], {
          env: { HOME: dir, PATH: "/usr/bin:/bin", NODE_ENV: "test", AGETOR_DATA_DIR: path.join(dir, `worker-data-${i}`), AGETOR_USAGE_OFFLINE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        }));
      }
      await until(() => [0, 1].every((i) => existsSync(path.join(dir, `${i}.ready`))));
      db.run("BEGIN IMMEDIATE"); locked = true;
      writeFileSync(gate, "go");
      await until(() => [0, 1].every((i) => existsSync(path.join(dir, `${i}.attempt`))));
      // Hold the writer while both independent processes enter approve().
      await Bun.sleep(200);
      db.run("COMMIT"); locked = false;
      const results = await Promise.all(children.map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        return JSON.parse(stdout.trim().split("\n").at(-1)!);
      }));
      expect(results.filter((r) => r.ok && !r.alreadyApplied)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.status === 409)).toHaveLength(1);
      const winner = results.find((r) => r.ok)!;
      expect(db.query("SELECT id FROM ai_employees WHERE kind = 'worker'").all()).toEqual([{ id: winner.id }]);
      expect(db.query("SELECT COUNT(*) AS n FROM ai_employee_profile_revisions").get()).toEqual({ n: 1 });
      expect(db.query("SELECT COUNT(*) AS n FROM hiring_proposal_events WHERE action = 'approved'").get()).toEqual({ n: 1 });
      expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      if (locked) db.run("ROLLBACK");
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}
