/**
 * FO-DEPLOY02 — Owner-controlled staging integration configuration (validated, no shell).
 */

import { validateProjectPath } from "../clusters/paths.ts";

export const STAGING_INTEGRATION_TYPES = ["external-staging-v1", "forgeorbit-fake-staging-v1"] as const;
export type StagingIntegrationType = (typeof STAGING_INTEGRATION_TYPES)[number];

/** Optional Owner-configured allowlist of external staging project slugs (comma-separated). */
export function allowedStagingProjectSlugs(): string[] | null {
  const raw = process.env.FORGEORBIT_DEPLOYMENT_ALLOWED_SLUGS?.trim();
  if (!raw) return null;
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry));
  return parsed.length > 0 ? parsed : null;
}

export interface StagingIntegrationCapabilities {
  preflight: "local-readonly" | "in-process" | "unsupported";
  dryRun: "local-readonly" | "in-process" | "unsupported";
  execute: "disabled" | "in-process-fake-only";
}

export interface StagingIntegrationRecord {
  id: string;
  clusterId: string;
  projectPath: string;
  environment: "staging";
  integrationType: StagingIntegrationType;
  integrationLabel: string;
  projectSlug: string;
  entrypointRef: string;
  /** Absolute path to published-images.env (--images-file); optional for config-only dry-run. */
  imagesCatalogRef: string | null;
  capabilities: StagingIntegrationCapabilities;
  realExecutionConfigured: boolean;
  realExecutionEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type IntegrationParse<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

function fail(error: string, status = 400): IntegrationParse<never> {
  return { ok: false, error, status };
}

const CREATE_KEYS = [
  "clusterId",
  "projectPath",
  "integrationType",
  "integrationLabel",
  "projectSlug",
  "entrypointRef",
  "imagesCatalogRef",
  "realExecutionConfigured",
  "realExecutionEnabled",
] as const;

export interface StagingIntegrationCreate {
  clusterId: string;
  projectPath: string;
  integrationType: StagingIntegrationType;
  integrationLabel: string;
  projectSlug: string;
  entrypointRef: string;
  imagesCatalogRef?: string | null;
  realExecutionConfigured?: boolean;
  realExecutionEnabled?: boolean;
}

export function defaultCapabilities(type: StagingIntegrationType): StagingIntegrationCapabilities {
  if (type === "forgeorbit-fake-staging-v1") {
    return { preflight: "in-process", dryRun: "in-process", execute: "in-process-fake-only" };
  }
  return { preflight: "local-readonly", dryRun: "local-readonly", execute: "disabled" };
}

export function validateEntrypointRef(ref: string): IntegrationParse<string> {
  if (typeof ref !== "string") return fail("Invalid entrypointRef.");
  const trimmed = ref.trim();
  if (trimmed.length < 1 || trimmed.length > 512) return fail("Invalid entrypointRef.");
  if (trimmed.includes("\0") || trimmed.includes(";") || trimmed.includes("|") || trimmed.includes("&")) {
    return fail("Invalid entrypointRef.");
  }
  if (!trimmed.startsWith("/") && !trimmed.startsWith("@forgeorbit-fake-staging-v1")) {
    return fail("entrypointRef must be an absolute path or the fake integration token.");
  }
  return { ok: true, value: trimmed };
}

export function validateProjectSlug(type: StagingIntegrationType, slug: string): IntegrationParse<string> {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) return fail("Invalid projectSlug.");
  if (type === "external-staging-v1") {
    const allowed = allowedStagingProjectSlugs();
    if (allowed && !allowed.includes(s)) {
      return fail(`projectSlug must be one of: ${allowed.join(", ")}.`);
    }
  }
  return { ok: true, value: s };
}

export function parseStagingIntegrationCreate(input: unknown): IntegrationParse<StagingIntegrationCreate> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Expected an object.");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CREATE_KEYS.includes(key as (typeof CREATE_KEYS)[number])) return fail("Unexpected field.");
  }
  const clusterIdRaw = record.clusterId;
  if (typeof clusterIdRaw !== "string" || !UUID_RE.test(clusterIdRaw.toLowerCase())) return fail("Invalid clusterId.");
  const path = validateProjectPath(record.projectPath);
  if (!path.ok) return fail(path.error);
  const integrationType = record.integrationType;
  if (typeof integrationType !== "string" || !STAGING_INTEGRATION_TYPES.includes(integrationType as StagingIntegrationType)) {
    return fail("Invalid integrationType.");
  }
  const type = integrationType as StagingIntegrationType;
  const label = typeof record.integrationLabel === "string" ? record.integrationLabel.trim() : "";
  if (label.length < 1 || label.length > 120) return fail("Invalid integrationLabel.");
  const slug = validateProjectSlug(type, typeof record.projectSlug === "string" ? record.projectSlug : "");
  if (!slug.ok) return slug;
  const entry = validateEntrypointRef(typeof record.entrypointRef === "string" ? record.entrypointRef : "");
  if (!entry.ok) return entry;
  let imagesCatalogRef: string | null = null;
  if ("imagesCatalogRef" in record && record.imagesCatalogRef != null) {
    if (typeof record.imagesCatalogRef !== "string") return fail("Invalid imagesCatalogRef.");
    const catalog = record.imagesCatalogRef.trim();
    if (!catalog.startsWith("/") || catalog.includes("..")) return fail("imagesCatalogRef must be an absolute path.");
    if (catalog.length > 512) return fail("Invalid imagesCatalogRef.");
    imagesCatalogRef = catalog;
  }
  const realExecutionConfigured = record.realExecutionConfigured === true;
  const realExecutionEnabled = record.realExecutionEnabled === true;
  if (realExecutionEnabled && !realExecutionConfigured) {
    return fail("realExecutionEnabled requires realExecutionConfigured.");
  }
  if (type !== "external-staging-v1" && (realExecutionConfigured || realExecutionEnabled)) {
    return fail("Real execution configuration is only valid for external-staging-v1.");
  }
  return {
    ok: true,
    value: {
      clusterId: clusterIdRaw.toLowerCase(),
      projectPath: path.path,
      integrationType: type,
      integrationLabel: label,
      projectSlug: slug.value,
      entrypointRef: entry.value,
      imagesCatalogRef,
      realExecutionConfigured,
      realExecutionEnabled,
    },
  };
}
