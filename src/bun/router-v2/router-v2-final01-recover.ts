/**
 * Second process for FO-ROUTER-FINAL01. Reopens the disposable company database
 * and ticks the saved missions. A paused mission must not launch another run.
 */
import { mkdirSync } from "node:fs";

const dataDir = process.env.AGETOR_DATA_DIR;
const home = process.env.HOME;
const expected = (process.env.FO_ROUTER_FINAL_RUNS ?? "").split(",").filter(Boolean).sort();
const missions = (process.env.FO_ROUTER_FINAL_MISSIONS ?? "").split(",").filter(Boolean);
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
    console.error(`mission ${id} is not paused`);
    process.exit(1);
  }
  await missionScheduler.tickMission(id);
}
const ids = db.query<{ id: string }, []>("SELECT id FROM runs ORDER BY id").all().map(run => run.id);
if (ids.join(",") !== expected.join(",")) {
  console.error(`run ids changed: ${ids.join(",")} vs ${expected.join(",")}`);
  process.exit(1);
}
console.log(JSON.stringify({ runs: ids, missions: missions.length }));
