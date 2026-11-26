/**
 * FO-DEPLOY03 — resolve immutable staging image references from Owner-configured catalogs.
 * Pure parsing; no shell, no network.
 */

import { createHash } from "node:crypto";

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface DeploymentImageArtifact {
  key: string;
  reference: string;
}

export type ImageArtifactResolveResult =
  | { ok: true; artifacts: DeploymentImageArtifact[]; imagesFilePath: string; catalogDigest: string }
  | { ok: false; code: string; message: string };

function envGet(content: string, key: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

function validateImmutableRef(label: string, ref: string): string | null {
  if (!ref.includes("@sha256:")) {
    return `${label} must use an immutable @sha256:<64-hex> reference (got mutable or missing digest).`;
  }
  if (/:latest|:develop|:main|:staging|:master/.test(ref)) {
    return `${label} uses a forbidden mutable tag pattern.`;
  }
  const digest = ref.split("@").pop() ?? "";
  if (!SHA256_DIGEST_RE.test(digest)) {
    return `${label} digest is invalid.`;
  }
  return null;
}

function envKeysForProjectSlug(slug: string): { app: string[]; web: string[]; sha: string[] } {
  const prefix = slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    app: [`${prefix}_APP_IMAGE`, `${prefix}_IMAGE`, "APP_IMAGE"],
    web: [`${prefix}_WEB_IMAGE`, "WEB_IMAGE"],
    sha: [`${prefix}_SHA`, "EXPECTED_SHA"],
  };
}

function firstEnvEntry(content: string, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = envGet(content, key);
    if (value) return { key, value };
  }
  return null;
}

export function computeImageCatalogDigest(artifacts: DeploymentImageArtifact[], revisionResolved: string | null): string {
  const payload = JSON.stringify({ revisionResolved, artifacts });
  return createHash("sha256").update(payload).digest("hex");
}

export function resolveImageArtifactsFromCatalog(input: {
  projectSlug: string;
  revisionResolved: string;
  catalogContent: string;
  imagesFilePath: string;
}): ImageArtifactResolveResult {
  if (!SLUG_RE.test(input.projectSlug)) {
    return { ok: false, code: "slug.unsupported", message: `Invalid staging project slug ${input.projectSlug}.` };
  }
  if (!SHA40_RE.test(input.revisionResolved)) {
    return { ok: false, code: "revision.sha40", message: "Revision must be a 40-character Git SHA." };
  }

  const mapping = envKeysForProjectSlug(input.projectSlug);
  const catalogSha = firstEnvEntry(input.catalogContent, mapping.sha)?.value ?? null;
  if (!catalogSha) {
    return {
      ok: false,
      code: "catalog.sha_missing",
      message: "Published images catalog does not declare EXPECTED_SHA or project SHA.",
    };
  }
  if (catalogSha !== input.revisionResolved) {
    return {
      ok: false,
      code: "catalog.sha_mismatch",
      message: `Catalog SHA ${catalogSha.slice(0, 12)}… does not match resolved revision ${input.revisionResolved.slice(0, 12)}….`,
    };
  }

  const artifacts: DeploymentImageArtifact[] = [];
  const appEntry = firstEnvEntry(input.catalogContent, mapping.app);
  if (!appEntry) {
    return { ok: false, code: "catalog.app_missing", message: "Required app image reference missing from catalog." };
  }
  const appErr = validateImmutableRef("App image", appEntry.value);
  if (appErr) return { ok: false, code: "catalog.app_invalid", message: appErr };
  artifacts.push({ key: appEntry.key, reference: appEntry.value });

  const webEntry = firstEnvEntry(input.catalogContent, mapping.web);
  if (webEntry) {
    const webErr = validateImmutableRef("Web image", webEntry.value);
    if (webErr) return { ok: false, code: "catalog.web_invalid", message: webErr };
    artifacts.push({ key: webEntry.key, reference: webEntry.value });
  }

  const catalogDigest = computeImageCatalogDigest(artifacts, input.revisionResolved);
  return {
    ok: true,
    artifacts,
    imagesFilePath: input.imagesFilePath,
    catalogDigest,
  };
}
