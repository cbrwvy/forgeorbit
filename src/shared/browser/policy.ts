/**
 * FO-BROWSER01 destination policy.
 * Pure checks plus an injected DNS lookup. Production navigation is HTTPS
 * and refuses loopback, private, and metadata destinations. Loopback HTTP
 * is accepted only when the caller explicitly selects loopback-fixture mode,
 * which the HTTP API enables solely from a test environment variable.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { BROWSER_LIMITS, type BrowserRefusalCode } from "./types.ts";

export type BrowserPolicyMode = "production" | "loopback-fixture";

export interface DestinationAllowance {
  mode: BrowserPolicyMode;
  approvedOrigins: readonly string[];
  /** Origin of the URL the Owner just asked for. Redirect hops must stay inside it and the approved set. */
  requestedOrigin?: string;
}

export type DestinationDecision =
  | { ok: true; url: string; origin: string; host: string }
  | { ok: false; code: BrowserRefusalCode; error: string };

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "metadata",
  "instance-data",
]);

const METADATA_IPS = new Set(["169.254.169.254", "fd00:ec2::254"]);

const forbidden = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  forbidden.addSubnet(address, prefix, "ipv4");
}
forbidden.addAddress("255.255.255.255", "ipv4");
forbidden.addSubnet("::", 128, "ipv6");
forbidden.addSubnet("::1", 128, "ipv6");
forbidden.addSubnet("fc00::", 7, "ipv6");
forbidden.addSubnet("fe80::", 10, "ipv6");
forbidden.addSubnet("ff00::", 8, "ipv6");
forbidden.addAddress("fd00:ec2::254", "ipv6");

export async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function addressDecision(ip: string, mode: BrowserPolicyMode): DestinationDecision | { ok: true } {
  const normalized = ip.trim().toLowerCase();
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  if (METADATA_IPS.has(mapped) || METADATA_IPS.has(normalized)) {
    return { ok: false, code: "metadata_endpoint", error: "Cloud metadata endpoints are blocked." };
  }
  if (isLoopback(mapped) || isLoopback(normalized)) {
    if (mode === "loopback-fixture") return { ok: true };
    return { ok: false, code: "loopback_forbidden", error: "Loopback destinations are blocked." };
  }
  const family = isIP(mapped);
  if (family === 0) return { ok: false, code: "private_network", error: "The destination address is not allowed." };
  if (forbidden.check(mapped, family === 4 ? "ipv4" : "ipv6")) {
    return { ok: false, code: "private_network", error: "Private-network destinations are blocked." };
  }
  return { ok: true };
}

export async function decideDestination(
  raw: string,
  allowance: DestinationAllowance,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveHost,
): Promise<DestinationDecision> {
  if (typeof raw !== "string") return refuse("invalid_request", "The destination must be a URL.");
  const text = raw.trim();
  if (!text || text.length > BROWSER_LIMITS.maxUrlChars) {
    return refuse("invalid_request", "The destination URL is empty or too long.");
  }
  if (/[\u0000-\u001f\u007f]/.test(text) || /\s/.test(text)) {
    return refuse("invalid_request", "The destination URL contains whitespace or control characters.");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse("invalid_request", "The destination is not a valid URL.");
  }
  if (url.username || url.password) return refuse("credentials_in_url", "URLs that carry a username or password are blocked.");
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    return refuse("scheme_forbidden", "Only HTTPS navigation is allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.endsWith(".") || host.includes("%")) {
    return refuse("invalid_request", "The destination host is not allowed.");
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (allowance.mode !== "loopback-fixture" || host !== "localhost") {
      return refuse("loopback_forbidden", "Loopback destinations are blocked.");
    }
  } else if (METADATA_HOSTS.has(host) || host.endsWith(".metadata.google.internal") || host.endsWith(".internal") || host.endsWith(".local")) {
    return refuse("metadata_endpoint", "Local and metadata hostnames are blocked.");
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return refuse("private_network", "Numeric hostnames are blocked.");
  }
  const literal = isIP(host) !== 0;
  let resolved: string[] | null = literal ? [host] : null;
  if (!resolved) {
    try {
      resolved = await resolveHost(host);
    } catch {
      return refuse("dns_unresolved", "The destination could not be resolved.");
    }
    if (resolved.length === 0) return refuse("dns_unresolved", "The destination could not be resolved.");
  }
  let sawLoopback = false;
  for (const address of resolved) {
    const decision = addressDecision(address, allowance.mode);
    if (!decision.ok) {
      if (!literal && decision.code !== "metadata_endpoint") {
        return refuse("dns_rebinding", "The destination resolves to a blocked address.");
      }
      return decision;
    }
    if (isLoopback(address)) sawLoopback = true;
  }
  if (protocol === "http:") {
    if (allowance.mode !== "loopback-fixture" || !sawLoopback) {
      return refuse("https_required", "Browser navigation must use HTTPS.");
    }
  }
  if (allowance.approvedOrigins.some((origin) => origin.startsWith("https://")) && protocol === "http:") {
    return refuse("protocol_downgrade", "This session cannot leave HTTPS.");
  }
  const origin = url.origin;
  const allowed = new Set(allowance.approvedOrigins);
  if (allowance.requestedOrigin && (allowed.size === 0 || allowed.has(allowance.requestedOrigin))) {
    allowed.add(allowance.requestedOrigin);
  }
  if (allowed.size > 0 && !allowed.has(origin)) {
    return refuse("origin_not_approved", "That origin is outside this session's approved destinations.");
  }
  return { ok: true, url: url.toString(), origin, host };
}

/** Link-list classification. It does not resolve DNS and does not grant navigation. */
export function previewLink(raw: string, allowance: DestinationAllowance): { permitted: boolean; code?: BrowserRefusalCode } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { permitted: false, code: "invalid_request" };
  }
  if (url.username || url.password) return { permitted: false, code: "credentials_in_url" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { permitted: false, code: "scheme_forbidden" };
  if (url.protocol === "http:" && allowance.mode !== "loopback-fixture") return { permitted: false, code: "https_required" };
  const allowed = new Set(allowance.approvedOrigins);
  if (allowed.size > 0 && !allowed.has(url.origin)) return { permitted: false, code: "origin_not_approved" };
  return { permitted: true };
}

export function refuse(code: BrowserRefusalCode, error: string): DestinationDecision {
  return { ok: false, code, error };
}

function isLoopback(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (isIP(value) !== 4) return false;
  const [first] = value.split(".");
  return first === "127";
}
