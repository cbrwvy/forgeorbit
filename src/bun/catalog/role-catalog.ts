/**
 * Local Role Catalog Service (FO-014B).
 *
 * Reads 283 AI agent role profiles across 18 divisions offline from local vendored markdown files.
 * Provides frontmatter extraction, searching, filtering, SHA-256 verification, and strict path traversal protection.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CatalogError, resolveCatalogDir, verifyCatalogIntegrity, type CatalogManifest } from "./catalog-resources.ts";
export { CatalogError } from "./catalog-resources.ts";
import type {
  CatalogFilter,
  CatalogManifestSummary,
  DivisionMeta,
  RoleTemplate,
  RoleTemplateSummary,
} from "../../shared/catalog/types.ts";

export function parseFrontmatter(rawText: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!rawText.startsWith("---")) {
    return { frontmatter: {}, body: rawText };
  }
  const endIdx = rawText.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: rawText };
  }

  const fmLines = rawText.slice(3, endIdx).split("\n");
  const body = rawText.slice(endIdx + 4).replace(/^\r?\n/, "");
  const frontmatter: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;

  for (const rawLine of fmLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Detect new top-level key: "key:" at zero indentation
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      const colonIdx = line.indexOf(":");
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      // Check if value is wrapped in quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (value === "") {
        // May start a list or multi-line block
        currentKey = key;
        currentArray = null;
        frontmatter[key] = "";
      } else {
        currentKey = key;
        currentArray = null;
        frontmatter[key] = value;
      }
      continue;
    }

    // List item under currentKey: "  - item" or "- item"
    if (currentKey && trimmed.startsWith("-")) {
      const itemVal = trimmed.slice(1).trim();
      if (!currentArray) {
        currentArray = [];
        frontmatter[currentKey] = currentArray;
      }
      currentArray.push(itemVal);
      continue;
    }

    // Indented continuation or nested key-value under list item
    if (currentKey) {
      const prev = frontmatter[currentKey];
      if (Array.isArray(prev)) {
        // Append or extend last item
        const lastIdx = prev.length - 1;
        if (lastIdx >= 0 && typeof prev[lastIdx] === "string") {
          prev[lastIdx] = `${prev[lastIdx]} ${trimmed}`;
        } else {
          prev.push(trimmed);
        }
      } else if (typeof prev === "string") {
        frontmatter[currentKey] = prev ? `${prev} ${trimmed}` : trimmed;
      }
    }
  }

  return { frontmatter, body };
}

export class RoleCatalogService {
  private readonly catalogDir: string;
  private manifest: CatalogManifest | null = null;
  private rolesBySlug: Map<string, RoleTemplateSummary> = new Map();
  private markdownCache: Map<string, string> = new Map();
  private frontmatterCache: Map<string, Record<string, unknown>> = new Map();
  private divisionsMap: Map<string, DivisionMeta> = new Map();
  private initialized = false;

  constructor(customCatalogDir?: string) {
    this.catalogDir = resolveCatalogDir(customCatalogDir);
  }

  public getCatalogDir(): string {
    return this.catalogDir;
  }

  public initialize(): void {
    if (this.initialized) return;
    this.manifest = verifyCatalogIntegrity(this.catalogDir);
    // Rebuild atomically from verified bytes after any previous failed attempt.
    this.rolesBySlug.clear();
    this.frontmatterCache.clear();
    this.markdownCache.clear();
    this.divisionsMap.clear();

    const divisions = this.manifest.divisions || [];
    const divisionsSet = new Set(divisions);

    // Filter profile files
    const profileFiles = (this.manifest.files || []).filter((f) => {
      const parts = f.path.split("/");
      return divisionsSet.has(parts[0]!) && f.path.endsWith(".md");
    });

    if (profileFiles.length !== 283) {
      throw new CatalogError(`Catalog manifest integrity error: expected 283 profiles, found ${profileFiles.length}`, 500);
    }

    for (const pf of profileFiles) {
      const slug = path.basename(pf.path, ".md");
      const fullPath = path.join(this.catalogDir, pf.path);

      if (!existsSync(fullPath)) {
        throw new CatalogError(`Missing role profile on disk: ${pf.path}`, 500);
      }

      const fileBuffer = readFileSync(fullPath);
      const actualSha256 = createHash("sha256").update(fileBuffer).digest("hex");
      if (actualSha256 !== pf.sha256) {
        throw new CatalogError(`SHA-256 checksum mismatch for ${pf.path}: expected ${pf.sha256}, got ${actualSha256}`, 500);
      }

      const rawText = fileBuffer.toString("utf-8");
      const { frontmatter, body } = parseFrontmatter(rawText);

      const parts = pf.path.split("/");
      const division = parts[0]!;
      const name = String(frontmatter.name || slug);
      const description = String(frontmatter.description || "");
      const color = String(frontmatter.color || "blue");
      const emoji = String(frontmatter.emoji || "🤖");
      const vibe = frontmatter.vibe ? String(frontmatter.vibe) : undefined;

      const summary: RoleTemplateSummary = {
        slug,
        name,
        description,
        division,
        color,
        emoji,
        vibe,
        sourcePath: pf.path,
        sourceCommit: this.manifest.source_commit,
        sha256: pf.sha256,
        sizeBytes: pf.size_bytes,
      };

      this.rolesBySlug.set(slug, summary);
      this.frontmatterCache.set(slug, frontmatter);
      this.markdownCache.set(slug, rawText);
    }

    // Build divisions metadata
    for (const div of divisions) {
      const meta = this.manifest.divisions_metadata?.[div] || { label: div, icon: "Code", color: "#3B82F6" };
      const count = [...this.rolesBySlug.values()].filter((r) => r.division === div).length;
      this.divisionsMap.set(div, {
        id: div,
        label: meta.label,
        icon: meta.icon,
        color: meta.color,
        count,
      });
    }

    this.initialized = true;
  }

  public validateSlug(slug: unknown): string {
    if (!slug || typeof slug !== "string") {
      throw new CatalogError("Role slug must be a non-empty string.", 400);
    }
    const clean = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(clean) && !/^[a-z0-9]$/.test(clean)) {
      throw new CatalogError(`Invalid role slug format: '${slug}'`, 400);
    }
    if (clean.length > 120 || clean.includes("..") || clean.includes("/") || clean.includes("\\")) {
      throw new CatalogError(`Invalid role slug format: '${slug}'`, 400);
    }
    return clean;
  }

  public getManifestSummary(): CatalogManifestSummary {
    this.initialize();
    if (!this.manifest) throw new CatalogError("Catalog not loaded", 500);

    return {
      sourceRepository: this.manifest.source_repository,
      sourceCommit: this.manifest.source_commit,
      importedAt: this.manifest.imported_at,
      license: this.manifest.license,
      totalProfiles: this.rolesBySlug.size,
      divisions: this.manifest.divisions,
      divisionsMetadata: this.manifest.divisions_metadata,
      countsByDivision: this.manifest.counts_by_division,
    };
  }

  public getDivisions(): DivisionMeta[] {
    this.initialize();
    return [...this.divisionsMap.values()];
  }

  public listRoles(filter?: CatalogFilter): RoleTemplateSummary[] {
    this.initialize();

    let list = [...this.rolesBySlug.values()];

    if (filter?.division) {
      const div = filter.division.trim().toLowerCase();
      list = list.filter((r) => r.division.toLowerCase() === div);
    }

    if (filter?.search) {
      const q = filter.search.trim().toLowerCase();
      if (q) {
        list = list.filter((r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.slug.toLowerCase().includes(q) ||
          (r.vibe && r.vibe.toLowerCase().includes(q)) ||
          r.division.toLowerCase().includes(q)
        );
      }
    }

    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  public getRole(slugInput: unknown): RoleTemplate {
    this.initialize();
    const slug = this.validateSlug(slugInput);

    const summary = this.rolesBySlug.get(slug);
    if (!summary) {
      throw new CatalogError(`Role template not found: '${slug}'`, 404);
    }

    // Path traversal check
    const fullPath = path.resolve(this.catalogDir, summary.sourcePath);
    const resolvedCatalog = path.resolve(this.catalogDir) + path.sep;
    if (!fullPath.startsWith(resolvedCatalog)) {
      throw new CatalogError("Path traversal violation detected", 403);
    }

    let rawMarkdown = this.markdownCache.get(slug);
    if (!rawMarkdown) {
      rawMarkdown = readFileSync(fullPath, "utf-8");
      this.markdownCache.set(slug, rawMarkdown);
    }

    let frontmatter = this.frontmatterCache.get(slug);
    if (!frontmatter) {
      const parsed = parseFrontmatter(rawMarkdown);
      frontmatter = parsed.frontmatter;
      this.frontmatterCache.set(slug, frontmatter);
    }

    return {
      ...summary,
      frontmatter,
      originalMarkdown: rawMarkdown,
    };
  }
}

// Global catalog singleton
let singleton: RoleCatalogService | null = null;
export function getRoleCatalogService(): RoleCatalogService {
  if (!singleton) {
    singleton = new RoleCatalogService();
    // Optional catalog must not make legacy Employee routes fail at construction.
    // Every catalog operation initializes and verifies it on first use.
  }
  return singleton;
}
