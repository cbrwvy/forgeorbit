// Headless SQLite service probe only; never imports the app or Task Runtime.
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { HiringProposalCore } from "../hiring-proposal-core.ts";
import { RoleCatalogService } from "../role-catalog.ts";

const [filename, proposalId, gate, marker] = process.argv.slice(2) as [string, string, string, string];
const deny = () => { throw new Error("Approval race forbids network and child processes"); };
Bun.spawn = deny as typeof Bun.spawn;
Bun.spawnSync = deny as typeof Bun.spawnSync;
globalThis.fetch = Object.assign(deny, { preconnect: deny }) as typeof fetch;
const db = new Database(filename);
db.run("PRAGMA busy_timeout = 5000");
const catalog = new RoleCatalogService();
catalog.initialize();
const core = new HiringProposalCore(db, { catalog });
writeFileSync(`${marker}.ready`, "ready");
const deadline = Date.now() + 10_000;
while (!existsSync(gate)) {
  if (Date.now() > deadline) throw new Error("Approval gate timed out");
  await Bun.sleep(5);
}
writeFileSync(`${marker}.attempt`, "attempt");
try {
  const result = core.approve(proposalId, { expectedRevision: 1 });
  console.log(JSON.stringify({ ok: true, id: result.employee.id, alreadyApplied: result.alreadyApplied }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, status: (error as { status?: number }).status, error: String(error) }));
} finally { db.close(); }
