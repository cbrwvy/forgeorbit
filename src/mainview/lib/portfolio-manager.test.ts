import { expect, test } from "bun:test";
import { delegationActions, delegationTargetLabel, dependencyNames, pendingDelegations, planPriorityLabel, portfolioConnection } from "./portfolio-manager.ts";
import type { DelegationView, PortfolioPlan } from "../../shared/portfolio-manager.ts";

function delegation(patch: Partial<DelegationView> = {}): DelegationView {
  return {
    id: "d1",
    messageId: "m1",
    projectPath: "/p",
    projectName: "P",
    objective: "Check",
    request: "Please check.",
    reason: "",
    contextSummary: "",
    expectedOutput: "",
    status: "proposed",
    revision: 1,
    error: null,
    pmMessageId: null,
    pmTurnId: null,
    result: null,
    createdAt: 1,
    updatedAt: 1,
    approvedAt: null,
    settledAt: null,
    target: {
      registered: true,
      managerConfigured: true,
      harnessId: "codex",
      harnessLabel: "Codex",
      model: "gpt-6.1-sol",
      consentConfirmed: true,
      problem: null,
      usageNotice: null,
    },
    ...patch,
  };
}

test("a proposal can be approved only when its target manager is ready", () => {
  expect(delegationActions(delegation(), false)).toMatchObject({ canApprove: true, canReject: true, approveLabel: "Approve & send" });
  const blocked = delegationActions(delegation({ target: { ...delegation().target, problem: "No agent." } }), false);
  expect(blocked.canApprove).toBe(false);
  expect(blocked.blockedReason).toBe("No agent.");
  expect(blocked.canReject).toBe(true);
  expect(delegationActions(delegation(), true).canApprove).toBe(false);
});

test("a failed delegation offers a retry; sent and answered ones offer nothing", () => {
  expect(delegationActions(delegation({ status: "failed" }), false).approveLabel).toBe("Approve & retry");
  for (const status of ["sending", "sent", "answered", "rejected"] as const) {
    const actions = delegationActions(delegation({ status }), false);
    expect(actions.canApprove).toBe(false);
    expect(actions.canReject).toBe(false);
  }
});

test("labels never invent a harness or priority", () => {
  expect(delegationTargetLabel(delegation())).toBe("Codex · gpt-6.1-sol");
  expect(delegationTargetLabel(delegation({ target: { ...delegation().target, managerConfigured: false } }))).toBe("No agent configured");
  expect(planPriorityLabel(null)).toBe("No priority");
  expect(planPriorityLabel("critical")).toBe("Critical");
});

test("dependencies read as project names", () => {
  const plan = { projects: [{ projectPath: "/a", projectName: "Alpha" }] } as unknown as PortfolioPlan;
  expect(dependencyNames(plan, ["/a", "/zzz"])).toEqual(["Alpha", "/zzz"]);
});

test("connection status and pending list", () => {
  expect(portfolioConnection({ answering: true, problem: null, needsConsent: false }).label).toBe("Answering…");
  expect(portfolioConnection({ answering: false, problem: "Codex is disabled.", needsConsent: false }).label).toBe("Unavailable");
  expect(portfolioConnection({ answering: false, problem: null, needsConsent: true }).tone).toBe("text-warning");
  expect(portfolioConnection({ answering: false, problem: null, needsConsent: false }).label).toBe("Ready");
  const list = [delegation({ id: "a", createdAt: 1 }), delegation({ id: "b", createdAt: 2, status: "failed" }), delegation({ id: "c", status: "sent" })];
  expect(pendingDelegations(list).map((item) => item.id)).toEqual(["b", "a"]);
});
