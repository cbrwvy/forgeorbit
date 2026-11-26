import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("NATIVE-003: unexpected package link");
    return entry.isDirectory() ? jsFiles(file) : entry.isFile() && file.endsWith(".js") ? [file] : [];
  });
}

/** Independent package gate. Exit zero from Electrobun alone is insufficient. */
export function verifyNativeRpcPackage(appCode: string, requireViewTransform = false) {
  const backend = jsFiles(path.join(appCode, "bun"));
  const patched = backend.filter(file => readFileSync(file, "utf8").includes("FO-NATIVE003-RPC-V1"));
  if (patched.length !== 1) throw new Error("NATIVE-003: packaged RPC transform missing/ambiguous");
  const code = readFileSync(patched[0]!, "utf8");
  if (!/hostname\s*:\s*["']127\.0\.0\.1["']/.test(code)
    || !code.includes("sec-websocket-protocol") || !code.includes("RPC loopback ports exhausted")
    || !code.includes("fo-rpc-v1") || !code.includes("timingSafeEqual")) {
    throw new Error("NATIVE-003: packaged RPC security implementation incomplete");
  }
  const views = jsFiles(path.join(appCode, "views"));
  const clients = views.filter(file => readFileSync(file, "utf8").includes("FO-NATIVE003-VIEW-V1"));
  if (requireViewTransform && !clients.length) throw new Error("NATIVE-003: packaged view transform missing");
  for (const file of clients) {
    const client = readFileSync(file, "utf8");
    if (!client.includes("HMAC") || !client.includes("fo-rpc-v1") || !client.includes("127.0.0.1")) {
      throw new Error("NATIVE-003: packaged view authentication incomplete");
    }
  }
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  return { backend: { file: path.relative(appCode, patched[0]!), sha256: digest(patched[0]!) },
    clients: clients.map(file => ({ file: path.relative(appCode, file), sha256: digest(file) })) };
}

export function acceptNativeRpcBuild(log: string, appCode: string, requireViewTransform = false) {
  if (/failed to load config|using default config/i.test(log)) throw new Error("NATIVE-003: config fallback build rejected");
  if (!log.includes("[FO-NATIVE003] socket transform applied")
    || !log.includes("[FO-NATIVE003] package verified")) {
    throw new Error("NATIVE-003: build security receipts missing");
  }
  return verifyNativeRpcPackage(appCode, requireViewTransform);
}
