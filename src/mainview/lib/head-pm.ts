/**
 * Pure rules of the floating Head of PM (FO-PM01). The Head of PM is a window
 * onto the existing managers — the project manager for "Current project", the
 * portfolio manager for "All projects" — so everything here only decides which
 * conversation to show and how to describe it. No state, no network.
 */

import type { WorkspaceSelection } from "./workspace";

export type HeadPmContext = { kind: "project"; path: string } | { kind: "all" };

/** "auto" follows the workspace; "all" is the owner's explicit pin. */
export type HeadPmChoice = "auto" | "all";

export const contextKey = (context: HeadPmContext): string => (context.kind === "all" ? "all" : `project:${context.path}`);

/** The project a workspace selection points at, if it points at one. */
export function selectedProjectPath(selection: WorkspaceSelection): string | null {
  return selection.scope === "project" ? selection.path : null;
}

/**
 * Which conversation the panel shows. A pinned "all" wins; otherwise the
 * selected project, and with no project selected the portfolio. The two
 * conversations never share a key, so switching projects can't mix histories.
 */
export function resolveContext(choice: HeadPmChoice, selection: WorkspaceSelection): HeadPmContext {
  const path = selectedProjectPath(selection);
  if (choice === "all" || path == null) return { kind: "all" };
  return { kind: "project", path };
}

export type OrbStatus = "idle" | "thinking" | "working" | "needs-owner" | "error";

/**
 * Orb state from real signals only. `thinking`: a manager turn is in flight.
 * `error`: the last owner message wasn't answered, or the conversation can't
 * be read. `needs-owner`: an approval card is waiting. `working`: a board task
 * in this context is running. Anything else is idle.
 */
export function deriveOrbStatus(input: { thinking: boolean; failed: boolean; pending: number; working: boolean }): OrbStatus {
  if (input.thinking) return "thinking";
  if (input.failed) return "error";
  if (input.pending > 0) return "needs-owner";
  if (input.working) return "working";
  return "idle";
}

export interface MinimalMessage {
  role: string;
  status: string | null;
}

/** The last owner message ended without an answer (cancelled is the owner's own choice). */
export function lastOwnerFailed(messages: readonly MinimalMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "owner") return message.status === "failed";
  }
  return false;
}

export interface AgentReadiness {
  configured: boolean;
  needsConsent: boolean;
}

/**
 * Light readiness read from the stored config. The authoritative checks
 * (installed, logged in, isolation) run on the core when a message is sent and
 * come back as an error the panel shows; this only avoids sending when the
 * manager was never set up.
 */
export function agentReadiness(config: { profileId: string | null; harness: string | null; consentKey: string | null }): AgentReadiness {
  const configured = config.profileId != null || config.harness != null;
  return { configured, needsConsent: configured && config.consentKey == null };
}

export function canSend(input: { text: string; busy: boolean; readiness: AgentReadiness; loaded: boolean }): boolean {
  return input.loaded && !input.busy && input.text.trim().length > 0 && input.readiness.configured && !input.readiness.needsConsent;
}
