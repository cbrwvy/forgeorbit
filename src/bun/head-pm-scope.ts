/** Server-owned context selection. Never use a model-generated path to fetch data. */
import { db, projects, tasks, taskScheduling } from "./db.ts";
import { classifyWorkdirs, ownershipOf } from "./project-ownership.ts";
import { InfrastructureCore } from "./infrastructure-core.ts";
import { capText, redactSecrets } from "../shared/project-interview.ts";
import type { HeadScope, HeadScopeSnapshot } from "../shared/head-pm-scope.ts";
import type { ContextSource } from "../shared/project-manager.ts";
import type { PortfolioPromptContext, PortfolioPromptProject, ProjectRefs } from "../shared/portfolio-manager.ts";
import { routerV2Service } from "./router-v2/router-v2-service.ts";

type Cluster = { id: string; name: string; slug: string | null };
const MAX_PROJECTS = 64;
const MAX_TASKS = 128;
const MAX_WORKERS = 64;

const clean = (text: string, length = 120) => capText(redactSecrets(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").trim(), length);
const clusters = () => db.query<Cluster, []>(
  "SELECT id, name, slug FROM clusters WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id",
).all();
const membership = (path: string) => db.query<Cluster, [string]>(
  `SELECT c.id,c.name,c.slug FROM clusters c JOIN cluster_project_memberships m ON m.cluster_id=c.id
    WHERE m.project_path=? AND c.archived_at IS NULL`,
).get(path);
const named = (actual: string, requested: string) =>
  actual.normalize("NFC").toLowerCase() === requested.trim().normalize("NFC").toLowerCase();

type ScopeResult = { ok: true; value: HeadScopeSnapshot } | { ok: false; status: number; error: string };
type Resolution = "selection" | "canonical";

export function resolveHeadScope(scope: HeadScope, mode: Resolution = "canonical"): ScopeResult {
  const missing = { ok: false, status: 404, error: "That scope is unavailable. Select a registered cluster, project, or task." } as const;
  const ambiguous = { ok: false, status: 409, error: "More than one target has that name. Select the exact cluster or project." } as const;
  if (scope.kind === "workspace") return { ok: true, value: { scope, label: "Workspace", projectPath: null, projectAddedAt: null, clusterId: null } };
  if (scope.kind === "cluster") {
    const rows = clusters();
    const exact = rows.find((c) => c.id === scope.id);
    const matches = exact ? [exact] : mode === "selection" ? rows.filter((c) => named(c.name, scope.id) || (c.slug && named(c.slug, scope.id))) : [];
    if (matches.length > 1) return ambiguous;
    const cluster = matches[0];
    if (!cluster) return missing;
    return { ok: true, value: { scope: { kind: "cluster", id: cluster.id }, label: cluster.name, projectPath: null, projectAddedAt: null, clusterId: cluster.id } };
  }
  const task = scope.kind === "task" ? tasks.get(scope.id) : null;
  if (scope.kind === "task" && (!task || task.archivedAt != null || task.pipelineParentId)) return missing;
  let project = null;
  if (scope.kind === "project") {
    project = projects.get(scope.path);
    if (!project && mode === "selection") {
      const matches = projects.list().filter((p) => named(p.name, scope.path));
      if (matches.length > 1) return ambiguous;
      project = matches[0] ?? null;
    }
  } else if (task) {
    const owner = ownershipOf(task.workdir, { fresh: true });
    if (owner.kind === "owned") project = projects.get(owner.projectPath);
  }
  if (!project) return missing;
  const cluster = membership(project.path);
  const label = [cluster?.name, project.name, task?.title].filter(Boolean).join(" / ");
  return { ok: true, value: {
    scope: task ? { kind: "task", id: task.id } : { kind: "project", path: project.path },
    label, projectPath: project.path, projectAddedAt: project.addedAt, clusterId: cluster?.id ?? null,
  } };
}

export function sameHeadScope(a: HeadScopeSnapshot, b: HeadScopeSnapshot): boolean {
  return JSON.stringify(a.scope) === JSON.stringify(b.scope)
    && a.projectPath === b.projectPath && a.projectAddedAt === b.projectAddedAt && a.clusterId === b.clusterId;
}

type TaskRow = { id: string; title: string; workdir: string; column: string; updated_at: number };
type Worker = { id: string; name: string; job_title: string };

export interface ScopedHeadContext {
  context: PortfolioPromptContext;
  refs: ProjectRefs;
  sources: ContextSource[];
  scope: HeadScopeSnapshot;
  taskRows: ReadonlyMap<string, TaskRow>;
  workers: ReadonlyMap<string, Worker>;
  includesProject(path: string): boolean;
}

export function gatherScopedHeadContext(scope: HeadScopeSnapshot): ScopedHeadContext {
  const registered = projects.list();
  const capturedAt = Date.now();
  const memberPaths = new Set(scope.clusterId ? db.query<{ project_path: string }, [string]>(
    "SELECT project_path FROM cluster_project_memberships WHERE cluster_id=?",
  ).all(scope.clusterId).map((r) => r.project_path) : []);
  const includesProject = (path: string) => scope.projectPath ? path === scope.projectPath
    : scope.scope.kind === "cluster" && memberPaths.has(path);
  const selected = registered.filter((p) => includesProject(p.path));
  const displayed = selected.slice(0, MAX_PROJECTS);
  const overview = [`Selected context: ${clean(scope.label, 240)} (${scope.scope.kind}).`];
  const gaps: string[] = [];
  const sources: ContextSource[] = [];
  const refs = new Map<string, { path: string; name: string }>();
  const taskRows = new Map<string, TaskRow>();
  const workers = new Map<string, Worker>();
  const projectContext: PortfolioPromptProject[] = [];
  const boardFilter = "archived_at IS NULL AND pipeline_parent_id IS NULL";
  const countColumns = (rows: TaskRow[]) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
    return [...counts].map(([column, count]) => `${column}: ${count}`).join(", ") || "empty";
  };
  const rowsByPath = new Map<string, TaskRow[]>();
  if (scope.scope.kind === "workspace") {
    const clusterRows = clusters();
    const counts = db.query<{ column: string; n: number }, []>(
      `SELECT "column", COUNT(*) AS n FROM tasks WHERE ${boardFilter} GROUP BY "column"`,
    ).all();
    const changed = db.query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE ${boardFilter} AND "column"='done' AND updated_at >= ?`,
    ).get(capturedAt - 86_400_000)?.n ?? 0;
    overview.push(`Workspace registry: ${clusterRows.length} active clusters, ${registered.length} registered projects.`);
    overview.push(`Workspace board counts (including unattributed tasks): ${counts.map((r) => `${r.column}: ${r.n}`).join(", ") || "empty"}.`);
    overview.push(`Tasks currently in Done and updated in the last 24 hours: ${changed}. Update time is not completion time.`);
    overview.push(`Cluster names: ${clusterRows.slice(0, MAX_PROJECTS).map((c) => clean(c.name)).join("; ") || "none"}.`);
    overview.push(`Project names: ${registered.slice(0, MAX_PROJECTS).map((p) => clean(p.name)).join("; ") || "none"}.`);
    if (clusterRows.length > MAX_PROJECTS || registered.length > MAX_PROJECTS) gaps.push("Directory names truncated. Use the scope selector for the full registry.");
    gaps.push("Select a cluster, project or task for details. Workspace summaries contain no task titles.");
  } else if (scope.scope.kind === "task") {
    const row = db.query<TaskRow, [string]>(
      `SELECT id,title,workdir,"column",updated_at FROM tasks WHERE id=? AND ${boardFilter}`,
    ).get(scope.scope.id);
    if (row && scope.projectPath) rowsByPath.set(scope.projectPath, [row]);
  } else {
    // Ownership can include subfolders and linked worktrees. Classify only
    // distinct workdirs first, then fetch metadata only for selected projects.
    const workdirs = db.query<{ workdir: string }, []>(
      `SELECT DISTINCT workdir FROM tasks WHERE ${boardFilter}`,
    ).all().map((row) => row.workdir);
    const { byProject } = classifyWorkdirs(registered.map((project) => project.path), workdirs);
    for (const { path } of displayed) {
      const dirs = byProject.get(path) ?? [];
      const rows: TaskRow[] = [];
      for (let i = 0; i < dirs.length; i += 500) {
        const page = dirs.slice(i, i + 500);
        rows.push(...db.query<TaskRow, string[]>(
          `SELECT id,title,workdir,"column",updated_at FROM tasks
            WHERE ${boardFilter} AND workdir IN (${page.map(() => "?").join(",")})`,
        ).all(...page));
      }
      rows.sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
      rowsByPath.set(path, rows);
    }
  }
  const inventory = new InfrastructureCore(db);
  const inventoryLines = (filter: { clusterId: string } | { projectPath: string }) => {
    const { resources, truncated } = inventory.list({ ...filter, archived: "active" });
    const lines = resources.slice(0, 8).map((r) => `Registry resource ${r.id}: ${clean(r.name)} (${r.resourceType}, ${r.environment ?? "environment unspecified"}, ${r.verification}). No deployment authority.`);
    if (truncated || resources.length > 8) lines.push("Additional registry resources omitted.");
    return lines;
  };
  if (scope.scope.kind === "cluster") overview.push(...inventoryLines({ clusterId: scope.scope.id }));
  for (const project of displayed) {
    const ref = `P${refs.size + 1}`;
    refs.set(ref, { path: project.path, name: clean(project.name) });
    const rows = rowsByPath.get(project.path) ?? [];
    const lines = [`Board counts in scope: ${countColumns(rows)}.`];
    if (scope.projectPath) {
      const details = rows.slice(0, MAX_TASKS);
      if (rows.length > details.length) gaps.push("Task list capped. Select a task for its current status and execution result.");
      for (const row of details) {
        taskRows.set(row.id, row);
        const taskObj = tasks.get(row.id);
        const assignment = db.query<{ name: string }, [string, string]>(
          `SELECT e.name FROM employee_task_assignments a JOIN ai_employees e ON e.id=a.employee_id
           WHERE a.task_id=? AND a.project_path=? AND a.status='active'`,
        ).get(row.id, project.path);
        const qcVerdict = taskObj?.qcState?.latestVerdict ?? null;
        const awaitingApproval = taskObj?.qcState?.awaitingOwnerApproval;
        const taskDetails = [
          `Task ${row.id} [${row.column}] (priority: ${taskScheduling.priorityOf(row.id)}): ${clean(row.title)}`,
          assignment ? `assigned: ${clean(assignment.name)}` : null,
          qcVerdict ? `QC: ${qcVerdict}${awaitingApproval ? " (awaiting Owner approval)" : ""}` : null,
        ].filter(Boolean).join(" · ");
        lines.push(taskDetails);
      }
      const projLifecycle = db.query<{ lifecycle_state: string | null }, [string]>("SELECT lifecycle_state FROM projects WHERE path=?").get(project.path);
      if (projLifecycle?.lifecycle_state) {
        lines.push(`Project lifecycle state: ${projLifecycle.lifecycle_state}.`);
      }
      const rPolicy = routerV2Service.getPolicy(project.path);
      lines.push(`Router 2.0 policy: ${rPolicy.preset} (quota: ${rPolicy.quotaPolicy}, autonomy: ${rPolicy.autonomyMode}).`);
      const specialists = db.query<Worker, [string, number]>(
        `SELECT id,name,job_title FROM ai_employees WHERE kind='worker' AND status='active' AND archived_at IS NULL
         AND project_path=? ORDER BY name COLLATE NOCASE,id LIMIT ?`,
      ).all(project.path, MAX_WORKERS + 1);
      for (const worker of specialists.slice(0, MAX_WORKERS)) {
        workers.set(worker.id, worker);
        lines.push(`Specialist ${worker.id}: ${clean(worker.name)} (${clean(worker.job_title)})`);
      }
      if (specialists.length > MAX_WORKERS) gaps.push("Specialist list capped.");
      if (scope.scope.kind === "project") {
        lines.push(...inventoryLines({ projectPath: project.path }));
        const environments = inventory.listProjectEnvironments(project.path).slice(0, 8);
        if (environments.length) lines.push(`Declared environments: ${environments.map((e) => clean(e.customLabel || e.environment)).join(", ")}.`);
      }
      if (scope.scope.kind === "task") {
        const task = tasks.get(scope.scope.id);
        if (task && taskRows.has(task.id)) {
          lines.push(`Priority: ${taskScheduling.priorityOf(task.id)}. QC verdict: ${task.qcState?.latestVerdict ?? "not recorded"}.`);
          const assignment = db.query<{ id: string; name: string }, [string, string]>(
            `SELECT a.id,e.name FROM employee_task_assignments a JOIN ai_employees e ON e.id=a.employee_id
             WHERE a.task_id=? AND a.project_path=? AND a.status='active'`,
          ).get(task.id, project.path);
          if (assignment) lines.push(`Active assignment ${assignment.id}: ${clean(assignment.name)}.`);
          const attempts = db.query<{ id: string; employee_name: string; status: string; result: string | null; reason: string | null }, [string, string]>(
            `SELECT id,employee_name,status,result,reason FROM employee_executions WHERE task_id=? AND project_path=?
             ORDER BY created_at DESC,id DESC LIMIT 3`,
          ).all(task.id, project.path);
          for (const row of attempts) lines.push(`Execution ${row.id} (${clean(row.employee_name)}): ${row.status}; result ${row.result ?? "not recorded"}${row.reason ? `; reason: ${clean(row.reason, 240)}` : ""}.`);
          if (task.runId) {
            const run = db.query<{ id: string; status: string; exit_code: number | null }, [string, string]>(
              "SELECT id,status,exit_code FROM runs WHERE id=? AND task_id=?",
            ).get(task.runId, task.id);
            if (run) lines.push(`Latest board run ${run.id}: ${run.status}; exit code ${run.exit_code ?? "not recorded"}.`);
          }
          try {
            const devEval = routerV2Service.evaluateTaskSync({
              taskId: task.id,
              projectId: project.path,
              title: task.title,
              type: ((task as any).taskType as any) ?? "general",
              complexity: ((task as any).complexity as any) ?? "unknown",
              role: "developer",
            });
            if (devEval.selected) {
              lines.push(`Router 2.0 recommended developer: ${devEval.selected.harnessId}/${devEval.selected.modelId} (${devEval.selected.selectionReasons.join("; ") || "eligible"}).`);
            }
            const revEval = routerV2Service.evaluateTaskSync({
              taskId: task.id,
              projectId: project.path,
              title: task.title,
              type: ((task as any).taskType as any) ?? "general",
              complexity: ((task as any).complexity as any) ?? "unknown",
              role: "reviewer",
            });
            if (revEval.selected) {
              lines.push(`Router 2.0 recommended reviewer: ${revEval.selected.harnessId}/${revEval.selected.modelId} (${revEval.selected.selectionReasons.join("; ") || "read-only eligible"}).`);
            }
          } catch {
            // non-blocking
          }
        }
      }
    }
    projectContext.push({ ref, path: clean(project.path, 1024), name: clean(project.name), lines });
  }
  sources.push({
    id: "head-scope", label: "Scoped workspace records", path: scope.projectPath, status: "included",
    detail: `${scope.label} · ${new Date(capturedAt).toISOString()} · project registry, board metadata${scope.projectPath ? ", specialist registry" : ""}${scope.scope.kind === "task" ? ", assignments and execution results" : ""}${["project", "cluster"].includes(scope.scope.kind) ? ", infrastructure registry" : ""}.`,
  });
  return {
    scope, taskRows, workers, includesProject, refs, sources,
    context: { capturedAt, overview, projects: projectContext, omittedProjects: selected.length - displayed.length,
      resources: [], conflicts: [], recommendations: [], estimation: [], dataGaps: gaps, observations: [] },
  };
}
