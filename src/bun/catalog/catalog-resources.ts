/** Offline, filesystem-only resource resolution. Never imports the native runtime. */
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class CatalogError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "CatalogError";
  }
}

export const CATALOG_RESOURCE_PATH = "resources/agent-catalog/agency-agents";
// Trust anchors for the committed FO-014A snapshot. Update deliberately alongside
// a reviewed catalog import; the manifest cannot authenticate itself.
export const CATALOG_MANIFEST_SHA256 = "35198619aaa6df0abc02358de85866bd0d5d08a32aa388a83bbbafab1aced473";
export const CATALOG_PROVENANCE_SHA256 = "418c24c0d9b101acf3ff018a48cc377970f7308d9951fbf6364bfb84dc385700";

export interface CatalogManifest {
  source_repository: string;
  source_commit: string;
  imported_at: string;
  license: string;
  total_profiles: number;
  divisions: string[];
  divisions_metadata: Record<string, { label: string; icon: string; color: string }>;
  counts_by_division: Record<string, number>;
  files: { path: string; sha256: string; size_bytes: number }[];
}

export function resolveCatalogDir(custom?: string, context: {
  execPath?: string;
  moduleDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const execPath = context.execPath ?? process.execPath;
  const moduleDir = context.moduleDir ?? import.meta.dir;
  const env = context.env ?? process.env;
  const override = custom ?? env.FORGEORBIT_CATALOG_PATH ?? env.FORGEORBIT_CATALOG_DIR;
  if (override !== undefined) {
    if (!path.isAbsolute(override)) throw new CatalogError("Catalog override must be an absolute path.", 500);
    // A missing explicit override must fail visibly, never silently pick another catalog.
    return path.normalize(override);
  }

  const executableDir = path.dirname(execPath);
  const packaged = path.resolve(executableDir, "../Resources/app", CATALOG_RESOURCE_PATH);
  if (path.basename(executableDir) === "MacOS" && path.basename(path.dirname(executableDir)) === "Contents") {
    return packaged;
  }
  // Also supports headless inspection using a host Bun binary and bundled JS.
  if (moduleDir.endsWith(`${path.sep}Resources${path.sep}app${path.sep}bun`)) {
    return path.resolve(moduleDir, "..", CATALOG_RESOURCE_PATH);
  }
  // Source-only development fallback, anchored to this module, never cwd.
  if (env.NODE_ENV !== "production" && moduleDir.endsWith(`${path.sep}src${path.sep}bun${path.sep}catalog`)) {
    return path.resolve(moduleDir, "../../..", CATALOG_RESOURCE_PATH);
  }
  return packaged;
}

function catalogFile(root: string, relative: string): Buffer {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe catalog path: ${relative}`);
  }
  if (!lstatSync(root).isDirectory()) throw new Error(`Catalog root is not a directory: ${root}`);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Catalog entry must be a regular file/directory, without symlinks: ${relative}`);
    }
  }
  return readFileSync(current);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Verify every committed manifest entry, including strategy, metadata and license. */
export function verifyCatalogIntegrity(root: string): CatalogManifest {
  try {
    const manifestBytes = catalogFile(root, "catalog-manifest.json");
    if (sha256(manifestBytes) !== CATALOG_MANIFEST_SHA256) throw new Error("SHA-256 mismatch: catalog-manifest.json");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as CatalogManifest;
    for (const file of manifest.files) {
      const bytes = catalogFile(root, file.path);
      if (bytes.length !== file.size_bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`SHA-256/size mismatch: ${file.path}`);
      }
    }
    if (sha256(catalogFile(root, "PROVENANCE.md")) !== CATALOG_PROVENANCE_SHA256) {
      throw new Error("SHA-256 mismatch: PROVENANCE.md");
    }
    return manifest;
  } catch (error) {
    throw new CatalogError(`Offline catalog unavailable or corrupt at ${root}: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
}
