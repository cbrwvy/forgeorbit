import { expect, test } from "bun:test";
import { readCollapsed, writeCollapsed, type PanelStorage } from "./panel-collapse.ts";
import {
  DEFAULT_WORKSPACE,
  PROJECT_SIDEBAR_COLLAPSED_KEY,
  WORKSPACE_STORAGE_KEY,
  activityByWorkdir,
  emptyProjectStats,
  includeOnBoard,
  moveNavIndex,
  outsideProjectCount,
  parseWorkspace,
  preferredWorkdirFor,
  visibleWorkspacePage,
  projectInitial,
  projectLabel,
  projectStats,
  readWorkspace,
  resolveWorkspace,
  sameWorkspace,
  summarizeByWorkdir,
  writeWorkspace,
  type WorkspaceSelection,
  type WorkspaceTask,
} from "./workspace.ts";

function fakeStorage(seed: Record<string, string> = {}): PanelStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
  };
}

const throwingStorage: PanelStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};

function task(partial: Partial<WorkspaceTask> & Pick<WorkspaceTask, "id" | "workdir" | "column">): WorkspaceTask {
  return {
    title: partial.title ?? partial.id,
    updatedAt: partial.updatedAt ?? 0,
    archivedAt: partial.archivedAt ?? null,
    pipelineParentId: partial.pipelineParentId ?? null,
    ...partial,
  };
}

const alpha = "/work/alpha";
const beta = "/work/beta";

// --- persistence ----------------------------------------------------------

test("readWorkspace defaults to the global overview", () => {
  expect(readWorkspace(fakeStorage())).toEqual(DEFAULT_WORKSPACE);
  expect(readWorkspace(null)).toEqual(DEFAULT_WORKSPACE);
  expect(readWorkspace(throwingStorage)).toEqual(DEFAULT_WORKSPACE);
});

test("the environment page round-trips and is project-only", () => {
  const stored: WorkspaceSelection = { scope: "project", path: alpha, page: "environment" };
  const storage = fakeStorage();
  writeWorkspace(stored, storage);
  expect(readWorkspace(storage)).toEqual(stored);
  expect(visibleWorkspacePage(stored)).toBe("environment");
  expect(visibleWorkspacePage({ scope: "all", page: "environment" })).toBe("overview");
});

test("the portfolio page is global and round-trips", () => {
  const stored: WorkspaceSelection = { scope: "all", page: "portfolio" };
  const storage = fakeStorage();
  writeWorkspace(stored, storage);
  expect(readWorkspace(storage)).toEqual(stored);
  expect(visibleWorkspacePage(stored)).toBe("portfolio");
  expect(visibleWorkspacePage({ scope: "project", path: alpha, page: "portfolio" })).toBe("portfolio");
});

test("the Needs-you page is global, round-trips, and falls back to the overview inside a project", () => {
  const attention: WorkspaceSelection = { scope: "all", page: "attention" };
  expect(parseWorkspace(JSON.parse(JSON.stringify(attention)))).toEqual(attention);
  expect(visibleWorkspacePage(attention)).toBe("attention");
  expect(visibleWorkspacePage({ scope: "project", path: alpha, page: "attention" })).toBe("overview");
});

test("the company page is global and round-trips", () => {
  const company: WorkspaceSelection = { scope: "all", page: "company" };
  expect(parseWorkspace(JSON.parse(JSON.stringify(company)))).toEqual(company);
  expect(visibleWorkspacePage(company)).toBe("company");
  expect(visibleWorkspacePage({ scope: "project", path: alpha, page: "company" })).toBe("overview");
  expect(sameWorkspace(company, { scope: "all", page: "portfolio" })).toBe(false);
});

test("the clusters directory and one cluster dashboard round-trip", () => {
  const directory: WorkspaceSelection = { scope: "all", page: "clusters" };
  const storage = fakeStorage();
  writeWorkspace(directory, storage);
  expect(readWorkspace(storage)).toEqual(directory);
  expect(visibleWorkspacePage(directory)).toBe("clusters");
  expect(visibleWorkspacePage({ scope: "project", path: alpha, page: "clusters" })).toBe("overview");

  const dashboard: WorkspaceSelection = { scope: "cluster", id: "cluster-1", page: "clusters" };
  writeWorkspace(dashboard, storage);
  expect(readWorkspace(storage)).toEqual(dashboard);
  expect(visibleWorkspacePage(dashboard)).toBe("clusters");
  expect(sameWorkspace(dashboard, { scope: "cluster", id: "cluster-2", page: "clusters" })).toBe(false);
  expect(parseWorkspace({ scope: "cluster", page: "clusters" })).toBeNull();
  expect(resolveWorkspace(dashboard, [], true)).toEqual(dashboard);
  expect(preferredWorkdirFor(dashboard)).toBeNull();
});

test("the estimates page round-trips and is project-only", () => {
  const stored: WorkspaceSelection = { scope: "project", path: alpha, page: "estimates" };
  const storage = fakeStorage();
  writeWorkspace(stored, storage);
  expect(readWorkspace(storage)).toEqual(stored);
  expect(visibleWorkspacePage(stored)).toBe("estimates");
  expect(visibleWorkspacePage({ scope: "all", page: "estimates" })).toBe("overview");
});

test("company brain is global and project brain stays on that project", () => {
  const company: WorkspaceSelection = { scope: "all", page: "brain" };
  const storage = fakeStorage();
  writeWorkspace(company, storage);
  expect(readWorkspace(storage)).toEqual(company);
  expect(visibleWorkspacePage(company)).toBe("brain");
  const project: WorkspaceSelection = { scope: "project", path: alpha, page: "brain" };
  expect(visibleWorkspacePage(project)).toBe("brain");
  expect(parseWorkspace({ scope: "all", page: "brain" })).toEqual(company);
});

test("company knowledge is global and project knowledge stays on that project", () => {
  const company: WorkspaceSelection = { scope: "all", page: "knowledge" };
  const storage = fakeStorage();
  writeWorkspace(company, storage);
  expect(readWorkspace(storage)).toEqual(company);
  expect(visibleWorkspacePage(company)).toBe("knowledge");
  const project: WorkspaceSelection = { scope: "project", path: alpha, page: "knowledge" };
  expect(visibleWorkspacePage(project)).toBe("knowledge");
  expect(parseWorkspace({ scope: "all", page: "knowledge" })).toEqual(company);
});

test("the manager page round-trips and is project-only", () => {
  const stored: WorkspaceSelection = { scope: "project", path: alpha, page: "manager" };
  const storage = fakeStorage();
  writeWorkspace(stored, storage);
  expect(readWorkspace(storage)).toEqual(stored);
  expect(visibleWorkspacePage(stored)).toBe("manager");
  expect(visibleWorkspacePage({ scope: "all", page: "manager" })).toBe("overview");
});

test("a project workspace round-trips through storage", () => {
  const stored: WorkspaceSelection = { scope: "project", path: alpha, page: "board" };
  const storage = fakeStorage();
  writeWorkspace(stored, storage);
  expect(readWorkspace(storage)).toEqual(stored);
  expect(storage.map.get(WORKSPACE_STORAGE_KEY)).toContain(alpha);
});

test("junk and partial workspace values fall back instead of throwing", () => {
  expect(parseWorkspace(null)).toBeNull();
  expect(parseWorkspace({ scope: "project", page: "board" })).toBeNull();
  expect(parseWorkspace({ scope: "all", page: "later" })).toBeNull();
  expect(parseWorkspace({ scope: "portfolio", page: "overview" })).toBeNull();
  const storage = fakeStorage({ [WORKSPACE_STORAGE_KEY]: "{not json" });
  expect(readWorkspace(storage)).toEqual(DEFAULT_WORKSPACE);
});

test("writeWorkspace swallows a missing or throwing store", () => {
  expect(() => writeWorkspace(DEFAULT_WORKSPACE, null)).not.toThrow();
  expect(() => writeWorkspace(DEFAULT_WORKSPACE, throwingStorage)).not.toThrow();
});

test("the project sidebar collapse flag uses the existing chrome helper", () => {
  const storage = fakeStorage();
  expect(readCollapsed(PROJECT_SIDEBAR_COLLAPSED_KEY, storage)).toBe(false);
  writeCollapsed(PROJECT_SIDEBAR_COLLAPSED_KEY, true, storage);
  expect(readCollapsed(PROJECT_SIDEBAR_COLLAPSED_KEY, storage)).toBe(true);
  writeCollapsed(PROJECT_SIDEBAR_COLLAPSED_KEY, false, storage);
  expect(readCollapsed(PROJECT_SIDEBAR_COLLAPSED_KEY, storage)).toBe(false);
});

// --- missing project ------------------------------------------------------

test("a stored project is kept until the project list has loaded", () => {
  const stored: WorkspaceSelection = { scope: "project", path: alpha, page: "board" };
  expect(resolveWorkspace(stored, [], false)).toEqual(stored);
});

test("a deleted project falls back to the global overview once the list is known", () => {
  const stored: WorkspaceSelection = { scope: "project", path: "/gone", page: "board" };
  const next = resolveWorkspace(stored, [alpha], true);
  expect(next).toEqual({ scope: "all", page: "overview" });
  expect(sameWorkspace(stored, next)).toBe(false);
});

test("a project that is still registered is left on its page", () => {
  const stored: WorkspaceSelection = { scope: "project", path: alpha, page: "board" };
  expect(resolveWorkspace(stored, [beta, alpha], true)).toEqual(stored);
});

// --- board membership -----------------------------------------------------

test("a project board shows only that project's tasks and ignores a stale repo filter", () => {
  const selection: WorkspaceSelection = { scope: "project", path: alpha, page: "board" };
  const tasks = [
    task({ id: "a", workdir: alpha, column: "running" }),
    task({ id: "b", workdir: beta, column: "backlog" }),
  ];
  const visible = tasks.filter((row) => includeOnBoard(row, selection, [beta]));
  expect(visible.map((row) => row.id)).toEqual(["a"]);
  expect(visible[0]).toBe(tasks[0]);
  expect(tasks[0]!.column).toBe("running");
});

test("switching projects changes which tasks the board includes", () => {
  const tasks = [
    task({ id: "a", workdir: alpha, column: "ready" }),
    task({ id: "b", workdir: beta, column: "review" }),
  ];
  const inAlpha = tasks.filter((row) => includeOnBoard(row, { scope: "project", path: alpha, page: "board" }, []));
  const inBeta = tasks.filter((row) => includeOnBoard(row, { scope: "project", path: beta, page: "board" }, []));
  expect(inAlpha.map((row) => row.id)).toEqual(["a"]);
  expect(inBeta.map((row) => row.id)).toEqual(["b"]);
});

test("the global board keeps every non-step task and still honors the repo filter", () => {
  const tasks = [
    task({ id: "a", workdir: alpha, column: "backlog" }),
    task({ id: "b", workdir: beta, column: "done" }),
    task({ id: "step", workdir: alpha, column: "running", pipelineParentId: "parent" }),
  ];
  const all = tasks.filter((row) => includeOnBoard(row, { scope: "all", page: "board" }, []));
  expect(all.map((row) => row.id)).toEqual(["a", "b"]);
  const filtered = tasks.filter((row) => includeOnBoard(row, { scope: "all", page: "board" }, [beta]));
  expect(filtered.map((row) => row.id)).toEqual(["b"]);
});

test("preferred workdir is the open project and unset on the global scope", () => {
  expect(preferredWorkdirFor({ scope: "project", path: alpha, page: "overview" })).toBe(alpha);
  expect(preferredWorkdirFor({ scope: "all", page: "board" })).toBeNull();
});

// --- counts ---------------------------------------------------------------

test("project stats skip hidden pipeline steps and archived rows", () => {
  const rows = [
    task({ id: "back", workdir: alpha, column: "backlog", updatedAt: 1 }),
    task({ id: "run", workdir: alpha, column: "running", updatedAt: 5 }),
    task({ id: "block", workdir: alpha, column: "blocked", updatedAt: 4 }),
    task({ id: "review", workdir: alpha, column: "review", updatedAt: 3 }),
    task({ id: "done", workdir: alpha, column: "done", updatedAt: 2 }),
    task({ id: "ready", workdir: alpha, column: "ready", updatedAt: 6 }),
    task({ id: "old", workdir: alpha, column: "done", archivedAt: 9, updatedAt: 9 }),
    task({ id: "step", workdir: alpha, column: "running", pipelineParentId: "run", updatedAt: 100 }),
    task({ id: "other", workdir: beta, column: "running", updatedAt: 50 }),
  ];
  const stats = projectStats(rows, alpha, 3);
  expect(stats.total).toBe(6);
  expect(stats.archived).toBe(1);
  expect(stats.columns).toEqual({
    backlog: 1,
    inbox: 0,
    ready: 1,
    running: 1,
    blocked: 1,
    review: 1,
    done: 1,
  });
  expect(stats.recent.map((row) => row.id)).toEqual(["ready", "run", "block"]);
  expect(projectStats(rows, "/missing")).toEqual(emptyProjectStats());
});

test("sidebar activity counts running and blocked work, not steps or archived tasks", () => {
  const activity = activityByWorkdir([
    task({ id: "run", workdir: alpha, column: "running" }),
    task({ id: "block", workdir: alpha, column: "blocked" }),
    task({ id: "step", workdir: alpha, column: "blocked", pipelineParentId: "p" }),
    task({ id: "arch", workdir: alpha, column: "running", archivedAt: 1 }),
    task({ id: "beta", workdir: beta, column: "running" }),
  ]);
  expect(activity.get(alpha)).toEqual({ running: 1, blocked: 1 });
  expect(activity.get(beta)).toEqual({ running: 1, blocked: 0 });
});

test("tasks outside registered projects are counted once and kept off project totals", () => {
  const summaries = summarizeByWorkdir([
    task({ id: "a", workdir: alpha, column: "backlog" }),
    task({ id: "loose", workdir: "/tmp/loose", column: "ready" }),
    task({ id: "loose-step", workdir: "/tmp/loose", column: "running", pipelineParentId: "p" }),
  ]);
  expect(outsideProjectCount(summaries, [alpha, beta])).toBe(1);
  expect(summaries.get(alpha)?.total).toBe(1);
});

// --- labels and keyboard --------------------------------------------------

test("project labels and initials come from the name, then the folder", () => {
  expect(projectLabel({ name: "ForgeOrbit", path: "/work/forgeorbit" })).toBe("ForgeOrbit");
  expect(projectLabel({ name: "  ", path: "/work/example-project" })).toBe("example-project");
  expect(projectInitial("ForgeOrbit")).toBe("F");
  expect(projectInitial("медиа")).toBe("М");
  expect(projectInitial("")).toBe("•");
});

test("sidebar arrow keys wrap and Home/End jump", () => {
  expect(moveNavIndex(0, 4, "ArrowDown")).toBe(1);
  expect(moveNavIndex(3, 4, "ArrowDown")).toBe(0);
  expect(moveNavIndex(0, 4, "ArrowUp")).toBe(3);
  expect(moveNavIndex(2, 4, "Home")).toBe(0);
  expect(moveNavIndex(2, 4, "End")).toBe(3);
  expect(moveNavIndex(1, 4, "Enter")).toBeNull();
  expect(moveNavIndex(-1, 4, "ArrowDown")).toBeNull();
});

test("project scope follows the server's owning project, not the raw workdir (FO-008D)", async () => {
  const { includeOnBoard, summarizeByWorkdir, activityByWorkdir, taskProjectPath, outsideProjectCount } = await import("./workspace.ts");
  const base = { title: "t", column: "running" as const, updatedAt: 1, archivedAt: null, pipelineParentId: null };
  const sub = { ...base, id: "a", workdir: "/p/web", ownerProjectPath: "/p" };
  const escaped = { ...base, id: "b", workdir: "/p/link", ownerProjectPath: null };
  const legacy = { ...base, id: "c", workdir: "/p" };
  expect(taskProjectPath(sub)).toBe("/p");
  expect(taskProjectPath(escaped)).toBeNull();
  expect(taskProjectPath(legacy)).toBe("/p");
  const selection = { scope: "project" as const, path: "/p", page: "board" as const };
  expect(includeOnBoard(sub, selection as never, [])).toBe(true);
  expect(includeOnBoard(escaped, selection as never, [])).toBe(false);
  const summary = summarizeByWorkdir([sub, escaped, legacy]);
  expect(summary.get("/p")?.total).toBe(2);
  expect(outsideProjectCount(summary, ["/p"])).toBe(1);
  expect(activityByWorkdir([sub, legacy]).get("/p")?.running).toBe(2);
});
