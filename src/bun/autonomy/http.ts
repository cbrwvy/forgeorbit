/**
 * Owner HTTP surface for autonomy policies.
 * The coordinator cannot call these mutators; only this authenticated route does.
 */
import {
  activateAutonomyPolicy,
  autonomyStatus,
  AutonomyPolicyError,
  createAutonomyPolicy,
  pauseAutonomyPolicy,
  resumeAutonomyPolicy,
  revokeAutonomyPolicy,
  reviseAutonomyPolicy,
} from "./policy-engine.ts";
import { clearEmergencyStop, emergencyStopAutonomy, prepareAutonomousMission, runningTasksNotStopped, scheduleAutonomyTick } from "./coordinator.ts";
import { practicalCycleStatus } from "./observed-test.ts";

function errorStatus(error: unknown): number {
  return error instanceof AutonomyPolicyError ? error.status : 400;
}

/** The stored status plus, while an Emergency Stop is on, how many running tasks it did not stop. */
function statusWithScope() {
  const status = autonomyStatus();
  return { ...status, emergency: { ...status.emergency, leftRunning: status.emergency.active ? runningTasksNotStopped() : 0 } };
}

export async function autonomyHttp(req: Request, authorized: boolean): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!authorized) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/api/autonomy/status" && req.method === "GET") {
    return json(statusWithScope());
  }
  if (pathname === "/api/autonomy/practical-cycle" && req.method === "GET") {
    return json(practicalCycleStatus(url.searchParams.get("missionId")));
  }
  if (pathname === "/api/autonomy/policies" && req.method === "POST") {
    try {
      const policy = createAutonomyPolicy(await req.json());
      return json({ ok: true, policy });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid policy." }, errorStatus(error));
    }
  }
  if (pathname === "/api/autonomy/emergency-stop" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const result = await emergencyStopAutonomy(body.reason || "Emergency stop by Owner");
    return json({ ok: true, ...result, status: statusWithScope() });
  }
  if (pathname === "/api/autonomy/emergency-stop/clear" && req.method === "POST") {
    clearEmergencyStop();
    return json({ ok: true, status: statusWithScope() });
  }
  if (pathname === "/api/autonomy/missions/prepare" && req.method === "POST") {
    try {
      const prepared = await prepareAutonomousMission(await req.json());
      scheduleAutonomyTick(200);
      return json({ ok: true, ...prepared });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Mission was not prepared." }, errorStatus(error));
    }
  }

  const match = pathname.match(/^\/api\/autonomy\/policies\/([^/]+)(?:\/(.*))?$/);
  if (!match?.[1]) return json({ error: "Not found" }, 404);
  const policyId = decodeURIComponent(match[1]);
  const action = match[2];
  try {
    if (action === "revise" && req.method === "POST") {
      const revised = reviseAutonomyPolicy(policyId, await req.json());
      return json({ ok: true, ...revised });
    }
    if (action === "activate" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { revision?: number };
      const activation = activateAutonomyPolicy(policyId, body.revision);
      return json({ ok: true, activation });
    }
    if (action === "pause" && req.method === "POST") return json({ ok: true, activation: pauseAutonomyPolicy(policyId) });
    if (action === "resume" && req.method === "POST") return json({ ok: true, activation: resumeAutonomyPolicy(policyId) });
    if (action === "revoke" && req.method === "POST") return json({ ok: true, activation: revokeAutonomyPolicy(policyId) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Policy action failed." }, errorStatus(error));
  }
  return json({ error: "Not found" }, 404);
}
