import { expect, test } from "bun:test";
import {
  formatRecordedCost,
  infrastructureStatusLabel,
  matchesInfrastructureQuery,
  parseInfrastructureCreate,
  parseInfrastructureUpdate,
  type InfrastructureResource,
} from "./model.ts";

const base = {
  name: "Staging fixture",
  resourceType: "vps",
} as const;

test("a manual resource stays unverified and optional fields stay empty", () => {
  const parsed = parseInfrastructureCreate(base);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.status).toBe("not-verified");
  expect(parsed.value.hostname).toBeNull();
  expect(parsed.value.ipAddress).toBeNull();
  expect(parsed.value.costAmount).toBeNull();
  expect(parsed.value.currency).toBeNull();
  expect(parsed.value.environment).toBeNull();
  expect(infrastructureStatusLabel("not-verified")).toBe("Not verified");
  expect(infrastructureStatusLabel("unknown")).toBe("Unknown");
  expect(formatRecordedCost(null, null)).toBe("No recorded cost");
  expect(formatRecordedCost("12.5", "USD")).toBe("12.5 USD");
  expect(formatRecordedCost("12", null)).toBe("12 (currency not recorded)");
});

test("live status, secrets, and bad addresses are rejected", () => {
  expect(parseInfrastructureCreate({ ...base, status: "online" })).toMatchObject({
    ok: false,
    error: "Live status is not verified from this registry.",
  });
  expect(parseInfrastructureCreate({ ...base, password: "nope" })).toMatchObject({ ok: false, error: "Unexpected field." });
  expect(parseInfrastructureCreate({ ...base, sshKey: "nope" })).toMatchObject({ ok: false, error: "Unexpected field." });
  expect(parseInfrastructureCreate({ ...base, notes: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" })).toMatchObject({
    ok: false,
    error: "Private keys are not stored in the inventory.",
  });
  expect(parseInfrastructureCreate({ ...base, ipAddress: "10.0.0.1" }).ok).toBe(true);
  expect(parseInfrastructureCreate({ ...base, ipAddress: "not-an-ip" })).toMatchObject({ ok: false });
  expect(parseInfrastructureCreate({ ...base, hostname: "https://example.com" })).toMatchObject({ ok: false });
  expect(parseInfrastructureCreate({ ...base, hostname: "fixture.invalid" }).ok).toBe(true);
  expect(parseInfrastructureCreate({ ...base, costAmount: "-4" })).toMatchObject({ ok: false });
  expect(parseInfrastructureCreate({ ...base, environment: "custom" })).toMatchObject({
    ok: false,
    error: "A custom environment needs a label.",
  });
  const custom = parseInfrastructureCreate({ ...base, environment: "custom", environmentCustom: "preview" });
  expect(custom.ok && custom.value.environmentCustom).toBe("preview");
});

test("filters match type, cluster, project, environment, provider, and archive", () => {
  const resource = {
    id: "1",
    name: "Shared",
    resourceType: "domain",
    provider: "Example",
    description: "",
    hostname: "app.example.invalid",
    ipAddress: null,
    environment: "staging",
    environmentCustom: null,
    region: null,
    costAmount: null,
    currency: null,
    status: "unknown",
    verification: "absent",
    notes: "",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    clusters: [{ id: "c1", name: "One" }, { id: "c2", name: "Two" }],
    projects: [{ path: "/work/a", name: "A" }, { path: "/work/b", name: "B" }],
    environmentLinks: [],
  } satisfies InfrastructureResource;
  expect(matchesInfrastructureQuery(resource, { archived: "active", resourceType: "domain", clusterId: "c2", projectPath: "/work/b", environment: "staging", provider: "example" })).toBe(true);
  expect(matchesInfrastructureQuery(resource, { archived: "archived" })).toBe(false);
  expect(matchesInfrastructureQuery(resource, { archived: "active", q: "app.example" })).toBe(true);
  const updated = parseInfrastructureUpdate({ status: "unknown", provider: null });
  expect(updated.ok && updated.value).toEqual({ status: "unknown", provider: null });
});
