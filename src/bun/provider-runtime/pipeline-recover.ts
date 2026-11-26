/**
 * Second process for FO-PROVIDERS-PIPELINE01.
 * Reopens the disposable database, recovers paused missions, and ticks once.
 * Completed runs and receipts must stay unchanged.
 */
import { mkdirSync } from "node:fs";

const dataDir = process.env.AGETOR_DATA_DIR;
const home = process.env.HOME;
const expected = (process.env.FO_PIPELINE_RUNS ?? "").split(",").filter(Boolean).sort();
const missions = (process.env.FO_PIPELINE_MISSIONS ?? "").split(",").filter(Boolean);
const receipts = Number(process.env.FO_PIPELINE_RECEIPTS ?? "0");
if (!dataDir || !home || expected.length === 0 || missions.length === 0) {
  console.error("missing recovery environment");
  process.exit(2);
}
mkdirSync(home, { recursive: true });
const { missionScheduler } = await import("../orchestration/mission-scheduler.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { db } = await import("../db.ts");

for (const id of missions) {
  const mission = missionStore.getMission(id);
  if (!mission || mission.status !== "paused") {
    console.error(`mission ${id} is not a paused checkpoint`);
    process.exit(1);
  }
}
await missionScheduler.recoverOrchestrationMissions();
for (const id of missions) {
  missionStore.updateMissionStatus(id, "running", "recovery tick");
  await missionScheduler.tickMission(id);
  missionStore.updateMissionStatus(id, "paused", "recovery held");
}
const ids = db.query<{ id: string }, []>("SELECT id FROM runs ORDER BY id").all().map(run => run.id).sort();
if (ids.join(",") !== expected.join(",")) {
  console.error(`run ids changed: ${ids.join(",")} vs ${expected.join(",")}`);
  process.exit(1);
}
const receiptCount = db.query<{ n: number }, []>(
  "SELECT COUNT(*) AS n FROM run_events WHERE data LIKE 'usage-accounting: %' AND data LIKE '%recorded-fixture%'",
).get()!.n;
if (receiptCount !== receipts) {
  console.error(`receipt count changed: ${receiptCount} vs ${receipts}`);
  process.exit(1);
}
console.log(JSON.stringify({ runs: ids, receipts: receiptCount }));
