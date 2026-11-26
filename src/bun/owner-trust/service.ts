/**
 * Owner proof verification.
 * Production execution becomes ready only for a production-signed app,
 * a Secure Enclave user-presence key, and a proof of this exact operation.
 * Synthetic signatures remain inside the test trust class.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { dataDir, db } from "../db.ts";
import { readApplicationIdentity, type ApplicationIdentity } from "./identity.ts";
import { OwnerTrustStore, reconcileProfile, type EnrollmentRow, type GrantRow } from "./store.ts";
import { verifyP256 } from "./crypto.ts";
import { admissionCode, loadAdmissionFacts, type AdmissionFacts } from "./admission.ts";
import { PRODUCTION_HELPER_ID, HELPER_BUNDLE_RELATIVE_PATH, localOwnerIdentityEstablished, sameCertPin } from "../../shared/owner-trust/signing-policy.ts";
import {
  CHALLENGE_TTL_MS,
  OWNER_TRUST_SCHEMA,
  PRODUCTION_BUNDLE_ID,
  QA_BUNDLE_ID,
  canonicalize,
  childInsideEnvelope,
  expectedScope,
  parseOwnerOperation,
  parseOwnerProof,
  sha256Hex,
  type OwnerKeyProtection,
  type OwnerOperation,
  type OwnerProof,
  type OwnerTrustClass,
} from "../../shared/owner-trust/protocol.ts";

export interface OwnerDecision {
  ok: boolean;
  executionReady: boolean;
  code: string;
  reason: string;
  method: "native-owner-proof";
  trustClass: OwnerTrustClass | "none";
  grantId: string | null;
  operationDigest: string | null;
}

export interface OwnerTrustService {
  identity: ApplicationIdentity;
  /** Profile directory. The helper stores its SE-encrypted Owner key blob here. */
  dataDir: string;
  status(): Record<string, unknown>;
  enrollSynthetic(publicKeySpki: string, label?: string): EnrollmentRow;
  enrollTransportFixture(publicKeySpki: string): EnrollmentRow;
  enrollFromHelper(attestation: HelperEnrollmentAttestation): OwnerDecision;
  reserveProductionEnrollment(operation: OwnerOperation): { enrollmentId: string; nonce: string; challengeId: string } | null;
  recordCancellation(code: string, reason: string, operationDigest: string | null): OwnerDecision;
  issueChallenge(raw: unknown, enrollmentId: string): { ok: true; challengeId: string; nonce: string; canonical: string; digest: string; expiresAt: number } | { ok: false; code: string; reason: string };
  admit(proofRaw: unknown, operationRaw: unknown, options?: { trustClasses?: OwnerTrustClass[]; consume?: boolean }): OwnerDecision;
  admitChild(grantId: string, operationRaw: unknown): OwnerDecision;
  revokeEnrollment(id: string): OwnerDecision;
  revokeGrant(id: string): OwnerDecision;
  store: OwnerTrustStore;
}

export interface HelperEnrollmentAttestation {
  publicKeySpki: string;
  applicationIdentity: string;
  helperIdentifier: string;
  helperTeamId: string | null;
  helperCertSha256: string | null;
  helperAdhoc: boolean;
  helperPath: string;
  bundleRoot: string;
  protection: OwnerKeyProtection;
  reservedEnrollmentId?: string;
}

export interface OwnerTrustOptions {
  database?: Database;
  dataDir?: string;
  machineId?: string;
  now?: () => number;
  allowSynthetic?: boolean;
  /** Isolated test boundary. The production singleton never sets this. */
  transportFixture?: boolean;
  identity?: ApplicationIdentity;
  admission?: (operation: OwnerOperation) => AdmissionFacts;
}

function machineId(): string {
  return "process-default";
}

export function createOwnerTrust(options: OwnerTrustOptions = {}): OwnerTrustService {
  const database = options.database ?? db;
  const directory = options.dataDir ?? dataDir;
  const machine = options.machineId ?? machineId();
  const now = options.now ?? (() => Date.now());
  const identity = options.identity ?? readApplicationIdentity();
  const store = new OwnerTrustStore(database);
  reconcileProfile(database, directory, machine);
  const factsFor = options.admission ?? loadAdmissionFacts;

  const journal = (eventType: "owner.trust.approved" | "owner.trust.refused" | "owner.trust.consumed" | "owner.trust.revoked" | "owner.trust.enrolled", operation: OwnerOperation | null, code: string, enrollmentId: string | null) => {
    try {
      new ActivityJournalCore(database).record({
        eventType,
        actorType: eventType === "owner.trust.refused" ? "system" : "owner",
        actorId: "owner-trust",
        targetType: "execution",
        targetId: operation?.requestId ?? enrollmentId ?? "owner-trust",
        projectPath: operation?.projectPath ?? null,
        taskId: operation && operation.taskId !== "policy-envelope" ? operation.taskId : null,
        idempotencyKey: `owner-trust:${eventType}:${operation?.requestId ?? enrollmentId}:${code}:${randomUUID()}`,
        payload: {
          requestId: operation?.requestId ?? "none",
          operationDigest: operation ? sha256Hex(canonicalize(operation)) : "none",
          enrollmentId: enrollmentId ?? "none",
          method: identity.trustClass,
          code,
          scope: operation?.scope ?? "none",
          policyRevision: operation?.policyRevision ?? "none",
          taskId: operation?.taskId ?? "none",
          providerId: operation?.providerId ?? "none",
          accountId: operation?.accountId ?? "none",
        },
      });
    } catch {
      // The decision row is the durable record if the journal schema is absent.
    }
  };

  const refuse = (code: string, reason: string, extra?: Partial<OwnerDecision>): OwnerDecision => ({
    ok: false,
    executionReady: false,
    code,
    reason,
    method: "native-owner-proof",
    trustClass: extra?.trustClass ?? "none",
    grantId: null,
    operationDigest: extra?.operationDigest ?? null,
  });

  const readyFor = (enrollment: EnrollmentRow) => localOwnerIdentityEstablished(identity)
    && enrollment.trust_class === "production"
    && enrollment.key_protection === "secure-enclave-user-presence"
    && enrollment.application_identity === PRODUCTION_BUNDLE_ID
    && sameCertPin(enrollment.signing_cert_sha256, identity.certSha256);

  return {
    identity,
    dataDir: directory,
    store,
    status() {
      const profile = database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
      const production = store.activeByClass("production");
      return {
        channel: "native-owner-proof",
        available: true,
        executionReady: false,
        code: identity.trustClass === "production" ? (production.length ? "owner-proof-absent" : "owner-not-enrolled") : "application-identity-unestablished",
        reason: identity.trustClass !== "production"
          ? "This process is not signed by the pinned local Owner certificate. A synthetic, QA, or ad-hoc identity cannot start a provider."
          : production.length
            ? "A production Owner key is enrolled. Each operation still needs a fresh proof."
            : "This process matches the pinned local Owner certificate. Enrollment still requires the Owner's authentication.",
        application: {
          bundleId: identity.bundleId,
          teamId: identity.teamId,
          trustClass: identity.trustClass,
          adhoc: identity.adhoc,
          signed: identity.signed,
          certSha256: identity.certSha256 ?? null,
          anchorSha256: identity.anchorSha256 ?? null,
          authority: identity.authority ?? null,
        },
        productionEnrollments: production.length,
        sealed: profile?.sealed === 1,
        externalProcessWillStart: false,
      };
    },
    enrollSynthetic(publicKeySpki, label = "synthetic-test") {
      if (!options.allowSynthetic) throw new Error("Synthetic Owner keys are not accepted by this trust configuration.");
      if (identity.trustClass === "production" && !options.identity) {
        throw new Error("The production process does not enroll a synthetic key.");
      }
      const row = store.insertEnrollment({
        trustClass: "synthetic-test",
        applicationIdentity: "synthetic-test",
        publicKeySpki,
        keyProtection: "synthetic-software",
        label,
        now: now(),
      });
      store.recordDecision({
        challengeId: null, grantId: null, enrollmentId: row.id, operationDigest: "enrollment",
        code: "enrolled", decision: "enrolled", now: now(),
      });
      return row;
    },
    enrollTransportFixture(publicKeySpki) {
      if (!options.transportFixture || !options.allowSynthetic) {
        throw new Error("Transport fixtures are not part of the production trust configuration.");
      }
      if (!localOwnerIdentityEstablished(identity)) {
        throw new Error("A transport fixture requires an injected production identity.");
      }
      return store.insertEnrollment({
        trustClass: "production",
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        publicKeySpki,
        keyProtection: "secure-enclave-user-presence",
        label: "transport-fixture-not-hardware",
        now: now(),
        signingCertSha256: identity.certSha256 ?? null,
      });
    },
    enrollFromHelper(attestation) {
      if (!localOwnerIdentityEstablished(identity)) {
        return refuse("application-identity-unestablished", "This process is not signed by the pinned local Owner certificate.");
      }
      if (attestation.applicationIdentity === QA_BUNDLE_ID || attestation.helperIdentifier !== PRODUCTION_HELPER_ID) {
        return refuse("qa-identity-rejected", "A QA helper cannot enroll a production Owner key.");
      }
      if (attestation.applicationIdentity !== PRODUCTION_BUNDLE_ID || attestation.helperAdhoc || !sameCertPin(attestation.helperCertSha256, identity.certSha256)) {
        return refuse("helper-identity-mismatch", "The helper certificate does not match the local Owner certificate.");
      }
      if (identity.teamId && attestation.helperTeamId && identity.teamId !== attestation.helperTeamId) {
        return refuse("helper-team-mismatch", "The helper TeamIdentifier does not match the application.");
      }
      if (attestation.protection !== "secure-enclave-user-presence") {
        return refuse("secure-enclave-unavailable", "A software key cannot enroll the Owner.");
      }
      const expectedPath = `${attestation.bundleRoot.replace(/\/+$/, "")}/${HELPER_BUNDLE_RELATIVE_PATH}`;
      if (attestation.helperPath !== expectedPath || !attestation.bundleRoot.endsWith(".app")) {
        return refuse("helper-path-rejected", "Enrollment requires the helper embedded in this application.");
      }
      const profile = database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
      if (profile?.sealed === 1) return refuse("owner-restored-inactive", "A restored profile cannot recreate Owner authority.");
      const liveCert = identity.certSha256 ?? "";
      if (store.activePinnedCertificates().some((pin) => !sameCertPin(pin, liveCert))) {
        return refuse("signing-identity-replaced", "An Owner enrollment is pinned to a different signing certificate. A new certificate cannot take its place.");
      }
      const existing = store.enrollmentByKey(attestation.publicKeySpki);
      if (existing?.authority_state === "removed") return refuse("owner-revoked", "This Owner key remains revoked.");
      if (existing?.authority_state === "active") {
        return { ok: true, executionReady: false, code: "owner-enrolled", reason: "This Owner key is already enrolled.", method: "native-owner-proof", trustClass: "production", grantId: null, operationDigest: null };
      }
      for (const row of store.activeByClass("production")) {
        store.setEnrollmentState(row.id, "rotated", now());
        database.run("UPDATE owner_trust_grants SET status = 'revoked', consumed_at = COALESCE(consumed_at, ?) WHERE enrollment_id = ? AND status = 'issued'", [now(), row.id]);
      }
      const row = store.insertEnrollment({
        trustClass: "production",
        applicationIdentity: PRODUCTION_BUNDLE_ID,
        publicKeySpki: attestation.publicKeySpki,
        keyProtection: "secure-enclave-user-presence",
        label: "secure-enclave",
        now: now(),
        id: attestation.reservedEnrollmentId,
        signingCertSha256: identity.certSha256 ?? null,
      });
      store.recordDecision({ challengeId: null, grantId: null, enrollmentId: row.id, operationDigest: "enrollment", code: "enrolled", decision: "enrolled", now: now() });
      journal("owner.trust.enrolled", null, "enrolled", row.id);
      return { ok: true, executionReady: false, code: "owner-enrolled", reason: "The Owner key was enrolled. It does not approve an operation by itself.", method: "native-owner-proof", trustClass: "production", grantId: null, operationDigest: null };
    },
    reserveProductionEnrollment(operation) {
      if (!localOwnerIdentityEstablished(identity)) return null;
      if (store.activeByClass("production").length > 0) return null;
      const profile = database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
      if (profile?.sealed === 1) return null;
      const enrollmentId = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      const canonical = canonicalize(operation);
      const row = store.insertChallenge({
        nonceHash: sha256Hex(nonce),
        nonce,
        operationDigest: sha256Hex(canonical),
        operationCanonical: canonical,
        enrollmentId,
        expiresAt: Math.min(operation.expiresAt, now() + CHALLENGE_TTL_MS),
        now: now(),
      });
      return { enrollmentId, nonce, challengeId: row.id };
    },
    recordCancellation(code, reason, operationDigest) {
      store.recordDecision({
        challengeId: null, grantId: null, enrollmentId: null, operationDigest: operationDigest ?? "cancelled",
        code, decision: "refused", now: now(),
      });
      journal("owner.trust.refused", null, code, null);
      return refuse(code, reason, { operationDigest });
    },
    issueChallenge(raw, enrollmentId) {
      const parsed = parseOwnerOperation(raw, now());
      if (!parsed.ok) return parsed;
      const enrollment = store.enrollment(enrollmentId);
      if (!enrollment) return { ok: false, code: "owner-not-enrolled", reason: "There is no active Owner enrollment for this challenge." };
      if (enrollment.authority_state === "removed") return { ok: false, code: "owner-revoked", reason: "This Owner identity was removed." };
      if (enrollment.authority_state === "rotated") return { ok: false, code: "owner-key-rotated", reason: "This signing key was rotated." };
      if (enrollment.authority_state !== "active") return { ok: false, code: "owner-restored-inactive", reason: "This profile copy does not have active execution authority." };
      const profile = database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
      if (profile?.sealed === 1) {
        return { ok: false, code: "owner-restored-inactive", reason: "This profile copy does not have active execution authority." };
      }
      const nonce = randomBytes(32).toString("base64url");
      const expiresAt = Math.min(parsed.operation.expiresAt, now() + CHALLENGE_TTL_MS);
      const row = store.insertChallenge({
        nonceHash: sha256Hex(nonce),
        nonce,
        operationDigest: parsed.digest,
        operationCanonical: parsed.canonical,
        enrollmentId,
        expiresAt,
        now: now(),
      });
      return { ok: true, challengeId: row.id, nonce, canonical: parsed.canonical, digest: parsed.digest, expiresAt };
    },
    admit(proofRaw, operationRaw, admitOptions = {}) {
      const trustClasses = admitOptions.trustClasses ?? ["production"];
      const consume = admitOptions.consume !== false;
      const parsedOperation = parseOwnerOperation(operationRaw, now());
      if (!parsedOperation.ok) {
        store.recordDecision({ challengeId: null, grantId: null, enrollmentId: null, operationDigest: "invalid", code: parsedOperation.code, decision: "refused", now: now() });
        return refuse(parsedOperation.code, parsedOperation.reason);
      }
      const parsedProof = parseOwnerProof(proofRaw);
      if (!parsedProof.ok) {
        store.recordDecision({ challengeId: null, grantId: null, enrollmentId: null, operationDigest: parsedOperation.digest, code: parsedProof.code, decision: "refused", now: now() });
        journal("owner.trust.refused", parsedOperation.operation, parsedProof.code, null);
        return refuse(parsedProof.code, parsedProof.reason, { operationDigest: parsedOperation.digest });
      }
      const proof = parsedProof.proof;
      const operation = parsedOperation.operation;
      if (proof.payload.operationDigest !== parsedOperation.digest || proof.payload.scope !== operation.scope || proof.payload.policyRevision !== operation.policyRevision || proof.payload.taskStateDigest !== operation.taskStateDigest || proof.payload.missionStateDigest !== operation.missionStateDigest || proof.payload.expiresAt !== operation.expiresAt) {
        return refuse("owner-operation-mismatch", "The proof is for a different operation.", { operationDigest: parsedOperation.digest });
      }
      const enrollment = store.enrollment(proof.payload.enrollmentId);
      if (!enrollment) return refuse("owner-unknown-key", "The signing key is not enrolled.", { operationDigest: parsedOperation.digest });
      if (enrollment.authority_state === "rotated") return refuse("owner-key-rotated", "This signing key was rotated.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      if (enrollment.authority_state === "removed") return refuse("owner-revoked", "This Owner identity was removed.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      if (enrollment.authority_state !== "active") return refuse("owner-restored-inactive", "This enrollment is not an active Owner identity.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      if (!trustClasses.includes(enrollment.trust_class)) {
        const code = enrollment.trust_class === "synthetic-test" ? "synthetic-identity-rejected" : enrollment.trust_class === "qa-dev" ? "qa-identity-rejected" : "owner-unknown-key";
        return refuse(code, "This signing key is not accepted by the production trust configuration.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      if (proof.payload.applicationIdentity !== enrollment.application_identity) {
        return refuse("owner-application-mismatch", "The proof names a different application identity.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      if (!verifyP256(enrollment.public_key_spki, proof.payload, proof.signature)) {
        store.recordDecision({ challengeId: null, grantId: null, enrollmentId: enrollment.id, operationDigest: parsedOperation.digest, code: "owner-signature-invalid", decision: "refused", now: now() });
        journal("owner.trust.refused", operation, "owner-signature-invalid", enrollment.id);
        return refuse("owner-signature-invalid", "The signature does not match the enrolled key.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      const challenge = store.challengeByNonce(sha256Hex(proof.payload.challenge));
      if (!challenge || challenge.enrollment_id !== enrollment.id || challenge.operation_digest !== parsedOperation.digest || challenge.operation_canonical !== parsedOperation.canonical) {
        return refuse("owner-challenge-unknown", "The challenge does not match this operation.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      const currentNow = now();
      if (challenge.expires_at <= currentNow || proof.payload.issuedAt > currentNow + 5_000) {
        database.run("UPDATE owner_trust_challenges SET status = 'expired', consumed_at = COALESCE(consumed_at, ?) WHERE id = ? AND status = 'open'", [currentNow, challenge.id]);
        journal("owner.trust.refused", operation, "owner-challenge-expired", enrollment.id);
        return refuse("owner-challenge-expired", "The challenge expired.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      if (challenge.consumed_at) {
        return refuse("owner-already-consumed", "This authorization was already used.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      const facts = factsFor(operation);
      const denied = admissionCode(operation, facts);
      if (denied) {
        const burn = denied.code === "owner-policy-stale" || denied.code === "owner-mission-stale" || denied.code === "owner-task-stale" || denied.code === "owner-revoked" || denied.code === "owner-policy-revoked";
        if (burn) {
          database.run("UPDATE owner_trust_challenges SET status = ?, consumed_at = ? WHERE id = ? AND consumed_at IS NULL", [denied.code, currentNow, challenge.id]);
        }
        store.recordDecision({ challengeId: challenge.id, grantId: null, enrollmentId: enrollment.id, operationDigest: parsedOperation.digest, code: denied.code, decision: "refused", now: currentNow });
        journal("owner.trust.refused", operation, denied.code, enrollment.id);
        return refuse(denied.code, denied.reason, { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      if (!trustClasses.includes("synthetic-test") && !readyFor(enrollment)) {
        const code = localOwnerIdentityEstablished(identity) && !sameCertPin(enrollment.signing_cert_sha256, identity.certSha256)
          ? "signing-identity-replaced"
          : "application-identity-unestablished";
        const reason = code === "signing-identity-replaced"
          ? "An Owner enrollment is pinned to a different signing certificate."
          : "This process is not signed by the pinned local Owner certificate.";
        store.recordDecision({ challengeId: challenge.id, grantId: null, enrollmentId: enrollment.id, operationDigest: parsedOperation.digest, code, decision: "refused", now: currentNow });
        journal("owner.trust.refused", operation, code, enrollment.id);
        return refuse(code, reason, { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      }
      if (!consume) {
        const executionReady = readyFor(enrollment);
        return {
          ok: true,
          executionReady,
          code: executionReady ? "owner-proof-valid" : "application-identity-unestablished",
          reason: executionReady ? "The proof matches this operation. Further admission still applies at launch." : "The proof is valid for its trust class. This process is not authorized to start a provider.",
          method: "native-owner-proof",
          trustClass: enrollment.trust_class,
          grantId: null,
          operationDigest: parsedOperation.digest,
        };
      }
      const grantId = randomUUID();
      const committed = database.transaction(() => {
        const current = store.challenge(challenge.id);
        if (!current || current.consumed_at || current.status !== "open") return false;
        if (current.expires_at <= now()) return false;
        const updated = database.run(
          "UPDATE owner_trust_challenges SET status = 'consumed', consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND status = 'open'",
          [now(), challenge.id],
        );
        if (updated.changes !== 1) return false;
        const envelopeKind = operation.kind === "bounded-mission" || operation.kind === "project-envelope";
        const status = envelopeKind ? "issued" : "consumed";
        database.run(
          `INSERT INTO owner_trust_grants
            (id, challenge_id, enrollment_id, operation_digest, operation_canonical, status, expires_at, consumed_at, task_id, mission_id, project_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [grantId, challenge.id, enrollment.id, parsedOperation.digest, parsedOperation.canonical, status, operation.expiresAt, status === "consumed" ? now() : null, operation.taskId, operation.missionId, operation.projectPath, now()],
        );
        return true;
      })();
      if (!committed) return refuse("owner-already-consumed", "This authorization was already used.", { trustClass: enrollment.trust_class, operationDigest: parsedOperation.digest });
      store.recordDecision({
        challengeId: challenge.id, grantId, enrollmentId: enrollment.id, operationDigest: parsedOperation.digest,
        code: operation.kind === "bounded-mission" || operation.kind === "project-envelope" ? "owner-grant-issued" : "owner-grant-consumed",
        decision: operation.kind === "bounded-mission" || operation.kind === "project-envelope" ? "approved" : "consumed",
        now: now(),
      });
      journal(operation.kind === "bounded-mission" || operation.kind === "project-envelope" ? "owner.trust.approved" : "owner.trust.consumed", operation, "owner-grant-consumed", enrollment.id);
      const executionReady = readyFor(enrollment);
      return {
        ok: true,
        executionReady,
        code: executionReady ? "owner-grant-consumed" : "verified-fixture",
        reason: executionReady
          ? "The production Owner proof was consumed for this operation."
          : "The proof was consumed for this exact operation. It does not start a provider process from this identity.",
        method: "native-owner-proof",
        trustClass: enrollment.trust_class,
        grantId,
        operationDigest: parsedOperation.digest,
      };
    },
    admitChild(grantId, operationRaw) {
      const parsed = parseOwnerOperation(operationRaw, now());
      if (!parsed.ok) return refuse(parsed.code, parsed.reason);
      const grant: GrantRow | null = store.grant(grantId);
      if (!grant || grant.status === "revoked") return refuse("owner-revoked", "The parent grant is revoked.");
      if (grant.status !== "issued") return refuse("owner-already-consumed", "The parent grant is not an open bounded mission.");
      if (grant.expires_at <= now()) return refuse("owner-challenge-expired", "The bounded grant expired.");
      const parent = parseOwnerOperation(JSON.parse(grant.operation_canonical), now(), { skipWindow: true });
      if (!parent.ok) return refuse("owner-proof-invalid", "The stored grant is unreadable.");
      const outside = childInsideEnvelope(parent.operation, parsed.operation);
      if (outside) return refuse("owner-envelope", outside, { operationDigest: parsed.digest });
      const facts = factsFor(parsed.operation);
      if (facts.policyStatus !== "active") return refuse("owner-envelope", "The child operation is not covered by the active policy.", { operationDigest: parsed.digest });
      const denied = admissionCode(parsed.operation, facts);
      if (denied) return refuse(denied.code, denied.reason, { operationDigest: parsed.digest });
      const useId = randomUUID();
      try {
        database.run(
          `INSERT INTO owner_trust_grant_uses (id, grant_id, task_id, role, run_id, operation_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [useId, grant.id, parsed.operation.taskId, parsed.operation.role, parsed.operation.runId, parsed.digest, now()],
        );
      } catch {
        return refuse("owner-already-consumed", "This task, role, and run were already consumed for the grant.", { operationDigest: parsed.digest });
      }
      store.recordDecision({ challengeId: grant.challenge_id, grantId: grant.id, enrollmentId: grant.enrollment_id, operationDigest: parsed.digest, code: "owner-grant-consumed", decision: "consumed", now: now() });
      journal("owner.trust.consumed", parsed.operation, "owner-grant-consumed", grant.enrollment_id);
      return {
        ok: true,
        executionReady: false,
        code: "verified-fixture",
        reason: "The child operation is inside the approved envelope. No provider process was started.",
        method: "native-owner-proof",
        trustClass: "none",
        grantId: grant.id,
        operationDigest: parsed.digest,
      };
    },
    revokeEnrollment(id) {
      const enrollment = store.enrollment(id);
      if (!enrollment) return refuse("owner-unknown-key", "There is no enrollment with that id.");
      store.setEnrollmentState(id, "removed", now());
      database.run("UPDATE owner_trust_grants SET status = 'revoked', consumed_at = COALESCE(consumed_at, ?) WHERE enrollment_id = ? AND status = 'issued'", [now(), id]);
      store.recordDecision({ challengeId: null, grantId: null, enrollmentId: id, operationDigest: "revocation", code: "owner-revoked", decision: "revoked", now: now() });
      journal("owner.trust.revoked", null, "owner-revoked", id);
      return refuse("owner-revoked", "The Owner identity was removed. New privileged operations are blocked.");
    },
    revokeGrant(id) {
      const grant = store.grant(id);
      if (!grant) return refuse("owner-unknown-key", "There is no grant with that id.");
      database.run("UPDATE owner_trust_grants SET status = 'revoked', consumed_at = COALESCE(consumed_at, ?) WHERE id = ?", [now(), id]);
      store.recordDecision({ challengeId: grant.challenge_id, grantId: id, enrollmentId: grant.enrollment_id, operationDigest: grant.operation_digest, code: "owner-revoked", decision: "revoked", now: now() });
      return refuse("owner-revoked", "The grant was revoked.");
    },
  };
}

let singleton: OwnerTrustService | null = null;

export function ownerTrust(): OwnerTrustService {
  if (!singleton) {
    singleton = createOwnerTrust({ allowSynthetic: false });
  }
  return singleton;
}

export function resetOwnerTrustForTest(): void {
  singleton = null;
}

export function buildProofPayload(operation: OwnerOperation, input: { nonce: string; enrollmentId: string; applicationIdentity: string; issuedAt: number }) {
  return {
    schema: OWNER_TRUST_SCHEMA,
    challenge: input.nonce,
    operationDigest: sha256Hex(canonicalize(operation)),
    enrollmentId: input.enrollmentId,
    applicationIdentity: input.applicationIdentity,
    issuedAt: input.issuedAt,
    expiresAt: operation.expiresAt,
    scope: expectedScope(operation),
    policyRevision: operation.policyRevision,
    taskStateDigest: operation.taskStateDigest,
    missionStateDigest: operation.missionStateDigest,
  };
}
