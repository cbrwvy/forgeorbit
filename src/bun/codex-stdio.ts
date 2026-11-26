import { CODEX_AUTH_ENV, CODEX_FILE_AUTH, CODEX_FILE_AUTH_ENV } from "../shared/accounts/codex-profile.ts";
import type { Subprocess } from "bun";

export interface CodexConnection {
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  readonly timedOut: boolean;
  close(): void;
}

/** Shared local JSONL wire for discovery and explicit account inspection. No listener or shell. */
export function openCodexStdio(options: {
  bin: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal;
  onNotification?: (method: string) => void;
}): CodexConnection {
  if (options.signal?.aborted) throw new Error("Codex inspection cancelled.");
  const profileFileAuth = options.env?.[CODEX_FILE_AUTH_ENV] === "1";
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (profileFileAuth) for (const name of CODEX_AUTH_ENV) delete env[name];
  delete env[CODEX_FILE_AUTH_ENV];
  const proc: Subprocess<"pipe", "pipe", "ignore"> = Bun.spawn([options.bin, ...(profileFileAuth ? CODEX_FILE_AUTH : []), "app-server"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    ...(options.env ? { env } : {}),
  });
  let settled = false, closed = false, timedOut = false, nextId = 1;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const pending = new Map<number, (value: unknown) => void>();
  const settle = () => {
    settled = true;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", close);
    process.removeListener("exit", close);
    settle();
    try { proc.stdin.end(); } catch { /* closed */ }
    // These owned, short-lived connections never run turns. Force teardown so
    // an unresponsive app-server cannot survive a cancelled/expired inspection.
    try { proc.kill("SIGKILL"); } catch { /* exited */ }
    void reader?.cancel().catch(() => {});
  };
  const timer = setTimeout(() => { timedOut = true; close(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", close, { once: true });
  process.once("exit", close);
  proc.exited.then(settle, settle);
  const dispatch = (line: string) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.id !== "number") {
      if (typeof msg.method === "string") options.onNotification?.(msg.method);
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  };
  void (async () => {
    try {
      reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "", received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { if (buf.trim()) dispatch(buf); settle(); break; }
        received += value.length;
        // Bound both an unterminated line and a stream of unrelated notifications.
        if (received > 4 * 1024 * 1024) { close(); break; }
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          dispatch(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        }
      }
    } catch { settle(); }
  })();
  const send = (message: unknown) => {
    if (settled) return;
    try { proc.stdin.write(`${JSON.stringify(message)}\n`); proc.stdin.flush(); } catch { settle(); }
  };
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise(resolve => {
        if (settled) { resolve(undefined); return; }
        pending.set(id, resolve); send({ id, method, params });
      });
    },
    notify: (method, params) => send({ method, params }),
    get timedOut() { return timedOut; },
    close,
  };
}
