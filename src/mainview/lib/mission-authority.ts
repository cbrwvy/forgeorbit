/**
 * What may advance a mission by itself, from the records: its binding to an Owner policy, that policy's activation,
 * the clock and the Emergency Stop. A mode name alone confers nothing: a revoked, expired or paused activation, or an
 * Emergency Stop, leaves every step waiting for the Owner.
 */
export interface AuthorityStatus {
  emergency: { active: boolean };
  bindings?: Array<{ missionId: string; mode: string; outcome: string; activationId: string }>;
  activations?: Array<{ id: string; status: string; expiresAt: number }>;
}

export type MissionAuthority =
  | { kind: "supervised" }
  | { kind: "autonomous" | "full-autonomy" }
  | { kind: "inactive"; why: "revoked" | "expired" | "paused" | "ended" | "missing" }
  | { kind: "emergency" };

export function missionAuthority(missionId: string, status: AuthorityStatus | null, now = Date.now()): MissionAuthority {
  if (!status) return { kind: "supervised" };
  const binding = status.bindings?.find((row) => row.missionId === missionId);
  if (!binding || binding.mode === "supervised") return { kind: "supervised" };
  if (status.emergency.active) return { kind: "emergency" };
  const activation = status.activations?.find((row) => row.id === binding.activationId);
  if (!activation) return { kind: "inactive", why: "missing" };
  if (activation.status === "revoked") return { kind: "inactive", why: "revoked" };
  if (activation.status === "paused") return { kind: "inactive", why: "paused" };
  if (activation.status === "expired" || now >= activation.expiresAt) return { kind: "inactive", why: "expired" };
  if (binding.outcome !== "active") return { kind: "inactive", why: "ended" };
  return binding.mode === "full-autonomy" ? { kind: "full-autonomy" } : { kind: "autonomous" };
}
