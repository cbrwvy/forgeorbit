/**
 * Runs the embedded Owner helper.
 * The helper path comes from the application bundle. A caller-supplied path
 * is rejected. The child environment cannot carry authorization flags.
 * Cancelling the native review records a refusal and creates no grant.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyOwnerTrustState, type OwnerTrustState } from "../../shared/owner-trust/diagnostics.ts";
import { PRODUCTION_BUNDLE_ID, type OwnerOperation, type OwnerProofPayload } from "../../shared/owner-trust/protocol.ts";
import { HELPER_BUNDLE_RELATIVE_PATH, sameCertPin } from "../../shared/owner-trust/signing-policy.ts";
import { assessInstalledHelper, type HelperAssessment } from "./helper-integrity.ts";
import { bundleRootFor, realUserHome } from "./identity.ts";
import { readAuthoritativeOperation, type AuthoritativePreview } from "./preview.ts";
import { verifyP256 } from "./crypto.ts";
import type { OwnerDecision, OwnerTrustService } from "./service.ts";

let active: ChildProcess | null = null;
let statusCache: { at: number; body: { canEvaluate: boolean; signed: boolean } | null } | null = null;

export function runningInsideForgeOrbitApp(execPath = process.execPath): boolean {
  const bundle = bundleRootFor(execPath);
  return bundle?.bundleId === "app.forgeorbit" || bundle?.bundleId === "app.forgeorbit.qa";
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: realUserHome() ?? process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "en_US.UTF-8",
  };
}

function spawnHelper(helper: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe"], env: cleanEnvironment() });
    active = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (active === child) active = null;
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

export async function helperAuthenticationStatus(trust: OwnerTrustService): Promise<{ canEvaluate: boolean; signed: boolean } | null> {
  if (statusCache && Date.now() - statusCache.at < 5000) return statusCache.body;
  const assessment = assessInstalledHelper("status", trust.identity);
  if (!assessment.path) {
    statusCache = { at: Date.now(), body: null };
    return null;
  }
  const result = await spawnHelper(assessment.path, ["status"], 4000);
  let body: { canEvaluate?: boolean; signed?: boolean } | null = null;
  try { body = JSON.parse(result.stdout) as { canEvaluate?: boolean; signed?: boolean }; } catch { body = null; }
  const parsed = body && typeof body.canEvaluate === "boolean"
    ? { canEvaluate: body.canEvaluate, signed: body.signed === true }
    : null;
  statusCache = { at: Date.now(), body: parsed };
  return parsed;
}

export async function ownerTrustDiagnostics(trust: OwnerTrustService, database = trust.store.database): Promise<Record<string, unknown>> {
  const base = trust.status();
  const helper = assessInstalledHelper("status", trust.identity);
  const auth = helper.path ? await helperAuthenticationStatus(trust) : null;
  const preview = readAuthoritativeOperation(database);
  const enrollmentState = enrollmentStateFor(trust);
  const state = classifyOwnerTrustState({
    bundleId: trust.identity.bundleId,
    trustClass: trust.identity.trustClass,
    adhoc: trust.identity.adhoc,
    signed: trust.identity.signed,
    teamId: trust.identity.teamId,
    helperPresent: Boolean(helper.path),
    helperOk: helper.ok,
    helperCode: helper.code,
    secureEnclaveHardware: process.arch === "arm64" && process.platform === "darwin",
    enrolled: enrollmentState === "active",
    enrollmentState,
    userAuthenticationAvailable: auth ? auth.canEvaluate : null,
    pending: false,
    refused: false,
  });
  return {
    ...base,
    executionReady: false,
    externalProcessWillStart: false,
    state,
    ownerAction: state,
    expectedProductionBundleId: PRODUCTION_BUNDLE_ID,
    helper,
    secureEnclave: process.arch === "arm64" && process.platform === "darwin" ? "hardware-present" : "unavailable",
    secureEnclaveEnrolled: enrollmentState === "active" && trust.store.activeByClass("production").some((row) => row.key_protection === "secure-enclave-user-presence"),
    userAuthenticationAvailable: auth?.canEvaluate === true,
    userAuthenticated: false,
    enrollmentState,
    providerExecutionEligible: false,
    operation: preview ? publicOperation(preview) : null,
    blockingReason: blockingReason(state, helper),
  };
}

function enrollmentStateFor(trust: OwnerTrustService): "none" | "active" | "revoked" | "restored-inactive" {
  const profile = trust.store.database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
  if (profile?.sealed === 1) return "restored-inactive";
  const active = trust.store.activeByClass("production");
  if (active.length > 0) {
    if (trust.identity.trustClass === "production" && !active.some((row) => sameCertPin(row.signing_cert_sha256, trust.identity.certSha256))) {
      return "revoked";
    }
    return "active";
  }
  const rows = trust.store.database.query<{ authority_state: string }, []>(
    "SELECT authority_state FROM owner_trust_enrollments ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).all();
  const state = rows[0]?.authority_state;
  if (state === "active") return "active";
  if (state === "removed" || state === "rotated") return "revoked";
  if (state === "restored-inactive") return "restored-inactive";
  return "none";
}

function publicOperation(preview: AuthoritativePreview) {
  const operation = preview.operation;
  return {
    projectPath: operation.projectPath,
    taskId: operation.taskId,
    taskTitle: preview.display.taskTitle,
    missionId: operation.missionId,
    missionTitle: preview.display.missionTitle,
    missionRevision: operation.missionRevision,
    providerId: operation.providerId,
    modelId: operation.modelId,
    accountId: operation.accountId,
    employeeRole: preview.display.employeeRole,
    employeeJobTitle: preview.display.employeeJobTitle,
    mode: operation.mode,
    workspace: operation.workspace,
    filesystem: operation.filesystem,
    terminalAllowed: operation.terminalAllowed,
    browserAllowed: operation.browserAllowed,
    computerUseAllowed: operation.computerUseAllowed,
    gitRead: operation.gitRead,
    gitPublish: operation.gitPublish,
    deploymentAllowed: operation.deploymentAllowed,
    scope: operation.scope,
    expiresAt: operation.expiresAt,
    knownCost: operation.knownCost,
    costCoverage: operation.costCoverage,
    externalProcess: false,
    cancellationAvailable: true,
    digest: preview.digest,
  };
}

function blockingReason(state: OwnerTrustState, helper: HelperAssessment): string {
  if (state === "development-or-qa") return "This is a development or QA build. It cannot become the production Owner identity.";
  if (state === "unsigned-or-adhoc") return "The application is ad-hoc or unsigned. The local Owner certificate is required.";
  if (state === "trusted-signature-missing") return "The running bundle is not app.forgeorbit signed by the pinned local Owner certificate.";
  if (state === "helper-missing") return "The Owner helper is not embedded in the application.";
  if (state === "helper-identity-mismatch") return helper.reason;
  if (state === "secure-enclave-unavailable") return "This Mac does not show a Secure Enclave capable of holding the Owner key.";
  if (state === "owner-not-enrolled") return "The Owner has not enrolled a Secure Enclave key in the signed application.";
  if (state === "native-authentication-unavailable") return "macOS cannot evaluate Owner authentication on this Mac.";
  if (state === "authorization-refused") return "Owner authorization was refused, revoked, or the profile was restored.";
  if (state === "owner-authorization-pending") return "An Owner review is already open.";
  return "The signed application can ask the Owner to confirm one exact operation. Confirmation has not happened.";
}

function refused(code: string, reason: string, operationDigest: string | null = null): OwnerDecision {
  return {
    ok: false,
    executionReady: false,
    code,
    reason,
    method: "native-owner-proof",
    trustClass: "none",
    grantId: null,
    operationDigest,
  };
}

async function signAndAdmitWithHelper(params: {
  trust: OwnerTrustService;
  operation: OwnerOperation;
  canonical: string;
  digest: string;
  locale: "en" | "ru";
  allowEnroll: boolean;
}): Promise<OwnerDecision> {
  const { trust, operation, canonical, digest, locale, allowEnroll } = params;
  if (!runningInsideForgeOrbitApp()) {
    return refused("owner-proof-invalid", "The embedded page cannot approve execution. Native authentication has to sign the exact operation.", digest);
  }
  if (active) return refused("owner-review-in-progress", "An Owner review is already open. No second approval was created.", digest);
  const helper = assessInstalledHelper("approve", trust.identity);
  if (!helper.ok || !helper.path) {
    return refused(helper.code, helper.reason, digest);
  }
  const profile = trust.store.database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
  if (profile?.sealed === 1) {
    return trust.recordCancellation("owner-restored-inactive", "A restored profile cannot recreate Owner authority.", digest);
  }
  const reserved = allowEnroll ? trust.reserveProductionEnrollment(operation) : null;
  const enrollment = reserved ? undefined : trust.store.activeByClass(trust.identity.trustClass === "qa-dev" ? "qa-dev" : "production")[0];
  if (!allowEnroll && !enrollment) {
    return refused("owner-not-enrolled", "Owner Secure Enclave identity is not enrolled. Enroll in Settings before launching.", digest);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "fo-owner-trust-"));
  const operationPath = path.join(dir, "operation.json");
  try {
    writeFileSync(operationPath, canonical, { mode: 0o600 });
    chmodSync(operationPath, 0o600);
    let nonce = reserved?.nonce ?? "unenrolled";
    let challengeId: string | null = reserved?.challengeId ?? null;
    let enrollmentId = reserved?.enrollmentId ?? enrollment?.id ?? "";
    if (!reserved && enrollment) {
      const issued = trust.issueChallenge(operation, enrollment.id);
      if (!issued.ok) {
        return trust.recordCancellation(issued.code, issued.reason, digest);
      }
      nonce = issued.nonce;
      challengeId = issued.challengeId;
      enrollmentId = enrollment.id;
    }
    const result = await spawnHelper(helper.path, [
      "approve",
      "--operation", operationPath,
      "--digest", digest,
      "--nonce", nonce,
      "--enrollment", enrollmentId,
      "--application", trust.identity.bundleId ?? "",
      "--data-dir", trust.dataDir,
      "--locale", locale,
      ...(reserved ? ["--rotate-key"] : []),
    ], 120_000);
    type HelperReply = { decision?: string; code?: string; signature?: string | null; payload?: unknown; publicKeySpki?: string };
    let parsed: HelperReply | null = null;
    try { parsed = JSON.parse(result.stdout) as HelperReply; } catch { parsed = null; }
    const cancelChallenge = () => {
      if (!challengeId) return;
      trust.store.database.run(
        "UPDATE owner_trust_challenges SET status = 'cancelled', consumed_at = ? WHERE id = ? AND status = 'open'",
        [Date.now(), challengeId],
      );
    };
    if (result.timedOut) {
      cancelChallenge();
      return trust.recordCancellation("native-helper-timeout", "The native confirmation timed out. No grant was created.", digest);
    }
    if (!parsed || parsed.decision !== "signed" || !parsed.signature || !parsed.payload || parsed.publicKeySpki == null) {
      cancelChallenge();
      const code = parsed?.code === "authentication-cancelled" ? "authentication-cancelled" : parsed?.code ?? "authentication-failed";
      return trust.recordCancellation(code, "The native confirmation did not approve this operation. No grant was created.", digest);
    }
    if (!verifyP256(parsed.publicKeySpki, parsed.payload as OwnerProofPayload, parsed.signature)) {
      cancelChallenge();
      return trust.recordCancellation("owner-signature-invalid", "The helper signature does not match the returned public key. No grant was created.", digest);
    }
    if (allowEnroll && trust.identity.trustClass === "production" && helper.path) {
      const bundleRoot = helper.path.endsWith(HELPER_BUNDLE_RELATIVE_PATH)
        ? helper.path.slice(0, -HELPER_BUNDLE_RELATIVE_PATH.length).replace(/\/$/, "")
        : "";
      const enrolled = trust.enrollFromHelper({
        publicKeySpki: parsed.publicKeySpki,
        applicationIdentity: trust.identity.bundleId ?? "",
        helperIdentifier: helper.identifier ?? "",
        helperTeamId: helper.teamId,
        helperCertSha256: helper.certSha256,
        helperAdhoc: helper.adhoc,
        helperPath: helper.path,
        bundleRoot,
        protection: "secure-enclave-user-presence",
        reservedEnrollmentId: reserved?.enrollmentId,
      });
      if (!enrolled.ok) {
        cancelChallenge();
        return enrolled;
      }
    }
    const decision = trust.admit(
      { schema: "forgeorbit-owner-trust-v1", payload: parsed.payload, signature: parsed.signature },
      operation,
      { trustClasses: ["production"], consume: true },
    );
    if (!decision.ok) cancelChallenge();
    return decision;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function authorizeOperationWithHelper(
  trust: OwnerTrustService,
  operation: OwnerOperation,
  canonical: string,
  digest: string,
  locale: "en" | "ru" = "en",
): Promise<OwnerDecision> {
  if (!operation.externalProcess || operation.requestId.startsWith("review:")) {
    return refused("owner-preview-not-launch", "Settings preview operations cannot authorize a real provider launch.", digest);
  }
  return signAndAdmitWithHelper({ trust, operation, canonical, digest, locale, allowEnroll: false });
}

/**
 * First-time Owner enrollment for a project authorization. Enrollment in this design is the creation of the Secure
 * Enclave key and the first signature in one native confirmation, so a profile that has never enrolled enrolls while it
 * signs the project envelope. It is refused for anything that is not a project envelope and for a revoked or restored
 * profile; the caller decides whether the profile has never enrolled.
 */
export async function enrollAndAuthorizeProjectEnvelope(
  trust: OwnerTrustService,
  operation: OwnerOperation,
  canonical: string,
  digest: string,
  locale: "en" | "ru" = "en",
): Promise<OwnerDecision> {
  if (operation.kind !== "project-envelope") return refused("owner-operation-mismatch", "Only a project authorization can enroll the Owner here.", digest);
  return signAndAdmitWithHelper({ trust, operation, canonical, digest, locale, allowEnroll: true });
}

export async function reviewAuthoritativeOperation(trust: OwnerTrustService, locale: "en" | "ru"): Promise<OwnerDecision> {
  if (!runningInsideForgeOrbitApp()) {
    return refused("owner-proof-invalid", "The embedded page cannot approve execution. Native authentication has to sign the exact operation.");
  }
  if (active) return refused("owner-review-in-progress", "An Owner review is already open. No second approval was created.");
  const preview = readAuthoritativeOperation(trust.store.database);
  if (!preview) {
    return refused("owner-operation-absent", "The embedded page cannot approve execution. No backend operation is waiting.");
  }
  return signAndAdmitWithHelper({
    trust,
    operation: preview.operation,
    canonical: preview.canonical,
    digest: preview.digest,
    locale,
    allowEnroll: true,
  });
}

export async function approveChallengeWithHelper(trust: OwnerTrustService, challengeId: string): Promise<OwnerDecision> {
  const challenge = trust.store.challenge(challengeId);
  if (!challenge || challenge.status !== "open" || challenge.consumed_at) {
    return refused("owner-challenge-unknown", "That challenge is not open.");
  }
  if (!runningInsideForgeOrbitApp()) {
    return refused("owner-proof-invalid", "The embedded page cannot approve execution. Native authentication has to sign the exact operation.", challenge.operation_digest);
  }
  return reviewAuthoritativeOperation(trust, "en");
}
