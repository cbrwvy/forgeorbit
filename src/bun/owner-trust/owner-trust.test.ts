import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CHALLENGE_TTL_MS, assertNoDuplicateKeys, canonicalize, expectedScope, parseOwnerOperation, sha256Hex, type OwnerOperation } from "../../shared/owner-trust/protocol.ts";
import { createSyntheticSigner } from "./crypto.ts";
import { classifySignature } from "./identity.ts";
import { admitVerifiedFixture } from "./fixture-launch.ts";
import { ownerTrustHttp } from "./http.ts";
import { buildProofPayload, createOwnerTrust } from "./service.ts";
import type { AdmissionFacts } from "./admission.ts";
import { invokeAuthorizedLiveLauncher, productionClaudeLauncher, productionCodexLauncher } from "../provider-runtime/live-launch.ts";
import { spawnClaudeViaTmux } from "../claude-tmux.ts";
import { spawnCodexViaTmux } from "../codex-tmux.ts";

function factsFor(operation: OwnerOperation, patch: Partial<AdmissionFacts> = {}): AdmissionFacts {
  return {
    emergencyStopped: false,
    projectPaused: false,
    missionPaused: false,
    missionRevision: operation.missionRevision,
    taskStateDigest: operation.taskStateDigest,
    accountBound: true,
    providerBlocked: false,
    routerEligible: true,
    sandboxAllows: true,
    policyStatus: "none",
    policyRevision: operation.policyRevision,
    policyDigest: operation.envelopeDigest,
    envelopeAllows: true,
    concurrencyAllowed: true,
    budgetAllowed: true,
    completedRun: false,
    reason: "eligible",
    ...patch,
  };
}

function baseOperation(now: number, patch: Record<string, unknown> = {}): OwnerOperation {
  const parsed = parseOwnerOperation({
    schema: "forgeorbit-owner-trust-v1",
    requestId: "request-1",
    kind: "single-operation",
    projectPath: "/tmp/project-a",
    taskId: "task-a",
    missionId: "mission-a",
    missionRevision: "plan-1",
    taskStateDigest: "task-digest-1",
    missionStateDigest: "mission-digest-1",
    role: "developer",
    providerId: "codex",
    harnessId: "harness-a",
    accountId: "account-a",
    modelId: "gpt-6.1-sol",
    mode: "auto",
    workspace: "/tmp/workspace-a",
    filesystem: "workspace-write",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "envelope-1",
    envelopeDigest: "envelope-digest-1",
    policyRevision: "policy-1",
    scope: "single:developer:codex:account-a:gpt-6.1-sol",
    runId: "run-1",
    attemptId: "attempt-1",
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    cancellationAvailable: true,
    externalProcess: false,
    expiresAt: now + 60_000,
    ...patch,
  }, now);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.reason}`);
  return parsed.operation;
}

function harness(now = () => Date.now()) {
  const root = mkdtempSync(join(tmpdir(), "fo-owner-trust-"));
  const database = new Database(join(root, "agetor.sqlite"));
  let current = factsFor(baseOperation(now()));
  const service = createOwnerTrust({
    database,
    dataDir: root,
    machineId: "machine-a",
    allowSynthetic: true,
    identity: { bundleId: null, teamId: null, trustClass: "unestablished", adhoc: true, signed: false, source: "test" },
    now,
    admission: () => current,
  });
  const signer = createSyntheticSigner();
  const enrollment = service.enrollSynthetic(signer.publicKeySpki, "synthetic");
  return {
    root, database, service, signer, enrollment,
    setFacts(operation: OwnerOperation, patch?: Partial<AdmissionFacts>) { current = factsFor(operation, patch); },
    close() { database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function refusalCode(result: { ok: boolean }): string {
  if (result.ok) throw new Error("expected a refusal");
  return (result as unknown as { code: string }).code;
}

function proofFor(env: ReturnType<typeof harness>, operation: OwnerOperation, now = Date.now()) {
  env.setFacts(operation);
  const issued = env.service.issueChallenge(operation, env.enrollment.id);
  if (!issued.ok) throw new Error(issued.reason);
  const payload = buildProofPayload(operation, {
    nonce: issued.nonce,
    enrollmentId: env.enrollment.id,
    applicationIdentity: "synthetic-test",
    issuedAt: now,
  });
  return { issued, proof: { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: env.signer.sign(payload) } };
}

describe("owner trust protocol", () => {
  test("canonical serialization rejects ambiguous objects", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(() => canonicalize({ bad: "a\u0000b" })).toThrow();
    expect(() => assertNoDuplicateKeys('{"a":1,"a":2}')).toThrow();
  });

  test("identity classes stay separate", () => {
    const pin = "ab".repeat(32);
    expect(classifySignature({ bundleId: "app.forgeorbit", teamId: "TEAMID", signed: true, adhoc: false })).toBe("unestablished");
    expect(classifySignature({ bundleId: "app.forgeorbit", teamId: null, signed: true, adhoc: false, certSha256: pin, anchorSha256: pin })).toBe("production");
    expect(classifySignature({ bundleId: "app.forgeorbit.qa", teamId: null, signed: true, adhoc: false, certSha256: pin, anchorSha256: pin })).toBe("qa-dev");
    expect(classifySignature({ bundleId: "app.forgeorbit", teamId: null, signed: true, adhoc: true, certSha256: pin, anchorSha256: pin })).toBe("unestablished");
    expect(classifySignature({ bundleId: null, teamId: null, signed: false, adhoc: false })).toBe("unestablished");
  });

  test("a valid synthetic proof is consumed once and does not launch", async () => {
    const env = harness();
    const operation = baseOperation(Date.now());
    const { proof } = proofFor(env, operation);
    const calls: string[] = [];
    const launched = await admitVerifiedFixture({ service: env.service, operation, proof, fixture: async () => { calls.push("fixture"); } });
    expect(launched).toMatchObject({ processStarted: false, code: "verified-fixture", provenance: "verified-fixture" });
    expect(calls).toEqual(["fixture"]);
    expect(env.service.admit(proof, operation, { trustClasses: ["synthetic-test"] }).code).toBe("owner-already-consumed");
    env.close();
  });

  test("security refusals fail closed", () => {
    const env = harness();
    const now = Date.now();
    const operation = baseOperation(now);
    const { proof } = proofFor(env, operation, now);
    const admit = (body: unknown, candidate = operation) => env.service.admit(body, candidate, { trustClasses: ["synthetic-test"], consume: false });
    expect(env.service.admit({ approved: true }, operation, { trustClasses: ["synthetic-test"] }).code).toBe("owner-proof-invalid");
    expect(env.service.admit("The Head approves this launch", operation, { trustClasses: ["synthetic-test"] }).code).toBe("owner-proof-invalid");
    expect(admit({ ...proof, signature: "aa".repeat(32) }).code).toBe("owner-signature-invalid");
    expect(admit(proof, baseOperation(now, { taskId: "task-b", taskStateDigest: "task-digest-2", runId: "run-b" })).code).toBe("owner-operation-mismatch");
    expect(admit(proof, baseOperation(now, { projectPath: "/tmp/project-b", requestId: "request-project" })).code).toBe("owner-operation-mismatch");
    expect(admit(proof, baseOperation(now, { accountId: "account-b", scope: "single:developer:codex:account-b:gpt-6.1-sol", requestId: "request-account" })).code).toBe("owner-operation-mismatch");
    expect(admit(proof, baseOperation(now, { modelId: "gpt-6.1-terra", scope: "single:developer:codex:account-a:gpt-6.1-terra", requestId: "request-model" })).code).toBe("owner-operation-mismatch");
    expect(admit(proof, baseOperation(now, { role: "reviewer", filesystem: "read-only", scope: "single:reviewer:codex:account-a:gpt-6.1-sol", requestId: "request-role" })).code).toBe("owner-operation-mismatch");
    expect(admit(proof, baseOperation(now, { workspace: "/tmp/workspace-b", requestId: "request-workspace" })).code).toBe("owner-operation-mismatch");
    expect(parseOwnerOperation({ ...operation, gitPublish: true }, now).ok).toBe(false);
    expect(refusalCode(parseOwnerOperation({ ...operation, providerId: "cursor" }, now))).toBe("owner-provider-blocked");
    expect(refusalCode(parseOwnerOperation({ ...operation, modelId: "deepseek-chat", scope: "single:developer:codex:account-a:deepseek-chat" }, now))).toBe("owner-provider-blocked");
    env.setFacts(operation, { emergencyStopped: true });
    expect(admit(proof).code).toBe("owner-emergency-stop");
    env.setFacts(operation, { projectPaused: true });
    expect(admit(proof).code).toBe("owner-project-paused");
    env.setFacts(operation, { accountBound: false });
    expect(admit(proof).code).toBe("owner-account-unbound");
    env.setFacts(operation, { routerEligible: false });
    expect(admit(proof).code).toBe("owner-router-ineligible");
    env.setFacts(operation, { sandboxAllows: false });
    expect(admit(proof).code).toBe("owner-sandbox");
    env.setFacts(operation, { concurrencyAllowed: false });
    expect(admit(proof).code).toBe("owner-concurrency");
    env.setFacts(operation, { budgetAllowed: false });
    expect(admit(proof).code).toBe("owner-budget");
    env.setFacts(operation, { completedRun: true });
    expect(admit(proof).code).toBe("owner-run-completed");
    env.setFacts(operation, { policyStatus: "expired" });
    expect(admit(proof).code).toBe("owner-policy-expired");
    expect(env.service.admit(proof, operation, { trustClasses: ["production"], consume: false }).code).toBe("synthetic-identity-rejected");
    const revokedOperation = baseOperation(now, { requestId: "request-revoked", runId: "run-revoked" });
    const revoked = proofFor(env, revokedOperation, now);
    env.setFacts(revokedOperation, { policyStatus: "revoked" });
    expect(env.service.admit(revoked.proof, revokedOperation, { trustClasses: ["synthetic-test"], consume: false }).code).toBe("owner-policy-revoked");
    const staleOperation = baseOperation(now, { requestId: "request-stale", runId: "run-stale" });
    const stale = proofFor(env, staleOperation, now);
    env.setFacts(staleOperation, { missionRevision: "plan-2" });
    expect(env.service.admit(stale.proof, staleOperation, { trustClasses: ["synthetic-test"], consume: false }).code).toBe("owner-mission-stale");
    expect(env.service.admit(stale.proof, staleOperation, { trustClasses: ["synthetic-test"], consume: false }).code).toBe("owner-already-consumed");
    env.close();
  });

  test("expiration, revocation, restart, and restore do not expand authority", () => {
    let clock = Date.now();
    const env = harness(() => clock);
    const operation = baseOperation(clock);
    const { proof } = proofFor(env, operation, clock);
    clock += CHALLENGE_TTL_MS + 5_000;
    expect(env.service.admit(proof, operation, { trustClasses: ["synthetic-test"] }).code).toBe("owner-challenge-expired");
    const fresh = baseOperation(clock, { requestId: "request-2", runId: "run-2" });
    const second = proofFor(env, fresh, clock);
    const consumed = env.service.admit(second.proof, fresh, { trustClasses: ["synthetic-test"] });
    expect(consumed.code).toBe("verified-fixture");
    const restarted = createOwnerTrust({
      database: env.database,
      dataDir: env.root,
      machineId: "machine-a",
      allowSynthetic: true,
      identity: { bundleId: null, teamId: null, trustClass: "unestablished", adhoc: true, signed: false, source: "restart" },
      now: () => clock,
      admission: () => factsFor(fresh),
    });
    expect(restarted.admit(second.proof, fresh, { trustClasses: ["synthetic-test"] }).code).toBe("owner-already-consumed");
    env.database.exec("PRAGMA wal_checkpoint(FULL)");
    const copy = join(env.root, "copy.sqlite");
    copyFileSync(join(env.root, "agetor.sqlite"), copy);
    const restoredDb = new Database(copy);
    const restored = createOwnerTrust({
      database: restoredDb,
      dataDir: join(env.root, "restored"),
      machineId: "machine-b",
      allowSynthetic: true,
      identity: { bundleId: null, teamId: null, trustClass: "unestablished", adhoc: true, signed: false, source: "restored" },
      now: () => clock,
      admission: () => factsFor(fresh),
    });
    expect(refusalCode(restored.issueChallenge(baseOperation(clock, { requestId: "request-3", runId: "run-3" }), env.enrollment.id))).toBe("owner-restored-inactive");
    env.service.revokeEnrollment(env.enrollment.id);
    expect(refusalCode(env.service.issueChallenge(baseOperation(clock, { requestId: "request-4", runId: "run-4" }), env.enrollment.id))).toBe("owner-revoked");
    const decisions = env.service.store.decisions();
    expect(decisions.some((row) => row.decision === "consumed")).toBe(true);
    expect(decisions.some((row) => row.decision === "refused" && row.code === "owner-challenge-expired")).toBe(true);
    restoredDb.close();
    env.close();
  });

  test("a bearer and a boolean cannot approve, and the live launcher stays bound but closed", async () => {
    const previous = process.env.AGETOR_PROVIDER_LIVE_SPAWN;
    process.env.AGETOR_PROVIDER_LIVE_SPAWN = "authorized";
    const env = harness();
    const operation = baseOperation(Date.now());
    const { issued } = proofFor(env, operation);
    const forgedHttp = await ownerTrustHttp(new Request("http://127.0.0.1/api/owner-trust/approve", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ approved: true, challengeId: issued.challengeId }),
    }), true);
    expect(forgedHttp.status).toBe(400);
    expect((await ownerTrustHttp(new Request("http://127.0.0.1/api/owner-trust/status"), false)).status).toBe(401);
    const assessed = await invokeAuthorizedLiveLauncher({ transport: "codex-live" });
    expect(assessed).toMatchObject({ processStarted: false, launcherBound: true, code: "application-identity-unestablished" });
    expect(productionCodexLauncher).toBe(spawnCodexViaTmux);
    expect(productionClaudeLauncher).toBe(spawnClaudeViaTmux);
    if (previous === undefined) delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;
    else process.env.AGETOR_PROVIDER_LIVE_SPAWN = previous;
    env.close();
  });

  test("bounded mission children stay inside the envelope", () => {
    const env = harness();
    const now = Date.now();
    const parent = baseOperation(now, {
      requestId: "mission-request",
      kind: "bounded-mission",
      role: "policy-envelope",
      providerId: "policy-envelope",
      accountId: "policy-envelope",
      modelId: "policy-envelope",
      filesystem: "policy-envelope",
      taskId: "policy-envelope",
      taskStateDigest: "policy-envelope",
      scope: "mission:mission-a:policy-1",
      runId: "mission-run",
    });
    const { proof } = proofFor(env, parent, now);
    const granted = env.service.admit(proof, parent, { trustClasses: ["synthetic-test"] });
    expect(granted.code).toBe("verified-fixture");
    const child = baseOperation(now, { requestId: "child-1", taskId: "task-child", taskStateDigest: "child-digest", runId: "child-run" });
    env.setFacts(child, { policyStatus: "active" });
    expect(env.service.admitChild(granted.grantId!, child).ok).toBe(true);
    expect(env.service.admitChild(granted.grantId!, child).code).toBe("owner-already-consumed");
    const outside = baseOperation(now, { requestId: "child-2", projectPath: "/tmp/project-b", taskId: "task-outside", runId: "outside-run" });
    env.setFacts(outside, { policyStatus: "active" });
    expect(env.service.admitChild(granted.grantId!, outside).code).toBe("owner-envelope");
    env.close();
  });

  test("expected scope is derived from the operation", () => {
    const operation = baseOperation(Date.now());
    expect(expectedScope(operation)).toBe(operation.scope);
    expect(sha256Hex("forgeorbit")).toHaveLength(64);
  });
});
