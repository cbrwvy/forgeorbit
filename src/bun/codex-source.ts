import pkg from "../../package.json" with { type: "json" };
import { AccountCoreError } from "./account-core.ts";
import { openCodexStdio, type CodexConnection } from "./codex-stdio.ts";
import { CODEX_IDENTITY_LIMITATION, type CodexSourceState } from "../shared/accounts/codex-source.ts";

export type CodexConnectionFactory = (options: { signal: AbortSignal; onNotification: (method: string) => void }) => CodexConnection;
const empty = (): CodexSourceState => ({ sourceId: "codex-app-server", status: "disconnected", authentication: "unknown",
  requiresOpenaiAuth: null, observedAt: null, expiresAt: null, linkedAccountId: null, binding: "unverified", refreshAvailable: false,
  reason: "Disconnected. Checking authentication requires explicit consent to start a local Codex app-server process." });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function result(value: unknown): Record<string, unknown> {
  if (!object(value) || "error" in value || !object(value.result)) throw new Error("Invalid protocol response.");
  return value.result;
}
/** No IO on construction/read. No adapter is registered: the documented response has no stable subject. */
export class CodexSource {
  private state = empty();
  private active: AbortController | null = null;
  private connection: CodexConnection | null = null;
  constructor(private connect: CodexConnectionFactory = options => {
    // Same executable resolution as the existing Harness discovery. Never override HOME/CODEX_HOME.
    const fallback = process.env.AGETOR_CODEX_BIN ?? "codex";
    return openCodexStdio({ ...options, bin: Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback, timeoutMs: 10_000 });
  }, private now: () => number = Date.now, private timeoutMs = 10_000) {}
  snapshot(): CodexSourceState {
    const copy = { ...this.state };
    if (copy.status === "unassigned" && copy.expiresAt !== null && this.now() >= copy.expiresAt) copy.status = "stale";
    return copy;
  }
  disconnect(): CodexSourceState {
    this.active?.abort(); this.connection?.close(); this.connection = null;
    this.state = empty();
    return this.snapshot();
  }
  async inspect(consent: boolean, signal?: AbortSignal): Promise<CodexSourceState> {
    if (consent !== true) throw new AccountCoreError("Explicit consent to start a local Codex app-server is required.", 400);
    if (this.active) throw new AccountCoreError("Codex inspection already in progress.", 409);
    if (signal?.aborted) throw new AccountCoreError("Codex inspection cancelled.", 409);
    const controller = new AbortController(); this.active = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    this.state = { ...empty(), status: "inspecting", reason: "Checking current CLI authentication; no login or task is requested." };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let authChanged = false;
    try {
      const connection = this.connect({ signal: controller.signal, onNotification: method => {
        if (method === "account/updated") { authChanged = true; controller.abort(); }
      } });
      this.connection = connection;
      const call = async (method: string, params: unknown) => {
        if (controller.signal.aborted) throw new Error("Cancelled.");
        const response = await connection.call(method, params);
        if (controller.signal.aborted) throw new Error("Cancelled.");
        return result(response);
      };
      const work = async () => {
        const init = await call("initialize", { clientInfo: { name: "forgeorbit", title: "ForgeOrbit", version: pkg.version } });
        if (typeof init.userAgent !== "string" || !init.userAgent) throw new Error("Invalid handshake.");
        connection.notify("initialized", {});
        const response = await call("account/read", { refreshToken: false });
        if (typeof response.requiresOpenaiAuth !== "boolean") throw new Error("Invalid account response.");
        const account = response.account;
        if (account !== null && (!object(account) || !["chatgpt", "apiKey", "amazonBedrock"].includes(String(account.type)))) throw new Error("Unsupported account response.");
        const authentication = account === null ? "none" : account.type as CodexSourceState["authentication"];
        const observedAt = this.now();
        return { ...empty(), status: "unassigned" as const, authentication, requiresOpenaiAuth: response.requiresOpenaiAuth,
          observedAt, expiresAt: observedAt + 60_000, reason: CODEX_IDENTITY_LIMITATION };
      };
      this.state = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          const abort = () => reject(new AccountCoreError(authChanged ? "Authentication changed during inspection. Evidence discarded." : "Codex inspection cancelled.", 409));
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
          timer = setTimeout(() => reject(new AccountCoreError("Codex inspection timed out.", 504)), this.timeoutMs);
        }),
      ]);
      if (controller.signal.aborted || authChanged) throw new AccountCoreError("Codex inspection cancelled. Evidence discarded.", 409);
      return this.snapshot();
    } catch (error) {
      if (this.state.status !== "disconnected") this.state = { ...empty(), status: "error", reason: "Inspection failed or was cancelled. No account evidence retained." };
      if (this.connection?.timedOut) throw new AccountCoreError("Codex inspection timed out.", 504);
      if (authChanged) throw new AccountCoreError("Authentication changed during inspection. Evidence discarded.", 409);
      if (controller.signal.aborted) throw new AccountCoreError("Codex inspection cancelled.", 409);
      if (error instanceof AccountCoreError) throw error;
      throw new AccountCoreError("Unable to inspect Codex authentication. No account evidence retained.", 502);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      controller.abort(); this.connection?.close(); this.connection = null; this.active = null;
    }
  }
}
