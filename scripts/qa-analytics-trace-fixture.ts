import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RUN_USAGE_STATUS_PREFIX } from "../src/shared/usage-analytics";

/**
 * FO-ANALYTICS-TRACE01 evidence: disposable rows shaped like the records a genuine run leaves (an
 * execution-identity event, a usage receipt, a price revision). They are written straight into an
 * isolated database. Nothing here was executed by a provider, so the data proves the accounting,
 * attribution and reconciliation arithmetic only. It is not evidence of real billing.
 *
 * Two projects, three accounts, two currencies, and one run of each kind:
 *   T1 P1 A1 calculated API (USD)     T2 P2 A2 calculated API (EUR)    T3 P1 A1 billed receipt (USD)
 *   T4 P2 A1 genuine run, no usage    T5 P1 A3 subscription-covered     T6 P1 A1 synthetic (excluded)
 *   T7 P1 A1 calculated API, before the selected period
 */
export interface TraceAccount { id: string }
export interface TraceContext {
  db: Database; insertRun: (row: { id: string; taskId: string; agent: string; startedAt: number; endedAt: number }) => void;
  projectOne: string; projectTwo: string; a1: TraceAccount; a2: TraceAccount; a3: TraceAccount; now: number;
}

export const TRACE_MODEL = "gpt-6.1-sol";
export const TRACE_RECEIPT = { amount: 0.8, currency: "USD" };

export function traceProjectDirs(root: string) {
  const one = join(root, "Trace one");
  const two = join(root, "Trace two");
  for (const dir of [one, two]) { mkdirSync(dir, { recursive: true }); }
  return { one, two };
}

export function seedTracePricing(ctx: TraceContext) {
  const at = ctx.now - 86_400_000;
  const price = (account: TraceAccount, billing: string, currency: string) => ctx.db.run(
    "INSERT INTO usage_pricing(harness_id,account_id,model_id,created_at,terms) VALUES ('codex',?,?,?,?)",
    [account.id, TRACE_MODEL, at, JSON.stringify({ billing, currency, inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1, cacheWritePerMillion: 0 })]);
  price(ctx.a1, "api", "USD");
  price(ctx.a2, "api", "EUR");
  price(ctx.a3, "subscription", "USD");
}

interface RunSpec {
  taskId: string; account: TraceAccount; startOffsetMs: number; execution?: "real-provider" | "synthetic";
  usage?: boolean; billed?: { amount: number; currency: string };
}

export function seedTraceRun(ctx: TraceContext, spec: RunSpec): string {
  const id = crypto.randomUUID();
  const start = ctx.now + spec.startOffsetMs;
  ctx.insertRun({ id, taskId: spec.taskId, agent: "codex", startedAt: start, endedAt: start + 9000 });
  const event = (payload: string) => ctx.db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [id, payload, start + 9000]);
  event(JSON.stringify({ kind: "execution-identity", executionType: spec.execution ?? "real-provider", provider: "codex", model: TRACE_MODEL, mode: "auto", accountProfile: { id: spec.account.id } }));
  if (spec.usage !== false) event(RUN_USAGE_STATUS_PREFIX + JSON.stringify({ input: 100_000, output: 50_000, cacheRead: 30_000, cacheWrite: 0, billed: spec.billed }));
  return id;
}
