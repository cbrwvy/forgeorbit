/**
 * SQLite access for FO-SELF-IMPROVE01. Version content is never updated.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import type { ImprovementStatus, ImprovementTarget } from "../../shared/self-improve/logic.ts";

export interface VersionRow {
  id: string;
  artifactKey: string;
  version: number;
  scope: "global" | "project";
  projectPath: string | null;
  role: string;
  targetKind: ImprovementTarget;
  content: string;
  contentSha: string;
  parentVersion: number | null;
  source: string;
  createdAt: number;
}

export interface CandidateRow {
  id: string;
  status: ImprovementStatus;
  targetKind: ImprovementTarget;
  role: string;
  scope: "global" | "project";
  projectPath: string | null;
  artifactKey: string;
  currentVersion: number | null;
  proposedVersion: number | null;
  currentContent: string;
  proposedContent: string | null;
  diffText: string | null;
  evidence: unknown[];
  hypothesis: string | null;
  expectedResult: string | null;
  evaluationPlan: string | null;
  risk: "low" | "medium" | "high";
  authorization: "owner" | "policy-low-risk" | "none";
  metrics: unknown;
  decision: string | null;
  decisionReason: string | null;
  depth: number;
  parentCandidateId: string | null;
  synthetic: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ControlRow {
  enabled: boolean;
  paused: boolean;
  stopped: boolean;
  periodStartedAt: number;
  candidatesInPeriod: number;
  activationAttempts: number;
  consecutiveFailures: number;
  consecutiveNoGain: number;
  cooldownUntil: number | null;
  maxCandidatesPerPeriod: number;
  maxEvaluationsPerCandidate: number;
  maxActivationAttempts: number;
  maxNestedDepth: number;
  maxConcurrent: number;
  maxRework: number;
  maxDurationMs: number;
  updatedAt: number;
}

interface CandidateSql {
  id: string;
  status: ImprovementStatus;
  target_kind: ImprovementTarget;
  role: string;
  scope: "global" | "project";
  project_path: string | null;
  artifact_key: string;
  current_version: number | null;
  proposed_version: number | null;
  current_content: string;
  proposed_content: string | null;
  diff_text: string | null;
  evidence_json: string;
  hypothesis: string | null;
  expected_result: string | null;
  evaluation_plan: string | null;
  risk: "low" | "medium" | "high";
  authorization: "owner" | "policy-low-risk" | "none";
  metrics_json: string | null;
  decision: string | null;
  decision_reason: string | null;
  depth: number;
  parent_candidate_id: string | null;
  synthetic: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function toCandidate(row: CandidateSql): CandidateRow {
  return {
    id: row.id,
    status: row.status,
    targetKind: row.target_kind,
    role: row.role,
    scope: row.scope,
    projectPath: row.project_path,
    artifactKey: row.artifact_key,
    currentVersion: row.current_version,
    proposedVersion: row.proposed_version,
    currentContent: row.current_content,
    proposedContent: row.proposed_content,
    diffText: row.diff_text,
    evidence: JSON.parse(row.evidence_json) as unknown[],
    hypothesis: row.hypothesis,
    expectedResult: row.expected_result,
    evaluationPlan: row.evaluation_plan,
    risk: row.risk,
    authorization: row.authorization,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
    decision: row.decision,
    decisionReason: row.decision_reason,
    depth: row.depth,
    parentCandidateId: row.parent_candidate_id,
    synthetic: row.synthetic === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const improvementStore = {
  ensureControl(now: number): ControlRow {
    db.run(`CREATE TRIGGER IF NOT EXISTS improvement_versions_immutable
      BEFORE UPDATE ON improvement_versions
      BEGIN
        SELECT RAISE(ABORT, 'improvement versions are immutable');
      END`);
    const existing = db.query<ControlRowSql, []>("SELECT * FROM improvement_controls WHERE id = 'owner'").get();
    if (!existing) {
      db.run(
        `INSERT INTO improvement_controls (id, period_started_at, updated_at) VALUES ('owner', ?, ?)`,
        [now, now],
      );
    }
    return this.control();
  },
  control(): ControlRow {
    const row = db.query<ControlRowSql, []>("SELECT * FROM improvement_controls WHERE id = 'owner'").get();
    if (!row) throw new Error("Improvement control row is missing.");
    return {
      enabled: row.enabled === 1,
      paused: row.paused === 1,
      stopped: row.stopped === 1,
      periodStartedAt: row.period_started_at,
      candidatesInPeriod: row.candidates_in_period,
      activationAttempts: row.activation_attempts,
      consecutiveFailures: row.consecutive_failures,
      consecutiveNoGain: row.consecutive_no_gain,
      cooldownUntil: row.cooldown_until,
      maxCandidatesPerPeriod: row.max_candidates_per_period,
      maxEvaluationsPerCandidate: row.max_evaluations_per_candidate,
      maxActivationAttempts: row.max_activation_attempts,
      maxNestedDepth: row.max_nested_depth,
      maxConcurrent: row.max_concurrent,
      maxRework: row.max_rework,
      maxDurationMs: row.max_duration_ms,
      updatedAt: row.updated_at,
    };
  },
  saveControl(patch: Partial<ControlRow> & { updatedAt: number }): void {
    const current = this.control();
    const next = { ...current, ...patch };
    db.run(
      `UPDATE improvement_controls SET
        enabled = ?, paused = ?, stopped = ?, period_started_at = ?, candidates_in_period = ?,
        activation_attempts = ?, consecutive_failures = ?, consecutive_no_gain = ?, cooldown_until = ?,
        max_candidates_per_period = ?, max_evaluations_per_candidate = ?, max_activation_attempts = ?,
        max_nested_depth = ?, max_concurrent = ?, max_rework = ?, max_duration_ms = ?, updated_at = ?
       WHERE id = 'owner'`,
      [
        next.enabled ? 1 : 0, next.paused ? 1 : 0, next.stopped ? 1 : 0, next.periodStartedAt,
        next.candidatesInPeriod, next.activationAttempts, next.consecutiveFailures, next.consecutiveNoGain,
        next.cooldownUntil, next.maxCandidatesPerPeriod, next.maxEvaluationsPerCandidate,
        next.maxActivationAttempts, next.maxNestedDepth, next.maxConcurrent, next.maxRework,
        next.maxDurationMs, next.updatedAt,
      ],
    );
  },
  insertObservation(input: {
    role: string;
    projectPath: string;
    fingerprint: string;
    summary: string;
    verified: boolean;
    synthetic: boolean;
    origin: "production" | "evaluation";
    source: string;
    sourceId: string;
    evidence: unknown;
    createdAt: number;
  }): { id: string; created: boolean } {
    const existing = db.query<{ id: string }, [string, string]>(
      "SELECT id FROM improvement_observations WHERE source = ? AND source_id = ?",
    ).get(input.source, input.sourceId);
    if (existing) return { id: existing.id, created: false };
    const id = randomUUID();
    db.run(
      `INSERT INTO improvement_observations (
        id, role, project_path, fingerprint, summary, verified, synthetic, origin, source, source_id, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.role, input.projectPath, input.fingerprint, input.summary,
        input.verified ? 1 : 0, input.synthetic ? 1 : 0, input.origin, input.source, input.sourceId,
        JSON.stringify(input.evidence), input.createdAt,
      ],
    );
    return { id, created: true };
  },
  listObservations(): Array<{
    id: string; role: string; projectPath: string; fingerprint: string; summary: string;
    verified: boolean; synthetic: boolean; origin: "production" | "evaluation"; source: string; sourceId: string | null;
  }> {
    const rows = db.query<{
      id: string; role: string; project_path: string; fingerprint: string; summary: string;
      verified: number; synthetic: number; origin: "production" | "evaluation"; source: string; source_id: string | null;
    }, []>("SELECT id, role, project_path, fingerprint, summary, verified, synthetic, origin, source, source_id FROM improvement_observations").all();
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      projectPath: row.project_path,
      fingerprint: row.fingerprint,
      summary: row.summary,
      verified: row.verified === 1,
      synthetic: row.synthetic === 1,
      origin: row.origin,
      source: row.source,
      sourceId: row.source_id,
    }));
  },
  maxVersion(artifactKey: string): number {
    return db.query<{ v: number | null }, [string]>("SELECT MAX(version) AS v FROM improvement_versions WHERE artifact_key = ?").get(artifactKey)?.v ?? 0;
  },
  /** The version currently active for exactly this artifact, scope and project (null: none is active). */
  activeVersionFor(artifactKey: string, role: string, scope: string, projectPath: string | null): number | null {
    return db.query<{ version: number }, [string, string, string, string | null]>(
      `SELECT version FROM improvement_activations
       WHERE artifact_key = ? AND role = ? AND scope = ? AND IFNULL(project_path, '') = IFNULL(?, '') AND status = 'active'
       ORDER BY activated_at DESC LIMIT 1`,
    ).get(artifactKey, role, scope, projectPath)?.version ?? null;
  },
  insertVersion(input: Omit<VersionRow, "id">): VersionRow {
    const id = randomUUID();
    db.run(
      `INSERT INTO improvement_versions (
        id, artifact_key, version, scope, project_path, role, target_kind, content, content_sha, parent_version, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.artifactKey, input.version, input.scope, input.projectPath, input.role, input.targetKind,
        input.content, input.contentSha, input.parentVersion, input.source, input.createdAt,
      ],
    );
    return { id, ...input };
  },
  version(artifactKey: string, version: number): VersionRow | null {
    const row = db.query<VersionSql, [string, number]>(
      "SELECT * FROM improvement_versions WHERE artifact_key = ? AND version = ?",
    ).get(artifactKey, version);
    return row ? toVersion(row) : null;
  },
  insertCandidate(input: Omit<CandidateRow, "id" | "evidence"> & { evidence: unknown[] }): CandidateRow {
    const id = randomUUID();
    db.run(
      `INSERT INTO improvement_candidates (
        id, status, target_kind, role, scope, project_path, artifact_key, current_version, proposed_version,
        current_content, proposed_content, diff_text, evidence_json, hypothesis, expected_result, evaluation_plan,
        risk, authorization, metrics_json, decision, decision_reason, depth, parent_candidate_id, synthetic,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.status, input.targetKind, input.role, input.scope, input.projectPath, input.artifactKey,
        input.currentVersion, input.proposedVersion, input.currentContent, input.proposedContent, input.diffText,
        JSON.stringify(input.evidence), input.hypothesis, input.expectedResult, input.evaluationPlan,
        input.risk, input.authorization, input.metrics ? JSON.stringify(input.metrics) : null,
        input.decision, input.decisionReason, input.depth, input.parentCandidateId, input.synthetic ? 1 : 0,
        input.expiresAt, input.createdAt, input.updatedAt,
      ],
    );
    return this.candidate(id)!;
  },
  candidate(id: string): CandidateRow | null {
    const row = db.query<CandidateSql, [string]>("SELECT * FROM improvement_candidates WHERE id = ?").get(id);
    return row ? toCandidate(row) : null;
  },
  listCandidates(): CandidateRow[] {
    return db.query<CandidateSql, []>("SELECT * FROM improvement_candidates ORDER BY created_at DESC").all().map(toCandidate);
  },
  updateCandidate(id: string, patch: Partial<CandidateRow> & { updatedAt: number }): CandidateRow {
    const current = this.candidate(id);
    if (!current) throw new Error("Improvement candidate not found.");
    const next = { ...current, ...patch };
    db.run(
      `UPDATE improvement_candidates SET
        status = ?, proposed_version = ?, proposed_content = ?, diff_text = ?, hypothesis = ?, expected_result = ?,
        evaluation_plan = ?, risk = ?, authorization = ?, metrics_json = ?, decision = ?, decision_reason = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.status, next.proposedVersion, next.proposedContent, next.diffText, next.hypothesis, next.expectedResult,
        next.evaluationPlan, next.risk, next.authorization, next.metrics ? JSON.stringify(next.metrics) : null,
        next.decision, next.decisionReason, next.updatedAt, id,
      ],
    );
    return this.candidate(id)!;
  },
  transition(candidateId: string, from: string, to: string, reason: string, createdAt: number): void {
    db.run(
      `INSERT INTO improvement_transitions (id, candidate_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), candidateId, from, to, reason, createdAt],
    );
  },
  countCandidatesSince(since: number): number {
    return db.query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM improvement_candidates WHERE created_at >= ?",
    ).get(since)?.n ?? 0;
  },
  countRunningEvaluations(): number {
    return db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM improvement_evaluations WHERE status = 'running'",
    ).get()?.n ?? 0;
  },
  evaluationAttempts(candidateId: string): number {
    return db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM improvement_evaluations WHERE candidate_id = ?",
    ).get(candidateId)?.n ?? 0;
  },
  insertEvaluation(input: {
    candidateId: string;
    attempt: number;
    fixtureIds: string[];
    provider: string;
    model: string;
    baselineModel: string;
    accountId: string | null;
    permissionKey: string;
    startedAt: number;
    baselineVersion: number | null;
    baselineSha: string;
    candidateVersion: number | null;
    candidateSha: string;
  }): string {
    const id = randomUUID();
    db.run(
      `INSERT INTO improvement_evaluations (
        id, candidate_id, attempt, status, fixture_ids_json, attribution, provider, model, baseline_model,
        account_id, quota_status, permission_key, started_at, baseline_version, baseline_sha, candidate_version, candidate_sha
      ) VALUES (?, ?, ?, 'running', ?, 'instruction-quality', ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?)`,
      [
        id, input.candidateId, input.attempt, JSON.stringify(input.fixtureIds), input.provider, input.model,
        input.baselineModel, input.accountId, input.permissionKey, input.startedAt,
        input.baselineVersion, input.baselineSha, input.candidateVersion, input.candidateSha,
      ],
    );
    return id;
  },
  /** The newest finished evaluation of a candidate, with the revisions and sample it recorded. */
  latestFinishedEvaluation(candidateId: string): {
    id: string; verdict: string | null; status: string; sampleSize: number | null; execution: string | null;
    baselineVersion: number | null; baselineSha: string | null; candidateVersion: number | null; candidateSha: string | null;
  } | null {
    const row = db.query<{
      id: string; verdict: string | null; status: string; sample_size: number | null; execution: string | null;
      baseline_version: number | null; baseline_sha: string | null; candidate_version: number | null; candidate_sha: string | null;
    }, [string]>(
      `SELECT id, verdict, status, sample_size, execution, baseline_version, baseline_sha, candidate_version, candidate_sha
       FROM improvement_evaluations WHERE candidate_id = ? AND finished_at IS NOT NULL ORDER BY attempt DESC LIMIT 1`,
    ).get(candidateId);
    return row ? {
      id: row.id, verdict: row.verdict, status: row.status, sampleSize: row.sample_size, execution: row.execution,
      baselineVersion: row.baseline_version, baselineSha: row.baseline_sha,
      candidateVersion: row.candidate_version, candidateSha: row.candidate_sha,
    } : null;
  },
  finishEvaluation(id: string, input: {
    status: "finished" | "inconclusive";
    baseline: unknown;
    candidate: unknown;
    verdict: string;
    attribution: string;
    finishedAt: number;
    sampleSize?: number;
    execution?: string;
  }): void {
    db.run(
      `UPDATE improvement_evaluations SET status = ?, baseline_metrics_json = ?, candidate_metrics_json = ?,
        verdict = ?, attribution = ?, finished_at = ?, sample_size = COALESCE(?, sample_size), execution = COALESCE(?, execution) WHERE id = ?`,
      [input.status, JSON.stringify(input.baseline), JSON.stringify(input.candidate), input.verdict, input.attribution, input.finishedAt, input.sampleSize ?? null, input.execution ?? null, id],
    );
  },
  unfinishedEvaluations(): Array<{ id: string; candidateId: string; permissionKey: string }> {
    return db.query<{ id: string; candidate_id: string; permission_key: string }, []>(
      "SELECT id, candidate_id, permission_key FROM improvement_evaluations WHERE status = 'running' AND finished_at IS NULL",
    ).all().map((row) => ({ id: row.id, candidateId: row.candidate_id, permissionKey: row.permission_key }));
  },
  insertActivation(input: {
    candidateId: string;
    artifactKey: string;
    version: number;
    scope: "global" | "project";
    projectPath: string | null;
    role: string;
    strategy: string;
    lastKnownGoodVersion: number | null;
    canaryLimit: number | null;
    activatedAt: number;
  }): string {
    const id = randomUUID();
    db.run(
      `INSERT INTO improvement_activations (
        id, candidate_id, artifact_key, version, scope, project_path, role, strategy, status,
        last_known_good_version, canary_limit, runs_consumed, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?)`,
      [
        id, input.candidateId, input.artifactKey, input.version, input.scope, input.projectPath, input.role,
        input.strategy, input.lastKnownGoodVersion, input.canaryLimit, input.activatedAt,
      ],
    );
    return id;
  },
  supersedeActive(artifactKey: string, role: string, scope: string, projectPath: string | null): number | null {
    const row = db.query<{ id: string; version: number }, [string, string, string, string | null]>(
      `SELECT id, version FROM improvement_activations
       WHERE artifact_key = ? AND role = ? AND scope = ? AND IFNULL(project_path, '') = IFNULL(?, '') AND status = 'active'`,
    ).get(artifactKey, role, scope, projectPath);
    if (!row) return null;
    db.run("UPDATE improvement_activations SET status = 'superseded' WHERE id = ?", [row.id]);
    return row.version;
  },
  rollbackActivation(id: string, reason: string, at: number): void {
    db.run(
      "UPDATE improvement_activations SET status = 'rolled_back', rolled_back_at = ?, rollback_reason = ? WHERE id = ?",
      [at, reason, id],
    );
  },
  reactivateVersion(artifactKey: string, role: string, scope: string, projectPath: string | null, version: number): boolean {
    const row = db.query<{ id: string }, [string, string, string, string | null, number]>(
      `SELECT id FROM improvement_activations
       WHERE artifact_key = ? AND role = ? AND scope = ? AND IFNULL(project_path, '') = IFNULL(?, '') AND version = ? AND status = 'superseded'
       ORDER BY activated_at DESC LIMIT 1`,
    ).get(artifactKey, role, scope, projectPath, version);
    if (!row) return false;
    db.run("UPDATE improvement_activations SET status = 'active', rolled_back_at = NULL, rollback_reason = NULL WHERE id = ?", [row.id]);
    return true;
  },
  activeActivations(role: string, projectPath: string): Array<{
    id: string; artifactKey: string; version: number; scope: "global" | "project"; projectPath: string | null;
    strategy: string; canaryLimit: number | null; runsConsumed: number;
  }> {
    return db.query<{
      id: string; artifact_key: string; version: number; scope: "global" | "project"; project_path: string | null;
      strategy: string; canary_limit: number | null; runs_consumed: number;
    }, [string, string]>(
      `SELECT id, artifact_key, version, scope, project_path, strategy, canary_limit, runs_consumed
       FROM improvement_activations
       WHERE status = 'active' AND role = ? AND (scope = 'global' OR project_path = ?)`,
    ).all(role, projectPath).map((row) => ({
      id: row.id,
      artifactKey: row.artifact_key,
      version: row.version,
      scope: row.scope,
      projectPath: row.project_path,
      strategy: row.strategy,
      canaryLimit: row.canary_limit,
      runsConsumed: row.runs_consumed,
    }));
  },
  consumeCanary(id: string): void {
    db.run("UPDATE improvement_activations SET runs_consumed = runs_consumed + 1 WHERE id = ?", [id]);
  },
  recordProvenance(input: {
    runId: string; taskId: string; projectPath: string; role: string; versionsJson: string; snapshotSha: string; frozenAt: number;
  }): void {
    db.run(
      `INSERT INTO improvement_run_provenance (run_id, task_id, project_path, role, versions_json, snapshot_sha, frozen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`,
      [input.runId, input.taskId, input.projectPath, input.role, input.versionsJson, input.snapshotSha, input.frozenAt],
    );
  },
  listProvenance(limit = 12): Array<{
    runId: string; taskId: string; projectPath: string; role: string; snapshotSha: string;
    versions: Array<{ artifactKey: string; version: number }>;
  }> {
    const cap = Math.max(1, Math.min(40, limit));
    return db.query<{
      run_id: string; task_id: string; project_path: string; role: string; versions_json: string; snapshot_sha: string;
    }, [number]>(
      `SELECT run_id, task_id, project_path, role, versions_json, snapshot_sha
       FROM improvement_run_provenance ORDER BY frozen_at DESC LIMIT ?`,
    ).all(cap).map((row) => {
      let versions: Array<{ artifactKey: string; version: number }> = [];
      try {
        const parsed = JSON.parse(row.versions_json) as unknown;
        if (Array.isArray(parsed)) {
          versions = parsed.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const record = item as { artifactKey?: unknown; version?: unknown };
            if (typeof record.artifactKey !== "string" || typeof record.version !== "number") return [];
            return [{ artifactKey: record.artifactKey, version: record.version }];
          });
        }
      } catch {
        versions = [];
      }
      return {
        runId: row.run_id,
        taskId: row.task_id,
        projectPath: row.project_path,
        role: row.role,
        snapshotSha: row.snapshot_sha,
        versions,
      };
    });
  },
  provenance(runId: string): { versionsJson: string; snapshotSha: string; role: string; projectPath: string } | null {
    const row = db.query<{ versions_json: string; snapshot_sha: string; role: string; project_path: string }, [string]>(
      "SELECT versions_json, snapshot_sha, role, project_path FROM improvement_run_provenance WHERE run_id = ?",
    ).get(runId);
    if (!row) return null;
    return {
      versionsJson: row.versions_json,
      snapshotSha: row.snapshot_sha,
      role: row.role,
      projectPath: row.project_path,
    };
  },
  listActive(): Array<{ artifactKey: string; version: number; role: string; scope: string; projectPath: string | null; strategy: string }> {
    return db.query<{
      artifact_key: string; version: number; role: string; scope: string; project_path: string | null; strategy: string;
    }, []>(
      "SELECT artifact_key, version, role, scope, project_path, strategy FROM improvement_activations WHERE status = 'active'",
    ).all().map((row) => ({
      artifactKey: row.artifact_key, version: row.version, role: row.role, scope: row.scope, projectPath: row.project_path, strategy: row.strategy,
    }));
  },
  latestActivation(candidateId: string): { id: string; version: number; status: string; lastKnownGoodVersion: number | null; artifactKey: string; role: string; scope: "global" | "project"; projectPath: string | null } | null {
    const row = db.query<{
      id: string; version: number; status: string; last_known_good_version: number | null; artifact_key: string;
      role: string; scope: "global" | "project"; project_path: string | null;
    }, [string]>(
      "SELECT id, version, status, last_known_good_version, artifact_key, role, scope, project_path FROM improvement_activations WHERE candidate_id = ? ORDER BY activated_at DESC LIMIT 1",
    ).get(candidateId);
    if (!row) return null;
    return {
      id: row.id, version: row.version, status: row.status, lastKnownGoodVersion: row.last_known_good_version,
      artifactKey: row.artifact_key, role: row.role, scope: row.scope, projectPath: row.project_path,
    };
  },
  insertFixture(input: {
    name: string; role: string; projectPath: string | null; heldOut: boolean; fingerprint: string;
    mustInclude: string[]; mustNotInclude: string[]; createdAt: number;
  }): string {
    const id = randomUUID();
    db.run(
      `INSERT INTO improvement_fixtures (
        id, name, role, project_path, held_out, defect_fingerprint, must_include_json, must_not_include_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.role, input.projectPath, input.heldOut ? 1 : 0, input.fingerprint, JSON.stringify(input.mustInclude), JSON.stringify(input.mustNotInclude), input.createdAt],
    );
    return id;
  },
  fixturesFor(role: string, projectPath: string | null): Array<{
    id: string; heldOut: boolean; mustInclude: string[]; mustNotInclude: string[]; projectPath: string | null;
  }> {
    const rows = db.query<{
      id: string; held_out: number; must_include_json: string; must_not_include_json: string; project_path: string | null;
    }, [string]>(
      "SELECT id, held_out, must_include_json, must_not_include_json, project_path FROM improvement_fixtures WHERE role = ?",
    ).all(role);
    return rows
      .filter((row) => row.project_path == null || row.project_path === projectPath)
      .map((row) => ({
        id: row.id,
        heldOut: row.held_out === 1,
        mustInclude: JSON.parse(row.must_include_json) as string[],
        mustNotInclude: JSON.parse(row.must_not_include_json) as string[],
        projectPath: row.project_path,
      }));
  },
};

interface ControlRowSql {
  enabled: number;
  paused: number;
  stopped: number;
  period_started_at: number;
  candidates_in_period: number;
  activation_attempts: number;
  consecutive_failures: number;
  consecutive_no_gain: number;
  cooldown_until: number | null;
  max_candidates_per_period: number;
  max_evaluations_per_candidate: number;
  max_activation_attempts: number;
  max_nested_depth: number;
  max_concurrent: number;
  max_rework: number;
  max_duration_ms: number;
  updated_at: number;
}

interface VersionSql {
  id: string;
  artifact_key: string;
  version: number;
  scope: "global" | "project";
  project_path: string | null;
  role: string;
  target_kind: ImprovementTarget;
  content: string;
  content_sha: string;
  parent_version: number | null;
  source: string;
  created_at: number;
}

function toVersion(row: VersionSql): VersionRow {
  return {
    id: row.id,
    artifactKey: row.artifact_key,
    version: row.version,
    scope: row.scope,
    projectPath: row.project_path,
    role: row.role,
    targetKind: row.target_kind,
    content: row.content,
    contentSha: row.content_sha,
    parentVersion: row.parent_version,
    source: row.source,
    createdAt: row.created_at,
  };
}
