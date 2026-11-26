import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import type {
  MissionRecord,
  MissionPlan,
  MissionStatus,
  MissionRuntimeState,
  MissionHistoryEvent,
  MissionReservation,
  MissionTaskDependency,
  MissionTaskPlan,
} from "../../shared/orchestration/types.js";

export class MissionStore {
  constructor(private database: Database = db, private now: () => number = Date.now) {}

  createMission(params: {
    title: string;
    goal: string;
    initiativeId?: string | null;
    status: MissionStatus;
    clusters: string[];
    projects: string[];
    plan: MissionPlan;
    planDigest: string;
  }): MissionRecord {
    const id = randomUUID();
    const at = this.now();
    const revision = 1;

    const state: MissionRuntimeState = {
      totalTasks: params.plan.tasks.length,
      completedTasks: 0,
      runningTasks: 0,
      blockedTasks: 0,
      failedTasks: 0,
      awaitingQcTasks: 0,
      awaitingOwnerTasks: 0,
      activeSpecialists: [],
      resourceUsage: {},
    };

    const history: MissionHistoryEvent[] = [
      {
        timestamp: at,
        event: "created",
        details: { status: params.status, totalTasks: params.plan.tasks.length },
      },
    ];

    const record: MissionRecord = {
      id,
      title: params.title,
      goal: params.goal,
      initiativeId: params.initiativeId ?? null,
      status: params.status,
      revision,
      clusters: params.clusters,
      projects: params.projects,
      plan: params.plan,
      planDigest: params.planDigest,
      authorization: null,
      concurrencyLimits: params.plan.concurrencyLimits,
      state,
      history,
      createdAt: at,
      updatedAt: at,
    };

    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO orchestration_missions (
          id, title, goal, initiative_id, status, revision,
          clusters_json, projects_json, plan_json, plan_digest,
          authorization_json, concurrency_limits_json, state_json, history_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.title,
          record.goal,
          record.initiativeId ?? null,
          record.status,
          record.revision,
          JSON.stringify(record.clusters),
          JSON.stringify(record.projects),
          JSON.stringify(record.plan),
          record.planDigest,
          null,
          JSON.stringify(record.concurrencyLimits),
          JSON.stringify(record.state),
          JSON.stringify(record.history),
          record.createdAt,
          record.updatedAt,
        ],
      );

      for (const task of params.plan.tasks) {
        for (const dep of task.dependencies || []) {
          this.database.run(
            `INSERT INTO orchestration_task_dependencies (
              id, mission_id, task_id, project_path,
              depends_on_task_id, depends_on_project_path, condition, satisfied_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              record.id,
              task.taskId,
              task.projectPath,
              dep.taskId,
              dep.projectPath,
              dep.condition,
              null,
              at,
            ],
          );
        }
      }
    }).immediate();

    return record;
  }

  getMission(id: string): MissionRecord | null {
    const row = this.database
      .query<
        {
          id: string;
          title: string;
          goal: string;
          initiative_id: string | null;
          status: string;
          revision: number;
          clusters_json: string;
          projects_json: string;
          plan_json: string;
          plan_digest: string;
          authorization_json: string | null;
          concurrency_limits_json: string;
          state_json: string;
          history_json: string;
          created_at: number;
          updated_at: number;
        },
        [string]
      >(`SELECT * FROM orchestration_missions WHERE id = ?`)
      .get(id);

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      goal: row.goal,
      initiativeId: row.initiative_id,
      status: row.status as MissionStatus,
      revision: row.revision,
      clusters: JSON.parse(row.clusters_json),
      projects: JSON.parse(row.projects_json),
      plan: JSON.parse(row.plan_json),
      planDigest: row.plan_digest,
      authorization: row.authorization_json ? JSON.parse(row.authorization_json) : null,
      concurrencyLimits: JSON.parse(row.concurrency_limits_json),
      state: JSON.parse(row.state_json),
      history: JSON.parse(row.history_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMissions(filter?: { status?: MissionStatus; clusterId?: string }): MissionRecord[] {
    let sql = `SELECT * FROM orchestration_missions`;
    const params: string[] = [];

    if (filter?.status) {
      sql += ` WHERE status = ?`;
      params.push(filter.status);
    }
    sql += ` ORDER BY updated_at DESC, created_at DESC`;

    const rows = this.database.query<
      {
        id: string;
        title: string;
        goal: string;
        initiative_id: string | null;
        status: string;
        revision: number;
        clusters_json: string;
        projects_json: string;
        plan_json: string;
        plan_digest: string;
        authorization_json: string | null;
        concurrency_limits_json: string;
        state_json: string;
        history_json: string;
        created_at: number;
        updated_at: number;
      },
      string[]
    >(sql).all(...params);

    return rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        goal: row.goal,
        initiativeId: row.initiative_id,
        status: row.status as MissionStatus,
        revision: row.revision,
        clusters: JSON.parse(row.clusters_json),
        projects: JSON.parse(row.projects_json),
        plan: JSON.parse(row.plan_json),
        planDigest: row.plan_digest,
        authorization: row.authorization_json ? JSON.parse(row.authorization_json) : null,
        concurrencyLimits: JSON.parse(row.concurrency_limits_json),
        state: JSON.parse(row.state_json),
        history: JSON.parse(row.history_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
      .filter((m) => {
        if (filter?.clusterId && !m.clusters.includes(filter.clusterId)) return false;
        return true;
      });
  }

  updateMissionStatus(
    id: string,
    status: MissionStatus,
    eventText: string,
    details?: Record<string, unknown>,
  ): MissionRecord | null {
    const mission = this.getMission(id);
    if (!mission) return null;

    const at = this.now();
    mission.status = status;
    mission.updatedAt = at;
    mission.history.push({
      timestamp: at,
      event: eventText,
      details,
    });

    this.database.run(
      `UPDATE orchestration_missions SET status = ?, history_json = ?, updated_at = ? WHERE id = ?`,
      [mission.status, JSON.stringify(mission.history), mission.updatedAt, id],
    );

    return mission;
  }

  updateMissionAuthorization(
    id: string,
    authorization: { authorizedAt: number; authorizedBy: string; digest: string },
    status: MissionStatus = "authorized",
  ): MissionRecord | null {
    const mission = this.getMission(id);
    if (!mission) return null;

    const at = this.now();
    mission.authorization = authorization;
    mission.status = status;
    mission.updatedAt = at;
    mission.history.push({
      timestamp: at,
      event: "authorized",
      details: { authorizedBy: authorization.authorizedBy, digest: authorization.digest },
    });

    this.database.run(
      `UPDATE orchestration_missions
       SET status = ?, authorization_json = ?, history_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        mission.status,
        JSON.stringify(mission.authorization),
        JSON.stringify(mission.history),
        mission.updatedAt,
        id,
      ],
    );

    return mission;
  }

  updateMissionPlan(
    id: string,
    plan: MissionPlan,
    planDigest: string,
    eventText: string,
  ): MissionRecord | null {
    const mission = this.getMission(id);
    if (!mission) return null;

    const at = this.now();
    mission.plan = plan;
    mission.planDigest = planDigest;
    mission.revision += 1;
    mission.authorization = null; // Invalidate prior authorization
    mission.status = "planned";
    mission.updatedAt = at;
    mission.history.push({
      timestamp: at,
      event: eventText,
      details: { revision: mission.revision, planDigest },
    });

    this.database.transaction(() => {
      this.database.run(
        `UPDATE orchestration_missions
         SET plan_json = ?, plan_digest = ?, revision = ?, authorization_json = NULL,
             status = ?, history_json = ?, updated_at = ?
         WHERE id = ?`,
        [
          JSON.stringify(mission.plan),
          mission.planDigest,
          mission.revision,
          mission.status,
          JSON.stringify(mission.history),
          mission.updatedAt,
          id,
        ],
      );

      // Re-create dependencies
      this.database.run(`DELETE FROM orchestration_task_dependencies WHERE mission_id = ?`, [id]);
      for (const task of plan.tasks) {
        for (const dep of task.dependencies || []) {
          this.database.run(
            `INSERT INTO orchestration_task_dependencies (
              id, mission_id, task_id, project_path,
              depends_on_task_id, depends_on_project_path, condition, satisfied_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              id,
              task.taskId,
              task.projectPath,
              dep.taskId,
              dep.projectPath,
              dep.condition,
              null,
              at,
            ],
          );
        }
      }
    }).immediate();

    return mission;
  }

  updateMissionState(id: string, state: MissionRuntimeState): void {
    const at = this.now();
    this.database.run(
      `UPDATE orchestration_missions SET state_json = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(state), at, id],
    );
  }

  saveMissionPlanState(id: string, plan: MissionPlan, state: MissionRuntimeState): void {
    const at = this.now();
    this.database.run(
      `UPDATE orchestration_missions SET plan_json = ?, state_json = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(plan), JSON.stringify(state), at, id],
    );
  }

  // Reservation management
  createReservation(params: {
    missionId: string;
    taskId: string;
    projectPath: string;
    employeeId: string;
    accountId?: string | null;
    harnessId: string;
    modelId: string;
    status: MissionReservation["status"];
    runId?: string | null;
    qcReviewId?: string | null;
  }): MissionReservation {
    const id = randomUUID();
    const at = this.now();

    const written = this.database.run(
      `INSERT INTO orchestration_reservations (
        id, mission_id, task_id, project_path,
        employee_id, account_id, harness_id, model_id,
        status, run_id, qc_review_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        mission_id = excluded.mission_id,
        project_path = excluded.project_path,
        employee_id = excluded.employee_id,
        account_id = excluded.account_id,
        harness_id = excluded.harness_id,
        model_id = excluded.model_id,
        status = excluded.status,
        run_id = excluded.run_id,
        qc_review_id = excluded.qc_review_id,
        updated_at = excluded.updated_at
      WHERE orchestration_reservations.status NOT IN ('reserved', 'starting', 'running', 'awaiting_qc', 'qc_running')`,
      [
        id,
        params.missionId,
        params.taskId,
        params.projectPath,
        params.employeeId,
        params.accountId ?? null,
        params.harnessId,
        params.modelId,
        params.status,
        params.runId ?? null,
        params.qcReviewId ?? null,
        at,
        at,
      ],
    );

    if (written.changes === 0) {
      throw new Error("This task already has an active reservation. A second worker was not launched.");
    }
    return this.getReservation(params.taskId) ?? {
      id,
      missionId: params.missionId,
      taskId: params.taskId,
      projectPath: params.projectPath,
      employeeId: params.employeeId,
      accountId: params.accountId ?? null,
      harnessId: params.harnessId,
      modelId: params.modelId,
      status: params.status,
      runId: params.runId ?? null,
      qcReviewId: params.qcReviewId ?? null,
      createdAt: at,
      updatedAt: at,
    };
  }

  getReservation(taskId: string): MissionReservation | null {
    const row = this.database
      .query<
        {
          id: string;
          mission_id: string;
          task_id: string;
          project_path: string;
          employee_id: string;
          account_id: string | null;
          harness_id: string;
          model_id: string;
          status: string;
          run_id: string | null;
          qc_review_id: string | null;
          created_at: number;
          updated_at: number;
        },
        [string]
      >(`SELECT * FROM orchestration_reservations WHERE task_id = ?`)
      .get(taskId);

    if (!row) return null;

    return {
      id: row.id,
      missionId: row.mission_id,
      taskId: row.task_id,
      projectPath: row.project_path,
      employeeId: row.employee_id,
      accountId: row.account_id,
      harnessId: row.harness_id,
      modelId: row.model_id,
      status: row.status as MissionReservation["status"],
      runId: row.run_id,
      qcReviewId: row.qc_review_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The shared-slot boundary. Counting the active reservations and inserting this one happen in ONE immediate
   * transaction, so no other tick (another mission, or another process on the same database) can take the slot
   * between the check and the write. Everything the scheduler checks earlier is a fast path that may be stale after
   * an await; this is the check that cannot be. A task that already holds a reservation is refused by
   * `createReservation` itself.
   */
  tryCreateReservation(
    params: Parameters<MissionStore["createReservation"]>[0],
    limits: { globalMax: number; perProjectMax: number },
  ): { ok: true; reservation: MissionReservation } | { ok: false; reason: string } {
    return this.database.transaction((): { ok: true; reservation: MissionReservation } | { ok: false; reason: string } => {
      const active = this.listActiveReservations();
      if (active.length >= limits.globalMax || active.filter((row) => row.projectPath === params.projectPath).length >= limits.perProjectMax) {
        return { ok: false, reason: "Waiting for a global, cluster, or project worker slot." };
      }
      return { ok: true, reservation: this.createReservation(params) };
    }).immediate();
  }

  listActiveReservations(missionId?: string): MissionReservation[] {
    let sql = `SELECT * FROM orchestration_reservations WHERE status IN ('reserved', 'starting', 'running', 'awaiting_qc', 'qc_running')`;
    const params: string[] = [];
    if (missionId) {
      sql += ` AND mission_id = ?`;
      params.push(missionId);
    }

    const rows = this.database.query<
      {
        id: string;
        mission_id: string;
        task_id: string;
        project_path: string;
        employee_id: string;
        account_id: string | null;
        harness_id: string;
        model_id: string;
        status: string;
        run_id: string | null;
        qc_review_id: string | null;
        created_at: number;
        updated_at: number;
      },
      string[]
    >(sql).all(...params);

    return rows.map((r) => ({
      id: r.id,
      missionId: r.mission_id,
      taskId: r.task_id,
      projectPath: r.project_path,
      employeeId: r.employee_id,
      accountId: r.account_id,
      harnessId: r.harness_id,
      modelId: r.model_id,
      status: r.status as MissionReservation["status"],
      runId: r.run_id,
      qcReviewId: r.qc_review_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  updateReservationStatus(
    taskId: string,
    status: MissionReservation["status"],
    updates?: { runId?: string | null; qcReviewId?: string | null },
  ): void {
    const at = this.now();
    let sql = `UPDATE orchestration_reservations SET status = ?, updated_at = ?`;
    const params: (string | number | null)[] = [status, at];

    if (updates?.runId !== undefined) {
      sql += `, run_id = ?`;
      params.push(updates.runId);
    }
    if (updates?.qcReviewId !== undefined) {
      sql += `, qc_review_id = ?`;
      params.push(updates.qcReviewId);
    }
    sql += ` WHERE task_id = ?`;
    params.push(taskId);

    this.database.run(sql, params);
  }

  releaseReservations(missionId: string): void {
    this.database.run(`DELETE FROM orchestration_reservations WHERE mission_id = ?`, [missionId]);
  }

  releaseTaskReservation(taskId: string): void {
    this.database.run(`DELETE FROM orchestration_reservations WHERE task_id = ?`, [taskId]);
  }

  // Dependencies
  listMissionDependencies(missionId: string): MissionTaskDependency[] {
    const rows = this.database
      .query<
        {
          id: string;
          mission_id: string;
          task_id: string;
          project_path: string;
          depends_on_task_id: string;
          depends_on_project_path: string;
          condition: string;
          satisfied_at: number | null;
          created_at: number;
        },
        [string]
      >(`SELECT * FROM orchestration_task_dependencies WHERE mission_id = ?`)
      .all(missionId);

    return rows.map((r) => ({
      id: r.id,
      missionId: r.mission_id,
      taskId: r.task_id,
      projectPath: r.project_path,
      dependsOnTaskId: r.depends_on_task_id,
      dependsOnProjectPath: r.depends_on_project_path,
      condition: r.condition as MissionTaskDependency["condition"],
      satisfiedAt: r.satisfied_at,
      createdAt: r.created_at,
    }));
  }

  markDependencySatisfied(missionId: string, dependsOnTaskId: string): number {
    const at = this.now();
    const res = this.database.run(
      `UPDATE orchestration_task_dependencies
       SET satisfied_at = ?
       WHERE mission_id = ? AND depends_on_task_id = ? AND satisfied_at IS NULL`,
      [at, missionId, dependsOnTaskId],
    );
    return res.changes;
  }
}

export const missionStore = new MissionStore();
