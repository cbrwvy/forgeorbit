/**
 * Project-workspace navigation for the board shell (FO-001).
 *
 * Orthogonal to `AppView` (board vs pipelines): this only records which
 * project the board is scoped to and whether that scope is showing its
 * overview or its kanban. Pipelines, the run panel, and the SSE/poll
 * subscriptions stay mounted in `App` either way — switching projects is a
 * filter, not a teardown.
 *
 * Persisted in localStorage, same reason as `panel-collapse.ts`: the choice
 * has to be known on the first paint, and it is webview chrome rather than
 * task state. No SQLite preference and no migration.
 */

import type { ColumnId } from "../../shared/types.ts";
import type { PanelStorage } from "./panel-collapse.ts";

/** Storage key for the selected scope + page. Namespaced like the other
 *  webview chrome keys (`agetor:newTaskPanelCollapsed`). */
export const WORKSPACE_STORAGE_KEY = "agetor:workspace";

/** Storage key for the project sidebar's collapsed flag. Read and written
 *  through `readCollapsed` / `writeCollapsed`. */
export const PROJECT_SIDEBAR_COLLAPSED_KEY = "agetor:projectSidebarCollapsed";

export type WorkspacePage = "overview" | "board" | "estimates" | "environment" | "manager" | "settings" | "recurring" | "portfolio" | "clusters" | "knowledge" | "brain" | "browser" | "native-computer" | "company" | "attention" | "missions" | "usage" | "projects" | "team";

/** Pages that belong to one registered project. Portfolio and spaces stay global.
 *  Analytics (`usage`) belongs to the open project. */
export type ProjectSurfacePage = Exclude<WorkspacePage, "portfolio" | "clusters" | "company" | "attention" | "browser" | "native-computer" | "missions" | "projects">;

/** `all` is the global overview, board, portfolio, or cluster directory.
 *  `project` scopes the board and the new-task workdir to one registered path.
 *  `cluster` opens one cluster dashboard. It is not a second router. */
export type WorkspaceSelection =
  | { scope: "all"; page: WorkspacePage }
  | { scope: "project"; path: string; page: WorkspacePage }
  | { scope: "cluster"; id: string; page: "clusters" };

export const DEFAULT_WORKSPACE: WorkspaceSelection = { scope: "all", page: "overview" };

/** The slice of a task the workspace counters and the board filter read.
 *  Hidden pipeline step rows (`pipelineParentId != null`) are excluded so a
 *  parent and its steps are never both counted. */
export interface WorkspaceTask {
  id: string;
  title: string;
  workdir: string;
  ownerProjectPath?: string | null;
  column: ColumnId;
  updatedAt: number;
  archivedAt: number | null;
  pipelineParentId?: string | null;
}

export interface ColumnCounts {
  backlog: number;
  inbox: number;
  ready: number;
  running: number;
  blocked: number;
  review: number;
  done: number;
}

export interface ProjectStats<T extends WorkspaceTask = WorkspaceTask> {
  /** Non-archived, non-step tasks in this workdir. */
  total: number;
  /** Archived non-step tasks. Kept out of `columns` so the numbers match the
   *  default "Active only" board. */
  archived: number;
  columns: ColumnCounts;
  recent: T[];
}

export function emptyColumnCounts(): ColumnCounts {
  return { backlog: 0, inbox: 0, ready: 0, running: 0, blocked: 0, review: 0, done: 0 };
}

export function emptyProjectStats<T extends WorkspaceTask>(): ProjectStats<T> {
  return { total: 0, archived: 0, columns: emptyColumnCounts(), recent: [] };
}

function defaultStorage(): PanelStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isPage(value: unknown): value is WorkspacePage {
  return value === "overview" || value === "board" || value === "estimates" || value === "environment" || value === "manager" || value === "settings" || value === "recurring" || value === "portfolio" || value === "clusters" || value === "knowledge" || value === "brain" || value === "browser" || value === "native-computer" || value === "company" || value === "attention" || value === "missions" || value === "usage" || value === "projects" || value === "team";
}

/** Estimates, environment, and manager exist only inside a project. A stored
 *  global selection that names one falls back to the overview. Portfolio and Company stay
 *  global. Clusters stay global, and a cluster dashboard is its own scope. */
export function visibleWorkspacePage(selection: WorkspaceSelection): WorkspacePage {
  if (selection.scope === "cluster") return "clusters";
  if (selection.page === "portfolio") return "portfolio";
  if (selection.page === "attention") return selection.scope === "all" ? "attention" : "overview";
  if (selection.page === "company") return selection.scope === "all" ? "company" : "overview";
  if (selection.page === "browser") return selection.scope === "all" ? "browser" : "overview";
  if (selection.page === "native-computer") return selection.scope === "all" ? "native-computer" : "overview";
  if (selection.page === "clusters") return selection.scope === "all" ? "clusters" : "overview";
  // Analytics is a project tab. A stored global Analytics page opens Home.
  if (selection.page === "usage") return selection.scope === "project" ? "usage" : "overview";
  // Execution plans moved to Settings. A stored Missions page opens Home.
  if (selection.page === "missions") return "overview";
  if (selection.page === "projects") return selection.scope === "all" ? "projects" : "overview";
  if (selection.page === "team" && selection.scope !== "project") return "overview";
  if (
    selection.scope !== "project" &&
    (selection.page === "estimates" || selection.page === "environment" || selection.page === "manager" || selection.page === "settings" || selection.page === "recurring")
  ) {
    return "overview";
  }
  return selection.page;
}

/** Accept only the scopes this build actually renders. Anything else
 *  (a future page name, a truncated write, a hand-edited value) is ignored
 *  so a bad key cannot strand the shell on an empty view. */
export function parseWorkspace(value: unknown): WorkspaceSelection | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { scope?: unknown; path?: unknown; page?: unknown; id?: unknown };
  if (rec.scope === "cluster") {
    if (rec.page !== "clusters" || typeof rec.id !== "string" || rec.id.length === 0) return null;
    return { scope: "cluster", id: rec.id, page: "clusters" };
  }
  if (!isPage(rec.page)) return null;
  if (rec.scope === "all") return { scope: "all", page: rec.page };
  if (rec.scope === "project" && typeof rec.path === "string" && rec.path.length > 0) {
    return { scope: "project", path: rec.path, page: rec.page };
  }
  return null;
}

export function readWorkspace(storage: PanelStorage | null = defaultStorage()): WorkspaceSelection {
  if (!storage) return DEFAULT_WORKSPACE;
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return DEFAULT_WORKSPACE;
    return parseWorkspace(JSON.parse(raw)) ?? DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

export function writeWorkspace(
  selection: WorkspaceSelection,
  storage: PanelStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    /* quota / disabled storage — the in-memory selection still works */
  }
}

export function sameWorkspace(a: WorkspaceSelection, b: WorkspaceSelection): boolean {
  if (a.page !== b.page || a.scope !== b.scope) return false;
  if (a.scope === "project" && b.scope === "project") return a.path === b.path;
  if (a.scope === "cluster" && b.scope === "cluster") return a.id === b.id;
  return true;
}

/**
 * Drop a stored project path that is no longer registered. Until the project
 * list has loaded, the stored path is kept — treating "not loaded" as
 * "deleted" would flash the global overview on every cold start.
 */
export function resolveWorkspace(
  selection: WorkspaceSelection,
  projectPaths: readonly string[],
  projectsLoaded: boolean,
): WorkspaceSelection {
  if (selection.scope !== "project") return selection;
  if (!projectsLoaded) return selection;
  if (projectPaths.includes(selection.path)) return selection;
  return { scope: "all", page: "overview" };
}

/** Workdir the new-task form should adopt. `null` on the global scope so the
 *  form keeps its own picker (including the most-recent project). */
export function preferredWorkdirFor(selection: WorkspaceSelection): string | null {
  return selection.scope === "project" ? selection.path : null;
}

export function projectLabel(project: { name: string; path: string }): string {
  const name = project.name.trim();
  if (name) return name;
  const trimmed = project.path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return base || project.path;
}

/** One-character mark for the sidebar. Neutral — not a generated color. */
export function projectInitial(label: string): string {
  const first = Array.from(label.trim())[0];
  return first ? first.toUpperCase() : "•";
}

/** Roving index for the sidebar. Returns null when the key isn't a move. */
export function moveNavIndex(current: number, count: number, key: string): number | null {
  if (count <= 0 || current < 0) return null;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function isStepTask(task: { pipelineParentId?: string | null }): boolean {
  return task.pipelineParentId != null;
}

/**
 * Whether a task belongs on the board for this workspace.
 *
 * A project scope ignores `repoFilter` — the sidebar already chose the
 * directory, and intersecting with a stale global repo filter would blank
 * the board. The global scope keeps `repoFilter` exactly as the kanban
 * filter row always has.
 *
 * Step tasks are excluded in both scopes (they are not board cards).
 */
/**
 * The registered project a task belongs to, as the server decided it
 * (FO-008D: folder, subfolder or proven worktree; null when none or
 * ambiguous). A payload without the field falls back to the exact workdir.
 */
export function taskProjectPath(task: { workdir: string; ownerProjectPath?: string | null }): string | null {
  return task.ownerProjectPath !== undefined ? task.ownerProjectPath : task.workdir;
}

/** True when the task belongs to the registered project at `projectPath`. */
export function isProjectTask(task: { workdir: string; ownerProjectPath?: string | null }, projectPath: string): boolean {
  return taskProjectPath(task) === projectPath;
}

/** The ordering scope of a card: its owning project, else its own folder (matches the server's `scopeOf`). */
export function projectScopeKey(task: { workdir: string; ownerProjectPath?: string | null }): string {
  return taskProjectPath(task) ?? task.workdir;
}

/** Grouping key: the owning project, else the raw workdir (which is never a
 *  registered path, so the task counts as outside every project). */
function groupKey(task: { workdir: string; ownerProjectPath?: string | null }): string {
  return taskProjectPath(task) ?? task.workdir;
}

export function includeOnBoard(
  task: { workdir: string; ownerProjectPath?: string | null; pipelineParentId?: string | null },
  selection: WorkspaceSelection,
  repoFilter: readonly string[],
): boolean {
  if (isStepTask(task)) return false;
  if (selection.scope === "project") return isProjectTask(task, selection.path);
  if (repoFilter.length > 0 && !repoFilter.includes(task.workdir)) return false;
  return true;
}

function statsFromList<T extends WorkspaceTask>(list: readonly T[], recentLimit: number): ProjectStats<T> {
  const columns = emptyColumnCounts();
  let archived = 0;
  const active: T[] = [];
  for (const task of list) {
    if (task.archivedAt != null) {
      archived += 1;
      continue;
    }
    columns[task.column] += 1;
    active.push(task);
  }
  active.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = columns.backlog + columns.inbox + columns.ready + columns.running + columns.blocked + columns.review + columns.done;
  return { total, archived, columns, recent: active.slice(0, recentLimit) };
}

/** One pass over the task list, keyed by workdir. Step tasks are skipped
 *  before grouping so they cannot inflate a project or appear as their own
 *  workdir. Projects with no tasks are simply absent — callers substitute
 *  {@link emptyProjectStats}. */
export function summarizeByWorkdir<T extends WorkspaceTask>(
  tasks: readonly T[],
  recentLimit = 5,
): Map<string, ProjectStats<T>> {
  const grouped = new Map<string, T[]>();
  for (const task of tasks) {
    if (isStepTask(task)) continue;
    const key = groupKey(task);
    const list = grouped.get(key);
    if (list) list.push(task);
    else grouped.set(key, [task]);
  }
  const out = new Map<string, ProjectStats<T>>();
  for (const [path, list] of grouped) out.set(path, statsFromList(list, recentLimit));
  return out;
}

export function projectStats<T extends WorkspaceTask>(
  tasks: readonly T[],
  path: string,
  recentLimit = 5,
): ProjectStats<T> {
  return summarizeByWorkdir(tasks, recentLimit).get(path) ?? emptyProjectStats<T>();
}

/** Active (non-archived) tasks whose workdir is not a registered project.
 *  They stay on the all-projects board; the overview only mentions them. */
export function outsideProjectCount(
  summaries: ReadonlyMap<string, Pick<ProjectStats, "total" | "archived">>,
  projectPaths: readonly string[],
): number {
  const known = new Set(projectPaths);
  let count = 0;
  for (const [path, stats] of summaries) {
    if (!known.has(path)) count += stats.total + stats.archived;
  }
  return count;
}

export interface WorkdirActivity {
  running: number;
  blocked: number;
}

/** Running / blocked counts for sidebar dots. Archived and step tasks are
 *  ignored — a hidden step blocked on a tool call is not a project blockage
 *  the owner triages from the board. */
export function activityByWorkdir(
  tasks: readonly Pick<WorkspaceTask, "workdir" | "ownerProjectPath" | "column" | "archivedAt" | "pipelineParentId">[],
): Map<string, WorkdirActivity> {
  const map = new Map<string, WorkdirActivity>();
  for (const task of tasks) {
    if (isStepTask(task) || task.archivedAt != null) continue;
    if (task.column !== "running" && task.column !== "blocked") continue;
    const key = groupKey(task);
    let row = map.get(key);
    if (!row) {
      row = { running: 0, blocked: 0 };
      map.set(key, row);
    }
    if (task.column === "running") row.running += 1;
    else row.blocked += 1;
  }
  return map;
}
