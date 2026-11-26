/** FO-HEAD-AUTO01: durable sequential dispatch of existing approved FO-AUTO02 batches. */
import { createHash, randomUUID } from "node:crypto";
import { db, tasks, headPmInitiatives } from "./db.ts";
import { getHeadPmInitiative, linkHeadPmBatch } from "./head-pm-initiative.ts";
import { getOrchestratedBatch, startOrchestratedBatch, pauseOrchestratedBatch, resumeOrchestratedBatch, cancelOrchestratedBatch } from "./pm-orchestrated-batch.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { workflowResourceBlock } from "./orchestrated-resources.ts";
import { grantForBatchTask } from "../shared/pm-orchestrated-batch.ts";
import { launchFingerprint } from "../shared/task-scheduling.ts";
import { broadcastAppEvent, subscribeAppEvents } from "./quit-guard.ts";
import { loadHeadAuto, activeBatchConflict } from "./head-pm-auto-boundary.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import type { HeadAutoPlan, HeadAutoRecord, HeadAutoView } from "../shared/head-pm-auto.ts";

export class HeadAutoError extends Error { readonly status = 409; }
const requireThat: (condition: unknown, text: string) => asserts condition = (c, text) => { if (!c) throw new HeadAutoError(text); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function save(c: HeadAutoRecord, text?: string): void {
  c.updatedAt = Date.now();
  if (text) c.history.push({ at: c.updatedAt, text });
  db.run(`INSERT INTO head_pm_auto (id, initiative_id, status, data_json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, data_json=excluded.data_json, updated_at=excluded.updated_at`,
    [c.id, c.initiativeId, c.status, JSON.stringify(c), c.updatedAt]);
  broadcastAppEvent({ type: "head_pm_initiative", initiativeId: c.initiativeId, status: JSON.parse(headPmInitiatives.get(c.initiativeId) ?? "null")?.status ?? "cancelled", ts: c.updatedAt });
}
function release(c: HeadAutoRecord) { db.run("DELETE FROM head_pm_auto_reservations WHERE coordination_id = ?", [c.id]); }
export function getHeadAuto(initiativeId: string): HeadAutoView {
  const row = db.query<{id: string}, [string]>("SELECT id FROM head_pm_auto WHERE initiative_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(initiativeId);
  const c = row ? loadHeadAuto(row.id) : null;
  return { record: c, batches: c ? c.plan.projects.flatMap(p => { const b = getOrchestratedBatch(p.projectPath, p.batchId); return b ? [b] : []; }) : [] };
}
function initiativeGate(id: string) {
  const i = getHeadPmInitiative(id);
  requireThat(i && i.cancelledAt == null, "Initiative is cancelled or unavailable.");
  requireThat(i.contributions.length === 2 && new Set(i.contributions.map(c => c.projectPath)).size === 2, "Exactly two distinct projects are required.");
  // Manual initiative creation is an explicit Owner action; chat proposals only create after approval.
  if (i.sourceProposalId) {
    const row = db.query<{status: string}, [string]>("SELECT status FROM head_pm_initiative_proposals WHERE id = ?").get(i.sourceProposalId);
    requireThat(row?.status === "approved", "Initiative proposal lacks Owner approval.");
  }
  for (const c of i.contributions) {
    const d = i.delegations.find(d => d.id === c.delegationId && d.projectPath === c.projectPath && d.initiativeId === i.id);
    requireThat(d && (d.status === "sent" || d.status === "answered"), `${c.projectName}: delegation requires Owner approval and delivery.`);
    requireThat(!c.manuallyClosed, `${c.projectName}: contribution is closed.`);
  }
  return i;
}
function validate(c: HeadAutoRecord): void {
  const i = initiativeGate(c.initiativeId);
  requireThat(digest(c.plan) === c.digest, "Frozen coordination plan changed.");
  requireThat(c.plan.expiresAt > Date.now(), "Coordination authorization expired.");
  for (const p of c.plan.projects) {
    const contribution = i.contributions.find(x => x.projectPath === p.projectPath);
    requireThat(contribution?.delegationId === p.delegationId && contribution.orchestratedBatchIds.includes(p.batchId), "Initiative delegation or batch reference changed.");
    const b = getOrchestratedBatch(p.projectPath, p.batchId)?.batch;
    requireThat(b && b.revision === p.revision && digest(b.tasks) === digest(p.tasks) && digest(b.policy) === digest(p.policy), "Project batch plan or grant changed.");
    if (c.completedBatchIds.includes(p.batchId)) {
      requireThat(b.status === "completed", "Completed batch state changed.");
      continue;
    }
    const lifecycle = checkProjectLaunchAdmission(p.projectPath);
    requireThat(lifecycle.allowed, `${p.projectName}: ${lifecycle.reason}`);
    requireThat(b.policy && b.policy.expiresAt != null && b.policy.expiresAt > Date.now(), "Project batch grant expired.");
    for (const plan of b.tasks) {
      const a = new AssignmentCore(db).forTask(plan.taskId);
      const frozen = p.assignments.find(x => x.taskId === plan.taskId);
      requireThat(a && a.employeeId === plan.implementerEmployeeId && a.revision === frozen?.revision, `“${plan.title}”: Developer assignment changed.`);
      const task = tasks.get(plan.taskId);
      requireThat(task?.workdir === p.projectPath, "Task project changed.");
      const phase = b.progress.byTask[plan.taskId]?.phase;
      if (phase === "queued") requireThat(task.column === "ready" && launchFingerprint(task) === plan.fingerprint, `“${plan.title}”: task changed since approval.`);
      const grant = { ...grantForBatchTask(b, plan), orchestratedBatchId: undefined };
      const blocker = workflowResourceBlock(grant) ?? workflowResourceBlock(grant, true);
      requireThat(!blocker, blocker ?? "Resource unavailable.");
    }
  }
}
export function prepareHeadAuto(initiativeId: string, batchIds: unknown): HeadAutoView {
  const i = initiativeGate(initiativeId);
  requireThat(Array.isArray(batchIds) && batchIds.length === 2 && batchIds.every(id => typeof id === "string") && new Set(batchIds).size === 2, "Select two distinct project batches in execution order.");
  const old = getHeadAuto(initiativeId).record;
  requireThat(!old || ["draft", "cancelled", "completed"].includes(old.status), "Cancel the existing coordination before preparing a replacement.");
  const projects = batchIds.map(id => {
    const contribution = i.contributions.find(c => getOrchestratedBatch(c.projectPath, id));
    requireThat(contribution, "Batch does not belong to an initiative project.");
    const b = getOrchestratedBatch(contribution.projectPath, id)!.batch;
    requireThat(b.status === "approved" && b.policy && b.policy.expiresAt != null, "Each project batch needs its own unexpired Owner approval.");
    requireThat(b.policy.autoReviewAfterImplementation && !b.policy.autoReworkOnChanges && b.policy.maxReworkIterations === 0 && b.policy.maxConcurrent === 1, "Coordination requires automatic QC, concurrency 1 and no rework.");
    return { projectPath: contribution.projectPath, projectName: contribution.projectName, pmName: contribution.pmName,
      delegationId: contribution.delegationId!, batchId: b.id, revision: b.revision, tasks: b.tasks, policy: b.policy,
      assignments: b.tasks.map(t => { const a = new AssignmentCore(db).forTask(t.taskId); requireThat(a, "Developer assignment is missing."); return {taskId: t.taskId, employeeId: a.employeeId, employeeName: db.query<{name: string}, [string]>("SELECT name FROM ai_employees WHERE id = ?").get(a.employeeId)?.name ?? a.employeeId, revision: a.revision}; }) };
  });
  requireThat(new Set(projects.map(p => p.projectPath)).size === 2, "Select one batch per distinct project.");
  for (const p of projects) { const linked = linkHeadPmBatch(i.id, p.projectPath, p.batchId); requireThat(linked.ok, "Could not link project batch."); }
  const plan: HeadAutoPlan = { initiativeId, title: i.title, projects, maxLaunches: projects.reduce((n,p) => n + p.tasks.length * p.policy.maxLaunchesPerTask, 0),
    expiresAt: Math.min(...projects.map(p => p.policy.expiresAt!)), globalConcurrency: 1, continuation: "all_tasks_qc_pass", failurePolicy: "stop_no_retry_no_rework", quota: "unknown" };
  const now = Date.now();
  const c: HeadAutoRecord = { id: old?.status === "draft" ? old.id : randomUUID(), initiativeId, status: "draft", plan, digest: digest(plan), authorization: null,
    currentIndex: 0, completedBatchIds: [], blocker: null, reservations: projects.map(p => ({ batchId: p.batchId, state: "reserved", at: now })), history: [], createdAt: now, updatedAt: now };
  validate(c); save(c, "Prepared exact two-project plan; execution is not authorized.");
  return getHeadAuto(initiativeId);
}
export function authorizeHeadAuto(initiativeId: string, approvedDigest: unknown): HeadAutoView {
  const c = getHeadAuto(initiativeId).record;
  requireThat(c?.status === "draft" && c.digest === approvedDigest, "Review the current plan digest before authorizing.");
  validate(c);
  db.transaction(() => {
    release(c);
    for (const p of c.plan.projects) {
      requireThat(getOrchestratedBatch(p.projectPath, p.batchId)?.batch.status === "approved", "Batch is no longer approved and unstarted.");
      requireThat(!db.query("SELECT batch_id FROM head_pm_auto_reservations WHERE batch_id = ?").get(p.batchId), "Batch is reserved by another coordination.");
      db.run("INSERT INTO head_pm_auto_reservations (batch_id, coordination_id) VALUES (?, ?)", [p.batchId, c.id]);
    }
    c.authorization = { approvedBy: "owner", approvedAt: Date.now(), digest: c.digest, expiresAt: c.plan.expiresAt };
    c.status = "approved";
    save(c, "Owner explicitly authorized this exact A → B sequence through QC PASS; task acceptance remains separate.");
  }).immediate();
  return getHeadAuto(initiativeId);
}
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; }
function auth(c: HeadAutoRecord) {
  requireThat(c.authorization?.digest === c.digest && c.authorization.expiresAt > Date.now(), "Fresh explicit coordination authorization required or expired.");
  validate(c);
}
async function block(c: HeadAutoRecord, reason: string) {
  c.status = "blocked"; c.blocker = reason; save(c, reason);
  const p = c.plan.projects[c.currentIndex];
  if (p && getOrchestratedBatch(p.projectPath, p.batchId)?.batch.status === "running") await pauseOrchestratedBatch(p.projectPath, p.batchId, reason);
}
async function tick(c: HeadAutoRecord): Promise<void> {
  if (c.status !== "running") return;
  try {
    auth(c);
    const p = c.plan.projects[c.currentIndex];
    if (!p) { c.status = "completed"; release(c); save(c, "Both project batches passed QC. Owner must accept tasks explicitly."); return; }
    const b = getOrchestratedBatch(p.projectPath, p.batchId)!.batch;
    if (b.status === "completed") {
      requireThat(b.tasks.every(t => b.progress.byTask[t.taskId]?.phase === "awaiting_owner" && tasks.get(t.taskId)?.qcState?.latestVerdict === "PASS"), "Project batch did not finish with independent QC PASS on every task.");
      c.completedBatchIds.push(p.batchId); c.reservations[c.currentIndex]!.state = "completed"; c.currentIndex++;
      save(c, `${p.projectName}: QC PASS; advancing under the existing explicit sequence authorization.`);
      await tick(c); return;
    }
    requireThat(b.status === "approved" || b.status === "running", `${p.projectName}: ${b.progress.pauseReason ?? `batch ${b.status}`}`);
    if (b.status === "approved") {
      requireThat(c.reservations[c.currentIndex]?.state === "reserved", "Dispatch reservation was already consumed; Owner review required.");
      requireThat(!db.query("SELECT id FROM pm_orchestrated_batches WHERE status = 'running'").get() && !activeBatchConflict(p?.batchId), "Another project batch is running or has unsettled Runs; global concurrency is 1.");
      c.reservations[c.currentIndex]!.state = "dispatched";
      save(c, `${p.projectName}: dispatch reserved before batch start.`);
      await startOrchestratedBatch(p.projectPath, p.batchId, { coordinationId: c.id, digest: c.digest });
    }
  } catch (e) { await block(c, e instanceof Error ? e.message : String(e)); }
}
export function tickHeadAuto(id: string): Promise<void> { return serialized(async () => { const c = loadHeadAuto(id); if (c) await tick(c); }); }
export function actHeadAuto(initiativeId: string, action: string): Promise<HeadAutoView> {
  return serialized(async () => {
    const c = getHeadAuto(initiativeId).record; requireThat(c, "Prepare a coordination plan first.");
    const p = c.plan.projects[c.currentIndex];
    if (action === "cancel") {
      requireThat(c.status !== "completed", "Coordination already completed.");
      c.status = "cancelled"; c.blocker = "Cancelled by Owner."; save(c, c.blocker);
      if (p && ["running", "paused"].includes(getOrchestratedBatch(p.projectPath, p.batchId)?.batch.status ?? "")) await cancelOrchestratedBatch(p.projectPath, p.batchId);
      release(c);
    } else if (action === "pause") {
      requireThat(c.status === "running" || c.status === "approved", "Only an authorized coordination can pause.");
      c.status = "paused"; c.blocker = "Paused by Owner."; save(c, c.blocker);
      if (p && getOrchestratedBatch(p.projectPath, p.batchId)?.batch.status === "running") await pauseOrchestratedBatch(p.projectPath, p.batchId);
    } else {
      requireThat(action === "start" || action === "resume", "Unknown coordination action.");
      requireThat(action === "start" ? c.status === "approved" : c.status === "paused", "Coordination cannot start/resume in this state.");
      try { auth(c); }
      catch (e) { await block(c, (e as Error).message); throw e; }
      requireThat(!db.query("SELECT id FROM head_pm_auto WHERE status = 'running' AND id != ?").get(c.id), "Another Head coordination is running.");
      requireThat(!db.query("SELECT id FROM pm_orchestrated_batches WHERE status = 'running'").get() && !activeBatchConflict(p?.batchId), "Another project batch is running or has unsettled Runs; global concurrency is 1.");
      c.status = "running"; c.blocker = null; save(c, `Owner ${action}.`);
      if (action === "resume" && p && getOrchestratedBatch(p.projectPath, p.batchId)?.batch.status === "paused") {
        try { await resumeOrchestratedBatch(p.projectPath, p.batchId, {coordinationId: c.id, digest: c.digest}); }
        catch (e) { await block(c, (e as Error).message); }
      }
      await tick(c);
    }
    return getHeadAuto(initiativeId);
  });
}
let initialized = false;
export function initHeadAuto(): void {
  if (initialized) return; initialized = true;
  subscribeAppEvents(e => {
    if (e.type === "head_pm_initiative" && e.status === "cancelled") {
      const row = db.query<{initiative_id: string}, [string]>("SELECT initiative_id FROM head_pm_auto WHERE initiative_id = ? AND status NOT IN ('cancelled', 'completed')").get(e.initiativeId);
      if (row) void actHeadAuto(row.initiative_id, "cancel").catch(() => { /* A queued cancellation may arrive after terminal completion. */ });
      return;
    }
    if (e.type !== "execution_batch") return;
    // Queue after the batch write/lock settles; no HTTP Owner impersonation.
    for (const row of db.query<{id: string}, []>("SELECT id FROM head_pm_auto WHERE status = 'running'").all()) void tickHeadAuto(row.id);
  });
}
export function recoverHeadAuto(): void {
  initHeadAuto();
  for (const row of db.query<{id: string}, []>("SELECT id FROM head_pm_auto WHERE status = 'running'").all()) {
    const c = loadHeadAuto(row.id)!;
    const p = c.plan.projects[c.currentIndex];
    const b = p ? getOrchestratedBatch(p.projectPath, p.batchId)?.batch : null;
    // A backend restart cannot prove ownership of the previous active Run.
    // Hold before FO-AUTO01/02 recovery is scheduled; keep all existing Run IDs.
    if (p && b?.status === "running") {
      c.status = "blocked";
      c.blocker = "Backend restarted during an active project batch; inspect existing Runs and prepare fresh Owner authorization. No replay.";
      save(c, c.blocker);
      void pauseOrchestratedBatch(p.projectPath, p.batchId, c.blocker).catch(() => { /* A terminal batch is preserved. */ });
    // A reservation persisted without a started batch is ambiguous. Never replay it.
    } else if (p && c.reservations[c.currentIndex]?.state === "dispatched" && b?.status === "approved") {
      c.status = "blocked"; c.blocker = "Restart found an uncommitted dispatch reservation; new Owner plan required."; save(c, c.blocker);
    } else void tickHeadAuto(c.id);
  }
}
