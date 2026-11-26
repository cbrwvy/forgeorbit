/**
 * Infrastructure inventory (FO-011D).
 *
 * A row is a declaration the owner typed. It is not a live probe, a
 * deployment, or a credential. Verified operational status is absent.
 */

import { validateProjectPath } from "../clusters/paths.ts";

export const INFRASTRUCTURE_TYPES = [
  "local-development",
  "vps",
  "cloud",
  "docker-host",
  "database",
  "domain",
  "deployment-environment",
  "cicd",
  "other",
] as const;

export type InfrastructureType = (typeof INFRASTRUCTURE_TYPES)[number];

export const INFRASTRUCTURE_TYPE_LABELS: Record<InfrastructureType, string> = {
  "local-development": "Local Development Environment",
  vps: "VPS / Dedicated Server",
  cloud: "Cloud Resource",
  "docker-host": "Docker Host / Container Environment",
  database: "Database",
  domain: "Domain",
  "deployment-environment": "Deployment Environment",
  cicd: "CI/CD Resource",
  other: "Other Infrastructure",
};

export const INFRASTRUCTURE_ENVIRONMENTS = [
  "local",
  "development",
  "staging",
  "production",
  "custom",
] as const;

export type InfrastructureEnvironment = (typeof INFRASTRUCTURE_ENVIRONMENTS)[number];

export const INFRASTRUCTURE_ENVIRONMENT_LABELS: Record<InfrastructureEnvironment, string> = {
  local: "Local",
  development: "Development",
  staging: "Staging",
  production: "Production",
  custom: "Custom",
};

export const INFRASTRUCTURE_STATUSES = ["not-verified", "unknown"] as const;
export type InfrastructureStatus = (typeof INFRASTRUCTURE_STATUSES)[number];

/** Live checks are not implemented. Every row carries this marker. */
export const INFRASTRUCTURE_VERIFICATION = "absent" as const;

export const INFRASTRUCTURE_STATUS_NOTE =
  "Not verified. Adding a resource does not check that it is reachable.";

export const INFRASTRUCTURE_COST_NOTE =
  "Only costs the owner recorded are shown. A missing cost is not zero.";

export const INFRASTRUCTURE_EMPTY_NOTE =
  "No resources are recorded. That is not zero servers and it is not an offline status.";

export const INFRASTRUCTURE_KNOWLEDGE_NOTE =
  "A knowledge note can describe architecture or deployment. It is not a confirmed live state.";

export const INFRASTRUCTURE_KNOWLEDGE_CATEGORIES = [
  "architecture",
  "infrastructure",
  "deployment",
  "operations",
] as const;

export const INFRASTRUCTURE_LIMITS = {
  name: 160,
  provider: 120,
  description: 4_000,
  hostname: 253,
  region: 80,
  custom: 80,
  notes: 8_000,
  list: 500,
  associations: 50,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COST_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const STRICT_CONTROL = /[\u0000-\u001f\u007f]/;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

const CREATE_KEYS = [
  "name",
  "resourceType",
  "provider",
  "description",
  "hostname",
  "ipAddress",
  "environment",
  "environmentCustom",
  "region",
  "costAmount",
  "currency",
  "status",
  "notes",
  "clusterIds",
  "projectPaths",
] as const;

const UPDATE_KEYS = [
  "name",
  "resourceType",
  "provider",
  "description",
  "hostname",
  "ipAddress",
  "environment",
  "environmentCustom",
  "region",
  "costAmount",
  "currency",
  "status",
  "notes",
] as const;

const CLUSTER_LINK_KEYS = ["clusterId"] as const;
const PROJECT_LINK_KEYS = ["projectPath"] as const;
const ENVIRONMENT_KEYS = ["projectPath", "environment", "customLabel"] as const;

export interface InfrastructureRef {
  id: string;
  name: string;
}

export interface InfrastructureProjectRef {
  path: string;
  name: string;
}

export interface InfrastructureEnvironmentLink {
  projectPath: string;
  projectName: string;
  environment: InfrastructureEnvironment;
  customLabel: string;
}

export interface InfrastructureResource {
  id: string;
  name: string;
  resourceType: InfrastructureType;
  provider: string | null;
  description: string;
  hostname: string | null;
  ipAddress: string | null;
  environment: InfrastructureEnvironment | null;
  environmentCustom: string | null;
  region: string | null;
  costAmount: string | null;
  currency: string | null;
  status: InfrastructureStatus;
  verification: typeof INFRASTRUCTURE_VERIFICATION;
  notes: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  clusters: InfrastructureRef[];
  projects: InfrastructureProjectRef[];
  environmentLinks: InfrastructureEnvironmentLink[];
}

export interface InfrastructureCreate {
  name: string;
  resourceType: InfrastructureType;
  provider: string | null;
  description: string;
  hostname: string | null;
  ipAddress: string | null;
  environment: InfrastructureEnvironment | null;
  environmentCustom: string | null;
  region: string | null;
  costAmount: string | null;
  currency: string | null;
  status: InfrastructureStatus;
  notes: string;
  clusterIds: string[];
  projectPaths: string[];
}

export interface InfrastructureUpdate {
  name?: string;
  resourceType?: InfrastructureType;
  provider?: string | null;
  description?: string;
  hostname?: string | null;
  ipAddress?: string | null;
  environment?: InfrastructureEnvironment | null;
  environmentCustom?: string | null;
  region?: string | null;
  costAmount?: string | null;
  currency?: string | null;
  status?: InfrastructureStatus;
  notes?: string;
}

export interface ProjectEnvironmentDeclaration {
  projectPath: string;
  projectName: string;
  environment: InfrastructureEnvironment;
  customLabel: string;
  createdAt: number;
}

export interface InfrastructureListQuery {
  q?: string;
  resourceType?: InfrastructureType;
  clusterId?: string;
  projectPath?: string;
  environment?: InfrastructureEnvironment;
  provider?: string;
  archived: "active" | "archived" | "all";
}

export interface ClusterInfrastructureProject {
  projectPath: string;
  name: string;
  membership: "cluster" | "resource-only";
  environments: { environment: InfrastructureEnvironment; customLabel: string }[];
  resourceIds: string[];
}

export interface ClusterInfrastructureView {
  clusterId: string;
  note: string;
  resources: InfrastructureResource[];
  projects: ClusterInfrastructureProject[];
  domains: { id: string; name: string; hostname: string | null }[];
  providers: { name: string; resourceIds: string[] }[];
  providerUnspecified: number;
  costs: { resourceId: string; name: string; amount: string | null; currency: string | null }[];
  unverified: { notVerified: number; unknown: number };
  statusNote: string;
  costNote: string;
  emptyNote: string;
}

export type InfrastructureParse<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

export function infrastructureStatusLabel(status: InfrastructureStatus): string {
  return status === "unknown" ? "Unknown" : "Not verified";
}

export function infrastructureEnvironmentLabel(
  environment: InfrastructureEnvironment | null,
  custom: string | null,
): string {
  if (!environment) return "Not recorded";
  if (environment === "custom") return custom?.trim() || "Custom";
  return INFRASTRUCTURE_ENVIRONMENT_LABELS[environment];
}

export function formatRecordedCost(amount: string | null, currency: string | null): string {
  if (amount && currency) return `${amount} ${currency}`;
  if (amount) return `${amount} (currency not recorded)`;
  if (currency) return `${currency} (amount not recorded)`;
  return "No recorded cost";
}

export function matchesInfrastructureQuery(resource: InfrastructureResource, query: InfrastructureListQuery): boolean {
  if (query.archived === "active" && resource.archivedAt != null) return false;
  if (query.archived === "archived" && resource.archivedAt == null) return false;
  if (query.resourceType && resource.resourceType !== query.resourceType) return false;
  if (query.clusterId && !resource.clusters.some((cluster) => cluster.id === query.clusterId)) return false;
  if (query.projectPath && !resource.projects.some((project) => project.path === query.projectPath)) return false;
  if (query.environment && resource.environment !== query.environment) return false;
  if (query.provider && (resource.provider ?? "").toLocaleLowerCase() !== query.provider.toLocaleLowerCase()) return false;
  const q = query.q?.trim().toLocaleLowerCase();
  if (q) {
    const haystack = [
      resource.name,
      resource.provider,
      resource.hostname,
      resource.ipAddress,
      resource.region,
      resource.description,
      resource.notes,
      resource.environmentCustom,
    ].filter((part): part is string => !!part).join("\n").toLocaleLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function parseInfrastructureCreate(input: unknown): InfrastructureParse<InfrastructureCreate> {
  const record = recordWithKeys(input, CREATE_KEYS);
  if (!record.ok) return record;
  const name = requiredName(record.value.name);
  if (!name.ok) return name;
  const resourceType = parseType(record.value.resourceType);
  if (!resourceType.ok) return resourceType;
  const provider = optionalLabel(record.value.provider, INFRASTRUCTURE_LIMITS.provider, "provider", true);
  if (!provider.ok) return provider;
  const description = optionalBody(record.value.description, INFRASTRUCTURE_LIMITS.description, "description", true);
  if (!description.ok) return description;
  const hostname = optionalHostname(record.value.hostname, true);
  if (!hostname.ok) return hostname;
  const ipAddress = optionalIp(record.value.ipAddress, true);
  if (!ipAddress.ok) return ipAddress;
  const environment = optionalEnvironment(record.value.environment, true);
  if (!environment.ok) return environment;
  const environmentCustom = optionalCustom(record.value.environmentCustom, true);
  if (!environmentCustom.ok) return environmentCustom;
  const pair = environmentPair(environment.value, environmentCustom.value);
  if (!pair.ok) return pair;
  const region = optionalLabel(record.value.region, INFRASTRUCTURE_LIMITS.region, "region", true);
  if (!region.ok) return region;
  const costAmount = optionalCost(record.value.costAmount, true);
  if (!costAmount.ok) return costAmount;
  const currency = optionalCurrency(record.value.currency, true);
  if (!currency.ok) return currency;
  const status = optionalStatus(record.value.status);
  if (!status.ok) return status;
  const notes = optionalBody(record.value.notes, INFRASTRUCTURE_LIMITS.notes, "notes", true);
  if (!notes.ok) return notes;
  const clusterIds = idList(record.value.clusterIds, "clusterIds", (value) => parseUuid(value, "cluster id"));
  if (!clusterIds.ok) return clusterIds;
  const projectPaths = idList(record.value.projectPaths, "projectPaths", (value) => {
    const path = validateProjectPath(value);
    return path.ok ? { ok: true, value: path.path } : { ok: false, error: path.error, status: 400 };
  });
  if (!projectPaths.ok) return projectPaths;
  return {
    ok: true,
    value: {
      name: name.value,
      resourceType: resourceType.value,
      provider: provider.value,
      description: description.value ?? "",
      hostname: hostname.value,
      ipAddress: ipAddress.value,
      environment: pair.value.environment,
      environmentCustom: pair.value.environmentCustom,
      region: region.value,
      costAmount: costAmount.value,
      currency: currency.value,
      status: status.value,
      notes: notes.value ?? "",
      clusterIds: clusterIds.value,
      projectPaths: projectPaths.value,
    },
  };
}

export function parseInfrastructureUpdate(input: unknown): InfrastructureParse<InfrastructureUpdate> {
  const record = recordWithKeys(input, UPDATE_KEYS);
  if (!record.ok) return record;
  const value: InfrastructureUpdate = {};
  if ("name" in record.value) {
    const name = requiredName(record.value.name);
    if (!name.ok) return name;
    value.name = name.value;
  }
  if ("resourceType" in record.value) {
    const resourceType = parseType(record.value.resourceType);
    if (!resourceType.ok) return resourceType;
    value.resourceType = resourceType.value;
  }
  if ("provider" in record.value) {
    const provider = optionalLabel(record.value.provider, INFRASTRUCTURE_LIMITS.provider, "provider", false);
    if (!provider.ok) return provider;
    value.provider = provider.value;
  }
  if ("description" in record.value) {
    const description = optionalBody(record.value.description, INFRASTRUCTURE_LIMITS.description, "description", false);
    if (!description.ok) return description;
    value.description = description.value ?? "";
  }
  if ("hostname" in record.value) {
    const hostname = optionalHostname(record.value.hostname, false);
    if (!hostname.ok) return hostname;
    value.hostname = hostname.value;
  }
  if ("ipAddress" in record.value) {
    const ipAddress = optionalIp(record.value.ipAddress, false);
    if (!ipAddress.ok) return ipAddress;
    value.ipAddress = ipAddress.value;
  }
  if ("environment" in record.value) {
    const environment = optionalEnvironment(record.value.environment, false);
    if (!environment.ok) return environment;
    value.environment = environment.value;
  }
  if ("environmentCustom" in record.value) {
    const environmentCustom = optionalCustom(record.value.environmentCustom, false);
    if (!environmentCustom.ok) return environmentCustom;
    value.environmentCustom = environmentCustom.value;
  }
  if ("region" in record.value) {
    const region = optionalLabel(record.value.region, INFRASTRUCTURE_LIMITS.region, "region", false);
    if (!region.ok) return region;
    value.region = region.value;
  }
  if ("costAmount" in record.value) {
    const costAmount = optionalCost(record.value.costAmount, false);
    if (!costAmount.ok) return costAmount;
    value.costAmount = costAmount.value;
  }
  if ("currency" in record.value) {
    const currency = optionalCurrency(record.value.currency, false);
    if (!currency.ok) return currency;
    value.currency = currency.value;
  }
  if ("status" in record.value) {
    if (record.value.status == null) return fail("Invalid status.", 400);
    const status = parseStatus(record.value.status);
    if (!status.ok) return status;
    value.status = status.value;
  }
  if ("notes" in record.value) {
    const notes = optionalBody(record.value.notes, INFRASTRUCTURE_LIMITS.notes, "notes", false);
    if (!notes.ok) return notes;
    value.notes = notes.value ?? "";
  }
  if (Object.keys(value).length === 0) return fail("Nothing to change.", 400);
  if ("environment" in value || "environmentCustom" in value) {
    const environment = "environment" in value ? value.environment ?? null : undefined;
    const custom = "environmentCustom" in value ? value.environmentCustom ?? null : undefined;
    if (environment !== undefined && custom !== undefined) {
      const pair = environmentPair(environment, custom);
      if (!pair.ok) return pair;
    } else if (environment === null && custom === undefined) {
      value.environmentCustom = null;
    } else if (environment && environment !== "custom" && custom === undefined) {
      value.environmentCustom = null;
    } else if (environment === "custom" && !custom) {
      return fail("A custom environment needs a label.", 400);
    }
  }
  return { ok: true, value };
}

export function parseClusterLink(input: unknown): InfrastructureParse<{ clusterId: string }> {
  const record = recordWithKeys(input, CLUSTER_LINK_KEYS);
  if (!record.ok) return record;
  const id = parseUuid(record.value.clusterId, "clusterId");
  if (!id.ok) return id;
  return { ok: true, value: { clusterId: id.value } };
}

export function parseProjectLink(input: unknown): InfrastructureParse<{ projectPath: string }> {
  const record = recordWithKeys(input, PROJECT_LINK_KEYS);
  if (!record.ok) return record;
  const path = validateProjectPath(record.value.projectPath);
  if (!path.ok) return fail(path.error, 400);
  return { ok: true, value: { projectPath: path.path } };
}

export function parseEnvironmentDeclaration(input: unknown): InfrastructureParse<{
  projectPath: string;
  environment: InfrastructureEnvironment;
  customLabel: string;
}> {
  const record = recordWithKeys(input, ENVIRONMENT_KEYS);
  if (!record.ok) return record;
  const path = validateProjectPath(record.value.projectPath);
  if (!path.ok) return fail(path.error, 400);
  const environment = parseEnvironment(record.value.environment);
  if (!environment.ok) return environment;
  const custom = optionalCustom(record.value.customLabel, true);
  if (!custom.ok) return custom;
  if (environment.value === "custom") {
    if (!custom.value) return fail("A custom environment needs a label.", 400);
    return { ok: true, value: { projectPath: path.path, environment: environment.value, customLabel: custom.value } };
  }
  if (custom.value) return fail("Only a custom environment has a label.", 400);
  return { ok: true, value: { projectPath: path.path, environment: environment.value, customLabel: "" } };
}

export function parseInfrastructureListQuery(params: URLSearchParams): InfrastructureParse<InfrastructureListQuery> {
  const allowed = new Set(["q", "type", "clusterId", "projectPath", "environment", "provider", "archived"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) return fail("Unexpected query.", 400);
  }
  const query: InfrastructureListQuery = { archived: "active" };
  const q = params.get("q");
  if (q != null) {
    const trimmed = q.trim();
    if (trimmed.length > 200 || STRICT_CONTROL.test(trimmed)) return fail("Invalid search.", 400);
    if (trimmed) query.q = trimmed;
  }
  const type = params.get("type");
  if (type != null) {
    const parsed = parseType(type);
    if (!parsed.ok) return parsed;
    query.resourceType = parsed.value;
  }
  const clusterId = params.get("clusterId");
  if (clusterId != null) {
    const parsed = parseUuid(clusterId, "clusterId");
    if (!parsed.ok) return parsed;
    query.clusterId = parsed.value;
  }
  const projectPath = params.get("projectPath");
  if (projectPath != null) {
    const parsed = validateProjectPath(projectPath);
    if (!parsed.ok) return fail(parsed.error, 400);
    query.projectPath = parsed.path;
  }
  const environment = params.get("environment");
  if (environment != null) {
    const parsed = parseEnvironment(environment);
    if (!parsed.ok) return parsed;
    query.environment = parsed.value;
  }
  const provider = params.get("provider");
  if (provider != null) {
    const parsed = optionalLabel(provider, INFRASTRUCTURE_LIMITS.provider, "provider", false);
    if (!parsed.ok) return parsed;
    if (parsed.value) query.provider = parsed.value;
  }
  const archived = params.get("archived");
  if (archived != null) {
    if (archived !== "true" && archived !== "all" && archived !== "false") return fail("Invalid archived filter.", 400);
    query.archived = archived === "true" ? "archived" : archived === "all" ? "all" : "active";
  }
  return { ok: true, value: query };
}

export function parseResourceId(value: string): InfrastructureParse<string> {
  return parseUuid(value, "resource id");
}

function fail(error: string, status: number): InfrastructureParse<never> {
  return { ok: false, error, status };
}

function recordWithKeys(input: unknown, keys: readonly string[]): InfrastructureParse<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Expected an object.", 400);
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) return fail("Unexpected field.", 400);
  }
  return { ok: true, value: record };
}

function rejectSecret(value: string): InfrastructureParse<string> {
  if (PRIVATE_KEY.test(value)) return fail("Private keys are not stored in the inventory.", 400);
  return { ok: true, value };
}

function requiredName(value: unknown): InfrastructureParse<string> {
  if (typeof value !== "string") return fail("Invalid name.", 400);
  const name = value.trim();
  if (name.length < 1 || name.length > INFRASTRUCTURE_LIMITS.name || STRICT_CONTROL.test(name)) return fail("Invalid name.", 400);
  return rejectSecret(name);
}

function parseType(value: unknown): InfrastructureParse<InfrastructureType> {
  if (typeof value !== "string" || !INFRASTRUCTURE_TYPES.includes(value as InfrastructureType)) {
    return fail("Invalid resource type.", 400);
  }
  return { ok: true, value: value as InfrastructureType };
}

function parseEnvironment(value: unknown): InfrastructureParse<InfrastructureEnvironment> {
  if (typeof value !== "string" || !INFRASTRUCTURE_ENVIRONMENTS.includes(value as InfrastructureEnvironment)) {
    return fail("Invalid environment.", 400);
  }
  return { ok: true, value: value as InfrastructureEnvironment };
}

function parseStatus(value: unknown): InfrastructureParse<InfrastructureStatus> {
  if (value === "online" || value === "verified" || value === "healthy" || value === "up") {
    return fail("Live status is not verified from this registry.", 400);
  }
  if (typeof value !== "string" || !INFRASTRUCTURE_STATUSES.includes(value as InfrastructureStatus)) {
    return fail("Invalid status.", 400);
  }
  return { ok: true, value: value as InfrastructureStatus };
}

function optionalStatus(value: unknown): InfrastructureParse<InfrastructureStatus> {
  if (value == null) return { ok: true, value: "not-verified" };
  return parseStatus(value);
}

function optionalLabel(
  value: unknown,
  max: number,
  label: string,
  absentIsNull: boolean,
): InfrastructureParse<string | null> {
  if (value == null) return absentIsNull || value === null ? { ok: true, value: null } : fail(`Invalid ${label}.`, 400);
  if (typeof value !== "string") return fail(`Invalid ${label}.`, 400);
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > max || STRICT_CONTROL.test(text)) return fail(`Invalid ${label}.`, 400);
  const secret = rejectSecret(text);
  if (!secret.ok) return secret;
  return { ok: true, value: text };
}

function optionalBody(
  value: unknown,
  max: number,
  label: string,
  absentIsEmpty: boolean,
): InfrastructureParse<string | null> {
  if (value == null) return { ok: true, value: absentIsEmpty ? "" : null };
  if (typeof value !== "string") return fail(`Invalid ${label}.`, 400);
  if (value.length > max || TEXT_CONTROL.test(value)) return fail(`Invalid ${label}.`, 400);
  const secret = rejectSecret(value);
  if (!secret.ok) return secret;
  return { ok: true, value };
}

function optionalHostname(value: unknown, absentIsNull: boolean): InfrastructureParse<string | null> {
  const label = optionalLabel(value, INFRASTRUCTURE_LIMITS.hostname, "hostname", absentIsNull);
  if (!label.ok || label.value == null) return label;
  if (!isHostname(label.value)) return fail("Invalid hostname.", 400);
  return label;
}

function optionalIp(value: unknown, absentIsNull: boolean): InfrastructureParse<string | null> {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") return fail("Invalid IP address.", 400);
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (!isIp(text)) return fail("Invalid IP address.", 400);
  return { ok: true, value: text };
}

function optionalEnvironment(value: unknown, absentIsNull: boolean): InfrastructureParse<InfrastructureEnvironment | null> {
  if (value == null || value === "") return { ok: true, value: null };
  return parseEnvironment(value);
}

function optionalCustom(value: unknown, absentIsNull: boolean): InfrastructureParse<string | null> {
  return optionalLabel(value, INFRASTRUCTURE_LIMITS.custom, "environment label", absentIsNull);
}

function optionalCost(value: unknown, absentIsNull: boolean): InfrastructureParse<string | null> {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "number" && typeof value !== "string") return fail("Invalid cost.", 400);
  const text = String(value).trim();
  if (!COST_RE.test(text)) return fail("Invalid cost.", 400);
  return { ok: true, value: text };
}

function optionalCurrency(value: unknown, absentIsNull: boolean): InfrastructureParse<string | null> {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return fail("Invalid currency.", 400);
  const text = value.trim().toUpperCase();
  if (!CURRENCY_RE.test(text)) return fail("Invalid currency.", 400);
  return { ok: true, value: text };
}

function environmentPair(
  environment: InfrastructureEnvironment | null,
  custom: string | null,
): InfrastructureParse<{ environment: InfrastructureEnvironment | null; environmentCustom: string | null }> {
  if (environment === "custom") {
    if (!custom) return fail("A custom environment needs a label.", 400);
    return { ok: true, value: { environment, environmentCustom: custom } };
  }
  if (custom) return fail("Only a custom environment has a label.", 400);
  return { ok: true, value: { environment, environmentCustom: null } };
}

function parseUuid(value: unknown, label: string): InfrastructureParse<string> {
  if (typeof value !== "string" || !UUID_RE.test(value.toLowerCase())) return fail(`Invalid ${label}.`, 400);
  return { ok: true, value: value.toLowerCase() };
}

function idList(
  value: unknown,
  label: string,
  parse: (value: unknown) => InfrastructureParse<string>,
): InfrastructureParse<string[]> {
  if (value == null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail(`Invalid ${label}.`, 400);
  if (value.length > INFRASTRUCTURE_LIMITS.associations) return fail(`Too many ${label}.`, 400);
  const ids: string[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (!parsed.ok) return parsed;
    if (!ids.includes(parsed.value)) ids.push(parsed.value);
  }
  return { ok: true, value: ids };
}

function isHostname(value: string): boolean {
  if (value.length > INFRASTRUCTURE_LIMITS.hostname || value.includes(":") || value.endsWith(".")) return false;
  const labels = value.split(".");
  if (labels.length === 0) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isIp(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function isIpv6(value: string): boolean {
  if (!value || value.includes("%") || value.includes(".")) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const hex = /^[0-9a-f]{1,4}$/i;
  const parts = (segment: string) => (segment ? segment.split(":") : []);
  if (halves.length === 1) {
    const all = parts(value);
    return all.length === 8 && all.every((part) => hex.test(part));
  }
  const left = parts(halves[0] ?? "");
  const right = parts(halves[1] ?? "");
  if (left.some((part) => !hex.test(part)) || right.some((part) => !hex.test(part))) return false;
  return left.length + right.length < 8;
}
