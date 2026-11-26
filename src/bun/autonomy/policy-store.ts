/**
 * Durable autonomy policy, activation, reservation, and recovery records.
 * Provenance JSON and digests are written once and never updated.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import type { AutonomyMode, AutonomyPolicyBody } from "../../shared/autonomy-policy.ts";

export interface PolicyRow {
  id: string;
  revision: number;
  status: "draft" | "active" | "paused" | "revoked" | "expired" | "superseded";
  mode: AutonomyMode;
  body: AutonomyPolicyBody;
  digest: string;
  createdAt: number;
  updatedAt: number;
}

export interface ActivationRow {
  id: string;
  policyId: string;
  revision: number;
  digest: string;
  activatedBy: "owner";
  activatedAt: number;
  expiresAt: number;
  status: "active" | "paused" | "revoked" | "expired";
  provenance: Record<string, unknown>;
}

export interface ReservationRow {
  id: string;
  activationId: string;
  policyId: string;
  revision: number;
  action: string;
  targetKey: string;
  missionId: string | null;
  taskId: string | null;
  projectPath: string | null;
  status: "reserved" | "consumed" | "released" | "cancelled";
}

export interface MissionBinding {
  missionId: string;
  policyId: string;
  revision: number;
  activationId: string;
  digest: string;
  mode: AutonomyMode;
  outcome: string;
  summary: string | null;
  emergencyTaskIds: string[];
}

function parseBody(raw: string): AutonomyPolicyBody {
  return JSON.parse(raw) as AutonomyPolicyBody;
}

export class AutonomyPolicyStore {
  insertPolicy(row: Omit<PolicyRow, "createdAt" | "updatedAt"> & { createdAt?: number }): PolicyRow {
    const at = row.createdAt ?? Date.now();
    db.run(
      `INSERT INTO autonomy_policies (
        id, revision, status, mode, scope_kind, scope_ref, mission_id, body_json, digest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.revision,
        row.status,
        row.mode,
        row.body.scopeKind,
        row.body.scopeRef,
        row.body.missionId,
        JSON.stringify(row.body),
        row.digest,
        at,
        at,
      ],
    );
    return { ...row, createdAt: at, updatedAt: at };
  }

  latestPolicy(id: string): PolicyRow | null {
    const row = db.query<{
      id: string; revision: number; status: PolicyRow["status"]; mode: AutonomyMode; body_json: string; digest: string; created_at: number; updated_at: number;
    }, [string]>(
      `SELECT id, revision, status, mode, body_json, digest, created_at, updated_at
       FROM autonomy_policies WHERE id = ? ORDER BY revision DESC LIMIT 1`,
    ).get(id);
    if (!row) return null;
    return {
      id: row.id,
      revision: row.revision,
      status: row.status,
      mode: row.mode,
      body: parseBody(row.body_json),
      digest: row.digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  policyRevision(id: string, revision: number): PolicyRow | null {
    const row = db.query<{
      id: string; revision: number; status: PolicyRow["status"]; mode: AutonomyMode; body_json: string; digest: string; created_at: number; updated_at: number;
    }, [string, number]>(
      `SELECT id, revision, status, mode, body_json, digest, created_at, updated_at
       FROM autonomy_policies WHERE id = ? AND revision = ?`,
    ).get(id, revision);
    if (!row) return null;
    return {
      id: row.id,
      revision: row.revision,
      status: row.status,
      mode: row.mode,
      body: parseBody(row.body_json),
      digest: row.digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  setPolicyStatus(id: string, revision: number, status: PolicyRow["status"]): void {
    db.run(
      `UPDATE autonomy_policies SET status = ?, updated_at = ? WHERE id = ? AND revision = ?`,
      [status, Date.now(), id, revision],
    );
  }

  listPolicies(): PolicyRow[] {
    const rows = db.query<{
      id: string; revision: number; status: PolicyRow["status"]; mode: AutonomyMode; body_json: string; digest: string; created_at: number; updated_at: number;
    }, []>(
      `SELECT p.id, p.revision, p.status, p.mode, p.body_json, p.digest, p.created_at, p.updated_at
       FROM autonomy_policies p
       JOIN (SELECT id, MAX(revision) AS revision FROM autonomy_policies GROUP BY id) latest
         ON latest.id = p.id AND latest.revision = p.revision
       ORDER BY p.updated_at DESC`,
    ).all();
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      status: row.status,
      mode: row.mode,
      body: parseBody(row.body_json),
      digest: row.digest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  insertActivation(row: ActivationRow): void {
    const at = row.activatedAt;
    db.run(
      `INSERT INTO autonomy_activations (
        id, policy_id, revision, digest, activated_by, activated_at, expires_at, status, provenance_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.policyId,
        row.revision,
        row.digest,
        row.activatedAt,
        row.expiresAt,
        row.status,
        JSON.stringify(row.provenance),
        at,
        at,
      ],
    );
  }

  getActivation(id: string): ActivationRow | null {
    const row = db.query<{
      id: string; policy_id: string; revision: number; digest: string; activated_by: "owner";
      activated_at: number; expires_at: number; status: ActivationRow["status"]; provenance_json: string;
    }, [string]>(
      `SELECT id, policy_id, revision, digest, activated_by, activated_at, expires_at, status, provenance_json
       FROM autonomy_activations WHERE id = ?`,
    ).get(id);
    if (!row) return null;
    return {
      id: row.id,
      policyId: row.policy_id,
      revision: row.revision,
      digest: row.digest,
      activatedBy: "owner",
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      status: row.status,
      provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    };
  }

  activationForPolicy(policyId: string, revision: number): ActivationRow | null {
    const row = db.query<{ id: string }, [string, number]>(
      `SELECT id FROM autonomy_activations WHERE policy_id = ? AND revision = ?`,
    ).get(policyId, revision);
    return row ? this.getActivation(row.id) : null;
  }

  setActivationStatus(id: string, status: ActivationRow["status"]): void {
    db.run(`UPDATE autonomy_activations SET status = ?, updated_at = ? WHERE id = ?`, [status, Date.now(), id]);
  }

  listActivations(): ActivationRow[] {
    const rows = db.query<{ id: string }, []>(`SELECT id FROM autonomy_activations ORDER BY activated_at DESC`).all();
    return rows.map((row) => this.getActivation(row.id)!).filter(Boolean);
  }

  activeActivations(): ActivationRow[] {
    return this.listActivations().filter((row) => row.status === "active" || row.status === "paused");
  }

  insertReservation(row: Omit<ReservationRow, "id"> & { id?: string }): ReservationRow {
    const id = row.id ?? randomUUID();
    const at = Date.now();
    db.run(
      `INSERT INTO autonomy_action_reservations (
        id, activation_id, policy_id, revision, action, target_key, mission_id, task_id, project_path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        row.activationId,
        row.policyId,
        row.revision,
        row.action,
        row.targetKey,
        row.missionId,
        row.taskId,
        row.projectPath,
        row.status,
        at,
        at,
      ],
    );
    return { ...row, id };
  }

  reservationByKey(activationId: string, targetKey: string): ReservationRow | null {
    const row = db.query<{
      id: string; activation_id: string; policy_id: string; revision: number; action: string; target_key: string;
      mission_id: string | null; task_id: string | null; project_path: string | null; status: ReservationRow["status"];
    }, [string, string]>(
      `SELECT id, activation_id, policy_id, revision, action, target_key, mission_id, task_id, project_path, status
       FROM autonomy_action_reservations WHERE activation_id = ? AND target_key = ?`,
    ).get(activationId, targetKey);
    if (!row) return null;
    return {
      id: row.id,
      activationId: row.activation_id,
      policyId: row.policy_id,
      revision: row.revision,
      action: row.action,
      targetKey: row.target_key,
      missionId: row.mission_id,
      taskId: row.task_id,
      projectPath: row.project_path,
      status: row.status,
    };
  }

  setReservationStatus(id: string, status: ReservationRow["status"], outcome?: Record<string, unknown>): void {
    db.run(
      `UPDATE autonomy_action_reservations SET status = ?, outcome_json = COALESCE(?, outcome_json), updated_at = ? WHERE id = ?`,
      [status, outcome ? JSON.stringify(outcome) : null, Date.now(), id],
    );
  }

  countLaunches(activationId: string): { used: number; inFlight: number } {
    const rows = db.query<{ status: string }, [string]>(
      `SELECT status FROM autonomy_action_reservations WHERE activation_id = ? AND action = 'launch_task'`,
    ).all(activationId);
    let used = 0;
    let inFlight = 0;
    for (const row of rows) {
      if (row.status === "cancelled") continue;
      used += 1;
      if (row.status === "reserved" || row.status === "consumed") inFlight += 1;
    }
    return { used, inFlight };
  }

  cancelUnclaimed(activationId?: string): number {
    const at = Date.now();
    if (activationId) {
      return db.run(
        `UPDATE autonomy_action_reservations SET status = 'cancelled', updated_at = ? WHERE activation_id = ? AND status = 'reserved'`,
        [at, activationId],
      ).changes;
    }
    return db.run(
      `UPDATE autonomy_action_reservations SET status = 'cancelled', updated_at = ? WHERE status = 'reserved'`,
      [at],
    ).changes;
  }

  recordDecision(input: {
    activationId: string | null;
    policyId: string | null;
    revision: number | null;
    action: string;
    target: unknown;
    verdict: "allowed" | "denied";
    reason: string;
    missionId?: string | null;
    taskId?: string | null;
  }): void {
    db.run(
      `INSERT INTO autonomy_decisions (
        id, activation_id, policy_id, revision, action, target_json, verdict, reason, mission_id, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.activationId,
        input.policyId,
        input.revision,
        input.action,
        JSON.stringify(input.target),
        input.verdict,
        input.reason.slice(0, 500),
        input.missionId ?? null,
        input.taskId ?? null,
        Date.now(),
      ],
    );
  }

  listDecisions(limit = 50): Array<{
    id: string; policyId: string | null; revision: number | null; action: string; verdict: string; reason: string; taskId: string | null; createdAt: number;
  }> {
    return db.query<{
      id: string; policy_id: string | null; revision: number | null; action: string; verdict: string; reason: string; task_id: string | null; created_at: number;
    }, [number]>(
      `SELECT id, policy_id, revision, action, verdict, reason, task_id, created_at
       FROM autonomy_decisions ORDER BY created_at DESC LIMIT ?`,
    ).all(limit).map((row) => ({
      id: row.id,
      policyId: row.policy_id,
      revision: row.revision,
      action: row.action,
      verdict: row.verdict,
      reason: row.reason,
      taskId: row.task_id,
      createdAt: row.created_at,
    }));
  }

  upsertBinding(binding: MissionBinding): void {
    const at = Date.now();
    db.run(
      `INSERT INTO autonomy_mission_bindings (
        mission_id, policy_id, revision, activation_id, digest, mode, outcome, summary_text, emergency_task_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        outcome = excluded.outcome,
        summary_text = excluded.summary_text,
        emergency_task_ids_json = excluded.emergency_task_ids_json,
        updated_at = excluded.updated_at`,
      [
        binding.missionId,
        binding.policyId,
        binding.revision,
        binding.activationId,
        binding.digest,
        binding.mode,
        binding.outcome,
        binding.summary,
        JSON.stringify(binding.emergencyTaskIds),
        at,
        at,
      ],
    );
  }

  getBinding(missionId: string): MissionBinding | null {
    const row = db.query<{
      mission_id: string; policy_id: string; revision: number; activation_id: string; digest: string; mode: AutonomyMode;
      outcome: string; summary_text: string | null; emergency_task_ids_json: string;
    }, [string]>(
      `SELECT mission_id, policy_id, revision, activation_id, digest, mode, outcome, summary_text, emergency_task_ids_json
       FROM autonomy_mission_bindings WHERE mission_id = ?`,
    ).get(missionId);
    if (!row) return null;
    return {
      missionId: row.mission_id,
      policyId: row.policy_id,
      revision: row.revision,
      activationId: row.activation_id,
      digest: row.digest,
      mode: row.mode,
      outcome: row.outcome,
      summary: row.summary_text,
      emergencyTaskIds: JSON.parse(row.emergency_task_ids_json) as string[],
    };
  }

  listBindings(): MissionBinding[] {
    const rows = db.query<{ mission_id: string }, []>(`SELECT mission_id FROM autonomy_mission_bindings`).all();
    return rows.map((row) => this.getBinding(row.mission_id)!).filter(Boolean);
  }

  journal(kind: string, payload: Record<string, unknown>): void {
    db.run(
      `INSERT INTO autonomy_recovery_journal (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)`,
      [randomUUID(), kind, JSON.stringify(payload), Date.now()],
    );
  }

  listJournal(limit = 20): Array<{ id: string; kind: string; payload: Record<string, unknown>; createdAt: number }> {
    return db.query<{ id: string; kind: string; payload_json: string; created_at: number }, [number]>(
      `SELECT id, kind, payload_json, created_at FROM autonomy_recovery_journal ORDER BY created_at DESC LIMIT ?`,
    ).all(limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  readEmergency(): { active: boolean; reason: string | null; activatedAt: number | null; outstanding: string[] } {
    const row = db.query<{ active: number; reason: string | null; activated_at: number | null; outstanding_json: string }, []>(
      `SELECT active, reason, activated_at, outstanding_json FROM autonomy_emergency WHERE id = 'global'`,
    ).get();
    if (!row) return { active: false, reason: null, activatedAt: null, outstanding: [] };
    return {
      active: row.active === 1,
      reason: row.reason,
      activatedAt: row.activated_at,
      outstanding: JSON.parse(row.outstanding_json) as string[],
    };
  }

  writeEmergency(active: boolean, reason: string | null, outstanding: string[]): void {
    const at = Date.now();
    db.run(
      `INSERT INTO autonomy_emergency (id, active, activated_at, reason, outstanding_json)
       VALUES ('global', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET active = excluded.active, activated_at = excluded.activated_at, reason = excluded.reason, outstanding_json = excluded.outstanding_json`,
      [active ? 1 : 0, active ? at : null, reason, JSON.stringify(outstanding)],
    );
  }
}

export const autonomyPolicyStore = new AutonomyPolicyStore();
