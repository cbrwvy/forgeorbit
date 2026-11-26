/** Account evidence is deliberately redacted. No email, plan, subject or tokens cross to the renderer. */
export interface CodexSourceState {
  sourceId: "codex-app-server";
  status: "disconnected" | "inspecting" | "unassigned" | "stale" | "error";
  authentication: "unknown" | "none" | "chatgpt" | "apiKey" | "amazonBedrock";
  requiresOpenaiAuth: boolean | null;
  observedAt: number | null;
  expiresAt: number | null;
  linkedAccountId: null;
  binding: "unverified";
  refreshAvailable: false;
  reason: string;
}
export const CODEX_IDENTITY_LIMITATION = "The documented account/read response does not provide a stable provider subject. Account linking and quota refresh are unavailable; email, plan and harness declarations cannot verify identity.";
