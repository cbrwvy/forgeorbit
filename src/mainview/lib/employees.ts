import { countLabel, intlLocale, t as tr } from "@/i18n/core";

/**
 * Pure helpers for the Company page (FO-010B): metrics, the organization
 * chart model, staff filtering, forms, and confirmation copy.
 *
 * Everything here reads FO-010A API shapes. Nothing starts a process, picks a
 * model or account, or invents activity. Employee counts are identity
 * records, not running AI processes.
 */

import {
  EMPLOYEE_LIMITS,
  ROLE_CATEGORIES,
  type Employee,
  type EmployeeEvent,
  type EmployeeKind,
  type EmployeeStatus,
  type OrganizationTree,
  type ProjectTeam,
  type RoleCategory,
} from "../../shared/employees/types.ts";
import type { Cluster } from "../../shared/clusters/types.ts";

// ----- text -----

const SQL_LIKE = /sqlite|sql\b|constraint|syntax error|no such (table|column)|\bdatabase\b|stack|at \S+\.ts/i;

/** Server messages are short sentences. Anything that looks like an engine error is hidden. */
export function employeeErrorText(error: unknown): string {
  const raw = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message.trim() : "";
  if (!raw || raw.length > 300 || SQL_LIKE.test(raw)) return tr("common.couldn_t_complete_the_employee_request");
  return raw;
}

export const ROLE_CATEGORY_LABELS: Record<RoleCategory, string> = {
  get leadership() { return tr("common.leadership"); },
  get management() { return tr("common.management"); },
  get engineering() { return tr("common.engineering"); },
  get architecture() { return tr("common.architecture"); },
  get quality() { return tr("common.quality"); },
  get operations() { return tr("common.operations"); },
  get security() { return tr("common.security"); },
  get data() { return tr("common.data"); },
  get product() { return tr("common.product"); },
  get design() { return tr("common.design"); },
  get documentation() { return tr("common.documentation"); },
  get other() { return tr("common.other"); },
};

export function roleCategoryLabel(category: string): string {
  return ROLE_CATEGORY_LABELS[category as RoleCategory] ?? category;
}

export function kindLabel(kind: EmployeeKind): string {
  if (kind === "head") return tr("common.head_of_project_management");
  if (kind === "project-manager") return tr("common.project_manager");
  return tr("common.ai_employee");
}

export function statusLabel(status: EmployeeStatus): string {
  if (status === "inactive") return tr("common.paused");
  return status === "archived" ? tr("common.archived_bdb865") : tr("common.active");
}

export function nameSourceLabel(source: Employee["nameSource"]): string {
  return source === "owner" ? tr("common.set_by_the_owner") : tr("common.randomly_generated");
}

export function formatEmployeeTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return tr("common.unknown");
  try {
    return new Date(ms).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function isCurrentRequest(requestId: number, latestId: number): boolean {
  return requestId === latestId;
}

// ----- structure -----

export interface ProjectEntry {
  team: ProjectTeam;
  cluster: Cluster | null;
}

/** Every registered project in the tree once, with the cluster that groups it (if any). */
export function projectEntries(tree: OrganizationTree): ProjectEntry[] {
  const rows: ProjectEntry[] = [];
  for (const group of tree.clusters) for (const team of group.projects) rows.push({ team, cluster: group.cluster });
  for (const team of tree.unclusteredProjects) rows.push({ team, cluster: null });
  return rows.sort((a, b) => a.team.projectName.localeCompare(b.team.projectName, undefined, { sensitivity: "base" }) || a.team.projectPath.localeCompare(b.team.projectPath));
}

export interface CompanyMetrics {
  hasHead: boolean;
  projectManagers: number;
  workers: number;
  active: number;
  paused: number;
  archived: number;
  projects: number;
  projectsWithManager: number;
  projectsWithoutManager: number;
  unassigned: number;
  detached: number;
  clusters: number;
}

/**
 * Counts of identity records. `all` is the full list including archived rows.
 * Archived people are never counted as managers or workers of the structure.
 */
export function companyMetrics(all: readonly Employee[], tree: OrganizationTree): CompanyMetrics {
  const current = all.filter((employee) => employee.status !== "archived");
  const entries = projectEntries(tree);
  return {
    hasHead: tree.head != null,
    projectManagers: current.filter((employee) => employee.kind === "project-manager").length,
    workers: current.filter((employee) => employee.kind === "worker").length,
    active: all.filter((employee) => employee.status === "active").length,
    paused: all.filter((employee) => employee.status === "inactive").length,
    archived: all.filter((employee) => employee.status === "archived").length,
    projects: entries.length,
    projectsWithManager: entries.filter((entry) => entry.team.projectManager != null).length,
    projectsWithoutManager: entries.filter((entry) => entry.team.projectManager == null).length,
    unassigned: tree.unassignedEmployees.length,
    detached: tree.detachedEmployees.length,
    clusters: tree.clusters.length,
  };
}

/**
 * Registered projects whose manager is already configured but that have no
 * active manager identity. This is what "Initialize existing manager
 * identities" would create. `null` configured facts are unknown, not zero.
 */
export function initializationCandidates(
  projects: readonly { path: string; managerConfigured: { value: boolean | null } }[],
  all: readonly Employee[],
): string[] {
  const covered = new Set(all.filter((e) => e.kind === "project-manager" && e.status !== "archived" && e.projectPath).map((e) => e.projectPath!));
  return projects.filter((project) => project.managerConfigured.value === true && !covered.has(project.path)).map((project) => project.path);
}

// ----- staff directory -----

export interface StaffRow {
  employee: Employee;
  clusterId: string | null;
  clusterName: string | null;
}

export const NO_CLUSTER = "__none__";

export function staffRows(employees: readonly Employee[], tree: OrganizationTree): StaffRow[] {
  const byProject = new Map<string, Cluster | null>();
  for (const entry of projectEntries(tree)) byProject.set(entry.team.projectPath, entry.cluster);
  const rows = employees.map((employee) => {
    const cluster = employee.projectPath ? byProject.get(employee.projectPath) ?? null : null;
    return { employee, clusterId: cluster?.id ?? null, clusterName: cluster?.name ?? null };
  });
  const order = { head: 0, "project-manager": 1, worker: 2 } as const;
  return rows.sort((a, b) =>
    order[a.employee.kind] - order[b.employee.kind]
    || a.employee.name.localeCompare(b.employee.name, undefined, { sensitivity: "base" })
    || a.employee.id.localeCompare(b.employee.id));
}

export interface StaffFilters {
  query: string;
  roleCategory: string;
  projectPath: string;
  cluster: string;
  specialization: string;
  status: "current" | "active" | "paused" | "archived" | "all";
  assignment: "all" | "assigned" | "unassigned";
}

export const DEFAULT_STAFF_FILTERS: StaffFilters = {
  query: "",
  roleCategory: "",
  projectPath: "",
  cluster: "",
  specialization: "",
  status: "current",
  assignment: "all",
};

export function staffFiltersActive(filters: StaffFilters): boolean {
  return (Object.keys(DEFAULT_STAFF_FILTERS) as (keyof StaffFilters)[]).some((key) => filters[key] !== DEFAULT_STAFF_FILTERS[key]);
}

export function filterStaff(rows: readonly StaffRow[], filters: StaffFilters): StaffRow[] {
  const query = filters.query.trim().toLowerCase();
  const special = filters.specialization.trim().toLowerCase();
  return rows.filter(({ employee, clusterId, clusterName }) => {
    if (filters.status === "current" && employee.status === "archived") return false;
    if (filters.status === "active" && employee.status !== "active") return false;
    if (filters.status === "paused" && employee.status !== "inactive") return false;
    if (filters.status === "archived" && employee.status !== "archived") return false;
    if (filters.roleCategory && employee.roleCategory !== filters.roleCategory) return false;
    if (filters.projectPath && employee.projectPath !== filters.projectPath) return false;
    if (filters.cluster === NO_CLUSTER ? clusterId != null : filters.cluster ? clusterId !== filters.cluster : false) return false;
    if (filters.assignment === "assigned" && employee.projectPath == null) return false;
    if (filters.assignment === "unassigned" && employee.projectPath != null) return false;
    if (special && !employee.specializations.some((item) => item.toLowerCase() === special)) return false;
    if (query) {
      const haystack = [
        employee.name, employee.displayName ?? "", employee.jobTitle, employee.department ?? "",
        employee.projectName ?? "", clusterName ?? "", ...employee.specializations,
      ].join("\n").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function specializationOptions(rows: readonly StaffRow[]): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) for (const item of row.employee.specializations) if (!seen.has(item.toLowerCase())) seen.set(item.toLowerCase(), item);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// ----- organization path -----

export interface PathSegment {
  kind: "owner" | "head" | "manager" | "employee" | "company" | "cluster" | "project" | "missing";
  label: string;
  employeeId?: string;
  projectPath?: string;
  clusterId?: string;
}

export interface OrganizationPath {
  /** Who the employee reports to, from the Owner down. */
  chain: PathSegment[];
  /** Where the employee sits: company, cluster, project. Grouping only. */
  location: PathSegment[];
}

function managerOf(projectPath: string, tree: OrganizationTree): Employee | null {
  for (const entry of projectEntries(tree)) if (entry.team.projectPath === projectPath) return entry.team.projectManager;
  return tree.detachedEmployees.find((employee) => employee.kind === "project-manager" && employee.projectPath === projectPath) ?? null;
}

export function organizationPath(employee: Employee, tree: OrganizationTree): OrganizationPath {
  const company: PathSegment = { kind: "company", label: tree.company.name };
  const self: PathSegment = {
    kind: employee.kind === "head" ? "head" : employee.kind === "project-manager" ? "manager" : "employee",
    label: employee.name,
    employeeId: employee.id,
  };
  if (employee.status === "archived") {
    return { chain: [self], location: [company] };
  }
  const owner: PathSegment = { kind: "owner", label: tr("common.owner_ceo") };
  const head: PathSegment = tree.head ? { kind: "head", label: tree.head.name, employeeId: tree.head.id } : { kind: "missing", label: tr("common.head_not_appointed") };
  if (employee.kind === "head") return { chain: [owner, self], location: [company] };

  const entry = employee.projectPath ? projectEntries(tree).find((item) => item.team.projectPath === employee.projectPath) : undefined;
  const location: PathSegment[] = [company];
  if (entry) {
    location.push(entry.cluster
      ? { kind: "cluster", label: entry.cluster.name, clusterId: entry.cluster.id }
      : { kind: "missing", label: tr("common.no_cluster") });
    location.push({ kind: "project", label: entry.team.projectName, projectPath: entry.team.projectPath });
  } else if (employee.projectPath) {
    location.push({ kind: "missing", label: tr("common.project_not_registered_9dfa8e", { p0: String(employee.projectPath) }) });
  } else {
    location.push({ kind: "missing", label: tr("common.no_project") });
  }
  if (employee.kind === "project-manager") return { chain: [owner, head, self], location };

  const manager = employee.projectPath ? managerOf(employee.projectPath, tree) : null;
  const historical: PathSegment[] = manager ? [{ kind: "manager", label: manager.name, employeeId: manager.id }] : [];
  return { chain: [owner, head, ...historical, self], location };
}

// ----- organization chart (tree list) -----

export type ChartKind =
  | "owner" | "head" | "missing-head" | "cluster" | "no-cluster" | "project"
  | "manager" | "worker" | "unassigned" | "detached";

export interface ChartNode {
  id: string;
  kind: ChartKind;
  label: string;
  detail: string | null;
  employeeId: string | null;
  projectPath: string | null;
  clusterId: string | null;
  archived: boolean;
  children: ChartNode[];
  /** Employees in this branch, not counting the node itself. */
  count: number;
}

function node(partial: Partial<ChartNode> & Pick<ChartNode, "id" | "kind" | "label">): ChartNode {
  return { detail: null, employeeId: null, projectPath: null, clusterId: null, archived: false, children: [], count: 0, ...partial };
}

function withCounts(root: ChartNode): ChartNode {
  let total = 0;
  for (const child of root.children) {
    const done = withCounts(child);
    total += done.count + (done.employeeId ? 1 : 0);
  }
  root.count = total;
  return root;
}

function employeeNode(employee: Employee, kind: ChartKind, children: ChartNode[] = []): ChartNode {
  return node({
    id: `emp:${employee.id}`,
    kind,
    label: employee.name,
    detail: employee.jobTitle,
    employeeId: employee.id,
    projectPath: employee.projectPath,
    archived: employee.status === "archived",
    children,
  });
}

function projectNode(team: ProjectTeam): ChartNode {
  const workers = team.employees.map((employee) => employeeNode(employee, "worker"));
  const historicalManager = team.projectManager ? employeeNode(team.projectManager, "manager") : null;
  if (historicalManager) historicalManager.detail = tr("m0.historicalManager");
  return node({
    id: `project:${team.projectPath}`,
    kind: "project",
    label: team.projectName,
    detail: team.pathMissing ? tr("common.folder_is_missing_on_disk") : null,
    projectPath: team.projectPath,
    children: historicalManager ? [...workers, historicalManager] : workers,
  });
}

/** Owner → Head → clusters → projects → workers. Clusters only group projects. */
export function buildChart(tree: OrganizationTree): ChartNode {
  const groups: ChartNode[] = tree.clusters.map((group) => node({
    id: `cluster:${group.cluster.id}`,
    kind: "cluster",
    label: group.cluster.name,
    detail: tr("common.grouping_only", { p0: String(group.projects.length), p1: String(group.projects.length === 1 ? "project" : "projects"), p2: String(group.cluster.archivedAt != null ? tr("common.archived_736ced") : "") }),
    clusterId: group.cluster.id,
    archived: group.cluster.archivedAt != null,
    children: group.projects.map(projectNode),
  }));
  if (tree.unclusteredProjects.length > 0) {
    groups.push(node({
      id: "no-cluster",
      kind: "no-cluster",
      label: tr("common.projects_without_a_cluster"),
      detail: tr("common.they_keep_their_managers_and_teams"),
      children: tree.unclusteredProjects.map(projectNode),
    }));
  }
  const head = tree.head
    ? employeeNode(tree.head, "head", groups)
    : node({ id: "missing-head", kind: "missing-head", label: tr("common.head_not_appointed"), detail: tr("common.projects_below_have_no_global_manager_identity"), children: groups });
  const root = node({ id: "owner", kind: "owner", label: tr("common.owner_ceo"), detail: tr("common.a_person_not_an_ai_account"), children: [head] });
  if (tree.unassignedEmployees.length > 0) {
    root.children.push(node({
      id: "unassigned",
      kind: "unassigned",
      label: tr("common.employees_without_a_project"),
      detail: tr("common.not_assigned_to_any_project"),
      children: tree.unassignedEmployees.map((employee) => employeeNode(employee, "worker")),
    }));
  }
  if (tree.detachedEmployees.length > 0) {
    root.children.push(node({
      id: "detached",
      kind: "detached",
      label: tr("common.project_no_longer_registered"),
      detail: tr("common.these_people_keep_their_identity_until_the_project"),
      children: tree.detachedEmployees.map((employee) => employeeNode(employee, employee.kind === "project-manager" ? "manager" : "worker")),
    }));
  }
  return withCounts(root);
}

export interface ChartRow {
  node: ChartNode;
  depth: number;
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
}

export function flattenChart(root: ChartNode, collapsed: ReadonlySet<string>): ChartRow[] {
  const rows: ChartRow[] = [];
  const walk = (current: ChartNode, depth: number, parentId: string | null) => {
    const expandable = current.children.length > 0;
    const expanded = expandable && !collapsed.has(current.id);
    rows.push({ node: current, depth, parentId, expandable, expanded });
    if (expanded) for (const child of current.children) walk(child, depth + 1, current.id);
  };
  walk(root, 0, null);
  return rows;
}

/** Large organizations start with project branches closed so the tree stays short. */
export function initialCollapsed(root: ChartNode, threshold = 60): Set<string> {
  const total = flattenChart(root, new Set()).length;
  const collapsed = new Set<string>();
  if (total <= threshold) return collapsed;
  const walk = (current: ChartNode) => {
    if (current.kind === "project" && current.children.length > 0) collapsed.add(current.id);
    current.children.forEach(walk);
  };
  walk(root);
  return collapsed;
}

export function allBranchIds(root: ChartNode): string[] {
  const ids: string[] = [];
  const walk = (current: ChartNode) => {
    if (current.children.length > 0) ids.push(current.id);
    current.children.forEach(walk);
  };
  walk(root);
  return ids;
}

export type ChartKeyResult = { focus?: string; expand?: string; collapse?: string; activate?: string } | null;

/** WAI-ARIA tree keyboard model over the visible rows. */
export function chartKey(rows: readonly ChartRow[], activeId: string, key: string): ChartKeyResult {
  const index = rows.findIndex((row) => row.node.id === activeId);
  if (index < 0) return rows[0] ? { focus: rows[0].node.id } : null;
  const row = rows[index]!;
  switch (key) {
    case "ArrowDown":
      return rows[index + 1] ? { focus: rows[index + 1]!.node.id } : null;
    case "ArrowUp":
      return rows[index - 1] ? { focus: rows[index - 1]!.node.id } : null;
    case "Home":
      return { focus: rows[0]!.node.id };
    case "End":
      return { focus: rows[rows.length - 1]!.node.id };
    case "ArrowRight":
      if (row.expandable && !row.expanded) return { expand: row.node.id };
      if (row.expandable && row.expanded) return { focus: rows[index + 1]!.node.id };
      return null;
    case "ArrowLeft":
      if (row.expandable && row.expanded) return { collapse: row.node.id };
      return row.parentId ? { focus: row.parentId } : null;
    case "Enter":
    case " ":
      return { activate: row.node.id };
    default:
      return null;
  }
}

// ----- forms -----

export interface EmployeeDraft {
  name: string;
  displayName: string;
  jobTitle: string;
  roleCategory: string;
  specializations: string;
  projectPath: string;
  department: string;
  description: string;
  notes: string;
  status: "active" | "inactive";
}

export function emptyEmployeeDraft(projectPath = ""): EmployeeDraft {
  return { name: "", displayName: "", jobTitle: "", roleCategory: "engineering", specializations: "", projectPath, department: "", description: "", notes: "", status: "active" };
}

export function draftFromEmployee(employee: Employee): EmployeeDraft {
  return {
    name: employee.name,
    displayName: employee.displayName ?? "",
    jobTitle: employee.jobTitle,
    roleCategory: employee.roleCategory,
    specializations: employee.specializations.join(", "),
    projectPath: employee.projectPath ?? "",
    department: employee.department ?? "",
    description: employee.description,
    notes: employee.notes ?? "",
    status: employee.status === "inactive" ? "inactive" : "active",
  };
}

/** Comma or line separated. Empty items are dropped and repeats ignored, case-insensitively. */
export function parseSpecializations(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const item = part.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    result.push(item);
  }
  return result;
}

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

function validateDraft(draft: EmployeeDraft, requireTitle: boolean): string | null {
  const name = draft.name.trim();
  if (name.length > EMPLOYEE_LIMITS.name) return tr("common.name_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.name) });
  if (draft.displayName.trim().length > EMPLOYEE_LIMITS.displayName) return tr("common.display_name_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.displayName) });
  const title = draft.jobTitle.trim();
  if (requireTitle && !title) return tr("common.job_title_is_required");
  if (title.length > EMPLOYEE_LIMITS.jobTitle) return tr("common.job_title_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.jobTitle) });
  const specializations = parseSpecializations(draft.specializations);
  if (specializations.length > EMPLOYEE_LIMITS.specializations) return tr("common.use_at_most_specializations", { p0: String(EMPLOYEE_LIMITS.specializations) });
  if (specializations.some((item) => item.length > EMPLOYEE_LIMITS.specialization)) return tr("common.each_specialization_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.specialization) });
  if (draft.department.trim().length > EMPLOYEE_LIMITS.department) return tr("common.department_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.department) });
  if (draft.description.length > EMPLOYEE_LIMITS.description) return tr("common.description_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.description) });
  if (draft.notes.length > EMPLOYEE_LIMITS.notes) return tr("common.notes_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.notes) });
  if (!(ROLE_CATEGORIES as readonly string[]).includes(draft.roleCategory)) return tr("common.choose_a_role_category");
  return null;
}

/** An empty name is omitted so the core draws a random one, once. */
export function workerCreateBody(draft: EmployeeDraft): BodyResult {
  const error = validateDraft(draft, true);
  if (error) return { ok: false, error };
  const body: Record<string, unknown> = {
    jobTitle: draft.jobTitle.trim(),
    roleCategory: draft.roleCategory,
    specializations: parseSpecializations(draft.specializations),
  };
  if (draft.name.trim()) body.name = draft.name.trim();
  if (draft.displayName.trim()) body.displayName = draft.displayName.trim();
  if (draft.projectPath) body.projectPath = draft.projectPath;
  if (draft.department.trim()) body.department = draft.department.trim();
  if (draft.description.trim()) body.description = draft.description.trim();
  if (draft.notes.trim()) body.notes = draft.notes.trim();
  return { ok: true, body };
}

/** Only the fields that changed. The project is changed with assign / unassign, never here. */
export function employeeUpdateBody(original: Employee, draft: EmployeeDraft): BodyResult {
  const error = validateDraft(draft, true);
  if (error) return { ok: false, error };
  if (!draft.name.trim()) return { ok: false, error: tr("common.name_is_required") };
  const body: Record<string, unknown> = {};
  if (draft.name.trim() !== original.name) body.name = draft.name.trim();
  if ((draft.displayName.trim() || null) !== original.displayName) body.displayName = draft.displayName.trim() || null;
  if (draft.jobTitle.trim() !== original.jobTitle) body.jobTitle = draft.jobTitle.trim();
  if (original.kind === "worker" && draft.roleCategory !== original.roleCategory) body.roleCategory = draft.roleCategory;
  const specializations = parseSpecializations(draft.specializations);
  if (JSON.stringify(specializations) !== JSON.stringify(original.specializations)) body.specializations = specializations;
  if ((draft.department.trim() || null) !== original.department) body.department = draft.department.trim() || null;
  if (draft.description.trim() !== original.description) body.description = draft.description.trim();
  if ((draft.notes.trim() || null) !== original.notes) body.notes = draft.notes.trim() || null;
  if (original.status !== "archived" && draft.status !== original.status) body.status = draft.status;
  if (Object.keys(body).length === 0) return { ok: false, error: tr("common.nothing_changed") };
  return { ok: true, body };
}

export function headBody(draft: { name: string; description: string }): BodyResult {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: tr("common.name_the_head_of_project_management_it_is") };
  if (name.length > EMPLOYEE_LIMITS.name) return { ok: false, error: tr("common.name_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.name) }) };
  if (draft.description.length > EMPLOYEE_LIMITS.description) return { ok: false, error: tr("common.description_can_be_at_most_characters", { p0: String(EMPLOYEE_LIMITS.description) }) };
  return { ok: true, body: { name, description: draft.description.trim() } };
}

// ----- confirmations -----

export interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

export function archiveConfirmCopy(employee: Employee): ConfirmCopy {
  return {
    get title() { return tr("common.archive_c39c49", { p0: String(employee.name) }); },
    get description() { return tr("common.the_employee_leaves_the_current_structure_their_record"); },
    get confirmLabel() { return tr("common.archive"); },
  };
}

export function regenerateConfirmCopy(employee: Employee): ConfirmCopy {
  return {
    get title() { return tr("common.draw_a_new_random_name_for", { p0: String(employee.name) }); },
    get description() { return tr("common.the_name_changes_the_employee_their_id_and"); },
    get confirmLabel() { return tr("common.draw_a_new_name"); },
  };
}

export function unassignConfirmCopy(employee: Employee): ConfirmCopy {
  return {
    get title() { return tr("common.remove_from", { p0: String(employee.name), p1: String(employee.projectName ?? tr("common.the_project")) }); },
    get description() { return tr("common.the_employee_stays_on_the_staff_without_a"); },
    get confirmLabel() { return tr("common.unassign"); },
  };
}

export function reassignConfirmCopy(employee: Employee, toName: string): ConfirmCopy {
  return {
    get title() { return tr("common.move_to", { p0: String(employee.name), p1: String(toName) }); },
    get description() { return tr("common.leaves_their_history_is_kept_and_records_the", { p0: String(employee.name), p1: String(employee.projectName ?? tr("common.the_current_project")) }); },
    get confirmLabel() { return tr("common.move_6ecc3d"); },
  };
}

export function initializeConfirmCopy(candidates: number | null): ConfirmCopy {
  const count = candidates == null ? tr("common.every_project_that_already_has_a_manager") : countLabel(candidates, "project");
  return {
    get title() { return tr("common.initialize_existing_manager_identities"); },
    get description() { return tr("common.will_get_a_named_project_manager_identity_this", { p0: String(count) }); },
    get confirmLabel() { return tr("common.create_identities"); },
  };
}

export function ensureManagerConfirmCopy(projectName: string): ConfirmCopy {
  return {
    get title() { return tr("common.create_a_project_manager_identity_for", { p0: String(projectName) }); },
    get description() { return tr("common.a_random_name_is_drawn_once_and_kept"); },
    get confirmLabel() { return tr("common.create_identity"); },
  };
}

// ----- history -----

const ACTION_LABELS: Record<EmployeeEvent["action"], string> = {
  get create() { return tr("common.created"); },
  get initialize() { return tr("common.identity_initialized"); },
  get rename() { return tr("common.renamed"); },
  get "regenerate-name"() { return tr("common.new_random_name"); },
  get update() { return tr("common.updated"); },
  get assign() { return tr("common.assigned_to_a_project"); },
  get reassign() { return tr("common.moved_to_another_project"); },
  get unassign() { return tr("common.removed_from_a_project"); },
  get archive() { return tr("common.archived_bdb865"); },
  get unarchive() { return tr("common.unarchived"); },
};

const FIELD_LABELS: Record<string, string> = {
  name: "name", get displayName() { return tr("common.display_name"); }, get jobTitle() { return tr("common.job_title"); }, get roleCategory() { return tr("common.role_category"); },
  specializations: "specializations", projectPath: "project", department: "department",
  description: "description", notes: "notes", status: "status",
};

function shortValue(value: unknown): string {
  if (value == null || value === "") return "none";
  const text = Array.isArray(value) ? value.join(", ") || "none" : String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function historyLabel(action: EmployeeEvent["action"]): string {
  return ACTION_LABELS[action] ?? action;
}

export function historyDetail(event: EmployeeEvent): string {
  const parts = Object.entries(event.changes)
    .filter(([field]) => !(event.action === "create" || event.action === "initialize") || field === "name" || field === "jobTitle")
    .map(([field, change]) => {
      const label = FIELD_LABELS[field] ?? field;
      return event.action === "create" || event.action === "initialize"
        ? `${label}: ${shortValue(change?.to)}`
        : `${label}: ${shortValue(change?.from)} → ${shortValue(change?.to)}`;
    });
  return parts.join("; ");
}
