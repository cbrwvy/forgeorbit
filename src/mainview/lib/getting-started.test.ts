import { describe, expect, test } from "bun:test";
import type { Harness, HarnessStatus } from "../../shared/types.ts";
import {
  deriveAiToolReadiness,
  deriveGettingStartedSteps,
  goalBlocker,
  resolveGettingStartedVisibility,
  type AiToolReadiness,
} from "./getting-started.ts";

const status = (id: string, patch: Partial<HarnessStatus> = {}): HarnessStatus =>
  ({ harnessId: id, kind: "claude-code", available: true, loggedIn: null, ...patch }) as HarnessStatus;
const row = (id: string, enabled = true): Harness => ({ id, label: `Label ${id}`, enabled }) as Harness;
const ai = (state: AiToolReadiness["state"]): AiToolReadiness => ({ state, label: null, authHelp: null, installedCount: state === "not-installed" ? 0 : 1 });

describe("deriveAiToolReadiness", () => {
  test("nothing installed", () => {
    expect(deriveAiToolReadiness([status("a", { available: false })], [row("a")]).state).toBe("not-installed");
    expect(deriveAiToolReadiness([], []).state).toBe("not-installed");
  });
  test("installed but disabled is not ready", () => {
    const result = deriveAiToolReadiness([status("a", { loggedIn: true })], [row("a", false)]);
    expect(result.state).toBe("disabled");
    expect(result.installedCount).toBe(1);
  });
  test("enabled and signed out needs a login and carries the CLI hint", () => {
    const result = deriveAiToolReadiness([status("a", { loggedIn: false, authHelp: "run fx login" })], [row("a")]);
    expect(result.state).toBe("needs-login");
    expect(result.authHelp).toBe("run fx login");
    expect(result.label).toBe("Label a");
  });
  test("an unreadable login is never promoted to ready", () => {
    expect(deriveAiToolReadiness([status("a", { loggedIn: null })], [row("a")]).state).toBe("unchecked");
  });
  test("signed in is ready", () => {
    expect(deriveAiToolReadiness([status("a", { loggedIn: true })], [row("a")]).state).toBe("ready");
  });
  test("the best tool wins", () => {
    const result = deriveAiToolReadiness(
      [status("a", { loggedIn: false }), status("b", { loggedIn: true }), status("c", { loggedIn: null })],
      [row("a"), row("b"), row("c")],
    );
    expect(result.state).toBe("ready");
    expect(result.label).toBe("Label b");
    expect(result.installedCount).toBe(3);
  });
  test("unknown harness rows never call a tool enabled", () => {
    expect(deriveAiToolReadiness([status("a", { loggedIn: true })], null).state).toBe("disabled");
  });
});

describe("deriveGettingStartedSteps", () => {
  test("a fresh profile: nothing done, goal blocked behind the project", () => {
    const steps = deriveGettingStartedSteps({ projectCount: 0, ai: ai("not-installed"), taskCount: 0, pendingPlanCount: 0 });
    expect(steps.map((s) => [s.id, s.status])).toEqual([["project", "todo"], ["ai-tool", "todo"], ["goal", "blocked"]]);
  });
  test("a project does not need a provider", () => {
    const steps = deriveGettingStartedSteps({ projectCount: 1, ai: ai("not-installed"), taskCount: 0, pendingPlanCount: 0 });
    expect(steps[0]!.status).toBe("done");
    expect(steps[2]!.status).toBe("todo");
  });
  test("unchecked stays distinct from done", () => {
    expect(deriveGettingStartedSteps({ projectCount: 1, ai: ai("unchecked"), taskCount: 0, pendingPlanCount: 0 })[1]!.status).toBe("unchecked");
    expect(deriveGettingStartedSteps({ projectCount: 1, ai: ai("ready"), taskCount: 0, pendingPlanCount: 0 })[1]!.status).toBe("done");
  });
  test("a task or a waiting plan means a goal already reached the Head of PM", () => {
    expect(deriveGettingStartedSteps({ projectCount: 1, ai: ai("ready"), taskCount: 1, pendingPlanCount: 0 })[2]!.status).toBe("done");
    expect(deriveGettingStartedSteps({ projectCount: 1, ai: ai("ready"), taskCount: 0, pendingPlanCount: 2 })[2]!.status).toBe("done");
  });
});

describe("goalBlocker", () => {
  test("only a state the app knows is a blocker", () => {
    expect(goalBlocker(ai("ready"))).toBeNull();
    expect(goalBlocker(ai("unchecked"))).toBeNull();
    expect(goalBlocker(ai("needs-login"))).toBe("needs-login");
    expect(goalBlocker(ai("disabled"))).toBe("disabled");
    expect(goalBlocker(ai("not-installed"))).toBe("not-installed");
  });
});

describe("resolveGettingStartedVisibility", () => {
  const todo = deriveGettingStartedSteps({ projectCount: 0, ai: ai("not-installed"), taskCount: 0, pendingPlanCount: 0 });
  const allDone = deriveGettingStartedSteps({ projectCount: 1, ai: ai("ready"), taskCount: 1, pendingPlanCount: 0 });
  const base = { loaded: true, projectCount: 0, taskCount: 0 };

  test("hidden until everything loaded", () => {
    expect(resolveGettingStartedVisibility({ ...base, loaded: false, dismissedPref: undefined, steps: todo })).toEqual({ show: false, autoDismiss: false });
  });
  test("a fresh profile sees the block and nothing is written", () => {
    expect(resolveGettingStartedVisibility({ ...base, dismissedPref: undefined, steps: todo })).toEqual({ show: true, autoDismiss: false });
  });
  test("an explicit dismissal wins", () => {
    expect(resolveGettingStartedVisibility({ ...base, dismissedPref: "true", steps: todo }).show).toBe(false);
  });
  test("a replay forces it visible even when every step is satisfied", () => {
    expect(resolveGettingStartedVisibility({ ...base, projectCount: 1, taskCount: 1, dismissedPref: "false", steps: allDone })).toEqual({ show: true, autoDismiss: false });
  });
  test("an established profile is not sent through setup again and the dismissal is written once", () => {
    const steps = deriveGettingStartedSteps({ projectCount: 1, ai: ai("needs-login"), taskCount: 2, pendingPlanCount: 0 });
    expect(resolveGettingStartedVisibility({ ...base, projectCount: 1, taskCount: 2, dismissedPref: undefined, steps })).toEqual({ show: false, autoDismiss: true });
  });
  test("a set-up profile with no tasks yet auto-dismisses", () => {
    const steps = deriveGettingStartedSteps({ projectCount: 1, ai: ai("ready"), taskCount: 0, pendingPlanCount: 1 });
    expect(resolveGettingStartedVisibility({ ...base, projectCount: 1, dismissedPref: undefined, steps })).toEqual({ show: false, autoDismiss: true });
  });
  test("a project without a provider still shows the block (nothing is forced, nothing is written)", () => {
    const steps = deriveGettingStartedSteps({ projectCount: 1, ai: ai("not-installed"), taskCount: 0, pendingPlanCount: 0 });
    expect(resolveGettingStartedVisibility({ ...base, projectCount: 1, dismissedPref: undefined, steps })).toEqual({ show: true, autoDismiss: false });
  });
});
