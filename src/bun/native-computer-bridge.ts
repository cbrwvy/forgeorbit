/**
 * FO-NATIVE-CU01 helper process. One request, then the process exits.
 * The spawn argv is only the helper path. There is no shell and no fallback.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export interface NativeBridgeResponse {
  ok: true;
  result: Record<string, unknown>;
}

export interface NativeBridgeFailure {
  ok: false;
  code: string;
  message: string;
}

export interface NativeBridge {
  call(request: Record<string, unknown>): Promise<NativeBridgeResponse | NativeBridgeFailure>;
  cancel(): void;
}

const CALL_TIMEOUT_MS = 12_000;

export function resolveNativeComputerHelper(): string {
  const override = process.env.FORGEORBIT_NATIVE_CU_HELPER;
  if (override) return override;
  const packaged = path.join(path.dirname(process.execPath), "..", "Resources", "app", "bin", "forgeorbit-native-cu");
  if (existsSync(packaged)) return packaged;
  const dev = path.join(process.cwd(), "vendor", "computer-use", "forgeorbit-native-cu");
  if (existsSync(dev)) return dev;
  return packaged;
}

export function spawnNativeBridge(helperPath = resolveNativeComputerHelper()): NativeBridge {
  console.log(`[native-computer] bridge helper: ${helperPath}`);
  let current: ReturnType<typeof Bun.spawn> | null = null;
  return {
    cancel() {
      current?.kill();
      current = null;
    },
    async call(request) {
      if (!existsSync(helperPath)) {
        return { ok: false, code: "helper_missing", message: "The native computer helper is not installed." };
      }
      const proc = Bun.spawn([helperPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          LANG: "en_US.UTF-8",
        },
      });
      current = proc;
      const timer = setTimeout(() => proc.kill(), CALL_TIMEOUT_MS);
      try {
        proc.stdin.write(JSON.stringify(request));
        await proc.stdin.end();
        const [stdout, code] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        if (current === proc) current = null;
        const parsed = parseBridge(stdout);
        if (!parsed) return { ok: false, code: "helper_failed", message: "The native helper stopped without a result." };
        if (code !== 0 && parsed.ok) return { ok: false, code: "helper_failed", message: "The native helper stopped without a result." };
        return parsed;
      } catch {
        proc.kill();
        return { ok: false, code: "helper_failed", message: "The native helper stopped without a result." };
      } finally {
        clearTimeout(timer);
        if (current === proc) current = null;
      }
    },
  };
}

function parseBridge(stdout: string): NativeBridgeResponse | NativeBridgeFailure | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.ok === true && record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      return { ok: true, result: record.result as Record<string, unknown> };
    }
    if (record.ok === false && typeof record.code === "string" && typeof record.message === "string") {
      return { ok: false, code: record.code, message: record.message };
    }
    return null;
  } catch {
    return null;
  }
}
