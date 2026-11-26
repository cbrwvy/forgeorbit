/**
 * FO-HEAD01 — company-wide read-only coordination snapshot for Head of PM.
 * Uses existing stores only; does not start agents or mutate workflow state.
 */

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { HeadPortfolioBindingCore } from "./head-portfolio-binding.ts";
import { ClusterCore } from "./cluster-core.ts";
import { ownershipOf } from "./project-ownership.ts";
import { listWorkflowHolds } from "./pm-orchestrated-workflow.ts";
import { readOwnerActions } from "./owner-actions.ts";
import { listHeadPmInitiatives } from "./head-pm-initiative.ts";
import { db, harnesses, portfolioManagerStore, projectManagers, projects, tasks } from "./db.ts";
import { interviewSupportFor } from "../shared/project-interview.ts";
import { DEFAULT_MANAGER_CONFIG, sanitizeManagerConfig, sanitizeStoredProposal } from "../shared/project-manager.ts";
import type { ColumnId } from "../shared/types.ts";
import type {
  HeadPmActiveWorkflowRow,
  HeadPmClusterRow,
  HeadPmCoordinationSnapshot,
  HeadPmDelegationRow,
  HeadPmProjectRow,
} from "../shared/head-pm-coordination.ts";
import { sanitizeDelegation, type DelegationProposal } from "../shared/portfolio-manager.ts";

const COLUMN_IDS: ColumnId[] = ["backlog", "inbox", "ready", "running", "blocked", "review", "done"];

function pathExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realpath(p: string): string | null {
  try {
    return statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface ManagerProbe {
  configured: boolean;
  problem: string | null;
}

function probeProjectManager(projectPath: string): ManagerProbe {
  if (!projects.get(projectPath)) return { configured: false, problem: "This project is no longer registered." };
  const row = projectManagers.getConfig(projectPath);
  const config = row ? sanitizeManagerConfig(parseJson(row.config)) : { ...DEFAULT_MANAGER_CONFIG };
  let harnessId = config.harness;
  if (config.profileId) {
    const profile = db.query<{ harness: string }, [string]>("SELECT harness FROM agent_profiles WHERE id = ?").get(config.profileId);
    if (!profile) return { configured: false, problem: "The agent profile for this project's manager no longer exists." };
    harnessId = profile.harness;
  }
  if (!harnessId) {
    return { configured: false, problem: "This project's manager has no agent configured yet." };
  }
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness) return { configured: false, problem: `Harness "${harnessId}" was not found.` };
  if (!harness.enabled) return { configured: false, problem: `${harness.label} is disabled.` };
  const support = interviewSupportFor(harness.kind);
  if (!support.supported) return { configured: false, problem: support.reason ?? "Harness not supported." };
  if (config.consentKey == null) {
    return { configured: false, problem: "Confirm the agent in this project's Manager tab before delegating." };
  }
  return { configured: true, problem: null };
}

function pmEmployee(projectPath: string): HeadPmProjectRow["projectManager"] {
  const row = db.query<{ id: string; name: string; job_title: string }, [string]>(
    `SELECT id, name, job_title FROM ai_employees
     WHERE kind = 'project-manager' AND project_path = ? AND archived_at IS NULL LIMIT 1`,
  ).get(projectPath);
  if (!row) return null;
  return { employeeId: row.id, name: row.name, jobTitle: row.job_title };
}

function taskColumnsByProject(projectPaths: string[]): Map<string, Partial<Record<ColumnId, number>>> {
  const out = new Map<string, Partial<Record<ColumnId, number>>>();
  for (const p of projectPaths) out.set(p, {});
  const rows = db.query<{ workdir: string; column: string }, []>(
    `SELECT workdir, column FROM tasks WHERE archived_at IS NULL AND (pipeline_parent_id IS NULL OR pipeline_parent_id = '')`,
  ).all();
  for (const row of rows) {
    const owner = ownershipOf(row.workdir);
    if (owner.kind !== "owned") continue;
    const col = row.column as ColumnId;
    if (!COLUMN_IDS.includes(col)) continue;
    const bucket = out.get(owner.projectPath) ?? {};
    bucket[col] = (bucket[col] ?? 0) + 1;
    out.set(owner.projectPath, bucket);
  }
  return out;
}

function activeWorkflows(projectPath: string): HeadPmActiveWorkflowRow[] {
  return db.query<{ id: string; task_id: string; status: string; phase: string }, [string]>(
    `SELECT id, task_id, status, phase FROM pm_orchestrated_workflows
     WHERE project_path = ? AND status IN ('active', 'paused', 'awaiting_owner') ORDER BY updated_at DESC LIMIT 5`,
  ).all(projectPath).map((row) => {
    const task = tasks.get(row.task_id);
    return {
      id: row.id,
      taskId: row.task_id,
      title: task?.title ?? row.task_id.slice(0, 8),
      status: row.status,
      phase: row.phase,
    };
  });
}

function pendingProposalCount(projectPath: string): number {
  return projectManagers.listProposals(projectPath).filter((raw) => {
    const proposal = sanitizeStoredProposal(parseJson(raw));
    return proposal?.status === "pending";
  }).length;
}

function loadDelegations(): DelegationProposal[] {
  return portfolioManagerStore.listDelegations()
    .map((raw) => sanitizeDelegation(parseJson(raw)))
    .filter((item): item is DelegationProposal => item != null);
}

function clusterIndex(database: Database): {
  clusters: HeadPmClusterRow[];
  membership: Map<string, { id: string; name: string }>;
  unassigned: string[];
} {
  const core = new ClusterCore(database, { pathExists, realpath });
  const clusters: HeadPmClusterRow[] = core.list({ includeArchived: false }).map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    projectPaths: core.listProjects(cluster.id).map((p) => p.projectPath),
  }));
  const membership = new Map<string, { id: string; name: string }>();
  for (const row of clusters) {
    for (const path of row.projectPaths) membership.set(path, { id: row.id, name: row.name });
  }
  const unassigned = core.listUnassigned().map((p) => p.projectPath);
  return { clusters, membership, unassigned };
}

/** Bounded company picture for API and Head of PM UI. */
export function buildHeadPmCoordination(database: Database = db): HeadPmCoordinationSnapshot {
  const capturedAt = Date.now();
  const binding = new HeadPortfolioBindingCore(database).get();
  const { clusters, membership, unassigned } = clusterIndex(database);
  const registered = projects.list();
  const columns = taskColumnsByProject(registered.map((p) => p.path));
  const projectRows: HeadPmProjectRow[] = registered.map((project) => {
    const cluster = membership.get(project.path) ?? null;
    const probe = probeProjectManager(project.path);
    const workflows = activeWorkflows(project.path);
    return {
      projectPath: project.path,
      projectName: project.name,
      clusterId: cluster?.id ?? null,
      clusterName: cluster?.name ?? null,
      projectManager: pmEmployee(project.path),
      managerConfigured: probe.configured,
      managerProblem: probe.problem,
      columns: columns.get(project.path) ?? {},
      pendingProposals: pendingProposalCount(project.path),
      activeWorkflows: workflows,
    };
  });
  const delegations: HeadPmDelegationRow[] = loadDelegations().map((item) => ({
    id: item.id,
    projectPath: item.projectPath,
    projectName: item.projectName,
    objective: item.objective,
    status: item.status,
  }));
  const owner = readOwnerActions();
  return {
    capturedAt,
    headBound: binding.status === "bound",
    headName: binding.head?.name ?? null,
    clusters,
    unassignedProjectPaths: unassigned,
    projects: projectRows,
    delegations,
    ownerQueue: {
      pendingProposals: owner.proposals.length,
      pendingDelegations: owner.delegations.length,
      batchHolds: owner.batchHolds.length,
      orchestratedHolds: (owner.orchestratedWorkflowHolds ?? listWorkflowHolds()).length,
    },
  };
}

const MAX_STRUCTURE_LINES = 24;
const MAX_PROJECT_EXTRA_LINES = 4;

/** Lines injected into the portfolio manager prompt (FO-HEAD01). */
export function companyStructureLines(snapshot: HeadPmCoordinationSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.clusters.length === 0 && snapshot.unassignedProjectPaths.length === 0) {
    lines.push("Company structure: no registered projects.");
    return lines;
  }
  lines.push(`Company structure: ${snapshot.clusters.length} cluster(s); ${snapshot.projects.length} registered project(s).`);
  if (snapshot.headBound && snapshot.headName) lines.push(`Head of Project Management (bound): ${snapshot.headName}.`);
  else lines.push("Head of Project Management: not bound to an employee identity (portfolio turns may be unattributed).");
  let used = lines.length;
  for (const cluster of snapshot.clusters) {
    if (used >= MAX_STRUCTURE_LINES) {
      lines.push("Additional clusters omitted by size limit.");
      break;
    }
    const names = cluster.projectPaths
      .map((path) => snapshot.projects.find((p) => p.projectPath === path)?.projectName ?? path)
      .slice(0, 8);
    const more = cluster.projectPaths.length > names.length ? ` (+${cluster.projectPaths.length - names.length} more)` : "";
    lines.push(`Cluster “${cluster.name}”: ${names.join(", ") || "no projects"}${more}.`);
    used += 1;
  }
  if (snapshot.unassignedProjectPaths.length > 0 && used < MAX_STRUCTURE_LINES) {
    lines.push(`Unassigned projects: ${snapshot.unassignedProjectPaths.length}.`);
  }
  const pending = snapshot.delegations.filter((d) => d.status === "proposed" || d.status === "failed").length;
  const inFlight = snapshot.delegations.filter((d) => d.status === "sent" || d.status === "sending").length;
  if (pending > 0) lines.push(`Portfolio delegations awaiting Owner approval or retry: ${pending}.`);
  if (inFlight > 0) lines.push(`Portfolio delegations waiting for a project manager answer: ${inFlight}.`);
  const q = snapshot.ownerQueue;
  if (q.pendingProposals > 0) lines.push(`Pending task proposals across projects (Owner approval): ${q.pendingProposals}.`);
  if (q.orchestratedHolds > 0) lines.push(`Bounded orchestration workflows on hold: ${q.orchestratedHolds}.`);
  for (const item of listHeadPmInitiatives().filter((i) => i.status !== "cancelled").slice(0, 4)) {
    if (used >= MAX_STRUCTURE_LINES) break;
    lines.push(`Initiative “${item.title}”: ${item.status}; ${item.contributions.length} project(s).`);
    used += 1;
  }
  return lines.slice(0, MAX_STRUCTURE_LINES);
}

/** Per-project lines added in gatherPortfolioContext. */
export function projectCoordinationExtraLines(projectPath: string, snapshot: HeadPmCoordinationSnapshot): string[] {
  const row = snapshot.projects.find((p) => p.projectPath === projectPath);
  if (!row) return [];
  const lines: string[] = [];
  if (row.clusterName) lines.push(`Cluster: ${row.clusterName}.`);
  else lines.push("Cluster: unassigned.");
  if (row.projectManager) lines.push(`Project manager identity: ${row.projectManager.name} (${row.projectManager.jobTitle}).`);
  else lines.push("Project manager identity: none created yet (manager chat may still work).");
  if (row.pendingProposals > 0) lines.push(`Pending task proposals (Owner approval, not executable): ${row.pendingProposals}.`);
  if (row.activeWorkflows.length > 0) {
    const wf = row.activeWorkflows.slice(0, 3).map((w) => `#${w.taskId.slice(0, 8)} ${w.title} — ${w.status}/${w.phase}`).join("; ");
    lines.push(`Bounded orchestration (FO-AUTO01): ${wf}${row.activeWorkflows.length > 3 ? " …" : ""}.`);
  }
  return lines.slice(0, MAX_PROJECT_EXTRA_LINES);
}
