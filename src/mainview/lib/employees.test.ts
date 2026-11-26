import { expect, test } from "bun:test";
import { EMPLOYEE_AUTHORITY, EMPLOYEE_RUNTIME_BINDING, OWNER_NODE, type Employee, type OrganizationTree, type ProjectTeam } from "../../shared/employees/types.ts";
import { FORGEORBIT_COMPANY, type Cluster } from "../../shared/clusters/types.ts";
import {
  DEFAULT_STAFF_FILTERS, NO_CLUSTER, allBranchIds, archiveConfirmCopy, buildChart, chartKey, companyMetrics, draftFromEmployee,
  emptyEmployeeDraft, employeeErrorText, employeeUpdateBody, filterStaff, flattenChart, headBody, historyDetail, initialCollapsed,
  initializationCandidates, initializeConfirmCopy, organizationPath, parseSpecializations, projectEntries, specializationOptions,
  staffFiltersActive, staffRows, workerCreateBody,
} from "./employees.ts";

let counter = 0;
function employee(partial: Partial<Employee> & Pick<Employee, "name" | "kind">): Employee {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    nameSource: "generated",
    displayName: null,
    jobTitle: partial.kind === "head" ? "Head of Project Management" : partial.kind === "project-manager" ? "Project Manager" : "QA Engineer",
    roleCategory: partial.kind === "head" ? "leadership" : partial.kind === "project-manager" ? "management" : "quality",
    specializations: [],
    projectPath: null,
    projectName: null,
    projectRegistered: false,
    department: null,
    description: "",
    notes: null,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    reportsTo: null,
    runtimeBinding: EMPLOYEE_RUNTIME_BINDING,
    authority: EMPLOYEE_AUTHORITY,
    ...partial,
  };
}

function cluster(id: string, name: string, archivedAt: number | null = null): Cluster {
  return {
    id, name, companyId: FORGEORBIT_COMPANY.id, slug: null, description: "", color: null, icon: null, notesSummary: null,
    priority: null, createdAt: 1, updatedAt: 1, archivedAt, projectCount: 0, knowledgeOwner: { kind: "cluster", id },
  };
}

function team(path: string, name: string, manager: Employee | null, employees: Employee[] = [], pathMissing = false): ProjectTeam {
  return { projectPath: path, projectName: name, pathMissing, projectManager: manager, employees };
}

const head = employee({ kind: "head", name: "Ilse", nameSource: "owner" });
const pmA = employee({ kind: "project-manager", name: "Robin", projectPath: "/a", projectName: "Alpha", projectRegistered: true });
const w1 = employee({ kind: "worker", name: "Ada", jobTitle: "Senior Backend Engineer", roleCategory: "engineering", specializations: ["APIs", "SQL"], projectPath: "/a", projectName: "Alpha", projectRegistered: true });
const w2 = employee({ kind: "worker", name: "Ada", jobTitle: "QA Engineer", projectPath: "/b", projectName: "Beta", projectRegistered: true });
const free = employee({ kind: "worker", name: "Sam", jobTitle: "Technical Writer", roleCategory: "documentation" });
const gone = employee({ kind: "worker", name: "Lost", projectPath: "/gone", projectName: null, projectRegistered: false });
const goneMgr = employee({ kind: "project-manager", name: "Orphan", projectPath: "/gone", projectName: null });
const archived = employee({ kind: "worker", name: "Old", status: "archived", archivedAt: 5, projectPath: "/a", projectName: "Alpha" });
const paused = employee({ kind: "worker", name: "Nap", status: "inactive", projectPath: "/a", projectName: "Alpha" });

function tree(partial: Partial<OrganizationTree> = {}): OrganizationTree {
  return {
    company: { id: FORGEORBIT_COMPANY.id, name: FORGEORBIT_COMPANY.name },
    owner: OWNER_NODE,
    head,
    clusters: [{ cluster: cluster("c1", "Lunarian"), projects: [team("/a", "Alpha", pmA, [w1, paused])] }],
    unclusteredProjects: [team("/b", "Beta", null, [w2])],
    unassignedEmployees: [free],
    detachedEmployees: [gone, goneMgr],
    ...partial,
  };
}

const everyone = [head, pmA, w1, w2, free, gone, goneMgr, archived, paused];

test("metrics count identity records, never running processes", () => {
  const m = companyMetrics(everyone, tree());
  expect(m).toMatchObject({
    hasHead: true, projectManagers: 2, workers: 5, active: 7, paused: 1, archived: 1,
    projects: 2, projectsWithManager: 1, projectsWithoutManager: 1, unassigned: 1, detached: 2, clusters: 1,
  });
  expect(Object.keys(m).join(" ")).not.toMatch(/running|busy|productiv|performance|session/i);
});

test("an empty organization reports zeros and no head", () => {
  const empty = tree({ head: null, clusters: [], unclusteredProjects: [], unassignedEmployees: [], detachedEmployees: [] });
  expect(companyMetrics([], empty)).toEqual({
    hasHead: false, projectManagers: 0, workers: 0, active: 0, paused: 0, archived: 0, projects: 0,
    projectsWithManager: 0, projectsWithoutManager: 0, unassigned: 0, detached: 0, clusters: 0,
  });
  const chart = buildChart(empty);
  expect(chart.children.map((child) => child.kind)).toEqual(["missing-head"]);
});

test("projects appear once and carry the cluster that groups them", () => {
  const rows = projectEntries(tree());
  expect(rows.map((row) => [row.team.projectName, row.cluster?.name ?? null])).toEqual([["Alpha", "Lunarian"], ["Beta", null]]);
});

test("initialization candidates are configured managers without an active identity, and unknown is not counted", () => {
  const projects = [
    { path: "/a", managerConfigured: { value: true } },
    { path: "/b", managerConfigured: { value: true } },
    { path: "/c", managerConfigured: { value: false } },
    { path: "/d", managerConfigured: { value: null } },
  ];
  expect(initializationCandidates(projects, [pmA])).toEqual(["/b"]);
  expect(initializationCandidates(projects, [{ ...pmA, status: "archived" }])).toEqual(["/a", "/b"]);
  expect(initializationCandidates(projects, [])).toEqual(["/a", "/b"]);
});

test("the staff list is sorted head, managers, workers, and equal names stay separate rows", () => {
  const rows = staffRows([w2, free, pmA, head, w1], tree());
  expect(rows.map((row) => row.employee.kind)).toEqual(["head", "project-manager", "worker", "worker", "worker"]);
  expect(rows.filter((row) => row.employee.name === "Ada")).toHaveLength(2);
  expect(rows.find((row) => row.employee.id === w1.id)!.clusterName).toBe("Lunarian");
  expect(rows.find((row) => row.employee.id === w2.id)!.clusterName).toBeNull();
});

test("staff filters cover name, title, role, project, cluster, specialization, status, and assignment", () => {
  const rows = staffRows(everyone, tree());
  const ids = (filters: Partial<typeof DEFAULT_STAFF_FILTERS>) => filterStaff(rows, { ...DEFAULT_STAFF_FILTERS, ...filters }).map((row) => row.employee.name);
  expect(ids({})).not.toContain("Old");
  expect(ids({ status: "archived" })).toEqual(["Old"]);
  expect(ids({ status: "paused" })).toEqual(["Nap"]);
  expect(ids({ status: "all" })).toContain("Old");
  expect(ids({ query: "backend" })).toEqual(["Ada"]);
  expect(ids({ query: "  LUNARIAN " })).toEqual(expect.arrayContaining(["Robin", "Ada", "Nap"]));
  expect(ids({ query: "sql" })).toEqual(["Ada"]);
  expect(ids({ roleCategory: "documentation" })).toEqual(["Sam"]);
  expect(ids({ projectPath: "/b" })).toEqual(["Ada"]);
  expect(ids({ cluster: "c1" })).toEqual(["Robin", "Ada", "Nap"]);
  expect(ids({ cluster: NO_CLUSTER })).toEqual(expect.arrayContaining(["Ilse", "Sam", "Lost"]));
  expect(ids({ cluster: NO_CLUSTER })).not.toContain("Robin");
  expect(ids({ specialization: "apis" })).toEqual(["Ada"]);
  expect(ids({ assignment: "unassigned" })).toEqual(["Ilse", "Sam"]);
  expect(ids({ assignment: "assigned" })).not.toContain("Sam");
  expect(ids({ query: "nothing like this" })).toEqual([]);
  expect(specializationOptions(rows)).toEqual(["APIs", "SQL"]);
  expect(staffFiltersActive(DEFAULT_STAFF_FILTERS)).toBe(false);
  expect(staffFiltersActive({ ...DEFAULT_STAFF_FILTERS, query: "x" })).toBe(true);
});

test("the organization path preserves recorded links without requiring an individual manager", () => {
  const t = tree();
  const worker = organizationPath(w1, t);
  expect(worker.chain.map((s) => s.label)).toEqual(["Owner / CEO", "Ilse", "Robin", "Ada"]);
  expect(worker.location.map((s) => s.label)).toEqual(["ForgeOrbit", "Lunarian", "Alpha"]);
  const noManager = organizationPath(w2, t);
  expect(noManager.chain.map((s) => [s.kind, s.label])).toEqual([["owner", "Owner / CEO"], ["head", "Ilse"], ["employee", "Ada"]]);
  expect(noManager.location.map((s) => s.label)).toEqual(["ForgeOrbit", "No cluster", "Beta"]);
  const noHead = organizationPath(pmA, tree({ head: null }));
  expect(noHead.chain.map((s) => [s.kind, s.label])).toEqual([["owner", "Owner / CEO"], ["missing", "Head not appointed"], ["manager", "Robin"]]);
  expect(organizationPath(free, t).location.at(-1)).toMatchObject({ kind: "missing", label: "No project" });
  expect(organizationPath(gone, t).chain.map((s) => s.label)).toContain("Orphan");
  expect(organizationPath(gone, t).location.at(-1)!.label).toContain("not registered");
  expect(organizationPath(head, t).chain.map((s) => s.label)).toEqual(["Owner / CEO", "Ilse"]);
  expect(organizationPath(archived, t).chain).toHaveLength(1);
});

test("the chart shows specialists directly under each project and retains historical manager identities", () => {
  const chart = buildChart(tree());
  expect(chart.kind).toBe("owner");
  expect(chart.children.map((child) => child.kind)).toEqual(["head", "unassigned", "detached"]);
  const headNode = chart.children[0]!;
  expect(headNode.children.map((child) => child.kind)).toEqual(["cluster", "no-cluster"]);
  const project = headNode.children[0]!.children[0]!;
  expect(project).toMatchObject({ kind: "project", label: "Alpha" });
  expect(project.children.map((child) => child.label)).toEqual(["Ada", "Nap", "Robin"]);
  expect(project.children[2]).toMatchObject({ kind: "manager", detail: "Legacy Manager" });
  const beta = headNode.children[1]!.children[0]!;
  expect(beta.children.map((child) => child.label)).toEqual(["Ada"]);
  expect(headNode.children[0]!.detail).toContain("grouping only");
  expect(chart.children[2]!.children.map((child) => child.kind)).toEqual(["worker", "manager"]);
  const ids = flattenChart(chart, new Set()).map((row) => row.node.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(chart.count).toBe(8);
});

test("a missing Head keeps the whole structure visible under a placeholder", () => {
  const chart = buildChart(tree({ head: null }));
  expect(chart.children[0]).toMatchObject({ kind: "missing-head", label: "Head not appointed" });
  expect(chart.children[0]!.children.map((child) => child.kind)).toEqual(["cluster", "no-cluster"]);
});

test("collapsing hides a branch, and a large organization starts with projects closed", () => {
  const chart = buildChart(tree());
  const open = flattenChart(chart, new Set());
  const closed = flattenChart(chart, new Set(["cluster:c1"]));
  expect(closed.length).toBeLessThan(open.length);
  expect(closed.find((row) => row.node.id === "cluster:c1")).toMatchObject({ expandable: true, expanded: false });
  expect(allBranchIds(chart)).toContain("owner");
  const big = Array.from({ length: 80 }, (_, i) => employee({ kind: "worker", name: `W${i}`, projectPath: "/a" }));
  const bigTree = tree({ clusters: [{ cluster: cluster("c1", "Lunarian"), projects: [team("/a", "Alpha", pmA, big)] }] });
  const collapsed = initialCollapsed(buildChart(bigTree));
  expect(collapsed.has("project:/a")).toBe(true);
  expect(initialCollapsed(chart).size).toBe(0);
});

test("tree keys follow the WAI-ARIA model", () => {
  const chart = buildChart(tree());
  const rows = flattenChart(chart, new Set(["cluster:c1"]));
  expect(chartKey(rows, "owner", "ArrowDown")).toEqual({ focus: rows[1]!.node.id });
  expect(chartKey(rows, "owner", "ArrowUp")).toBeNull();
  expect(chartKey(rows, "owner", "End")).toEqual({ focus: rows.at(-1)!.node.id });
  expect(chartKey(rows, "owner", "Home")).toEqual({ focus: "owner" });
  expect(chartKey(rows, "cluster:c1", "ArrowRight")).toEqual({ expand: "cluster:c1" });
  expect(chartKey(rows, "owner", "ArrowRight")).toEqual({ focus: rows[1]!.node.id });
  expect(chartKey(rows, "owner", "ArrowLeft")).toEqual({ collapse: "owner" });
  expect(chartKey(rows, "cluster:c1", "ArrowLeft")).toEqual({ focus: `emp:${head.id}` });
  expect(chartKey(rows, `emp:${head.id}`, "Enter")).toEqual({ activate: `emp:${head.id}` });
  expect(chartKey(rows, "owner", "x")).toBeNull();
  expect(chartKey(rows, "missing", "ArrowDown")).toEqual({ focus: "owner" });
});

test("specializations are split, trimmed, deduplicated, and bounded", () => {
  expect(parseSpecializations(" APIs, apis ,\nSQL,, ")).toEqual(["APIs", "SQL"]);
  expect(parseSpecializations("")).toEqual([]);
});

test("a new worker without a name omits it so one random name is drawn by the core", () => {
  const draft = { ...emptyEmployeeDraft("/a"), jobTitle: " Frontend Engineer ", specializations: "React, CSS" };
  expect(workerCreateBody(draft)).toEqual({ ok: true, body: { jobTitle: "Frontend Engineer", roleCategory: "engineering", specializations: ["React", "CSS"], projectPath: "/a" } });
  expect(workerCreateBody({ ...draft, name: " Alex " })).toMatchObject({ ok: true, body: { name: "Alex" } });
  expect(workerCreateBody({ ...draft, jobTitle: " " })).toMatchObject({ ok: false });
  expect(workerCreateBody({ ...draft, name: "x".repeat(81) })).toMatchObject({ ok: false });
  expect(workerCreateBody({ ...draft, specializations: Array.from({ length: 21 }, (_, i) => `s${i}`).join(",") })).toMatchObject({ ok: false });
  expect(workerCreateBody({ ...draft, roleCategory: "wizard" })).toMatchObject({ ok: false });
});

test("an update sends only changed fields, never the project, and never a role category for a manager", () => {
  const draft = draftFromEmployee(w1);
  expect(employeeUpdateBody(w1, draft)).toEqual({ ok: false, error: "Nothing changed." });
  expect(employeeUpdateBody(w1, { ...draft, name: "Ada L.", jobTitle: "Principal Engineer", specializations: "APIs" })).toEqual({
    ok: true, body: { name: "Ada L.", jobTitle: "Principal Engineer", specializations: ["APIs"] },
  });
  const moved = employeeUpdateBody(w1, { ...draft, projectPath: "/b", department: "Platform" });
  expect(moved).toEqual({ ok: true, body: { department: "Platform" } });
  expect(employeeUpdateBody(pmA, { ...draftFromEmployee(pmA), roleCategory: "leadership", jobTitle: "Lead" })).toEqual({ ok: true, body: { jobTitle: "Lead" } });
  expect(employeeUpdateBody(w1, { ...draft, status: "inactive" })).toEqual({ ok: true, body: { status: "inactive" } });
  expect(employeeUpdateBody(w1, { ...draft, name: " " })).toMatchObject({ ok: false });
});

test("the Head form requires an owner-typed name and never draws one", () => {
  expect(headBody({ name: "  ", description: "" })).toMatchObject({ ok: false });
  expect(headBody({ name: " Ilse ", description: " Runs the portfolio " })).toEqual({ ok: true, body: { name: "Ilse", description: "Runs the portfolio" } });
});

test("errors never show engine text, and dangerous actions have explicit copy", () => {
  expect(employeeErrorText(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: ai_employees.kind"))).toBe("Couldn't complete the employee request.");
  expect(employeeErrorText(new Error("Project is not registered."))).toBe("Project is not registered.");
  expect(employeeErrorText("boom")).toBe("Couldn't complete the employee request.");
  expect(archiveConfirmCopy(w1).description).toContain("history");
  expect(initializeConfirmCopy(3).description).toMatch(/identity records/);
  expect(initializeConfirmCopy(3).description).toMatch(/no AI process/);
  expect(initializeConfirmCopy(null).title).toBe("Initialize existing manager identities?");
});

test("history lines show what changed without inventing fields", () => {
  expect(historyDetail({ id: 1, employeeId: "x", action: "rename", at: 1, changes: { name: { from: "Alex", to: "Ada" } } })).toBe("name: Alex → Ada");
  expect(historyDetail({ id: 2, employeeId: "x", action: "create", at: 1, changes: { name: { from: null, to: "Alex" }, jobTitle: { from: null, to: "QA" }, projectPath: { from: null, to: "/a" } } })).toBe("name: Alex; job title: QA");
  expect(historyDetail({ id: 3, employeeId: "x", action: "reassign", at: 1, changes: { projectPath: { from: "/a", to: "/b" } } })).toBe("project: /a → /b");
});
