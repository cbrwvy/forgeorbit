/**
 * Cluster registry (FO-011A).
 *
 * Company → Cluster → Project is an organizational dimension. It does not
 * choose a harness, an account, a VPS, or a task owner. Project identity
 * stays the registered path from the project registry.
 *
 * Knowledge documents address a cluster through {@link KnowledgeOwnerRef}.
 * Infrastructure rows address the same cluster id from their own tables.
 * A cluster payload does not embed those rows.
 */

export const FORGEORBIT_COMPANY = {
  id: "company:forgeorbit",
  name: "ForgeOrbit",
} as const;

export const KNOWLEDGE_OWNER_KINDS = ["company", "cluster", "project"] as const;
export type KnowledgeOwnerKind = (typeof KNOWLEDGE_OWNER_KINDS)[number];

/** Stable pointer for a future document. Not a document and not a file path. */
export interface KnowledgeOwnerRef {
  kind: KnowledgeOwnerKind;
  id: string;
}

export function knowledgeOwnerRef(kind: KnowledgeOwnerKind, id: string): KnowledgeOwnerRef {
  return { kind, id };
}

export const CLUSTER_INFRASTRUCTURE = {
  status: "registry",
  note: "Infrastructure is a separate registry. This cluster is not a VPS. Recorded rows are declarations. Live status is not verified, and an empty list is not zero servers.",
} as const;

export const CLUSTER_MANAGER = {
  status: "not-assigned",
  note: "A cluster does not create an AI manager. Cluster Manager and Department Head assignment is a later stage. The global portfolio manager still sees every permitted project.",
} as const;

export const CLUSTER_RUN_NOTE =
  "A finished run is not a done task. Done is the done column only. A task already counted on its project is not counted again on the cluster.";

export const CLUSTER_LIMITS = {
  name: 120,
  slug: 64,
  description: 4_000,
  notesSummary: 500,
  icon: 64,
  priorityMax: 1_000,
  historyPage: 50,
  path: 4_096,
} as const;

export interface Cluster {
  id: string;
  companyId: typeof FORGEORBIT_COMPANY.id;
  name: string;
  slug: string | null;
  description: string;
  color: string | null;
  icon: string | null;
  notesSummary: string | null;
  /** Null means the owner has not set a priority. It is not zero and not a default rank. */
  priority: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  projectCount: number;
  knowledgeOwner: KnowledgeOwnerRef;
}

export interface MembershipEvent {
  id: number;
  projectPath: string;
  fromClusterId: string | null;
  toClusterId: string | null;
  action: "assign" | "move" | "unassign";
  at: number;
}

export interface ClusterProject {
  projectPath: string;
  name: string;
  addedAt: number;
  clusterId: string | null;
  assignedAt: number | null;
  /** True when the registered path is not a directory on disk. The registry row is kept. */
  pathMissing: boolean;
}

export interface ClusterDetails extends Cluster {
  membershipHistory: MembershipEvent[];
  membershipHistoryTruncated: boolean;
  infrastructure: typeof CLUSTER_INFRASTRUCTURE;
  manager: typeof CLUSTER_MANAGER;
}
