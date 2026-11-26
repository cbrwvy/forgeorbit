import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccountCore } from "../src/bun/account-core";

/**
 * FO-FORECAST-PORTFOLIO01 evidence for one portfolio-planning case. Disposable data only: it writes
 * recorded history, API price revisions and recorded quota readings into the database handle it is
 * given, and calls no provider. The same case backs the service suite and the Chromium journey.
 *
 *  - Accounts A and B (two projects) share ONE evidenced USD credit pool and window.
 *  - Account D has its own evidenced pool with room. Account C is eligible but has no quota evidence
 *    at all, so its capacity is Unknown. A recorded refusal sits on C (an earlier request was refused).
 *  - History gives every account known per-stage demand in USD minor units (compatible typed unit).
 */
export interface PlanningAccount { accountId: string; harnessId: string }
export interface PlanningContext {
  a: PlanningAccount; b: PlanningAccount; c: PlanningAccount; d: PlanningAccount;
  alphaPath: string; betaPath: string; model: string; now: number;
}

export const PLANNING_PROMPT = "Implement a small parser. Acceptance: run tests.";

export function writeProjectManifest(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), "{}");
}

const scope = (projectPath: string) => JSON.stringify({
  projectPath, clusterId: null, missionId: null, category: "task", technology: "JavaScript/TypeScript", complexity: "low",
});

/** Pricing and three completed genuine runs per (account, project): enough for known per-stage demand. */
export function seedPlanningHistory(db: Database, ctx: PlanningContext) {
  const at = ctx.now - 600_000;
  for (const acct of [ctx.a, ctx.b, ctx.c, ctx.d]) {
    db.run("INSERT INTO usage_pricing(harness_id,account_id,model_id,created_at,terms) VALUES (?,?,?,?,?)", [
      acct.harnessId, acct.accountId, ctx.model, at - 10_000,
      JSON.stringify({ billing: "api", currency: "USD", inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1, cacheWritePerMillion: 0 }),
    ]);
  }
  const plan: Array<[PlanningAccount, string]> = [[ctx.a, ctx.alphaPath], [ctx.b, ctx.betaPath], [ctx.c, ctx.betaPath], [ctx.d, ctx.betaPath], [ctx.d, ctx.alphaPath], [ctx.c, ctx.alphaPath]];
  let n = 0;
  for (const [acct, projectPath] of plan) {
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const start = at + (n++) * 20_000;
      db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
        VALUES (?,?,?,'backlog',?,?,?,'auto',?,?)`, [id, `History ${n}`, PLANNING_PROMPT, acct.harnessId, projectPath, ctx.model, at - 50_000, at - 50_000]);
      db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,usage_scope)
        VALUES (?,?,?,'succeeded',?,?,0,?,?)`, [runId, id, acct.harnessId, start, start + 12_000, runId, scope(projectPath)]);
      const event = (data: string) => db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [runId, data, start + 12_000]);
      event(JSON.stringify({ kind: "execution-identity", executionType: "real-provider", provider: "codex", model: ctx.model, mode: "auto", accountProfile: { id: acct.accountId } }));
      event("usage-accounting: " + JSON.stringify({ input: 100_000, output: 50_000, cacheRead: 30_000, cacheWrite: 0 }));
      // An independent PASS review on the same account gives the Reviewer stage known demand too.
      const reviewId = crypto.randomUUID();
      const reviewRun = crypto.randomUUID();
      db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,qc_review_id,usage_scope)
        VALUES (?,?,?,'succeeded',?,?,0,?,?,?)`, [reviewRun, id, acct.harnessId, start + 13_000, start + 21_000, reviewRun, reviewId, scope(projectPath)]);
      db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,
        implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
        VALUES (?,?,?,1,'completed','PASS',?,?,?,?,'{}',?,?,?)`, [reviewId, id, projectPath, acct.harnessId, ctx.model, runId, reviewRun, start + 13_000, start + 13_000, start + 21_000]);
      const reviewEvent = (data: string) => db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [reviewRun, data, start + 21_000]);
      reviewEvent(JSON.stringify({ kind: "execution-identity", executionType: "real-provider", provider: "codex", model: ctx.model, mode: "ask", accountProfile: { id: acct.accountId } }));
      reviewEvent("usage-accounting: " + JSON.stringify({ input: 100_000, output: 50_000, cacheRead: 30_000, cacheWrite: 0 }));
      db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [id]);
      db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [start + 23_000, id]);
    }
  }
}

/** One recorded, fresh, verified-shaped USD credit reading. A shared id puts several accounts on one balance. */
export function observePool(core: AccountCore, quotaId: string, accountId: string, window: string, remaining: number, sharedId: string | null, now: number, ageMs = 1000) {
  core.recordTrustedObservations("recorded-contract", [{ quotaId, values: {
    observedAt: now - ageMs, expiresAt: now + 43_200_000, resetAt: null, limit: 10_000_000_000, used: null, remaining, indicator: null, confidence: "high",
  }, evidence: {
    provider: "openai", accountId, subject: "offline-sample", method: "provider-account", sourceId: "recorded-contract",
    officialUrl: "https://example.invalid", checkedAt: "2026-11-14", receivedAt: now,
    sharedPool: sharedId ? { id: sharedId, scope: "account", window, verified: true } : null, limitations: "Recorded QA evidence",
  } }]);
}

export function recordPool(core: AccountCore, accountId: string, window: string, remaining: number, sharedId: string | null, now: number, ageMs = 1000) {
  const def = core.createDefinition({ accountId, scope: "account", category: "api-credit", unit: { kind: "money", currency: "USD" }, window });
  observePool(core, def.id, accountId, window, remaining, sharedId, now, ageMs);
  return def;
}

export function recordRefusal(db: Database, account: PlanningAccount, now: number) {
  db.run(`INSERT INTO provider_refusal_observations(id,kind,provider,harness_id,account_id,model_id,observed_at,surface,evidence_id,proof,retry_hint,diagnostics)
    VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?)`, [
    crypto.randomUUID(), "usage-limit", "openai", account.harnessId, account.accountId, now - 3_600_000, "developer-run", "qa-planning-1",
    "codex-cli-usage-limit", "try again at Nov 20th, 2026 9:31 PM", "recorded QA refusal",
  ]);
}
