/**
 * Owner HTTP surface for the self-improvement engine.
 * Prepare stays a text draft. Evaluate with policyTest runs the existing harness comparison and does not activate a skill.
 */
import {
  SelfImprovementError,
  activateImprovementCandidate,
  answerImprovementQuestion,
  evaluateCandidateOnAuthorizedTest,
  approveImprovementCandidate,
  discoverImprovementCandidates,
  evaluateImprovementCandidate,
  prepareImprovementCandidate,
  proposeImprovementContent,
  reconcileSelfImprovement,
  recordMonitoredOutcome,
  rejectImprovementCandidate,
  retainImprovementCandidate,
  rollbackImprovementCandidate,
  runImprovementCycle,
  selfImprovementStatus,
  setImprovementControl,
} from "./engine.ts";

function errorStatus(error: unknown): number {
  return error instanceof SelfImprovementError ? error.status : 400;
}

export async function selfImprovementHttp(req: Request, authorized: boolean): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!authorized) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const pathname = url.pathname;
  try {
    if (pathname === "/api/self-improvement/status" && req.method === "GET") {
      return json(selfImprovementStatus());
    }
    if (pathname === "/api/self-improvement/report" && req.method === "GET") {
      const question = url.searchParams.get("question") ?? "";
      return json({ answer: answerImprovementQuestion(question) });
    }
    if (pathname === "/api/self-improvement/control" && req.method === "POST") {
      return json({ ok: true, control: setImprovementControl(await req.json()) });
    }
    if (pathname === "/api/self-improvement/discover" && req.method === "POST") {
      return json({ ok: true, candidates: discoverImprovementCandidates() });
    }
    if (pathname === "/api/self-improvement/cycle" && req.method === "POST") {
      const body = await req.json() as { projectPath?: string };
      if (!body.projectPath) return json({ error: "projectPath is required." }, 400);
      return json({ ok: true, ...runImprovementCycle(body.projectPath) });
    }
    if (pathname === "/api/self-improvement/reconcile" && req.method === "POST") {
      return json({ ok: true, ...reconcileSelfImprovement() });
    }
    const match = pathname.match(/^\/api\/self-improvement\/candidates\/([^/]+)(?:\/(.*))?$/);
    if (!match?.[1]) return json({ error: "Not found" }, 404);
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (action === "prepare" && req.method === "POST") return json({ ok: true, candidate: prepareImprovementCandidate(id) });
    if (action === "propose" && req.method === "POST") {
      const body = await req.json() as { content?: string };
      if (!body.content) return json({ error: "content is required." }, 400);
      return json({ ok: true, candidate: proposeImprovementContent(id, body.content) });
    }
    if (action === "evaluate" && req.method === "POST") {
      const body = await req.json() as { provider?: string; model?: string; baselineModel?: string; accountId?: string | null; policyTest?: boolean };
      if (body.policyTest === true) {
        return json({
          ok: true,
          candidate: await evaluateCandidateOnAuthorizedTest(id, {
            provider: body.provider ?? "claude-code",
            model: body.model ?? "haiku-4.5",
            accountId: body.accountId,
          }),
        });
      }
      return json({
        ok: true,
        candidate: evaluateImprovementCandidate(id, {
          provider: body.provider ?? "fake",
          model: body.model ?? "fake-driver",
          baselineModel: body.baselineModel,
          accountId: body.accountId,
        }),
      });
    }
    if (action === "approve" && req.method === "POST") return json({ ok: true, candidate: approveImprovementCandidate(id, "owner") });
    if (action === "reject" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { reason?: string };
      return json({ ok: true, candidate: rejectImprovementCandidate(id, body.reason) });
    }
    if (action === "activate" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { strategy?: "manual" | "project" | "canary" };
      return json({ ok: true, candidate: activateImprovementCandidate(id, { actor: "owner", strategy: body.strategy ?? "project" }) });
    }
    if (action === "rollback" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { reason?: string };
      return json({ ok: true, candidate: rollbackImprovementCandidate(id, body.reason || "Owner rolled back the improvement.", "owner") });
    }
    if (action === "retain" && req.method === "POST") return json({ ok: true, candidate: retainImprovementCandidate(id) });
    if (action === "monitor" && req.method === "POST") {
      const body = await req.json() as { errors?: number };
      if (typeof body.errors !== "number") return json({ error: "errors is required." }, 400);
      return json({ ok: true, candidate: recordMonitoredOutcome(id, body.errors) });
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Self-improvement request failed." }, errorStatus(error));
  }
  return json({ error: "Not found" }, 404);
}
