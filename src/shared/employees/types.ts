/**
 * AI employee identity and organization (FO-010A).
 *
 * An employee is a persistent organizational identity. It is not an agent
 * profile, a harness, an account, a model, or a runtime session, and no field
 * here points at any of them. A future task picks an employee and then a
 * verified resource for that one run.
 *
 * A job title or role category describes the organization. It grants no
 * permission and is not evidence that a model can do the work.
 */

import type { Cluster } from "../clusters/types.ts";

export const EMPLOYEE_KINDS = ["head", "project-manager", "worker"] as const;
export type EmployeeKind = (typeof EMPLOYEE_KINDS)[number];

export const EMPLOYEE_STATUSES = ["active", "inactive", "archived"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const ROLE_CATEGORIES = [
  "leadership",
  "management",
  "engineering",
  "architecture",
  "quality",
  "operations",
  "security",
  "data",
  "product",
  "design",
  "documentation",
  "other",
] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

/** Role category and default title for the two structural positions. */
export const POSITION_DEFAULTS = {
  head: { jobTitle: "Head of Project Management", roleCategory: "leadership" },
  "project-manager": { jobTitle: "Project Manager", roleCategory: "management" },
} as const satisfies Record<Exclude<EmployeeKind, "worker">, { jobTitle: string; roleCategory: RoleCategory }>;

/** Examples shown to the owner. Not a closed list: any title is accepted. */
export const EXAMPLE_JOB_TITLES = [
  "Senior Backend Engineer",
  "Frontend Engineer",
  "QA Engineer",
  "DevOps Engineer",
  "Software Architect",
  "Technical Writer",
  "Security Engineer",
  "Data Engineer",
  "Product Manager",
] as const;

export const EMPLOYEE_LIMITS = {
  name: 80,
  displayName: 120,
  jobTitle: 120,
  specialization: 60,
  specializations: 20,
  department: 80,
  description: 4_000,
  notes: 4_000,
  path: 4_096,
  historyPage: 50,
  nameDrawAttempts: 8,
} as const;

export type EmployeeNameSource = "generated" | "owner";

/**
 * What an employee is not bound to. Every resource is chosen per task and
 * re-verified at run time. Absence of a binding is not "no model available".
 */
export const EMPLOYEE_RUNTIME_BINDING = {
  status: "none",
  note: "An employee has no fixed agent profile, harness, account, model, or thinking effort. The resource is chosen per task, recommended by the model router, approved by the owner, and verified before a run.",
} as const;

/** The job title never widens what an employee or manager may do. */
export const EMPLOYEE_AUTHORITY = {
  source: "existing-mechanisms",
  grantsPermissions: false,
  note: "Job title and role category are labels. Permissions come only from the existing manager, execution, and approval mechanisms. Owner approval stays required where it already is.",
} as const;

export type EmployeeField =
  | "name"
  | "displayName"
  | "jobTitle"
  | "roleCategory"
  | "specializations"
  | "projectPath"
  | "department"
  | "description"
  | "notes"
  | "status";

export interface Employee {
  id: string;
  kind: EmployeeKind;
  name: string;
  nameSource: EmployeeNameSource;
  displayName: string | null;
  jobTitle: string;
  roleCategory: RoleCategory;
  specializations: string[];
  /** Registered project path, or null for the head and for an unassigned worker. */
  projectPath: string | null;
  /** Name of the registered project, or null when it is no longer registered. */
  projectName: string | null;
  /** False when the stored project path is not in the project registry now. */
  projectRegistered: boolean;
  department: string | null;
  description: string;
  notes: string | null;
  status: EmployeeStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Derived, never stored: the owner for the head, the head for a manager, the manager for a worker. */
  reportsTo: { kind: "owner" } | { kind: "employee"; id: string } | null;
  runtimeBinding: typeof EMPLOYEE_RUNTIME_BINDING;
  authority: typeof EMPLOYEE_AUTHORITY;
}

export type EmployeeEventAction =
  | "create"
  | "initialize"
  | "rename"
  | "regenerate-name"
  | "update"
  | "assign"
  | "reassign"
  | "unassign"
  | "archive"
  | "unarchive";

export interface EmployeeEvent {
  id: number;
  employeeId: string;
  action: EmployeeEventAction;
  changes: Partial<Record<EmployeeField, { from: unknown; to: unknown }>>;
  at: number;
}

export interface EmployeeDetails extends Employee {
  history: EmployeeEvent[];
  historyTruncated: boolean;
}

export interface ProjectTeam {
  projectPath: string;
  projectName: string;
  pathMissing: boolean;
  projectManager: Employee | null;
  employees: Employee[];
}

export interface OrganizationCluster {
  cluster: Cluster;
  projects: ProjectTeam[];
}

/** Read-only tree for a future org chart. Clusters only group projects for display. */
export interface OrganizationTree {
  company: { id: string; name: string };
  owner: { kind: "owner"; note: string };
  head: Employee | null;
  clusters: OrganizationCluster[];
  /** Registered projects with no cluster. They keep their manager and team. */
  unclusteredProjects: ProjectTeam[];
  /** Workers with no project. */
  unassignedEmployees: Employee[];
  /** Active employees whose stored project is no longer registered. */
  detachedEmployees: Employee[];
}

export const OWNER_NODE = {
  kind: "owner",
  note: "The owner is a person, not an AI account, and is not created as an employee.",
} as const;

export * from "./profile-types.ts";
