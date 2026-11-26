import type { Harness, HarnessStatus } from "../../shared/types.ts";

/**
 * Preference key (see `preferences` table / `GET|PUT /preferences/:key`) that
 * persists whether the Owner dismissed the getting-started block on Home.
 * `"true"` = dismissed, `"false"` = explicitly replayed (Settings → General),
 * absent = never evaluated. The key is the one the old welcome dialog and
 * checklist used, so an established profile keeps its stored choice.
 */
export const ONBOARDING_DISMISSED_PREF = "onboardingDismissed";

export type GettingStartedStepId = "project" | "ai-tool" | "goal";

/**
 * What the app can actually say about the AI tools, best one first:
 *
 * - `ready`            installed, enabled, and the CLI itself reports it is signed in
 * - `unchecked`        installed and enabled, but the CLI cannot report a login (no probe, or the probe failed)
 * - `needs-login`      installed and enabled, and the CLI reports it is signed out
 * - `disabled`         installed, but every installed tool is switched off in Settings
 * - `not-installed`    no tool found on this machine
 *
 * `unchecked` is never promoted to `ready`: no data says it can run.
 */
export type AiToolState = "ready" | "unchecked" | "needs-login" | "disabled" | "not-installed";

export interface AiToolReadiness {
  state: AiToolState;
  /** Display label of the tool the state is about (the best one), when there is one. */
  label: string | null;
  /** The CLI's own sign-in hint for `needs-login`, when it gave one. */
  authHelp: string | null;
  /** Number of tools that are installed (found on this machine). */
  installedCount: number;
}

const RANK: Record<AiToolState, number> = { ready: 4, unchecked: 3, "needs-login": 2, disabled: 1, "not-installed": 0 };

/**
 * Pure: derives the AI tool state from the harness probes and the harness rows.
 * `harnessRows` is `null` while the harness list has not loaded; the enabled flag
 * is then unknown and no tool is called enabled (callers hide the block until loaded).
 */
export function deriveAiToolReadiness(statuses: readonly HarnessStatus[], harnessRows: readonly Harness[] | null): AiToolReadiness {
  const rowById = new Map((harnessRows ?? []).map((row) => [row.id, row] as const));
  let best: { state: AiToolState; label: string | null; authHelp: string | null } = { state: "not-installed", label: null, authHelp: null };
  let installedCount = 0;
  for (const status of statuses) {
    if (status.available !== true) continue;
    installedCount += 1;
    const row = rowById.get(status.harnessId);
    const enabled = row ? row.enabled : false;
    const label = row?.label ?? status.harnessId;
    let state: AiToolState;
    if (!enabled) state = "disabled";
    else if (status.loggedIn === false) state = "needs-login";
    else if (status.loggedIn === true) state = "ready";
    else state = "unchecked";
    if (RANK[state] > RANK[best.state]) {
      best = { state, label, authHelp: state === "needs-login" ? status.authHelp ?? null : null };
    }
  }
  return { ...best, installedCount };
}

export type GettingStartedStatus = "done" | "todo" | "unchecked" | "blocked";

export interface GettingStartedStep {
  id: GettingStartedStepId;
  status: GettingStartedStatus;
}

/** True when the step needs nothing more from the Owner (used to hide the block for set-up profiles). */
export function stepSatisfied(step: GettingStartedStep): boolean {
  return step.status === "done" || step.status === "unchecked";
}

/**
 * Pure: the three steps from live app state. Always all three, in a fixed order
 * (Add a project, Set up an AI tool, Give the Head of PM a goal) — the block renders
 * them positionally.
 *
 * - project: done once any project is registered.
 * - ai-tool: done only for a tool that is installed, enabled and reported signed in; `unchecked`
 *   when it is installed and enabled but sign-in cannot be read; otherwise todo.
 * - goal: done once the board holds any task or the core holds a plan waiting for the Owner
 *   (a goal already reached the Head of PM). Without a project it is `blocked`.
 */
export function deriveGettingStartedSteps(input: {
  projectCount: number;
  ai: AiToolReadiness;
  taskCount: number;
  pendingPlanCount: number;
}): GettingStartedStep[] {
  const { projectCount, ai, taskCount, pendingPlanCount } = input;
  const project: GettingStartedStatus = projectCount > 0 ? "done" : "todo";
  const aiTool: GettingStartedStatus = ai.state === "ready" ? "done" : ai.state === "unchecked" ? "unchecked" : "todo";
  const goal: GettingStartedStatus = taskCount > 0 || pendingPlanCount > 0 ? "done" : projectCount === 0 ? "blocked" : "todo";
  return [
    { id: "project", status: project },
    { id: "ai-tool", status: aiTool },
    { id: "goal", status: goal },
  ];
}

/** The actual blocker for the first goal, or null when nothing the app knows stands in the way. */
export function goalBlocker(ai: AiToolReadiness): AiToolState | null {
  return ai.state === "ready" || ai.state === "unchecked" ? null : ai.state;
}

export interface GettingStartedVisibility {
  show: boolean;
  /** Existing-profile path: write the dismissal once (the caller does the write). */
  autoDismiss: boolean;
}

/**
 * Pure: whether the block shows.
 *
 * - Nothing shows until everything it reads has loaded (no flash for a set-up profile).
 * - A replay (pref `"false"`) forces it visible even when every step is satisfied; dismissing again hides it.
 * - A profile that never set the pref but already has a project and tasks, or already satisfies
 *   every step, is treated as established: the block stays hidden and the dismissal is written once.
 * - An explicit dismissal (`"true"`) always wins.
 */
export function resolveGettingStartedVisibility(input: {
  dismissedPref: string | undefined;
  loaded: boolean;
  steps: readonly GettingStartedStep[];
  projectCount: number;
  taskCount: number;
}): GettingStartedVisibility {
  const { dismissedPref, loaded, steps, projectCount, taskCount } = input;
  if (!loaded) return { show: false, autoDismiss: false };
  const dismissed = dismissedPref === "true";
  const replaying = dismissedPref === "false";
  const prefUnset = dismissedPref === undefined;
  const allSatisfied = steps.every(stepSatisfied);
  const established = projectCount > 0 && taskCount > 0;
  return {
    show: replaying || (!dismissed && !allSatisfied && !established),
    autoDismiss: prefUnset && (allSatisfied || established),
  };
}
