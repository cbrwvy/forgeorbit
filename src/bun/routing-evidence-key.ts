/**
 * Hash stored routing facts, excluding volatile timestamps and transient local
 * run occupancy (`sqlite:all-running-runs`) whose concurrency bounds are already
 * checked synchronously at claim/reservation time. Account quotas (`facts.quotas`)
 * and declared limits remain hashed in full so real account or quota changes
 * still invalidate stale reviews.
 */
import { createHash } from "node:crypto";
import type { RoutingSnapshot } from "../shared/model-router/types.ts";

export function routingEvidenceKey(snapshot: RoutingSnapshot): string {
  const { capturedAt: _capturedAt, ...facts } = snapshot;
  const hasSqliteOccupancy = facts.limits.some(
    (limit) => limit.id === "global" && limit.occupied?.source === "sqlite:all-running-runs",
  );
  const limits = facts.limits.map((limit) => {
    if (limit.id === "global" && limit.occupied?.source === "sqlite:all-running-runs") {
      return {
        ...limit,
        occupied: { source: limit.occupied.source, verification: limit.occupied.verification },
      };
    }
    const scope = limit.scope;
    if (
      hasSqliteOccupancy
      && scope.kind === "account"
      && facts.quotas.some((q) =>
        q.definition.accountId === scope.id
        && q.definition.unit.kind === "concurrency"
        && q.definition.window === "instant")
    ) {
      return { ...limit, occupied: null };
    }
    return limit;
  });
  return createHash("sha256").update(JSON.stringify({ ...facts, limits })).digest("hex");
}
