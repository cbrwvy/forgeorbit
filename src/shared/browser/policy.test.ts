import { expect, test } from "bun:test";
import { addressDecision, decideDestination, previewLink, type BrowserPolicyMode } from "./policy.ts";

const publicHost = async () => ["93.184.216.34"];
const rebind = async () => ["127.0.0.1"];

async function decide(raw: string, mode: BrowserPolicyMode = "production", approvedOrigins: string[] = [], requestedOrigin?: string) {
  return decideDestination(raw, { mode, approvedOrigins, requestedOrigin }, publicHost);
}

async function refused(raw: string, mode: BrowserPolicyMode = "production", approvedOrigins: string[] = []) {
  const decision = await decide(raw, mode, approvedOrigins);
  if (decision.ok) throw new Error(`expected ${raw} to be refused`);
  return decision.code;
}

test("production navigation requires HTTPS and a public address", async () => {
  const allowed = await decide("https://public.example/docs");
  expect(allowed.ok).toBe(true);
  if (allowed.ok) expect(allowed.origin).toBe("https://public.example");
  expect(await refused("http://public.example/")).toBe("https_required");
});

test("loopback HTTP is allowed only in fixture mode", async () => {
  expect(await refused("http://127.0.0.1:9/ok")).toBe("loopback_forbidden");
  expect(await refused("https://127.0.0.1/")).toBe("loopback_forbidden");
  expect(await refused("http://[::1]/")).toBe("loopback_forbidden");
  const fixture = await decide("http://127.0.0.1:4317/ok", "loopback-fixture");
  expect(fixture.ok).toBe(true);
  const named = await decideDestination("http://localhost:9/ok", { mode: "loopback-fixture", approvedOrigins: [] }, async () => ["127.0.0.1"]);
  expect(named.ok).toBe(true);
  expect(await refused("http://localhost:9/ok")).toBe("loopback_forbidden");
});

test("private networks, metadata, and disguised hosts are refused", async () => {
  expect(await refused("https://10.1.1.1/")).toBe("private_network");
  expect(await refused("https://192.168.1.20/secret")).toBe("private_network");
  expect(await refused("https://172.16.0.1/")).toBe("private_network");
  expect(await refused("https://169.254.169.254/latest/meta-data/")).toBe("metadata_endpoint");
  expect(await refused("http://169.254.169.254/", "loopback-fixture")).toBe("metadata_endpoint");
  expect(await refused("https://metadata.google.internal/")).toBe("metadata_endpoint");
  expect(await refused("https://printer.local/")).toBe("metadata_endpoint");
  expect(await refused("https://2130706433/")).toBe("loopback_forbidden");
  expect(addressDecision("10.2.3.4", "loopback-fixture").ok).toBe(false);
  expect(addressDecision("::ffff:127.0.0.1", "production").ok).toBe(false);
  expect(addressDecision("::ffff:127.0.0.1", "loopback-fixture").ok).toBe(true);
});

test("file, javascript, data, and credential URLs are refused", async () => {
  expect(await refused("file:///etc/passwd")).toBe("scheme_forbidden");
  expect(await refused("javascript:alert(1)")).toBe("scheme_forbidden");
  expect(await refused("data:text/html,hi")).toBe("scheme_forbidden");
  expect(await refused("chrome://settings")).toBe("scheme_forbidden");
  expect(await refused("about:blank")).toBe("scheme_forbidden");
  expect(await refused("https://user:secret@public.example/")).toBe("credentials_in_url");
});

test("a hostname that resolves to a blocked address is refused", async () => {
  const decision = await decideDestination("https://rebind.example/", { mode: "production", approvedOrigins: [] }, rebind);
  expect(decision.ok).toBe(false);
  if (!decision.ok) expect(decision.code).toBe("dns_rebinding");
  const missing = await decideDestination("https://missing.example/", { mode: "production", approvedOrigins: [] }, async () => {
    throw new Error("ENOTFOUND");
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe("dns_unresolved");
});

test("approved origins stay in force for later destinations", async () => {
  const first = await decide("https://public.example/start");
  expect(first.ok).toBe(true);
  const same = await decide("https://public.example/next", "production", ["https://public.example"]);
  expect(same.ok).toBe(true);
  const other = await decide("https://other.example/next", "production", ["https://public.example"]);
  expect(other.ok).toBe(false);
  if (!other.ok) expect(other.code).toBe("origin_not_approved");
  const downgrade = await decide("http://127.0.0.1/next", "loopback-fixture", ["https://public.example"]);
  expect(downgrade.ok).toBe(false);
  if (!downgrade.ok) expect(downgrade.code).toBe("protocol_downgrade");
  const redirect = await decide("https://other.example/landed", "production", ["https://public.example"], "https://public.example");
  expect(redirect.ok).toBe(false);
});

test("link preview does not treat an external or script URL as permitted", () => {
  const allowance = { mode: "loopback-fixture" as const, approvedOrigins: ["http://127.0.0.1:9"] };
  expect(previewLink("http://127.0.0.1:9/next", allowance).permitted).toBe(true);
  expect(previewLink("https://example.com/out", allowance).permitted).toBe(false);
  expect(previewLink("javascript:alert(1)", allowance).permitted).toBe(false);
  expect(previewLink("file:///etc/passwd", allowance).permitted).toBe(false);
});
