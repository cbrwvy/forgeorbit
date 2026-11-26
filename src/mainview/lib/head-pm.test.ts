import { expect, test } from "bun:test";
import { agentReadiness, canSend, contextKey, deriveOrbStatus, lastOwnerFailed, resolveContext } from "./head-pm";

test("the context follows the selected project and falls back to the portfolio", () => {
  expect(resolveContext("auto", { scope: "project", path: "/a", page: "board" })).toEqual({ kind: "project", path: "/a" });
  expect(resolveContext("auto", { scope: "all", page: "overview" })).toEqual({ kind: "all" });
  expect(resolveContext("auto", { scope: "cluster", id: "c", page: "clusters" })).toEqual({ kind: "all" });
  expect(resolveContext("all", { scope: "project", path: "/a", page: "board" })).toEqual({ kind: "all" });
});

test("conversations of different projects and the portfolio never share a key", () => {
  const keys = new Set([contextKey({ kind: "all" }), contextKey({ kind: "project", path: "/a" }), contextKey({ kind: "project", path: "/b" })]);
  expect(keys.size).toBe(3);
});

test("orb status comes from real signals in a fixed order", () => {
  const base = { thinking: false, failed: false, pending: 0, working: false };
  expect(deriveOrbStatus(base)).toBe("idle");
  expect(deriveOrbStatus({ ...base, working: true })).toBe("working");
  expect(deriveOrbStatus({ ...base, working: true, pending: 2 })).toBe("needs-owner");
  expect(deriveOrbStatus({ ...base, pending: 2, failed: true })).toBe("error");
  expect(deriveOrbStatus({ ...base, failed: true, thinking: true })).toBe("thinking");
});

test("only an unanswered last owner message is an error, not an owner cancel", () => {
  expect(lastOwnerFailed([])).toBe(false);
  expect(lastOwnerFailed([{ role: "owner", status: "failed" }, { role: "system", status: null }])).toBe(true);
  expect(lastOwnerFailed([{ role: "owner", status: "failed" }, { role: "owner", status: "answered" }])).toBe(false);
  expect(lastOwnerFailed([{ role: "owner", status: "cancelled" }])).toBe(false);
});

test("sending needs a set-up, confirmed agent and a non-empty idle composer", () => {
  const ready = agentReadiness({ profileId: null, harness: "codex", consentKey: "k" });
  expect(canSend({ text: "hi", busy: false, readiness: ready, loaded: true })).toBe(true);
  expect(canSend({ text: "  ", busy: false, readiness: ready, loaded: true })).toBe(false);
  expect(canSend({ text: "hi", busy: true, readiness: ready, loaded: true })).toBe(false);
  expect(canSend({ text: "hi", busy: false, readiness: ready, loaded: false })).toBe(false);
  expect(agentReadiness({ profileId: null, harness: null, consentKey: null })).toEqual({ configured: false, needsConsent: false });
  expect(agentReadiness({ profileId: "p", harness: null, consentKey: null })).toEqual({ configured: true, needsConsent: true });
});
