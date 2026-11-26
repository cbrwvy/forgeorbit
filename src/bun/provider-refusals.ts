/**
 * Store for provider refusal observations (migration 140). Records and reads; it never retries,
 * launches, routes or estimates anything. See `src/shared/provider-refusal.ts`.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { db } from "./db.ts";
import { redactSecrets } from "../shared/project-interview.ts";
import {
  refusalClearedBy,
  type ProviderRefusalKind,
  type ProviderRefusalProof,
  type ProviderRefusalScope,
  type ProviderRefusalSummary,
} from "../shared/provider-refusal.ts";

interface Row {
  id: string; kind: ProviderRefusalKind; provider: string; harness_id: string; account_id: string | null;
  model_id: string | null; observed_at: number; surface: string; evidence_id: string; proof: ProviderRefusalProof;
  retry_hint: string | null; diagnostics: string; superseded_at: number | null; superseded_by: string | null;
}

const DIAGNOSTICS_MAX = 700;
const HINT_MAX = 120;

function accountLabelOf(accountId: string | null, database: Database): string | null {
  if (!accountId) return null;
  try {
    return database.query<{ name: string | null }, [string]>("SELECT json_extract(data, '$.displayName') AS name FROM resource_accounts WHERE id = ?").get(accountId)?.name ?? null;
  } catch { return null; }
}

function summary(row: Row, database: Database = db): ProviderRefusalSummary {
  return {
    accountLabel: accountLabelOf(row.account_id, database),
    id: row.id, kind: row.kind, provider: row.provider, harnessId: row.harness_id, accountId: row.account_id,
    modelId: row.model_id, observedAt: row.observed_at, surface: row.surface, proof: row.proof,
    retryHint: row.retry_hint, supersededAt: row.superseded_at, diagnostics: row.diagnostics,
  };
}

export interface RecordRefusalInput {
  kind: ProviderRefusalKind;
  provider: string;
  scope: ProviderRefusalScope;
  surface: string;
  /** The id of the thing the evidence came from, such as a Head message. Makes recording idempotent. */
  evidenceId: string;
  proof: ProviderRefusalProof;
  retryHint: string | null;
  diagnostics: string;
  now?: number;
}

/** Idempotent per (surface, evidenceId): a replay returns the row that already exists. */
export function recordProviderRefusal(input: RecordRefusalInput): ProviderRefusalSummary {
  const existing = db.query<Row, [string, string]>("SELECT * FROM provider_refusal_observations WHERE surface = ? AND evidence_id = ?").get(input.surface, input.evidenceId);
  if (existing) return summary(existing);
  const hint = input.retryHint ? redactSecrets(input.retryHint).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, HINT_MAX) || null : null;
  const diagnostics = redactSecrets(input.diagnostics).slice(0, DIAGNOSTICS_MAX);
  const id = randomUUID();
  const observedAt = input.now ?? Date.now();
  // A late or replayed refusal must not outlive a provider answer that is newer than it.
  const answer = input.scope.modelId === null ? null : lastAnswer({ harnessId: input.scope.harnessId, accountId: input.scope.accountId, modelId: input.scope.modelId });
  const alreadyAnswered = answer !== null && answer.observedAt >= observedAt;
  db.run(
    `INSERT INTO provider_refusal_observations
       (id, kind, provider, harness_id, account_id, model_id, observed_at, surface, evidence_id, proof, retry_hint, diagnostics, superseded_at, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, input.provider, input.scope.harnessId, input.scope.accountId, input.scope.modelId, observedAt, input.surface, input.evidenceId, input.proof, hint, diagnostics,
      alreadyAnswered ? answer.observedAt : null, alreadyAnswered ? answer.evidenceId : null],
  );
  return summary(db.query<Row, [string]>("SELECT * FROM provider_refusal_observations WHERE id = ?").get(id)!);
}

export function getProviderRefusal(id: string): ProviderRefusalSummary | null {
  const row = db.query<Row, [string]>("SELECT * FROM provider_refusal_observations WHERE id = ?").get(id);
  return row ? summary(row) : null;
}

/** The latest refusal that still speaks for exactly this scope, or null. */
export function activeProviderRefusal(scope: ProviderRefusalScope, now = Date.now()): ProviderRefusalSummary | null {
  const row = db.query<Row, [string, string | null, string | null, number]>(
    `SELECT * FROM provider_refusal_observations WHERE harness_id = ? AND account_id IS ?
      AND (model_id IS NULL OR model_id IS ?) AND observed_at <= ? AND superseded_at IS NULL
      ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
  ).get(scope.harnessId, scope.accountId, scope.modelId, now);
  return row ? summary(row) : null;
}

/** Every refusal still standing for one harness, newest first. Used by the account view. */
export function activeProviderRefusalsForHarness(harnessId: string): ProviderRefusalSummary[] {
  return db.query<Row, [string]>(
    "SELECT * FROM provider_refusal_observations WHERE harness_id = ? AND superseded_at IS NULL ORDER BY observed_at DESC, rowid DESC",
  ).all(harnessId).map(row => summary(row));
}

export interface ProviderAnswerScope { harnessId: string; accountId: string | null; modelId: string }

interface AnswerRow { observed_at: number; evidence_id: string; surface: string }

/** The newest successful provider answer for exactly this scope, or null. */
export function lastAnswer(scope: ProviderAnswerScope): { observedAt: number; evidenceId: string; surface: string } | null {
  const row = db.query<AnswerRow, [string, string, string]>(
    "SELECT observed_at, evidence_id, surface FROM provider_last_answer WHERE harness_id = ? AND account_key = ? AND model_id = ?",
  ).get(scope.harnessId, scope.accountId ?? "", scope.modelId);
  return row ? { observedAt: row.observed_at, evidenceId: row.evidence_id, surface: row.surface } : null;
}

/**
 * A successful provider answer is the only recovery signal. A login check, the passing of a hinted
 * time or an Owner click is not. The answer ends only refusals observed at or before it, for exactly
 * its own harness, account and model (see `refusalClearedBy`). The newest answer per scope is kept, so a
 * late or duplicate settlement can neither move it backwards nor clear a newer refusal.
 */
export function supersedeProviderRefusals(scope: ProviderRefusalScope, successEvidenceId: string, at: number = Date.now(), surface = "answer"): number {
  if (scope.modelId === null) return 0;
  const answer: ProviderAnswerScope = { harnessId: scope.harnessId, accountId: scope.accountId, modelId: scope.modelId };
  db.run(
    `INSERT INTO provider_last_answer (harness_id, account_key, model_id, observed_at, surface, evidence_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(harness_id, account_key, model_id) DO UPDATE SET
       observed_at = excluded.observed_at, surface = excluded.surface, evidence_id = excluded.evidence_id
     WHERE excluded.observed_at > provider_last_answer.observed_at`,
    [answer.harnessId, answer.accountId ?? "", answer.modelId, at, surface, successEvidenceId],
  );
  const ids = db.query<Row, [string]>(
    "SELECT * FROM provider_refusal_observations WHERE harness_id = ? AND superseded_at IS NULL",
  ).all(scope.harnessId).filter((row) => row.observed_at <= at && refusalClearedBy(summary(row), answer)).map((row) => row.id);
  for (const id of ids) {
    db.run("UPDATE provider_refusal_observations SET superseded_at = ?, superseded_by = ? WHERE id = ? AND superseded_at IS NULL", [at, successEvidenceId, id]);
  }
  return ids.length;
}

/** Every refusal that still stands, newest first, read once for a whole candidate list. */
export function allActiveProviderRefusals(database: Database = db): ProviderRefusalSummary[] {
  return database.query<Row, []>(
    "SELECT * FROM provider_refusal_observations WHERE superseded_at IS NULL ORDER BY observed_at DESC, rowid DESC",
  ).all().map(row => summary(row, database));
}

/** The refusals recognized on specific runs (Developer or Reviewer), keyed by run id. Read-only. */
export function providerRefusalsForRuns(runIds: readonly string[]): Map<string, ProviderRefusalSummary> {
  const out = new Map<string, ProviderRefusalSummary>();
  if (runIds.length === 0) return out;
  const marks = runIds.map(() => "?").join(",");
  const rows = db.query<Row, string[]>(
    `SELECT * FROM provider_refusal_observations WHERE surface IN ('developer-run','reviewer-run') AND evidence_id IN (${marks})`,
  ).all(...runIds);
  for (const row of rows) out.set(row.evidence_id, summary(row));
  return out;
}
