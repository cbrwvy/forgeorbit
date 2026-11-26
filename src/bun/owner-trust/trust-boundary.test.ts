import { generateKeyPairSync, sign as signDer } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { classifyOwnerTrustState } from "../../shared/owner-trust/diagnostics.ts";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID, parseOwnerOperation, proofMessage, type OwnerOperation } from "../../shared/owner-trust/protocol.ts";
import { HISTORICAL_STABLE_BUNDLE_ID, PRODUCTION_HELPER_ID, QA_HELPER_ID, productionSignatureAllowed } from "../../shared/owner-trust/signing-policy.ts";
import type { AdmissionFacts } from "./admission.ts";
import { createSyntheticSigner, ecdsaSignatureToP1363, verifyP256 } from "./crypto.ts";
import { assessHelperCandidate, developmentHelperPath } from "./helper-integrity.ts";
import { identityFromCodesign } from "./identity.ts";
import { ownerTrustHttp } from "./http.ts";
import { readAuthoritativeOperation } from "./preview.ts";
import { buildProofPayload, createOwnerTrust } from "./service.ts";
import { observeAuthorizedTransportForTest } from "../provider-runtime/live-launch.ts";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";

const LOCAL_PIN = "ab".repeat(32);
const productionIdentity = {
  bundleId: PRODUCTION_BUNDLE_ID,
  teamId: null,
  trustClass: "production" as const,
  adhoc: false,
  signed: true,
  source: "/tmp/ForgeOrbit.app",
  certSha256: LOCAL_PIN,
  anchorSha256: LOCAL_PIN,
};

function facts(operation: OwnerOperation, patch: Partial<AdmissionFacts> = {}): AdmissionFacts {
  return {
    emergencyStopped: false, projectPaused: false, missionPaused: false, missionRevision: operation.missionRevision,
    taskStateDigest: operation.taskStateDigest, accountBound: true, providerBlocked: false, routerEligible: true,
    sandboxAllows: true, policyStatus: "none", policyRevision: operation.policyRevision, policyDigest: operation.envelopeDigest,
    envelopeAllows: true, concurrencyAllowed: true, budgetAllowed: true, completedRun: false, reason: "eligible", ...patch,
  };
}

function operation(now: number, patch: Record<string, unknown> = {}): OwnerOperation {
  const parsed = parseOwnerOperation({
    schema: "forgeorbit-owner-trust-v1", requestId: "request-1", kind: "single-operation",
    projectPath: "/tmp/project-a", taskId: "task-a", missionId: "mission-a", missionRevision: "plan-1",
    taskStateDigest: "task-digest-1", missionStateDigest: "mission-digest-1", role: "developer", providerId: "codex",
    harnessId: "harness-a", accountId: "account-a", modelId: "gpt-6.1-sol", mode: "auto", workspace: "/tmp/workspace-a",
    filesystem: "workspace-write", terminalAllowed: false, browserAllowed: false, computerUseAllowed: false,
    gitRead: true, gitPublish: false, deploymentAllowed: false, envelopeId: "envelope-1", envelopeDigest: "envelope-digest-1",
    policyRevision: "policy-1", scope: "single:developer:codex:account-a:gpt-6.1-sol", runId: "run-1", attemptId: "attempt-1",
    knownCost: "unknown", costCoverage: "unknown-subscription", cancellationAvailable: true, externalProcess: false,
    expiresAt: now + 60_000, ...patch,
  }, now);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.operation;
}

describe("owner trust boundary", () => {
  test("production signing rejects ad-hoc, QA, historical, unsigned, and mismatched helper identities", () => {
    const refusedSignature = (claim: Parameters<typeof productionSignatureAllowed>[0], code: string) => {
      const decision = productionSignatureAllowed(claim);
      if (decision.ok) throw new Error(`expected ${code}`);
      expect(decision.code).toBe(code);
    };
    const pin = LOCAL_PIN;
    refusedSignature({
      bundleId: PRODUCTION_BUNDLE_ID, teamId: null, signed: true, adhoc: true,
      certSha256: pin, anchorSha256: pin,
      helperId: PRODUCTION_HELPER_ID, helperTeamId: null, helperAdhoc: true, helperSigned: true, helperInsideBundle: true,
      helperCertSha256: pin,
    }, "application-identity-unestablished");
    refusedSignature({
      bundleId: PRODUCTION_BUNDLE_ID, teamId: "TEAM", signed: true, adhoc: false,
      helperId: PRODUCTION_HELPER_ID, helperTeamId: "TEAM", helperAdhoc: false, helperSigned: true, helperInsideBundle: true,
      helperCertSha256: pin,
    }, "application-identity-unestablished");
    refusedSignature({
      bundleId: QA_BUNDLE_ID, teamId: null, signed: true, adhoc: false,
      certSha256: pin, anchorSha256: pin,
      helperId: QA_HELPER_ID, helperTeamId: null, helperAdhoc: false, helperSigned: true, helperInsideBundle: true,
      helperCertSha256: pin,
    }, "qa-identity-rejected");
    refusedSignature({
      bundleId: HISTORICAL_STABLE_BUNDLE_ID, teamId: null, signed: true, adhoc: false,
      certSha256: pin, anchorSha256: pin,
      helperId: PRODUCTION_HELPER_ID, helperTeamId: null, helperAdhoc: false, helperSigned: true, helperInsideBundle: true,
      helperCertSha256: pin,
    }, "historical-bundle-rejected");
    refusedSignature({
      bundleId: PRODUCTION_BUNDLE_ID, teamId: null, signed: true, adhoc: false,
      certSha256: pin, anchorSha256: pin,
      helperId: PRODUCTION_HELPER_ID, helperTeamId: null, helperAdhoc: false, helperSigned: false, helperInsideBundle: true,
      helperCertSha256: pin,
    }, "helper-identity-mismatch");
    refusedSignature({
      bundleId: PRODUCTION_BUNDLE_ID, teamId: null, signed: true, adhoc: false,
      certSha256: pin, anchorSha256: pin,
      helperId: PRODUCTION_HELPER_ID, helperTeamId: null, helperAdhoc: false, helperSigned: true, helperInsideBundle: true,
      helperCertSha256: "cd".repeat(32),
    }, "helper-identity-mismatch");
    expect(productionSignatureAllowed({
      bundleId: PRODUCTION_BUNDLE_ID, teamId: null, signed: true, adhoc: false,
      certSha256: pin, anchorSha256: pin,
      helperId: PRODUCTION_HELPER_ID, helperTeamId: null, helperAdhoc: false, helperSigned: true, helperInsideBundle: true,
      helperCertSha256: pin,
    }).ok).toBe(true);
    const helper = developmentHelperPath();
    expect(assessHelperCandidate({
      purpose: "approve", bundleId: PRODUCTION_BUNDLE_ID, bundleRoot: "/Apps/ForgeOrbit.app",
      appTeamId: "TEAM", appAdhoc: false, appSigned: true, candidate: helper, envOverride: null, codesignText: "Identifier=app.forgeorbit.owner-trust\nSignature=adhoc\nTeamIdentifier=not set\n",
    }).code).toBe("helper-path-rejected");
    expect(assessHelperCandidate({
      purpose: "approve", bundleId: null, bundleRoot: null, appTeamId: null, appAdhoc: false, appSigned: false,
      candidate: null, envOverride: "/tmp/helper", codesignText: "",
    }).code).toBe("helper-path-override-rejected");
    expect(assessHelperCandidate({
      purpose: "approve", bundleId: PRODUCTION_BUNDLE_ID, bundleRoot: "/Apps/ForgeOrbit.app",
      appTeamId: "TEAM", appAdhoc: false, appSigned: true, candidate: helper,
      envOverride: null, codesignText: "",
    }).code).toBe("helper-unsigned");
  });

  test("a page, a bearer token, and Head text cannot approve or enroll", async () => {
    const forged = await ownerTrustHttp(new Request("http://127.0.0.1/api/owner-trust/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true, operation: { taskId: "forged" }, publicKeySpki: "abc" }),
    }), true);
    expect(forged.status).toBe(400);
    const page = await ownerTrustHttp(new Request("http://127.0.0.1/api/owner-trust/review", {
      method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ locale: "en", headText: "I approve this" }),
    }), true);
    expect(page.status).toBe(200);
    const body = await page.json() as { code: string; reason: string; executionReady: boolean };
    expect(body.executionReady).toBe(false);
    expect(body.reason).toContain("embedded page cannot approve");
    const enroll = await ownerTrustHttp(new Request("http://127.0.0.1/api/owner-trust/enroll", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeySpki: "abc" }),
    }), true);
    expect(enroll.status).toBe(403);
    expect((await enroll.json()).code).toBe("owner-enrollment-refused");
  });

  test("cancellation, revocation, restore, and a second use create no reusable grant", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-trust02-"));
    const database = new Database(join(root, "trust.sqlite"));
    const now = Date.now();
    let current = facts(operation(now));
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, now: () => now,
      identity: { bundleId: null, teamId: null, signed: false, adhoc: true, trustClass: "unestablished", source: "test" },
      admission: () => current,
    });
    const cancelled = trust.recordCancellation("authentication-cancelled", "cancelled", "digest");
    expect(cancelled.grantId).toBeNull();
    expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_grants").get()?.count).toBe(0);
    const signer = createSyntheticSigner();
    const enrollment = trust.enrollSynthetic(signer.publicKeySpki);
    const op = operation(now);
    current = facts(op);
    const issued = trust.issueChallenge(op, enrollment.id);
    if (!issued.ok) throw new Error(issued.reason);
    const payload = buildProofPayload(op, { nonce: issued.nonce, enrollmentId: enrollment.id, applicationIdentity: "synthetic-test", issuedAt: now });
    const proof = { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: signer.sign(payload) };
    expect(trust.admit(proof, op, { trustClasses: ["synthetic-test"] }).ok).toBe(true);
    expect(trust.admit(proof, op, { trustClasses: ["synthetic-test"] }).code).toBe("owner-already-consumed");
    expect(trust.admit(proof, operation(now, { accountId: "other", scope: "single:developer:codex:other:gpt-6.1-sol" }), { trustClasses: ["synthetic-test"] }).code).toMatch(/owner-/);
    trust.revokeEnrollment(enrollment.id);
    expect(trust.issueChallenge(operation(now, { requestId: "request-2", runId: "run-2" }), enrollment.id).ok).toBe(false);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a valid fixture proof still loses to emergency stop, pause, policy, sandbox, and spending", async () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-trust02-live-"));
    const database = new Database(join(root, "trust.sqlite"));
    const now = Date.now();
    const op = operation(now);
    let current = facts(op);
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true, now: () => now,
      identity: productionIdentity,
      admission: () => current,
    });
    const signer = createSyntheticSigner();
    trust.enrollTransportFixture(signer.publicKeySpki);
    const issued = trust.issueChallenge(op, trust.store.activeByClass("production")[0]!.id);
    if (!issued.ok) throw new Error(issued.reason);
    const payload = buildProofPayload(op, { nonce: issued.nonce, enrollmentId: trust.store.activeByClass("production")[0]!.id, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: now });
    const proof = { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: signer.sign(payload) };
    const seen: string[] = [];
    current = facts(op, { emergencyStopped: true });
    const stopped = await observeAuthorizedTransportForTest({
      trust, proof, operation: op, transport: "codex-live", spy: () => seen.push("spy"),
    });
    expect(stopped.spyCalled).toBe(false);
    expect(stopped.code).toBe("owner-emergency-stop");
    expect(stopped.processStarted).toBe(false);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the transport spy sees the exact operation and does not start a process", async () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-trust02-spy-"));
    const database = new Database(join(root, "trust.sqlite"));
    const now = Date.now();
    const op = operation(now);
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true, now: () => now,
      identity: productionIdentity, admission: () => facts(op),
    });
    const signer = createSyntheticSigner();
    const enrollment = trust.enrollTransportFixture(signer.publicKeySpki);
    const issued = trust.issueChallenge(op, enrollment.id);
    if (!issued.ok) throw new Error(issued.reason);
    const payload = buildProofPayload(op, { nonce: issued.nonce, enrollmentId: enrollment.id, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: now });
    const proof = { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: signer.sign(payload) };
    let seen: { accountId: string; modelId: string; role: string; workspace: string; providerId: string } | null = null;
    const result = await observeAuthorizedTransportForTest({
      trust, proof, operation: op, transport: "claude-live", spy: (value) => { seen = value; },
    });
    expect(result).toMatchObject({ processStarted: false, launched: false, spyCalled: true, code: "transport-observed" });
    expect(seen).toMatchObject({ accountId: "account-a", modelId: "gpt-6.1-sol", role: "developer", workspace: "/tmp/workspace-a", providerId: "codex" });
    expect(trust.admit(proof, op, { trustClasses: ["production"] }).code).toBe("owner-already-consumed");
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("paused project, revoked policy, sandbox, and spending block a fixture proof", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-trust02-block-"));
    const database = new Database(join(root, "trust.sqlite"));
    const now = Date.now();
    const op = operation(now);
    let current = facts(op);
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true, now: () => now,
      identity: productionIdentity, admission: () => current,
    });
    const signer = createSyntheticSigner();
    const enrollment = trust.enrollTransportFixture(signer.publicKeySpki);
    for (const patch of [
      { projectPaused: true, code: "owner-project-paused" },
      { policyStatus: "revoked" as const, code: "owner-policy-revoked" },
      { sandboxAllows: false, code: "owner-sandbox" },
      { budgetAllowed: false, code: "owner-budget" },
      { routerEligible: false, code: "owner-router-ineligible" },
    ]) {
      current = facts(op, patch);
      const issued = trust.issueChallenge(operation(now, { requestId: patch.code, runId: patch.code }), enrollment.id);
      if (!issued.ok) throw new Error(issued.reason);
      const next = operation(now, { requestId: patch.code, runId: patch.code });
      current = facts(next, patch);
      const payload = buildProofPayload(next, { nonce: issued.nonce, enrollmentId: enrollment.id, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: now });
      expect(trust.admit({ schema: "forgeorbit-owner-trust-v1", payload, signature: signer.sign(payload) }, next, { trustClasses: ["production"], consume: false }).code).toBe(patch.code);
    }
    expect(parseOwnerOperation({ ...op, providerId: "cursor" }, now).ok).toBe(false);
    expect(parseOwnerOperation({ ...op, modelId: "deepseek-chat" }, now).ok).toBe(false);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("helper enrollment rejects QA, ad-hoc, restored, and revoked keys", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-trust02-enroll-"));
    const database = new Database(join(root, "trust.sqlite"));
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: false,
      identity: { bundleId: QA_BUNDLE_ID, teamId: null, signed: true, adhoc: true, trustClass: "qa-dev", source: "/tmp/ForgeOrbitQA-dev.app" },
    });
    const attestation = {
      publicKeySpki: "abc", applicationIdentity: PRODUCTION_BUNDLE_ID, helperIdentifier: PRODUCTION_HELPER_ID,
      helperTeamId: null, helperCertSha256: LOCAL_PIN, helperAdhoc: false, helperPath: "/tmp/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust",
      bundleRoot: "/tmp/ForgeOrbit.app", protection: "secure-enclave-user-presence" as const,
    };
    expect(trust.enrollFromHelper(attestation).code).toBe("application-identity-unestablished");
    expect(() => trust.enrollTransportFixture("abc")).toThrow(/production trust configuration/);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a restored profile and a rotated key do not become active production authority", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-trust02-restore-"));
    const database = new Database(join(root, "trust.sqlite"));
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true,
      identity: productionIdentity,
    });
    const first = createSyntheticSigner();
    const enrolled = trust.enrollTransportFixture(first.publicKeySpki);
    const second = createSyntheticSigner();
    const rotated = trust.enrollFromHelper({
      publicKeySpki: second.publicKeySpki, applicationIdentity: PRODUCTION_BUNDLE_ID, helperIdentifier: PRODUCTION_HELPER_ID,
      helperTeamId: null, helperCertSha256: LOCAL_PIN, helperAdhoc: false,
      helperPath: "/tmp/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust",
      bundleRoot: "/tmp/ForgeOrbit.app", protection: "secure-enclave-user-presence",
    });
    expect(rotated.ok).toBe(true);
    expect(trust.store.enrollment(enrolled.id)?.authority_state).toBe("rotated");
    database.run("UPDATE owner_trust_profile SET sealed = 1");
    database.run("UPDATE owner_trust_enrollments SET authority_state = 'restored-inactive' WHERE authority_state = 'active'");
    expect(trust.enrollFromHelper({
      publicKeySpki: createSyntheticSigner().publicKeySpki, applicationIdentity: PRODUCTION_BUNDLE_ID, helperIdentifier: PRODUCTION_HELPER_ID,
      helperTeamId: null, helperCertSha256: LOCAL_PIN, helperAdhoc: false,
      helperPath: "/tmp/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust",
      bundleRoot: "/tmp/ForgeOrbit.app", protection: "secure-enclave-user-presence",
    }).code).toBe("owner-restored-inactive");
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a different signing certificate cannot rotate or replace an enrolled Owner key", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-local-pin-"));
    const database = new Database(join(root, "trust.sqlite"));
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true,
      identity: productionIdentity,
    });
    const enrolled = trust.enrollTransportFixture(createSyntheticSigner().publicKeySpki);
    const otherPin = "cd".repeat(32);
    const replaced = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: false,
      identity: { ...productionIdentity, certSha256: otherPin, anchorSha256: otherPin },
    });
    const decision = replaced.enrollFromHelper({
      publicKeySpki: createSyntheticSigner().publicKeySpki, applicationIdentity: PRODUCTION_BUNDLE_ID, helperIdentifier: PRODUCTION_HELPER_ID,
      helperTeamId: null, helperCertSha256: otherPin, helperAdhoc: false,
      helperPath: "/tmp/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust",
      bundleRoot: "/tmp/ForgeOrbit.app", protection: "secure-enclave-user-presence",
    });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("signing-identity-replaced");
    expect(trust.store.enrollment(enrolled.id)?.authority_state).toBe("active");
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("after an explicit Owner revocation a replaced certificate can enroll a fresh key", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-local-recover-"));
    const database = new Database(join(root, "trust.sqlite"));
    const trust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: false,
      identity: productionIdentity,
    });
    const helperPath = "/tmp/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust";
    const attest = (publicKeySpki: string, certSha256: string) => ({
      publicKeySpki, applicationIdentity: PRODUCTION_BUNDLE_ID, helperIdentifier: PRODUCTION_HELPER_ID,
      helperTeamId: null, helperCertSha256: certSha256, helperAdhoc: false,
      helperPath, bundleRoot: "/tmp/ForgeOrbit.app", protection: "secure-enclave-user-presence" as const,
    });
    const first = trust.enrollFromHelper(attest(createSyntheticSigner().publicKeySpki, LOCAL_PIN));
    expect(first.ok).toBe(true);
    const active = trust.store.activeByClass("production")[0]!;
    const otherPin = "cd".repeat(32);
    const replaced = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: false,
      identity: { ...productionIdentity, certSha256: otherPin, anchorSha256: otherPin },
    });
    // While the old enrollment is active, a different certificate is refused.
    expect(replaced.enrollFromHelper(attest(createSyntheticSigner().publicKeySpki, otherPin)).code).toBe("signing-identity-replaced");
    // The Owner explicitly revokes the enrollment. A fresh key may then enroll
    // under the deliberately replaced certificate.
    trust.revokeEnrollment(active.id);
    expect(trust.store.enrollment(active.id)?.authority_state).toBe("removed");
    expect(replaced.enrollFromHelper(attest(createSyntheticSigner().publicKeySpki, otherPin)).ok).toBe(true);
    // The revoked key itself stays revoked.
    const revokedAgain = replaced.enrollFromHelper(attest(active.public_key_spki, otherPin));
    expect(revokedAgain.code).toBe("owner-revoked");
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("diagnostics do not call a QA or ad-hoc build production ready", () => {
    expect(classifyOwnerTrustState({
      bundleId: QA_BUNDLE_ID, trustClass: "qa-dev", adhoc: true, signed: true, teamId: null,
      helperPresent: true, helperOk: true, helperCode: "helper-ok", secureEnclaveHardware: true,
      enrolled: false, enrollmentState: "none", userAuthenticationAvailable: true, pending: false, refused: false,
    })).toBe("development-or-qa");
    expect(classifyOwnerTrustState({
      bundleId: PRODUCTION_BUNDLE_ID, trustClass: "production", adhoc: false, signed: true, teamId: null,
      helperPresent: true, helperOk: true, helperCode: "helper-ok", secureEnclaveHardware: true,
      enrolled: false, enrollmentState: "none", userAuthenticationAvailable: true, pending: false, refused: false,
    })).toBe("owner-not-enrolled");
    expect(classifyOwnerTrustState({
      bundleId: PRODUCTION_BUNDLE_ID, trustClass: "unestablished", adhoc: false, signed: true, teamId: "TEAM",
      helperPresent: true, helperOk: true, helperCode: "helper-ok", secureEnclaveHardware: true,
      enrolled: false, enrollmentState: "none", userAuthenticationAvailable: true, pending: false, refused: false,
    })).toBe("trusted-signature-missing");
    expect(classifyOwnerTrustState({
      bundleId: PRODUCTION_BUNDLE_ID, trustClass: "unestablished", adhoc: true, signed: true, teamId: null,
      helperPresent: true, helperOk: true, helperCode: "helper-ok", secureEnclaveHardware: true,
      enrolled: false, enrollmentState: "none", userAuthenticationAvailable: true, pending: false, refused: false,
    })).toBe("unsigned-or-adhoc");
    const launcher = identityFromCodesign("Identifier=launcher\nSignature=adhoc\nTeamIdentifier=not set\n", QA_BUNDLE_ID, "/tmp/ForgeOrbitQA-dev.app");
    expect(launcher.bundleId).toBe(QA_BUNDLE_ID);
    expect(launcher.adhoc).toBe(true);
  });

  test("the authoritative preview comes from the task row, resolves bound profiles, and skips full-computer tasks", () => {
    const database = new Database(":memory:");
    database.exec(`CREATE TABLE tasks (id TEXT, title TEXT, prompt TEXT, workdir TEXT, agent TEXT, model TEXT, mode TEXT, "column" TEXT, worktree_path TEXT, access_mode TEXT, archived_at INTEGER, updated_at INTEGER)`);
    database.exec(`CREATE TABLE harnesses (id TEXT PRIMARY KEY, kind TEXT NOT NULL)`);
    database.exec(`CREATE TABLE account_harness_bindings (account_id TEXT NOT NULL, harness_id TEXT NOT NULL)`);
    database.run(`INSERT INTO harnesses (id, kind) VALUES ('codex', 'codex'), ('codex-profile-acc-1', 'codex')`);
    database.run(`INSERT INTO account_harness_bindings (account_id, harness_id) VALUES ('acc-1', 'codex-profile-acc-1')`);
    database.run(
      `INSERT INTO tasks (id, title, prompt, workdir, agent, model, mode, "column", worktree_path, access_mode, archived_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 1)`,
      ["task-1", "Owner task", "prompt", "/tmp/project", "codex", "gpt-6.1-sol", "auto", "ready", "workspace"],
    );
    const preview = readAuthoritativeOperation(database, 1_700_000_000_000);
    expect(preview?.operation.taskId).toBe("task-1");
    expect(preview?.operation.accountId).toBe("unbound");
    expect(preview?.operation.externalProcess).toBe(false);
    expect(preview?.display.employeeRole).toBe("developer");

    database.run(
      `INSERT INTO tasks (id, title, prompt, workdir, agent, model, mode, "column", worktree_path, access_mode, archived_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 2)`,
      ["task-2", "Bound profile task", "prompt", "/tmp/project", "codex-profile-acc-1", "gpt-6.1-sol", "auto", "ready", "workspace"],
    );
    const boundPreview = readAuthoritativeOperation(database, 1_700_000_000_000);
    expect(boundPreview?.operation.taskId).toBe("task-2");
    expect(boundPreview?.operation.providerId).toBe("codex");
    expect(boundPreview?.operation.accountId).toBe("acc-1");

    database.run(
      `INSERT INTO tasks (id, title, prompt, workdir, agent, model, mode, "column", worktree_path, access_mode, archived_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 3)`,
      ["task-3", "Full computer task", "prompt", "/tmp/project", "codex-profile-acc-1", "gpt-6.1-sol", "auto", "ready", "full-computer"],
    );
    const skippedFullComputer = readAuthoritativeOperation(database, 1_700_000_000_000);
    expect(skippedFullComputer?.operation.taskId).toBe("task-2");
    database.close();
  });

  test("Direction 21 accessMode and broken seals/unestablished callers cannot gain production grants", () => {
    const brokenSeal = identityFromCodesign(
      "Identifier=app.forgeorbit\nAuthority=ForgeOrbit Local Owner\nTeamIdentifier=not set\n",
      PRODUCTION_BUNDLE_ID,
      "/tmp/ForgeOrbit.app",
      { certSha256: LOCAL_PIN, anchorSha256: LOCAL_PIN, sealValid: false },
    );
    expect(brokenSeal.trustClass).toBe("unestablished");
    expect(brokenSeal.signed).toBe(false);

    const wrongCodesignId = identityFromCodesign(
      "Identifier=app.forgeorbit.owner-trust\nAuthority=ForgeOrbit Local Owner\nTeamIdentifier=not set\n",
      PRODUCTION_BUNDLE_ID,
      "/tmp/ForgeOrbit.app",
      { certSha256: LOCAL_PIN, anchorSha256: LOCAL_PIN },
    );
    expect(wrongCodesignId.trustClass).toBe("unestablished");

    const helperBundleRoot = mkdtempSync(join(tmpdir(), "fo-helper-verify-"));
    const fakeHelper = join(helperBundleRoot, "ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust");
    mkdirSync(join(helperBundleRoot, "ForgeOrbit.app/Contents/Resources/app/bin"), { recursive: true });
    writeFileSync(fakeHelper, "stub");
    expect(assessHelperCandidate({
      purpose: "approve",
      bundleId: PRODUCTION_BUNDLE_ID,
      bundleRoot: join(helperBundleRoot, "ForgeOrbit.app"),
      appTeamId: null,
      appAdhoc: false,
      appSigned: true,
      appCertSha256: LOCAL_PIN,
      anchorSha256: LOCAL_PIN,
      helperCertSha256: LOCAL_PIN,
      candidate: fakeHelper,
      envOverride: null,
      codesignText: "Identifier=app.forgeorbit.owner-trust\nAuthority=ForgeOrbit Local Owner\nTeamIdentifier=not set\n",
      helperVerifyOk: false,
    }).code).toBe("helper-identity-mismatch");
    rmSync(helperBundleRoot, { recursive: true, force: true });

    const root = mkdtempSync(join(tmpdir(), "fo-owner-d21-admit-"));
    const database = new Database(join(root, "trust.sqlite"));
    const now = Date.now();
    const op = operation(now);
    const prodTrust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true, now: () => now,
      identity: productionIdentity, admission: () => facts(op),
    });
    const signer = createSyntheticSigner();
    const enrollment = prodTrust.enrollTransportFixture(signer.publicKeySpki);
    const issued = prodTrust.issueChallenge(op, enrollment.id);
    if (!issued.ok) throw new Error(issued.reason);
    const payload = buildProofPayload(op, { nonce: issued.nonce, enrollmentId: enrollment.id, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: now });
    const proof = { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: signer.sign(payload) };

    const adhocTrust = createOwnerTrust({
      database, dataDir: root, machineId: "machine-a", allowSynthetic: false, now: () => now,
      identity: { bundleId: PRODUCTION_BUNDLE_ID, teamId: null, signed: true, adhoc: true, trustClass: "unestablished", source: "/tmp/ForgeOrbit.app" },
      admission: () => facts(op),
    });
    const adhocAdmit = adhocTrust.admit(proof, op, { trustClasses: ["production"] });
    expect(adhocAdmit.ok).toBe(false);
    expect(adhocAdmit.executionReady).toBe(false);
    expect(adhocAdmit.code).toBe("application-identity-unestablished");
    expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_grants").get()?.count).toBe(0);

    for (const priv of [{ browserAllowed: true }, { computerUseAllowed: true }, { terminalAllowed: true }]) {
      expect(parseOwnerOperation({ ...op, ...priv }, now).ok).toBe(false);
    }
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("DER Secure Enclave signatures verify as P-256", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeySpki = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64url");
    const payload = {
      schema: "forgeorbit-owner-trust-v1" as const, challenge: "nonce", operationDigest: "digest", enrollmentId: "id",
      applicationIdentity: "app.forgeorbit", issuedAt: 1, expiresAt: 2, scope: "scope", policyRevision: "policy",
      taskStateDigest: "task", missionStateDigest: "mission",
    };
    const der = signDer("sha256", Buffer.from(proofMessage(payload)), { key: privateKey, dsaEncoding: "der" });
    expect(ecdsaSignatureToP1363(der)?.length).toBe(64);
    expect(verifyP256(publicKeySpki, payload, der.toString("base64url"))).toBe(true);
  });

  test("the helper refuses a shell caller and does not report authentication", async () => {
    const binary = developmentHelperPath();
    const approve = Bun.spawn([binary, "approve"], { stdout: "pipe", stderr: "pipe" });
    const body = await new Response(approve.stdout).text();
    expect(await approve.exited).toBe(3);
    expect(body).toContain("caller-identity-rejected");
    const status = Bun.spawn([binary, "status"], { stdout: "pipe", stderr: "pipe" });
    const statusBody = JSON.parse(await new Response(status.stdout).text()) as { authenticated: boolean; canEvaluate: boolean };
    expect(await status.exited).toBe(0);
    expect(statusBody.authenticated).toBe(false);
    expect(statusBody.canEvaluate).toBe(true);
  });

  test("in-place upgrade from 142 to current preserves active Owner enrollment only for the same dataDir and certificate pin", () => {
    const root = mkdtempSync(join(tmpdir(), "fo-owner-upgrade-142-"));
    const dbPath = join(root, "agetor.sqlite");
    const db = new Database(dbPath);
    try {
      const cut142 = migrations.findIndex((m) => m.id === "142_run_terminations");
      expect(cut142).toBeGreaterThan(0);
      expect(migrate(db, migrations.slice(0, cut142 + 1)).at(-1)).toBe("142_run_terminations");

      const now = Date.now();
      const op = operation(now);
      const signer = createSyntheticSigner();
      const beforeTrust = createOwnerTrust({
        database: db, dataDir: root, machineId: "machine-a", allowSynthetic: true, transportFixture: true, now: () => now,
        identity: productionIdentity, admission: () => facts(op),
      });
      const enrollment = beforeTrust.enrollTransportFixture(signer.publicKeySpki);
      expect(enrollment.authority_state).toBe("active");
      expect(enrollment.signing_cert_sha256).toBe(LOCAL_PIN);

      // Simulate bundle replacement migrating 142 -> 145 at the same dataDir.
      const applied = migrate(db, migrations);
      expect(applied[0]).toBe("143_router_issued_plans");
      expect(applied.at(-1)).toBe(migrations.at(-1)!.id);

      const upgradedSamePin = createOwnerTrust({
        database: db, dataDir: root, machineId: "machine-a", allowSynthetic: false, now: () => now,
        identity: productionIdentity, admission: () => facts(op),
      });
      expect(upgradedSamePin.status().productionEnrollments).toBe(1);
      expect(upgradedSamePin.status().sealed).toBe(false);
      const issued = upgradedSamePin.issueChallenge(op, enrollment.id);
      if (!issued.ok) throw new Error(issued.reason);
      const payload = buildProofPayload(op, { nonce: issued.nonce, enrollmentId: enrollment.id, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: now });
      const proof = { schema: "forgeorbit-owner-trust-v1" as const, payload, signature: signer.sign(payload) };
      const admitted = upgradedSamePin.admit(proof, op, { trustClasses: ["production"], consume: true });
      expect(admitted.ok).toBe(true);
      expect(admitted.executionReady).toBe(true);
      expect(admitted.code).toBe("owner-grant-consumed");

      // Opening the same upgraded profile with a different Owner certificate pin refuses authority.
      const differentPin = "cd".repeat(32);
      const upgradedWrongPin = createOwnerTrust({
        database: db, dataDir: root, machineId: "machine-a", allowSynthetic: false, now: () => now,
        identity: { ...productionIdentity, certSha256: differentPin, anchorSha256: differentPin },
        admission: () => facts(op),
      });
      const issued2 = upgradedWrongPin.issueChallenge(op, enrollment.id);
      if (!issued2.ok) throw new Error(issued2.reason);
      const payload2 = buildProofPayload(op, { nonce: issued2.nonce, enrollmentId: enrollment.id, applicationIdentity: PRODUCTION_BUNDLE_ID, issuedAt: now });
      const proof2 = { schema: "forgeorbit-owner-trust-v1" as const, payload: payload2, signature: signer.sign(payload2) };
      const refused = upgradedWrongPin.admit(proof2, op, { trustClasses: ["production"], consume: true });
      expect(refused.ok).toBe(false);
      expect(refused.executionReady).toBe(false);
      expect(refused.code).toBe("signing-identity-replaced");

      // Moving/opening the upgraded profile at a different dataDir seals it inactive.
      const movedDir = join(root, "moved-profile");
      mkdirSync(movedDir, { recursive: true });
      const movedTrust = createOwnerTrust({
        database: db, dataDir: movedDir, machineId: "machine-a", allowSynthetic: false, now: () => now,
        identity: productionIdentity, admission: () => facts(op),
      });
      expect(movedTrust.status().sealed).toBe(true);
      expect(movedTrust.status().productionEnrollments).toBe(0);
      expect(db.query<{ authority_state: string }, [string]>("SELECT authority_state FROM owner_trust_enrollments WHERE id = ?").get(enrollment.id)?.authority_state).toBe("restored-inactive");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
