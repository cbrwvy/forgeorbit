/**
 * Project-level Owner authorization for hands-off work.
 *
 * One native Owner confirmation signs a project envelope (see shared/handsoff-authorization.ts). This module
 *  - builds the envelope for the saved policy and asks the existing Owner Trust path for the signature,
 *  - answers "is this project authorized right now, and for what" for the settings page and the driver,
 *  - hands each provider launch a single-use child grant, checked at the moment of launch, with the launch budget
 *    reserved atomically,
 *  - revokes without any confirmation.
 * It never prompts on its own: a missing or stale authorization is a state, not a dialog.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { db, harnesses, projects, tasks } from "../db.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { registerEnvelopeAdmission, taskBindingDigest } from "../owner-trust/admission.ts";
import {
  authorizeProjectEnvelopeOperation,
  currentOwnerTrustService,
  isProductionOwnerGateActive,
  registerProjectGrantAuthorizer,
  registerTicketDiscardObserver,
} from "../owner-trust/launch-gate.ts";
import { localOwnerIdentityEstablished, sameCertPin } from "../../shared/owner-trust/signing-policy.ts";
import { OWNER_TRUST_SCHEMA, expectedScope, parseOwnerOperation } from "../../shared/owner-trust/protocol.ts";
import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
import {
  HANDSOFF_AUTH_LIMITS,
  envelopeFrom,
  launchClaimKey,
  policyWithinEnvelope,
  type HandsoffAuthorizationState,
  type HandsoffAuthorizationView,
  type HandsoffEnvelope,
} from "../../shared/handsoff-authorization.ts";
import { envelopeDigest, projectIdentityOf } from "../../shared/handsoff-authorization-digest.ts";
import { hasResource, type HandsoffResourceRef } from "../../shared/handsoff.ts";
import { HandsoffError } from "./errors.ts";
import { accountKey } from "./resources.ts";
import { handsoffStore } from "./store.ts";
import { notifySmartQueueChanged } from "./queue-events.ts";
import { taskAvailabilityFor } from "../task-availability.ts";

interface AuthRow {
  id: string; project_path: string; project_identity: string; grant_id: string; enrollment_id: string; envelope_json: string;
  envelope_digest: string; policy_revision: number; launch_budget: number; expires_at: number; status: string; created_at: number; ended_at: number | null;
}

let clock: () => number = () => Date.now();
/** Test seam only. */
export function setAuthorizationClockForTest(next: (() => number) | null): void { clock = next ?? (() => Date.now()); }

/** Envelopes this process built and is currently asking the Owner to sign, by digest. Nothing else is admitted. */
const pending = new Map<string, HandsoffEnvelope>();
const inFlight = new Set<string>();

function canonicalProject(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function registeredPath(raw: string): string | null {
  const direct = projects.get(raw);
  if (direct) return direct.path;
  const real = canonicalProject(raw);
  if (!real) return null;
  for (const project of projects.list()) if (canonicalProject(project.path) === real) return project.path;
  return null;
}

export function identityOfProject(projectPath: string): string | null {
  const project = projects.get(projectPath);
  const real = canonicalProject(projectPath);
  return project && real ? projectIdentityOf(real, project.addedAt) : null;
}

const rowOf = (raw: AuthRow | null | undefined) => raw ?? null;
function activeRow(projectPath: string): AuthRow | null {
  return rowOf(db.query<AuthRow, [string]>("SELECT * FROM handsoff_authorizations WHERE project_path = ? AND status = 'active'").get(projectPath));
}
function latestRow(projectPath: string): AuthRow | null {
  return rowOf(db.query<AuthRow, [string]>("SELECT * FROM handsoff_authorizations WHERE project_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projectPath));
}
const envelopeOfRow = (row: AuthRow): HandsoffEnvelope => JSON.parse(row.envelope_json) as HandsoffEnvelope;

function launchesUsed(authorizationId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM handsoff_launches WHERE authorization_id = ? AND status != 'released'").get(authorizationId)?.n ?? 0;
}

function announce(projectPath: string, status: string): void {
  try { broadcastAppEvent({ type: "handsoff", projectPath, taskId: null, runId: null, status, ts: clock() }); } catch { /* the next read catches up */ }
}

/** What can currently be covered, as the Router sees it: the models each role may use on the covered harnesses and accounts. */
function modelsFor(role: "developer" | "reviewer", resources: readonly HandsoffResourceRef[]): string[] {
  const out = new Set<string>();
  let candidates: ReturnType<typeof routerV2Service.gatherCandidatesSync> = [];
  try { candidates = routerV2Service.gatherCandidatesSync(role); } catch { candidates = []; }
  for (const candidate of candidates) {
    const kind = harnesses.get(candidate.harnessId)?.kind;
    if (!kind || !hasResource(resources, role, candidate.harnessId, accountKey(candidate.accountId))) continue;
    if (role === "developer" ? kind !== "codex" || candidate.mode !== "auto" : !readOnlyReviewerContract(kind) || candidate.mode !== readOnlyReviewerContract(kind)!.mode) continue;
    out.add(candidate.modelId);
  }
  return [...out].sort();
}

export function computeEnvelope(projectPath: string, launchBudget: number): HandsoffEnvelope | { error: string } {
  const stored = handsoffStore.getPolicy(projectPath);
  const identity = identityOfProject(projectPath);
  const real = canonicalProject(projectPath);
  if (!stored?.policy.enabled) return { error: "Work independently is off for this project. Turn it on and save first." };
  if (!identity || !real) return { error: "The project folder is not available." };
  const { policy } = stored;
  if (policy.resources.length === 0) return { error: "Choose at least one covered resource first." };
  const developerModels = modelsFor("developer", policy.resources);
  const reviewerModels = modelsFor("reviewer", policy.resources);
  if (developerModels.length === 0 || reviewerModels.length === 0) {
    return { error: "No eligible Developer and Reviewer model was found for the covered harnesses and accounts. Nothing can be authorized." };
  }
  return envelopeFrom({ policy, projectPath: real, projectIdentity: identity, developerModels, reviewerModels, launchBudget });
}

/* ------------------------------------------------------------------------------------------------- state */

function stateOf(projectPath: string): { view: HandsoffAuthorizationView; row: AuthRow | null; envelope: HandsoffEnvelope | null } {
  const now = clock();
  const required = isProductionOwnerGateActive();
  const stored = handsoffStore.getPolicy(projectPath);
  const empty = (state: HandsoffAuthorizationState, reasons: string[] = []): HandsoffAuthorizationView => ({
    state, reasons, expiresAt: null, launchBudget: null, launchesUsed: null, launchesRemaining: null, envelope: null, authorizedAt: null, required,
  });
  if (!required) return { view: empty("not-required"), row: null, envelope: null };
  if (!stored?.policy.enabled) return { view: empty("off"), row: null, envelope: null };
  const row = activeRow(projectPath);
  if (!row) {
    const last = latestRow(projectPath);
    return { view: empty(last?.status === "revoked" ? "revoked" : "not-authorized"), row: null, envelope: null };
  }
  const envelope = envelopeOfRow(row);
  const used = launchesUsed(row.id);
  const base = {
    expiresAt: row.expires_at, launchBudget: row.launch_budget, launchesUsed: used, launchesRemaining: Math.max(0, row.launch_budget - used),
    envelope, authorizedAt: row.created_at, required,
  };
  const trust = currentOwnerTrustService();
  const grant = trust.store.grant(row.grant_id);
  if (!grant || grant.status !== "issued") return { view: { ...base, state: "revoked", reasons: [] }, row, envelope };
  if (row.expires_at <= now || grant.expires_at <= now) return { view: { ...base, state: "expired", reasons: [] }, row, envelope };
  const reasons: string[] = [];
  const enrolled = trust.store.activeByClass("production").find((enrollment) => sameCertPin(enrollment.signing_cert_sha256, trust.identity.certSha256));
  if (!enrolled || enrolled.id !== row.enrollment_id) reasons.push("enrollment");
  if (identityOfProject(projectPath) !== row.project_identity) reasons.push("project");
  const within = policyWithinEnvelope(stored.policy, envelope);
  if (!within.ok) reasons.push(...within.reasons);
  if (reasons.length > 0) return { view: { ...base, state: "needs-renewal", reasons }, row, envelope };
  if (used >= row.launch_budget) return { view: { ...base, state: "exhausted", reasons: [] }, row, envelope };
  return { view: { ...base, state: "active", reasons: [] }, row, envelope };
}

export function authorizationView(projectPathRaw: string): HandsoffAuthorizationView {
  const projectPath = registeredPath(projectPathRaw) ?? projectPathRaw;
  return stateOf(projectPath).view;
}

/* ------------------------------------------------------------------------------------------ authorize */

function buildOperation(projectPath: string, envelope: HandsoffEnvelope, digest: string, policyRevision: number, expiresAt: number, now: number) {
  const missionId = `handsoff:${envelope.projectIdentity.slice(0, 40)}`;
  const raw = {
    schema: OWNER_TRUST_SCHEMA,
    requestId: `handsoff:project:${randomUUID()}`,
    kind: "project-envelope",
    projectPath: envelope.projectPath,
    taskId: "policy-envelope",
    missionId,
    missionRevision: digest.slice(0, 64),
    role: "policy-envelope",
    providerId: "policy-envelope",
    harnessId: envelope.harnessIds.join(", "),
    modelId: "policy-envelope",
    accountId: envelope.accountIds.join(", "),
    mode: "Developer: Codex Auto in an isolated working copy. Reviewer: read-only.",
    workspace: envelope.projectPath,
    filesystem: "policy-envelope",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: false,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "handsoff-project",
    envelopeDigest: digest,
    policyRevision: String(policyRevision),
    scope: expectedScope({ kind: "project-envelope", role: "policy-envelope", providerId: "policy-envelope", accountId: envelope.accountIds.join(", "), modelId: "policy-envelope", missionId, policyRevision: String(policyRevision) }),
    runId: "policy-envelope",
    attemptId: "none",
    knownCost: `Unknown (subscription). Up to ${envelope.launchBudget} provider launches (Developer, Reviewer and corrections each count). Models: ${[...new Set([...envelope.developerModels, ...envelope.reviewerModels])].join(", ")}. Delivery: ${envelope.autoApply ? "applies the reviewed change to the project folder" : "result stays in its working copy"}${envelope.autoDone ? ", marks the task Done" : ""}.`,
    costCoverage: "unknown-subscription",
    expiresAt,
    cancellationAvailable: true,
    externalProcess: true,
    taskStateDigest: envelope.projectIdentity,
    missionStateDigest: envelope.projectIdentity,
  };
  return parseOwnerOperation(raw, now);
}

const interruptible = (code: string) => code === "authentication-cancelled" || code === "authentication-failed";

/**
 * The one native Owner confirmation. A refusal or cancellation leaves the previous authorization exactly as it was.
 */
export async function authorizeProject(projectPathRaw: string, options: { hours?: unknown; launches?: unknown; locale?: "en" | "ru" } = {}): Promise<HandsoffAuthorizationView> {
  const projectPath = registeredPath(projectPathRaw);
  if (!projectPath) throw new HandsoffError("That project is not registered in ForgeOrbit.", 404, "project");
  if (!isProductionOwnerGateActive()) return authorizationView(projectPath);
  const hours = options.hours === undefined ? HANDSOFF_AUTH_LIMITS.defaultHours : options.hours;
  const launches = options.launches === undefined ? HANDSOFF_AUTH_LIMITS.defaultLaunches : options.launches;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > HANDSOFF_AUTH_LIMITS.maxHours) {
    throw new HandsoffError(`The validity must be a whole number of hours from 1 to ${HANDSOFF_AUTH_LIMITS.maxHours}.`, 400, "invalid");
  }
  if (typeof launches !== "number" || !Number.isInteger(launches) || launches < HANDSOFF_AUTH_LIMITS.minLaunches || launches > HANDSOFF_AUTH_LIMITS.maxLaunches) {
    throw new HandsoffError(`The launch budget must be a whole number from ${HANDSOFF_AUTH_LIMITS.minLaunches} to ${HANDSOFF_AUTH_LIMITS.maxLaunches}.`, 400, "invalid");
  }
  if (autonomyPolicyStore.readEmergency().active) throw new HandsoffError("Emergency Stop is active. Nothing was authorized.", 409, "emergency-stop");
  if (inFlight.has(projectPath)) throw new HandsoffError("A confirmation for this project is already open.", 409, "in-progress");
  const envelope = computeEnvelope(projectPath, launches);
  if ("error" in envelope) throw new HandsoffError(envelope.error, 409, "envelope");
  const stored = handsoffStore.getPolicy(projectPath)!;
  const now = clock();
  const digest = envelopeDigest(envelope);
  const expiresAt = now + hours * 3_600_000;
  const built = buildOperation(projectPath, envelope, digest, stored.revision, expiresAt, now);
  if (!built.ok) throw new HandsoffError(built.reason, 409, built.code);
  inFlight.add(projectPath);
  pending.set(digest, envelope);
  try {
    const result = await authorizeProjectEnvelopeOperation({ operation: built.operation, canonical: built.canonical, digest: built.digest, locale: options.locale });
    if (!result.ok) {
      throw new HandsoffError(result.reason, interruptible(result.code) ? 409 : 403, result.code);
    }
    const trust = currentOwnerTrustService();
    const grant = trust.store.grant(result.grantId);
    if (!grant) throw new HandsoffError("The signed authorization could not be read back. Nothing was activated.", 500, "internal");
    const created = clock();
    const previous = activeRow(projectPath);
    db.transaction(() => {
      if (previous) db.run("UPDATE handsoff_authorizations SET status = 'superseded', ended_at = ? WHERE id = ?", [created, previous.id]);
      db.run(
        `INSERT INTO handsoff_authorizations (id, project_path, project_identity, grant_id, enrollment_id, envelope_json, envelope_digest, policy_revision, launch_budget, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [randomUUID(), projectPath, envelope.projectIdentity, result.grantId, grant.enrollment_id, JSON.stringify(envelope), digest, stored.revision, envelope.launchBudget, Math.min(expiresAt, grant.expires_at), created],
      );
    }).immediate();
    if (previous) { try { trust.revokeGrant(previous.grant_id); } catch { /* the row is already superseded */ } }
    announce(projectPath, "authorized");
    notifySmartQueueChanged(projectPath, "authorized");
    return authorizationView(projectPath);
  } finally {
    pending.delete(digest);
    inFlight.delete(projectPath);
  }
}

/** Revoke without any confirmation: it only narrows. New launches stop at once; live work is stopped like any stop. */
export async function revokeProjectAuthorization(projectPathRaw: string, reason = "The Owner revoked this project's authorization."): Promise<HandsoffAuthorizationView> {
  const projectPath = registeredPath(projectPathRaw) ?? projectPathRaw;
  const row = activeRow(projectPath);
  if (row) {
    db.run("UPDATE handsoff_authorizations SET status = 'revoked', ended_at = ? WHERE id = ? AND status = 'active'", [clock(), row.id]);
    try { currentOwnerTrustService().revokeGrant(row.grant_id); } catch { /* the authorization row already refuses launches */ }
    db.run("UPDATE handsoff_launches SET status = 'released', updated_at = ? WHERE authorization_id = ? AND status = 'reserved'", [clock(), row.id]);
    try {
      const { stopHandsoffForProject } = await import("./driver.ts");
      await stopHandsoffForProject(projectPath, reason);
    } catch { /* the revoked grant refuses every later launch regardless */ }
    announce(projectPath, "revoked");
  }
  return authorizationView(projectPath);
}

/* ------------------------------------------------------------------------------------------ launches */

const refuse = (code: string, reason: string) => ({ ok: false as const, code, reason });

registerEnvelopeAdmission((operation) => {
  const envelope = pending.get(operation.envelopeDigest);
  if (!envelope) return { ok: false, reason: "This process did not prepare that project envelope. It is not admitted." };
  if (envelope.projectPath !== operation.projectPath) return { ok: false, reason: "The envelope names another project." };
  const live = handsoffStore.getPolicy(envelope.projectPath);
  if (!live?.policy.enabled) return { ok: false, reason: "Work independently was turned off while the confirmation was open." };
  if (String(live.revision) !== operation.policyRevision) return { ok: false, reason: "The saved settings changed while the confirmation was open. Review them and authorize again." };
  if (identityOfProject(envelope.projectPath) !== envelope.projectIdentity) return { ok: false, reason: "The project changed while the confirmation was open." };
  const within = policyWithinEnvelope(live.policy, envelope);
  return within.ok ? { ok: true } : { ok: false, reason: "The saved settings are wider than the envelope that was shown." };
});

registerTicketDiscardObserver((childGrantId) => {
  db.run("UPDATE handsoff_launches SET status = 'released', updated_at = ? WHERE child_grant_id = ? AND status = 'reserved'", [clock(), childGrantId]);
  db.run("UPDATE owner_trust_grants SET status = 'revoked' WHERE id = ? AND status = 'consumed' AND NOT EXISTS (SELECT 1 FROM owner_trust_grant_uses WHERE grant_id = ?)", [childGrantId, childGrantId]);
});

registerProjectGrantAuthorizer(({ built, claim, mintTicket }) => {
  const now = clock();
  const projectPath = registeredPath(built.projectPath);
  if (!projectPath) return refuse("owner-project-paused", "The project is not registered.");
  if (autonomyPolicyStore.readEmergency().active) return refuse("owner-emergency-stop", "Emergency Stop is active. The project authorization does not override it.");
  const admission = checkProjectLaunchAdmission(projectPath);
  if (!admission.allowed) return refuse("owner-project-paused", `${admission.reason ?? "The project is not running."} The project authorization does not start it.`);
  const { view, row, envelope } = stateOf(projectPath);
  if (view.state !== "active" || !row || !envelope) {
    return refuse(`handsoff-authorization-${view.state === "needs-renewal" ? "renewal" : view.state}`, `This project's hands-off authorization is ${view.state}. Nothing was launched.`);
  }
  const run = handsoffStore.getRun(claim.handsoffRunId);
  if (!run || run.finishedAt != null || run.projectPath !== projectPath || run.taskId !== built.taskId || run.round !== claim.round) {
    return refuse("owner-operation-mismatch", "The launch is not part of an open hands-off run of this project and task.");
  }
  if (run.status === "stopped" || run.status === "cancelled") return refuse("owner-run-completed", "That hands-off work was stopped.");
  const op = built.operation;
  if (built.role !== "developer" && built.role !== "reviewer") return refuse("owner-envelope", "Only a Developer or an independent Reviewer can use a project authorization.");
  if (op.kind !== "single-operation" || op.terminalAllowed || op.browserAllowed || op.computerUseAllowed || op.gitPublish || op.deploymentAllowed) {
    return refuse("owner-privileged-excluded", "The launch asks for more than the project authorization covers.");
  }
  if (canonicalProject(op.projectPath) !== envelope.projectPath) return refuse("owner-envelope", "The launch leaves the authorized project.");
  if (!envelope.harnessIds.includes(built.harnessId)) return refuse("owner-envelope", "That harness is not covered by the authorization.");
  if (!envelope.accountIds.includes(built.accountId)) return refuse("owner-envelope", "That account is not covered by the authorization.");
  if (!hasResource(envelope.resources, built.role, built.harnessId, built.accountId)) return refuse("owner-envelope", "That harness and account are not covered for this role by the authorization.");
  const kind = harnesses.get(built.harnessId)?.kind ?? "";
  if (built.role === "developer") {
    if (built.mode !== envelope.developerMode || op.filesystem !== "workspace-write" || kind !== "codex") return refuse("owner-sandbox", "The Developer launch is outside Codex Auto in an isolated working copy.");
    if (!envelope.developerModels.includes(built.modelId)) return refuse("owner-envelope", "That model is not covered for the Developer.");
  } else {
    const contract = readOnlyReviewerContract(kind);
    if (!contract || built.mode !== contract.mode || op.filesystem !== "read-only") return refuse("owner-sandbox", "The Reviewer launch is not read-only.");
    if (!envelope.reviewerModels.includes(built.modelId)) return refuse("owner-envelope", "That model is not covered for the Reviewer.");
  }
  const task = tasks.get(built.taskId);
  if (!task || task.archivedAt != null || canonicalProject(task.workdir) !== envelope.projectPath) return refuse("owner-task-stale", "The task is not in this project any more.");
  if (built.role === "developer") {
    const availability = taskAvailabilityFor(task, now);
    if (!availability.available) {
      return refuse("scheduled-not-yet-available", `Task is scheduled to be available from ${availability.availableFromUtc}. Waiting for scheduled time.`);
    }
  }
  if (op.taskStateDigest !== taskBindingDigest({ id: task.id, prompt: task.prompt, workdir: task.workdir, column: task.column })) {
    return refuse("owner-task-stale", "The task changed after this launch was prepared.");
  }
  const claimKey = launchClaimKey({ handsoffRunId: claim.handsoffRunId, role: built.role, round: claim.round, intentAt: claim.intentAt });
  const childId = randomUUID();
  const trust = currentOwnerTrustService();
  const reserved = db.transaction((): { ok: true } | { ok: false; code: string; reason: string } => {
    const fresh = db.query<AuthRow, [string]>("SELECT * FROM handsoff_authorizations WHERE id = ? AND status = 'active'").get(row.id);
    if (!fresh || fresh.expires_at <= now) return refuse("handsoff-authorization-expired", "The authorization ended before this launch.");
    if (db.query("SELECT 1 FROM handsoff_launches WHERE claim_key = ?").get(claimKey)) {
      return refuse("owner-already-consumed", "This launch was already claimed. A replay does not mint a second grant.");
    }
    if (launchesUsed(row.id) >= fresh.launch_budget) return refuse("handsoff-authorization-exhausted", "The authorization's launch budget is used up. Nothing was launched.");
    db.run(
      `INSERT INTO owner_trust_grants (id, challenge_id, enrollment_id, operation_digest, operation_canonical, status, expires_at, consumed_at, task_id, mission_id, project_path, created_at)
       VALUES (?, ?, ?, ?, ?, 'consumed', ?, ?, ?, ?, ?, ?)`,
      [childId, `child:${childId}`, row.enrollment_id, built.digest, built.canonical, Math.min(op.expiresAt, fresh.expires_at), now, built.taskId, op.missionId, op.projectPath, now],
    );
    db.run(
      `INSERT INTO handsoff_launches (claim_key, authorization_id, handsoff_run_id, task_id, role, child_grant_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      [claimKey, row.id, claim.handsoffRunId, built.taskId, built.role, childId, now, now],
    );
    return { ok: true };
  }).immediate();
  if (!reserved.ok) return reserved;
  trust.store.recordDecision({ challengeId: null, grantId: childId, enrollmentId: row.enrollment_id, operationDigest: built.digest, code: "owner-grant-consumed", decision: "consumed", now });
  const ticket = mintTicket(childId);
  if (!ticket.ok) {
    db.run("UPDATE handsoff_launches SET status = 'released', updated_at = ? WHERE child_grant_id = ?", [now, childId]);
    return ticket;
  }
  return ticket;
});

/**
 * Boot: no in-memory ticket survives a restart. A reservation whose run was recorded stays counted; one that never
 * reached a run goes back to the budget. Nothing is started and no grant is minted.
 */
export function recoverHandsoffAuthorizations(): { released: number } {
  const rows = db.query<{ child_grant_id: string }, []>("SELECT child_grant_id FROM handsoff_launches WHERE status = 'reserved'").all();
  let released = 0;
  for (const { child_grant_id } of rows) {
    const used = db.query("SELECT 1 FROM owner_trust_grant_uses WHERE grant_id = ?").get(child_grant_id);
    if (used) continue;
    db.run("UPDATE handsoff_launches SET status = 'released', updated_at = ? WHERE child_grant_id = ?", [clock(), child_grant_id]);
    db.run("UPDATE owner_trust_grants SET status = 'revoked' WHERE id = ? AND status = 'consumed'", [child_grant_id]);
    released += 1;
  }
  return { released };
}

export { localOwnerIdentityEstablished };
