import { parentPort } from "node:worker_threads";
import { readCoreCreds, removeCoreCreds } from "./core-creds.ts";

export function markNativeBackendReady() {
  (globalThis as Record<symbol, unknown>)[Symbol.for("forgeorbit.native.backendReady")] = true;
}

/** Publish ownership before writing credentials, so forced Worker termination
 * can be cleaned up by the supervisor too. No token is written to diagnostics. */
export function ownNativeCredentials(dataDir: string, token: string, stopApi: () => void) {
  parentPort?.postMessage({ type: "fo-native004-credentials", dataDir, token, pid: process.pid });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const current = readCoreCreds(dataDir);
    if (current?.pid === process.pid && current.token === token) removeCoreCreds(dataDir);
    stopApi();
  };
  process.once("exit", cleanup);
  return cleanup;
}
