/**
 * Disposable ForgeOrbitQA profile seed for FO-ANALYTICS-NATIVE01.
 * Recorded fixtures only. No provider login and no inference.
 *
 * bun --no-env-file scripts/qa-analytics-native01-seed.ts accounts
 * bun --no-env-file scripts/qa-analytics-native01-seed.ts complete <taskId>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeSyntheticCodexProfile } from "../e2e/codex-profile-fixture.ts";

const data = process.env.FORGEORBIT_DATA_DIR ?? process.env.AGETOR_DATA_DIR;
const home = process.env.HOME;
if (!data || !home || !data.includes("fo-analytics-native01-")) {
  throw new Error("Refusing to seed outside the disposable analytics QA profile");
}
process.env.AGETOR_DATA_DIR = data;
process.env.FORGEORBIT_DATA_DIR = data;

const { db, tasks } = await import("../src/bun/db.ts");
const { AccountCore } = await import("../src/bun/account-core.ts");
const { CodexProfiles } = await import("../src/bun/codex-profiles.ts");
const { usageResources } = await import("../src/bun/usage-analytics/resources.ts");
const { taskActuals } = await import("../src/bun/usage-analytics/actuals.ts");
db.exec("PRAGMA busy_timeout = 8000");

const mode = process.argv[2];
if (mode === "accounts") {
  const core = new AccountCore(db);
  const profiles = new CodexProfiles(core);
  const register = (name: string) => {
    const directory = join(home, name.replaceAll(" ", "-").toLowerCase());
    mkdirSync(directory, { recursive: true });
    writeSyntheticCodexProfile(directory, "fixture-subject");
    return profiles.register({ displayName: name, directory });
  };
  const synthetic = register("Synthetic quota");
  const configured = register("Configured limit");
  register("No quota reading");
  const now = Date.now();
  const verified = core.createDefinition({ accountId: synthetic.accountId, scope: "account", unit: { kind: "requests" }, window: "5h" });
  core.recordTrustedObservations("synthetic-fixture", [{
    quotaId: verified.id,
    values: { remaining: 20, used: 80, limit: 100, expiresAt: now + 3_600_000 },
    evidence: {
      provider: "openai", accountId: synthetic.accountId, subject: "fixture-subject", method: "provider-account",
      sourceId: "synthetic-fixture", officialUrl: "https://example.invalid", checkedAt: "2026-11-10",
      receivedAt: now, sharedPool: null, limitations: "synthetic fixture",
    },
  }]);
  const manual = core.createDefinition({ accountId: configured.accountId, scope: "account", unit: { kind: "tokens" }, window: "monthly" });
  core.recordObservation(manual.id, { remaining: 800, limit: 1000, expiresAt: now + 86_400_000 });
  db.run(
    "INSERT INTO harness_usage_history(harness_id, observed_at, snapshot_json) VALUES ('codex', ?, ?)",
    [now, JSON.stringify({ meters: [{ id: "session", usedPercent: 37, resetsAtMs: null }] })],
  );
  const snapshot = usageResources();
  const body = JSON.stringify(snapshot);
  if (body.includes("fixture-subject") || body.includes("auth.json") || body.includes("CODEX_HOME")) {
    throw new Error("Quota seed leaked a profile subject or path into the resources view");
  }
  console.log(JSON.stringify({
    accounts: snapshot.accounts.map(account => ({
      label: account.label,
      identity: account.identity,
      quota: account.quota.map(item => ({
        current: item.current && {
          remaining: item.current.remaining, resetAt: item.current.resetAt, source: item.current.source,
        },
        provenances: item.observations.map(observation => observation.provenance),
      })),
    })),
    localMeters: snapshot.observations.flatMap(observation => observation.meters),
  }));
} else if (mode === "complete") {
  const taskId = process.argv[3] ?? "";
  const task = tasks.get(taskId);
  if (!task) throw new Error("Task was not found for the synthetic completion");
  if (task.column !== "backlog") throw new Error(`Refusing to complete a task in ${task.column}`);
  const before = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId)?.n ?? 0;
  if (before !== 0) throw new Error("Estimation already created a run");
  const start = Date.now();
  const scope = JSON.stringify({ projectPath: task.workdir, clusterId: null, missionId: null, category: task.taskType });
  const insert = (id: string, started: number, ended: number) => {
    db.run(
      `INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,usage_scope) VALUES (?,?,?,'succeeded',?,?,?)`,
      [id, taskId, task.agent, started, ended, scope],
    );
    db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [
      id, JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model: task.model }), ended,
    ]);
  };
  insert("synthetic-a", start, start + 10_000);
  insert("synthetic-b", start + 5_000, start + 14_000);
  tasks.update(taskId, { column: "done" });
  db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [start + 14_000, taskId]);
  const actual = taskActuals(taskId);
  if (!actual) throw new Error("Synthetic completion produced no actuals");
  const result = {
    runs: actual.runs.length,
    synthetic: actual.runs.every(run => run.execution === "synthetic"),
    workerMs: actual.workerMs,
    activeWallMs: actual.activeWallMs,
    executionElapsedMs: actual.executionElapsedMs,
    totalElapsedMs: actual.totalElapsedMs,
    testMs: actual.testMs,
    qcMs: actual.qcMs,
    reworkMs: actual.reworkMs,
    humanMs: actual.humanMs,
    estimateId: actual.frozenEstimateId,
    tokensKnown: actual.runs.some(run => run.tokens.input !== null || run.cost.money !== null),
  };
  if (result.runs !== 2 || !result.synthetic || result.workerMs !== 19_000 || result.activeWallMs !== 14_000
    || result.executionElapsedMs !== 14_000 || result.estimateId === null || result.tokensKnown
    || result.testMs !== null || result.qcMs !== null || result.reworkMs !== null || result.humanMs !== null) {
    throw new Error(`Synthetic actuals were not the recorded fixture: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} else {
  throw new Error("Use accounts or complete");
}
