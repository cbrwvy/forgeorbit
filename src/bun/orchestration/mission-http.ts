/**
 * FO-ORCH-SCALE01: Scalable Multi-Project Orchestration — HTTP Endpoints
 */

import { missionStore } from "./mission-store.ts";
import { missionScheduler, OrchestrationError } from "./mission-scheduler.ts";
import { missionResourceOptions, missionResourceProposals, prepareMissionResourceProposal, settleMissionResourceProposal } from "./mission-replan.ts";
import { approveObjectiveMission, ObjectiveMissionError } from "./objective-mission.ts";
import type { MissionStatus } from "../../shared/orchestration/types.js";

export async function orchestrationHttp(req: Request, authorized: boolean): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });

  if (!authorized) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const pathname = url.pathname;

  // GET /api/orchestration/missions
  if (pathname === "/api/orchestration/missions" && req.method === "GET") {
    const status = url.searchParams.get("status") as MissionStatus | null;
    const clusterId = url.searchParams.get("clusterId") || undefined;
    const missions = missionStore.listMissions({
      status: status || undefined,
      clusterId,
    });
    return json({ missions });
  }

  // POST /api/orchestration/missions/prepare
  if (pathname === "/api/orchestration/missions/prepare" && req.method === "POST") {
    try {
      const body = await req.json();
      const mission = await missionScheduler.prepareMission(body);
      return json({ ok: true, mission });
    } catch (e) {
      const status = e instanceof OrchestrationError ? e.status : 400;
      return json({ error: (e as Error).message }, status);
    }
  }

  // GET /api/orchestration/reservations
  if (pathname === "/api/orchestration/reservations" && req.method === "GET") {
    const missionId = url.searchParams.get("missionId") || undefined;
    const reservations = missionStore.listActiveReservations(missionId);
    return json({ reservations });
  }

  // Match /api/orchestration/missions/:id/*
  const match = pathname.match(/^\/api\/orchestration\/missions\/([^/]+)(?:\/(.*))?$/);
  if (match && match[1]) {
    const missionId = decodeURIComponent(match[1]);
    const action = match[2];

    if (!action && req.method === "GET") {
      const mission = missionStore.getMission(missionId);
      if (!mission) return json({ error: "Mission not found." }, 404);
      return json({ mission });
    }

    if ((action === "approve-objective" || action === "confirm-launch") && req.method === "POST") {
      try {
        const body = await req.json();
        if (body?.confirm !== true) return json({ error: "Explicit confirmation is required." }, 400);
        if (action === "approve-objective") {
          const { mission, started } = await approveObjectiveMission(missionId, body.digest);
          if (started) {
            missionScheduler.wakeObjectiveMissions();
            void missionScheduler.tickMission(mission.id).catch(error => console.warn("[missions] Initial tick failed:", error));
          }
          return json({ mission });
        }
        if (typeof body.taskId === "string" && typeof body.refusalId === "string" && body.operationId === undefined) {
          missionScheduler.retryQuotaWait(missionId, body.taskId, body.refusalId);
          return json({ ok: true }, 202);
        }
        if (typeof body.taskId !== "string" || typeof body.operationId !== "string") return json({ error: "Choose a prepared launch operation." }, 400);
        const locale = req.headers.get("accept-language")?.toLowerCase().startsWith("ru") ? "ru" : "en";
        missionScheduler.confirmObjectiveLaunch(missionId, body.taskId, body.operationId, locale);
        return json({ ok: true }, 202);
      } catch (error) {
        const status = error instanceof OrchestrationError || error instanceof ObjectiveMissionError ? error.status : 400;
        return json({ error: (error as Error).message }, status);
      }
    }

    if (action === "resource-proposals" || action === "resource-options") {
      try {
        if (action === "resource-options" && req.method === "GET") {
          const role = url.searchParams.get("role");
          if (role !== "developer" && role !== "reviewer") return json({ error: "Choose a stage." }, 400);
          return json({ options: missionResourceOptions(missionId, url.searchParams.get("taskId") ?? "", role) });
        }
        if (action === "resource-proposals" && req.method === "GET") {
          if (!missionStore.getMission(missionId)) return json({ error: "Mission not found." }, 404);
          return json(missionResourceProposals(missionId));
        }
        if (action === "resource-proposals" && req.method === "POST") {
          return json(prepareMissionResourceProposal(missionId, await req.json()));
        }
        if (action === "resource-proposals" && req.method === "PATCH") {
          const body = await req.json();
          if (body?.confirm !== true || typeof body.id !== "string" || typeof body.digest !== "string" ||
            (body.decision !== "approve" && body.decision !== "reject")) return json({ error: "An exact Owner decision and digest are required." }, 400);
          return json(settleMissionResourceProposal(missionId, body.id, body.digest, body.decision));
        }
      } catch (error) {
        return json({ error: (error as Error).message }, error instanceof OrchestrationError ? error.status : 400);
      }
    }

    if (action === "authorize" && req.method === "POST") {
      try {
        const body = (await req.json()) as { digest?: string };
        if (!body?.digest) {
          return json({ error: "digest is required for mission authorization." }, 400);
        }
        const authorizedMission = await missionScheduler.authorizeMission(missionId, body.digest);
        return json({ ok: true, mission: authorizedMission });
      } catch (e) {
        const status = e instanceof OrchestrationError ? e.status : 400;
        return json({ error: (e as Error).message }, status);
      }
    }

    if (action === "start" && req.method === "POST") {
      try {
        const started = await missionScheduler.startMission(missionId);
        return json({ ok: true, mission: started });
      } catch (e) {
        const status = e instanceof OrchestrationError ? e.status : 400;
        return json({ error: (e as Error).message }, status);
      }
    }

    if (action === "pause" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { reason?: string };
        const paused = await missionScheduler.pauseMission(missionId, body?.reason);
        return json({ ok: true, mission: paused });
      } catch (e) {
        const status = e instanceof OrchestrationError ? e.status : 400;
        return json({ error: (e as Error).message }, status);
      }
    }

    if (action === "resume" && req.method === "POST") {
      try {
        const resumed = await missionScheduler.resumeMission(missionId);
        return json({ ok: true, mission: resumed });
      } catch (e) {
        const status = e instanceof OrchestrationError ? e.status : 400;
        return json({ error: (e as Error).message }, status);
      }
    }

    if (action === "cancel" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { reason?: string };
        const cancelled = await missionScheduler.cancelMission(missionId, body?.reason);
        return json({ ok: true, mission: cancelled });
      } catch (e) {
        const status = e instanceof OrchestrationError ? e.status : 400;
        return json({ error: (e as Error).message }, status);
      }
    }
  }

  // GET /api/orchestration/dependencies/:missionId
  const depMatch = pathname.match(/^\/api\/orchestration\/dependencies\/([^/]+)$/);
  if (depMatch && depMatch[1] && req.method === "GET") {
    const missionId = decodeURIComponent(depMatch[1]);
    const dependencies = missionStore.listMissionDependencies(missionId);
    return json({ dependencies });
  }

  return json({ error: "Not found" }, 404);
}
