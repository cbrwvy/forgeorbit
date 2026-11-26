/**
 * Role Catalog data types (FO-014B).
 *
 * Sourced offline from the vendored Agency Agents catalog (283 profiles, 18 divisions).
 * Original files are immutable; profiles serve as passive textual templates.
 */

export interface DivisionMeta {
  id: string;
  label: string;
  icon: string;
  color: string;
  count: number;
}

export interface RoleTemplateSummary {
  slug: string;
  name: string;
  description: string;
  division: string;
  color: string;
  emoji: string;
  vibe?: string;
  sourcePath: string;
  sourceCommit: string;
  sha256: string;
  sizeBytes: number;
}

export interface RoleTemplate extends RoleTemplateSummary {
  frontmatter: Record<string, unknown>;
  originalMarkdown: string;
}

export interface CatalogManifestSummary {
  sourceRepository: string;
  sourceCommit: string;
  importedAt: string;
  license: string;
  totalProfiles: number;
  divisions: string[];
  divisionsMetadata: Record<string, { label: string; icon: string; color: string }>;
  countsByDivision: Record<string, number>;
}

export interface CatalogFilter {
  search?: string;
  division?: string;
}
