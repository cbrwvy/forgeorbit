import { expect, test } from "bun:test";
import { missionAuthority } from "./mission-authority";

const now = 1_000_000;
const status = (over: Partial<{ mode: string; outcome: string; actStatus: string; expiresAt: number; emergency: boolean }> = {}) => ({
  emergency: { active: over.emergency ?? false },
  bindings: [{ missionId: "m", mode: over.mode ?? "full-autonomy", outcome: over.outcome ?? "active", activationId: "a" }],
  activations: [{ id: "a", status: over.actStatus ?? "active", expiresAt: over.expiresAt ?? now + 1000 }],
});

test("a mission with no binding, or a Supervised one, advances only by the Owner's step approvals", () => {
  expect(missionAuthority("m", null, now)).toEqual({ kind: "supervised" });
  expect(missionAuthority("other", status(), now)).toEqual({ kind: "supervised" });
  expect(missionAuthority("m", status({ mode: "supervised" }), now)).toEqual({ kind: "supervised" });
});

test("a mode confers authority only while its activation is active, unexpired and no Emergency Stop is on", () => {
  expect(missionAuthority("m", status(), now)).toEqual({ kind: "full-autonomy" });
  expect(missionAuthority("m", status({ mode: "autonomous" }), now)).toEqual({ kind: "autonomous" });
  expect(missionAuthority("m", status({ actStatus: "revoked" }), now)).toEqual({ kind: "inactive", why: "revoked" });
  expect(missionAuthority("m", status({ actStatus: "paused" }), now)).toEqual({ kind: "inactive", why: "paused" });
  expect(missionAuthority("m", status({ expiresAt: now - 1 }), now)).toEqual({ kind: "inactive", why: "expired" });
  expect(missionAuthority("m", status({ outcome: "completed" }), now)).toEqual({ kind: "inactive", why: "ended" });
  expect(missionAuthority("m", status({ emergency: true }), now)).toEqual({ kind: "emergency" });
});
