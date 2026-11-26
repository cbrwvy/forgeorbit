import { expect, test } from "bun:test";
import { evaluateAccountEligibility, type AccountResourceEvidence } from "./account-eligibility.ts";
const evidence: AccountResourceEvidence = { account: { id: "a", label: "Configured A", provider: "openai" }, fingerprint: "digest-a", configuration: "valid", authentication: "authenticated", model: "supported", capabilities: ["file-modification"], access: "workspace-write" };
const base = { evidence, role: "developer" as const, kind: "codex", enabled: true, installed: true, modeSupported: true, policyBlocked: false, permissionBlocked: false };
test("eligible exact profile is advisory, independent of quota or cost", () => {
  expect(evaluateAccountEligibility(base)).toMatchObject({ state: "eligible", authorization: "owner-approval-required", evidence: { account: { id: "a" } } });
  expect(evaluateAccountEligibility(base)).toEqual(evaluateAccountEligibility(base));
});
test("missing harness, mode, authentication, registration and model fail closed", () => {
  for (const patch of [{ installed: false }, { enabled: false }, { modeSupported: false }, { policyBlocked: true }, { permissionBlocked: true }]) expect(evaluateAccountEligibility({ ...base, ...patch }).state).toBe("ineligible");
  for (const patch of [{ authentication: "required" }, { configuration: "invalid" }, { model: "unsupported" }] as const) expect(evaluateAccountEligibility({ ...base, evidence: { ...evidence, ...patch } }).state).toBe("ineligible");
});
test("Unknown is neither capacity nor authorization; profile B cannot borrow A status", () => {
  const b = { ...evidence, account: { ...evidence.account!, id: "b" }, fingerprint: "digest-b", authentication: "unknown" as const };
  expect(evaluateAccountEligibility({ ...base, evidence: b })).toMatchObject({ state: "unknown", reasons: [{ code: "authentication-unknown" }] });
  for (const patch of [{ configuration: "unknown" }, { model: "unknown" }, { fingerprint: null }, { account: null }] as const) expect(evaluateAccountEligibility({ ...base, evidence: { ...evidence, ...patch } }).state).toBe("unknown");
});
test("Reviewer requires enforced read-only; Developer requires file modification", () => {
  expect(evaluateAccountEligibility({ ...base, role: "reviewer" }).state).toBe("ineligible");
  const read = { ...evidence, access: "read-only" as const, capabilities: ["read-only"] };
  expect(evaluateAccountEligibility({ ...base, role: "reviewer", evidence: read }).state).toBe("eligible");
  expect(evaluateAccountEligibility({ ...base, evidence: read }).state).toBe("ineligible");
});
test("manager/head use only existing execution adapters; diagnostics never enable DSH", () => {
  for (const role of ["project-manager", "head"] as const) expect(evaluateAccountEligibility({ ...base, role, evidence: {...evidence,access:"read-only"} }).state).toBe("eligible");
  for (const role of ["developer", "reviewer", "project-manager", "head"] as const) expect(evaluateAccountEligibility({ ...base, kind: "deepseek-dsh", role }).state).toBe("ineligible");
});
