// FO-NATIVE004-SUPERVISOR-V1
// The native main thread is inside a synchronous FFI event loop. Its JS Worker
// callbacks cannot run there, so supervise the backend on a separate JS thread.
import { Worker, workerData } from "node:worker_threads";
import { dlopen } from "bun:ffi";
import { readFileSync, unlinkSync } from "node:fs";

const { appEntrypointPath, libPath, startup, launcherPid } = workerData;
const native = dlopen(libPath, { forceExit: { args: ["i32"], returns: "void" } });
// Read the kernel parent identity, rather than a runtime-cached process.ppid.
const libc = process.platform === "darwin"
  ? dlopen("/usr/lib/libSystem.B.dylib", { getppid: { args: [], returns: "i32" } }) : undefined;
let ownership: { dataDir: string; pid: number; token: string } | undefined;
let stopping = false;
function failed(code = 1, reason = "backend Worker stopped") {
  if (stopping) return;
  stopping = true;
  // Termination skips backend JS hooks. Never remove another core's credentials
  // (including a CLI daemon whose bind/handoff was refused).
  if (ownership) {
    try {
      const file = ownership.dataDir + "/agetor-core.json";
      const current = JSON.parse(readFileSync(file, "utf8"));
      if (current.pid === process.pid && current.pid === ownership.pid && current.token === ownership.token) unlinkSync(file);
    } catch { /* absent/unpublished credentials */ }
  }
  console.error("[FO-NATIVE004]", reason, "; exiting launcher", code);
  native.symbols.forceExit(code === 0 ? 1 : code);
}

try {
  const backend = new Worker(appEntrypointPath);
  backend.on("message", message => {
    if (message?.type === "fo-native004-credentials" && message.pid === process.pid
      && typeof message.dataDir === "string" && typeof message.token === "string") ownership = message;
  });
  backend.on("error", (err) => {
    console.error("[FO-NATIVE004] backend Worker error:", err);
    failed(1, `backend Worker error: ${(err as any)?.message || err}`);
  });
  // An unexpected zero exit is not a successful application startup/quit.
  // Normal SDK quit exits the whole process directly, after synchronous hooks.
  backend.on("exit", (code) => {
    console.error("[FO-NATIVE004] backend Worker exited with code:", code);
    failed(code, `backend Worker exited: ${code}`);
  });
  // Cmd+Q / Apple quit terminates the native launcher first. forceExit then
  // skips the backend's before-quit and exit hooks, which is what left a
  // settled tmux session alive. Ask the backend to release its own settled
  // sessions, wait briefly for the ack, then exit. A dead backend that never
  // acks still loses the race to the timeout — quit does not hang.
  let releasing = false;
  setInterval(() => {
    if (stopping || releasing) return;
    if ((libc?.symbols.getppid() ?? process.ppid) === launcherPid) return;
    releasing = true;
    const timer = setTimeout(() => finish(), 1500);
    const onMessage = (message: { type?: string }) => {
      if (message?.type !== "fo-native004-released") return;
      clearTimeout(timer);
      backend.off("message", onMessage);
      finish();
    };
    function finish() {
      backend.off("message", onMessage);
      failed(1, "native launcher owner exited");
    }
    backend.on("message", onMessage);
    try {
      backend.postMessage({ type: "fo-native004-release-settled" });
    } catch {
      clearTimeout(timer);
      finish();
    }
  }, 250);
  console.log("FO-NATIVE004-SUPERVISOR-V1: backend supervision active");
  Atomics.store(new Int32Array(startup), 0, 1);
  Atomics.notify(new Int32Array(startup), 0);
} catch {
  failed(1);
}
