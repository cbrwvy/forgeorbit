/**
 * Where a health check is allowed to connect.
 *
 * Profiles are configuration, and a future editor will persist them. A check
 * that can target an arbitrary host is a way to poke the network from the
 * ForgeOrbit process. The first version allows loopback only. Extend
 * {@link isAllowedHealthHost} deliberately — do not fall open.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isAllowedHealthHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface HttpTarget {
  href: string;
  hostname: string;
  port: number;
}

export function parseLoopbackHttpUrl(raw: string): { ok: true; target: HttpTarget } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "URL is not parseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "only http and https URLs are allowed" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "URLs must not carry credentials" };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isAllowedHealthHost(hostname)) {
    return { ok: false, error: "health checks may only target loopback addresses" };
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "URL port is out of range" };
  }
  return { ok: true, target: { href: url.href, hostname, port } };
}

export function assertLoopbackHost(host: string): string | null {
  if (!isAllowedHealthHost(host)) return "health checks may only target loopback addresses";
  return null;
}
