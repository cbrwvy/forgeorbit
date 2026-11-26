/**
 * Employee Professional Profile data types (FO-014B).
 *
 * Distinct persistent entity for an employee's professional specialization,
 * adapted markdown instructions, and append-only revision history.
 */

import type { RoleTemplateSummary } from "../catalog/types.ts";

export const MAX_PROMPT_BYTES = 512 * 1024; // 512 KB

export interface EmployeePromptRevision {
  id: string;
  employeeId: string;
  revision: number;
  catalogRoleSlug: string;
  professionalTitle: string;
  division: string;
  promptMarkdown: string;
  promptSha256: string;
  ownerProvenance: "owner" | "system";
  changeNote?: string | null;
  createdAt: number;
}

export interface EmployeePromptRevisionSummary {
  id: string;
  employeeId: string;
  revision: number;
  catalogRoleSlug: string;
  professionalTitle: string;
  division: string;
  promptSha256: string;
  ownerProvenance: "owner" | "system";
  changeNote?: string | null;
  createdAt: number;
}

export interface EmployeeProfessionalProfile {
  employeeId: string;
  catalogRoleSlug: string;
  professionalTitle: string;
  division: string;
  currentRevision: number;
  createdAt: number;
  updatedAt: number;
  activePrompt: EmployeePromptRevision;
  template?: RoleTemplateSummary | null;
}

export interface AssignProfessionalRoleRequest {
  catalogRoleSlug: string;
  professionalTitle?: string;
  promptMarkdown?: string;
  expectedRevision?: number; // 0 if brand new
  changeNote?: string;
}

export interface UpdateProfessionalPromptRequest {
  promptMarkdown: string;
  expectedRevision: number;
  changeNote?: string;
}
