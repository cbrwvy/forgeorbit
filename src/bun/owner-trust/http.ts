/**
 * HTTP surface for Owner trust.
 * A page, a bearer token, and a public-key body cannot enroll or approve.
 * The review route asks the embedded helper to display the backend operation.
 */
import { ownerTrust } from "./service.ts";
import { ownerTrustDiagnostics, reviewAuthoritativeOperation } from "./native-bridge.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const FORGED_KEYS = ["approved", "proof", "publicKey", "publicKeySpki", "operation", "signature", "executionReady"];

export async function ownerTrustHttp(req: Request, authorized: boolean): Promise<Response> {
  if (!authorized) return json({ error: "unauthorized", code: "unauthorized" }, 401);
  const url = new URL(req.url);
  const trust = ownerTrust();
  if (url.pathname === "/api/owner-trust/status" && req.method === "GET") return json(await ownerTrustDiagnostics(trust));
  if (url.pathname === "/api/owner-trust/enroll" && req.method === "POST") {
    return json({
      ok: false,
      executionReady: false,
      code: "owner-enrollment-refused",
      reason: "An API request cannot enroll an Owner key. Enrollment happens only in the signed application after macOS authentication.",
    }, 403);
  }
  if (url.pathname === "/api/owner-trust/approve" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || body.approved === true || typeof body.challengeId !== "string" || !body.challengeId.trim()) {
      return json({
        ok: false,
        executionReady: false,
        code: "owner-proof-invalid",
        error: "The embedded page cannot approve execution. Native authentication has to sign the exact operation.",
        reason: "The embedded page cannot approve execution. Native authentication has to sign the exact operation.",
      }, 400);
    }
    const result = await reviewAuthoritativeOperation(trust, "en");
    return json(result, result.ok ? 200 : 200);
  }
  if (url.pathname === "/api/owner-trust/review" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || FORGED_KEYS.some((key) => key in body)) {
      return json({
        ok: false,
        executionReady: false,
        code: "owner-proof-invalid",
        reason: "The embedded page cannot approve execution. Native authentication has to sign the exact operation.",
      }, 400);
    }
    const locale = body.locale === "ru" ? "ru" : "en";
    const result = await reviewAuthoritativeOperation(trust, locale);
    return json(result, 200);
  }
  if (url.pathname === "/api/owner-trust/cancel" && req.method === "POST") {
    const result = trust.recordCancellation("authentication-cancelled", "The Owner cancelled before authentication. No grant was created.", null);
    return json(result, 200);
  }
  if (url.pathname === "/api/owner-trust/revoke" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { enrollmentId?: string; grantId?: string };
    if (body.enrollmentId) return json(trust.revokeEnrollment(body.enrollmentId), 200);
    if (body.grantId) return json(trust.revokeGrant(body.grantId), 200);
    return json({ ok: false, code: "owner-proof-invalid", reason: "Name the enrollment or the grant to revoke." }, 400);
  }
  return json({ error: "Not found" }, 404);
}
