import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { QuotaObservation, QuotaState } from "../../shared/accounts/types.ts";
import type { EstimationResult } from "../../shared/estimation/types.ts";
import { analyzeTaskRequirements, previewPortfolioRouting, routeTask, UNKNOWN_OWNER_CONSTRAINTS } from "../../shared/model-router/index.ts";
import { ROUTING_POLICIES, type CandidateAssessment, type RoutingPreview } from "../../shared/model-router/types.ts";
import { createModelRouterApi, createPreviewSession } from "./model-router-api.ts";
import {
  EMPTY_PREVIEW_DRAFT,
  POLICY_COPY,
  PreviewDraftError,
  abstentionReasons,
  accountLabel,
  buildPortfolioPreviewBody,
  buildTaskPreviewBody,
  complexityLabel,
  concurrencyNotes,
  effortPresentation,
  groupedCandidates,
  evidenceBoundaries,
  hasExpiredQuota,
  ownerRows,
  planningEstimateNote,
  portfolioComparison,
  presentAssignment,
  presentQuota,
  previewBoundary,
  requirementRows,
  sharedResourceNotes,
  type PreviewDraft,
} from "./model-router-preview.ts";

const root = path.resolve(import.meta.dir, "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const catalog = { harnessIds: ["codex", "cursor"], accountIds: ["11111111-1111-1111-1111-111111111111"] };
const allow = { projectPaths: ["/proj"] };

function card(id: string, status: CandidateAssessment["status"], patch: Partial<CandidateAssessment> = {}): CandidateAssessment {
  return {
    candidate: { id, harnessId: "codex", accountId: "acc-1", modelId: "model-a", profileIds: [] },
    status,
    reasons: [],
    unknowns: [],
    provenance: ["fake"],
    expectedCost: null,
    thinkingEffort: { value: null, status: "conditional", reason: "Supported effort vocabulary is unverified." },
    quotaEvidence: [],
    conflicts: [],
    requiredOwnerApproval: ["Owner must approve any future execution."],
    ranking: { quality: null, duration: null, reserve: null },
    ...patch,
  };
}

function preview(patch: Partial<RoutingPreview> = {}): RoutingPreview {
  return {
    status: "no-verified-candidate",
    requirements: analyzeTaskRequirements({ taskId: "task-1", projectId: "/proj" }),
    policy: "balanced",
    ownerConstraints: { ...UNKNOWN_OWNER_CONSTRAINTS, requiredApprovals: [...UNKNOWN_OWNER_CONSTRAINTS.requiredApprovals] },
    recommendedCandidate: null,
    conditionalCandidates: [],
    excludedCandidates: [],
    alternativeCandidates: [],
    unknownInformation: [],
    requiredOwnerApproval: [],
    capturedAt: 1_000,
    readOnly: true,
    execution: "preview-only",
    revalidation: { requiredBeforeExecution: true, reservesResources: false, checks: ["Recheck occupancy."] },
    ...patch,
  };
}

function observation(patch: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    id: "obs",
    quotaId: "quota-1",
    source: "fake-source",
    provenance: "verified",
    verification: "verified",
    observedAt: 1_000,
    expiresAt: 5_000,
    resetAt: null,
    limit: 10,
    used: 1,
    remaining: 9,
    indicator: null,
    confidence: "high",
    ...patch,
  };
}

function quota(status: QuotaState["status"], current: QuotaObservation | null): QuotaState {
  return {
    definition: { id: "quota-1", accountId: "acc-1", subscriptionId: null, scope: "account", unit: { kind: "requests" }, window: "week", createdAt: 1, archivedAt: null },
    status,
    observations: current ? [current] : [],
    current,
    warnings: [],
  };
}

test("empty requirements stay general with no inferred capabilities", () => {
  const requirements = analyzeTaskRequirements({ taskId: "task-1", projectId: "/proj" });
  const rows = Object.fromEntries(requirementRows(requirements).map((row) => [row.label, row.value]));
  expect(rows["Task type"]).toBe("general");
  expect(rows["Required capabilities"]).toBe("None");
  expect(rows["Required tools"]).toBe("None");
  expect(rows["Quota demands"]).toBe("None");
  const body = buildTaskPreviewBody("/proj", "task-1", EMPTY_PREVIEW_DRAFT, allow, catalog);
  expect(body.requirements).toEqual({ type: "general", complexity: "unknown" });
  expect(body.ownerConstraints).toBeUndefined();
});

test("unknown complexity is preserved and a title is not an input", () => {
  expect(complexityLabel("unknown")).toBe("Unknown");
  const draft: PreviewDraft = { ...EMPTY_PREVIEW_DRAFT, capabilities: "very high architecture" };
  const body = buildTaskPreviewBody("/proj", "task-1", draft, allow, catalog);
  expect(body.requirements?.complexity).toBe("unknown");
  expect(body.requirements).not.toHaveProperty("title");
  expect(analyzeTaskRequirements({ taskId: "Implement a very complex architecture", projectId: "/proj" }).complexity).toBe("unknown");
});

test("verified recommendation is shown only from the recommended candidate", () => {
  const recommended = card("best", "verified", { reasons: ["All required eligibility, quota and concurrency checks have current verified evidence."] });
  const groups = groupedCandidates(preview({
    status: "recommended",
    recommendedCandidate: recommended,
    conditionalCandidates: [card("maybe", "conditional")],
    excludedCandidates: [card("nope", "excluded")],
  }));
  expect(groups.recommended?.candidate.id).toBe("best");
  expect(groups.conditional.map((item) => item.candidate.id)).toEqual(["maybe"]);
  expect(groups.excluded.map((item) => item.candidate.id)).toEqual(["nope"]);
});

test("conditional candidates stay out of the recommendation", () => {
  const conditional = card("maybe", "conditional", { unknowns: ["CLI authorization for this exact harness/account is unknown."] });
  const groups = groupedCandidates(preview({ conditionalCandidates: [conditional] }));
  expect(groups.recommended).toBeNull();
  expect(groups.conditional).toEqual([conditional]);
});

test("excluded candidates stay in the excluded group", () => {
  const excluded = card("nope", "excluded", { reasons: ["Owner disallows this harness."] });
  const groups = groupedCandidates(preview({ excludedCandidates: [excluded] }));
  expect(groups.recommended).toBeNull();
  expect(groups.excluded[0]?.reasons).toEqual(["Owner disallows this harness."]);
});

test("no verified candidate uses only returned reasons", () => {
  const result = preview({
    unknownInformation: ["Quota availability is unknown."],
    conditionalCandidates: [card("maybe", "conditional")],
    recommendedCandidate: card("should-not-promote", "verified"),
  });
  expect(groupedCandidates(result).recommended).toBeNull();
  expect(abstentionReasons(result)).toEqual(["Quota availability is unknown."]);
  expect(abstentionReasons(result).join(" ")).not.toContain("verified login");
});

test("five routing policies match the backend and are explained without a private ranking", () => {
  expect(Object.keys(POLICY_COPY)).toEqual([...ROUTING_POLICIES]);
  for (const policy of ROUTING_POLICIES) {
    expect(POLICY_COPY[policy].explanation.length).toBeGreaterThan(20);
    expect(POLICY_COPY[policy].explanation.toLowerCase()).not.toContain("claude is better");
  }
  const bodies = ROUTING_POLICIES.map((policy) => buildTaskPreviewBody("/proj", "task-1", { ...EMPTY_PREVIEW_DRAFT, policy }, allow, catalog).policy);
  expect(bodies).toEqual([...ROUTING_POLICIES]);
});

test("verified effort shows the backend value", () => {
  expect(effortPresentation({ value: "standard", status: "verified", reason: "Selected within the confirmed ordered harness/model vocabulary." })).toEqual({
    label: "standard",
    detail: "Selected within the confirmed ordered harness/model vocabulary.",
  });
});

test("unknown effort is not verified for this model", () => {
  expect(effortPresentation({ value: null, status: "conditional", reason: "Supported effort vocabulary is unverified." }).label).toBe("Not verified for this model");
});

test("unsupported effort has no effort parameter", () => {
  expect(effortPresentation({ value: null, status: "not-applicable", reason: "This harness/model has no effort parameter." }).label).toBe("No effort parameter");
});

test("unknown quota is not labeled available", () => {
  const shown = presentQuota(quota("unknown", null), 2_000);
  expect(shown.label).toBe("Unknown");
  expect(shown.label.toLowerCase()).not.toContain("available");
});

test("expired quota is not labeled current", () => {
  const shown = presentQuota(quota("current", observation({ expiresAt: 1_500 })), 2_000);
  expect(shown.label).toBe("Expired — not current");
  expect(shown.label.toLowerCase()).not.toContain("current —");
});

test("conflicting quota stays conflicting", () => {
  expect(presentQuota(quota("conflict", observation()), 2_000).label).toBe("Conflicting");
});

test("shared pool text is passed through and balances are not added", () => {
  const notes = sharedResourceNotes([
    "Shared pool reports were resolved together.",
    "remaining 5",
    "remaining 5",
  ]);
  expect(notes).toEqual(["Shared pool reports were resolved together."]);
  expect(JSON.stringify(notes)).not.toContain("10");
});

test("shared subscription text does not become a summed balance", () => {
  const notes = sharedResourceNotes(["Shared subscription has no verified quota pool identity."]);
  expect(notes).toEqual(["Shared subscription has no verified quota pool identity."]);
});

test("spending restrictions are sent as preview limits only", () => {
  const body = buildTaskPreviewBody("/proj", "task-1", {
    ...EMPTY_PREVIEW_DRAFT,
    spending: "no-extra",
    currency: "USD",
    costAmount: "1.00",
  }, allow, catalog);
  expect(body.ownerConstraints).toEqual({ spending: "no-extra", maxExpectedCost: { currency: "USD", minor: 100 } });
  expect(JSON.stringify(body)).not.toMatch(/credential|command|switch/i);
  expect(() => buildTaskPreviewBody("/other", "task-1", EMPTY_PREVIEW_DRAFT, allow, catalog)).toThrow(PreviewDraftError);
});

test("concurrency notes report returned text and do not invent zero", () => {
  expect(concurrencyNotes(["Concurrency capacity is occupied: global"])).toEqual(["Concurrency capacity is occupied: global"]);
  expect(concurrencyNotes([])).toEqual([]);
  const body = buildTaskPreviewBody("/proj", "task-1", { ...EMPTY_PREVIEW_DRAFT, globalConcurrency: "2" }, allow, catalog);
  expect(body.ownerConstraints).toEqual({ globalConcurrency: 2 });
});

test("assigned employee keeps role, project and revision apart from the resource", () => {
  const shown = presentAssignment(
    { employeeName: "Ada", revision: 4 },
    { jobTitle: "Worker", roleCategory: "engineering", projectPath: "/proj", projectName: "Media", projectRegistered: true },
  );
  expect(shown).toMatchObject({ status: "assigned", name: "Ada", role: "Worker (engineering)", project: "Media", revision: 4 });
  if (shown.status === "assigned") expect(shown.note).toContain("not a harness");
});

test("unassigned task does not invent an employee", () => {
  const shown = presentAssignment(null, null);
  expect(shown.status).toBe("unassigned");
  expect(presentAssignment("error", null).status).toBe("unknown");
  expect(presentAssignment({ employeeName: null, revision: 2 }, "error")).toMatchObject({ status: "assigned", name: "Name unknown", role: "Unknown", project: "Unknown", revision: 2 });
});

test("portfolio preview lists tasks without summing subscriptions or promoting a candidate", () => {
  const first = preview({ requirements: analyzeTaskRequirements({ taskId: "a", projectId: "/a", priority: "high" }), ownerConstraints: { ...UNKNOWN_OWNER_CONSTRAINTS, projectPriority: "high", requiredApprovals: [] } });
  const second = preview({
    requirements: analyzeTaskRequirements({ taskId: "b", projectId: "/b" }),
    unknownInformation: ["Quota availability is unknown."],
    conditionalCandidates: [card("b1", "conditional")],
  });
  const comparison = portfolioComparison([first, second], [
    { taskId: "a", estimate: null },
    { taskId: "b", estimate: null },
  ]);
  expect(comparison.tasks.map((task) => task.recommendation)).toEqual([null, null]);
  expect(comparison.tasks.map((task) => task.taskPriority)).toEqual(["high", "Unknown"]);
  expect(comparison.quotaCompetition).toEqual(["Quota availability is unknown."]);
  expect(JSON.stringify(comparison)).not.toMatch(/summed|totalMinor|subscriptionFees/i);
  expect(comparison.tasks[1]?.estimate.lines.join(" ")).toContain("not the cost of a launch");
});

test("unknown project priority is not turned into an allocation", () => {
  const quiet = portfolioComparison([preview()], []);
  expect(quiet.crossProjectAllocationWithheld).toBe(false);
  expect(quiet.tasks[0]?.projectPriority).toBe("Unknown");
  const withheld = portfolioComparison([preview({ unknownInformation: ["Project priorities are incomplete; no cross-project allocation is recommended."] })], []);
  expect(withheld.crossProjectAllocationWithheld).toBe(true);
  expect(withheld.unresolved).toEqual(["Project priorities are incomplete; no cross-project allocation is recommended."]);
});

test("API unauthorized is surfaced once and not retried", async () => {
  let calls = 0;
  const client = createModelRouterApi(async (requestPath, init, opts) => {
    calls += 1;
    expect(requestPath).toBe("/model-router/preview");
    expect(init?.method).toBe("POST");
    expect(opts?.retry).toBe(false);
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  });
  await expect(client.preview({ path: "/proj", taskId: "task-1", policy: "balanced" })).rejects.toThrow("unauthorized");
  expect(calls).toBe(1);
});

test("stale response cancellation aborts the older preview", () => {
  const session = createPreviewSession();
  const first = session.begin();
  const second = session.begin();
  expect(first.signal.aborted).toBe(true);
  expect(first.isCurrent()).toBe(false);
  expect(second.isCurrent()).toBe(true);
  session.invalidate();
  expect(second.signal.aborted).toBe(true);
  expect(second.isCurrent()).toBe(false);
});

test("preview UI does not start an agent or send effort to a CLI", () => {
  const source = read("src/mainview/components/router/ResourceRecommendation.tsx");
  expect(source).toContain("PREVIEW_BANNER");
  expect(read("src/mainview/lib/model-router-preview.ts")).toContain("Preview only — no resources reserved, no agents started.");
  expect(source).toContain('id="resources.thinking_effort_is_not_sent_to_a_cli"');
  expect(source).not.toMatch(/startTask|updateTask|spawnAgent|refreshQuota|bindHarness|open-terminal/);
  expect(source.indexOf("const calculate")).toBeLessThan(source.indexOf("modelRouter.preview"));
  expect(source.split("modelRouter.preview").length - 1).toBe(1);
});

test("preview UI does not switch accounts", () => {
  const source = read("src/mainview/components/router/ResourceRecommendation.tsx") + read("src/mainview/components/router/PortfolioRouterPreview.tsx");
  expect(source).not.toMatch(/bindHarness|unbindHarness|switchAccount|open-terminal/);
  expect(source).toContain("accountCore.accounts");
  expect(source).not.toContain("api.listHarnesses(");
});

test("preview requests do not carry a database write", () => {
  const body = buildPortfolioPreviewBody(
    [{ path: "/proj", taskId: "task-1" }],
    { ...EMPTY_PREVIEW_DRAFT, limitAccounts: true, allowedAccounts: [catalog.accountIds[0]!] },
    { "/proj": "high" },
    [{ path: "/proj", taskIds: ["task-1"] }],
    catalog,
  );
  expect(Object.keys(body)).toEqual(["requests"]);
  expect(Object.keys(body.requests[0]!.ownerConstraints ?? {}).sort()).toEqual(["allowedAccounts", "projectPriority"]);
  expect(() => buildPortfolioPreviewBody([{ path: "/proj", taskId: "other" }], EMPTY_PREVIEW_DRAFT, {}, [{ path: "/proj", taskIds: ["task-1"] }], catalog)).toThrow(PreviewDraftError);
  const client = read("src/mainview/lib/model-router-api.ts");
  expect(client).toContain('"/model-router/preview"');
  expect(client).toContain('"/model-router/portfolio-preview"');
  expect(client).toContain("retry: false");
  expect(client).not.toMatch(/INSERT|UPDATE|DELETE|migration/i);
});

test("existing model router still abstains without evidence and stays preview-only", () => {
  const task = analyzeTaskRequirements({ taskId: "task-1", projectId: "/proj" });
  const snapshot = { capturedAt: 1_000, candidates: [], accounts: [], bindings: [], subscriptions: [], subscriptionLinks: [], quotas: [], limits: [], occupancyComplete: true };
  const result = routeTask(task, snapshot);
  expect(result.status).toBe("no-verified-candidate");
  expect(result.recommendedCandidate).toBeNull();
  expect(previewBoundary(result).ok).toBe(true);
  expect(groupedCandidates(result).recommended).toBeNull();
  const portfolio = previewPortfolioRouting([{ requirements: task, owner: result.ownerConstraints, policy: "balanced" }], snapshot);
  expect(portfolio).toMatchObject({ readOnly: true, execution: "preview-only" });
  expect(snapshot.candidates).toHaveLength(0);
});

test("portfolio page keeps its overview and adds comparison without a launcher", () => {
  const source = read("src/mainview/components/workspace/portfolio/PortfolioDashboard.tsx");
  expect(source).toContain('data-testid="portfolio-dashboard"');
  expect(source).toContain('data-testid="portfolio-refresh"');
  expect(source).toContain("PortfolioRouterPreview");
  expect(source).not.toContain("startTask");
});

test("task details keep scheduling and add the recommendation beside it", () => {
  const panel = read("src/mainview/components/kanban/RunPanel.tsx");
  expect(panel).toContain("<TaskSchedulingSection task={task} />");
  expect(panel).toContain("<ResourceRecommendation key={task.id} task={task} harnesses={harnesses} />");
  expect(read("src/mainview/components/kanban/TaskSchedulingSection.tsx")).not.toContain("model-router");
});

test("accounts dashboard is unchanged by the preview UI", () => {
  const source = read("src/mainview/components/accounts/AccountsDashboard.tsx");
  expect(source).toContain('data-testid="accounts-dashboard"');
  expect(source).not.toContain("model-router");
  expect(source).not.toContain("ResourceRecommendation");
});

test("account display name is shown only for a known account", () => {
  expect(accountLabel("acc-1", [{ id: "acc-1", displayName: "Owner" }])).toBe("Owner · acc-1");
  expect(accountLabel("acc-2", [{ id: "acc-1", displayName: "Owner" }])).toBe("acc-2");
  expect(accountLabel(null, [])).toBe("No account");
});

test("stale quota is not described as current", () => {
  expect(presentQuota(quota("stale", observation({ remaining: 9 })), 2_000).label).toBe("Stale — not current");
});

test("a past or Owner-reported reading keeps its time and is never described as verified capacity", () => {
  // A re-resolved stale state has no current reading; the past one stays on record with its own time and source.
  const stale = quota("stale", null);
  stale.observations = [observation({ remaining: 9, expiresAt: 500 })];
  const past = presentQuota(stale, 2_000);
  expect(past.label).toBe("Stale — not current");
  expect(past.verification).toBe("unknown");
  expect(past.observedAt).toBe(1_000);
  expect(past.provenance).toBe("fake-source");
  const owner = presentQuota(quota("current", observation({ verification: "unverified", provenance: "user-provided", source: "manual", remaining: 9, expiresAt: 5_000 })), 2_000);
  expect(owner.label).toBe("Reported by you — not verified");
  expect(owner.verification).toBe("unverified");
});

test("planning estimate is labeled as planning and omits subscription totals", () => {
  const estimate = {
    ok: true,
    missing: [{ code: "rate", path: "rate", message: "Rate is missing." }],
    confidence: { summary: "Confidence is limited." },
    scenarios: { expected: { additionalCash: { status: "known", money: { currency: "USD", minor: 250 } } } },
  } as EstimationResult;
  const note = planningEstimateNote(estimate);
  expect(note.lines.join(" ")).toContain("Saved planning additional cash");
  expect(note.lines.join(" ")).toContain("not a reservation");
  expect(note.lines.join(" ")).toContain("Subscription commitments are not summed");
  expect(note.lines.join(" ")).not.toContain("subscription fee");
  expect(planningEstimateNote(null).heading).toBe("No saved planning estimate");
});

test("quota reset, missing expiry, future observations and unverified evidence never show current capacity", () => {
  for (const patch of [{ resetAt: 1_500 }, { expiresAt: null }, { observedAt: 3_000 }, { verification: "unverified" as const }]) {
    const shown = presentQuota(quota("current", observation(patch)), 2_000);
    expect(shown.label).not.toContain("Current —");
  }
});

test("local evidence deadlines cover reset and expiry without changing backend grouping", () => {
  const recommended = card("winner", "verified", { quotaEvidence: [quota("current", observation({ resetAt: 4_000 }))] });
  const result = preview({ status: "recommended", recommendedCandidate: recommended });
  expect(evidenceBoundaries([result])).toEqual([4_000, 5_000]);
  expect(hasExpiredQuota(recommended, 3_000)).toBe(false);
  expect(hasExpiredQuota(recommended, 4_000)).toBe(true);
  expect(groupedCandidates(result).recommended).toBe(recommended);
  expect(result.recommendedCandidate?.status).toBe("verified");
});

test("empty owner allowlists mean none allowed", () => {
  const rows = ownerRows({ ...UNKNOWN_OWNER_CONSTRAINTS, allowedHarnesses: [], allowedAccounts: [] });
  expect(rows.find(row => row.label === "Allowed harnesses")?.value).toBe("None allowed");
  expect(rows.find(row => row.label === "Allowed accounts")?.value).toBe("None allowed");
});

test("quota demands and permission restrictions preserve exact units and reject invalid values", () => {
  const body = buildTaskPreviewBody("/proj", "task-1", { ...EMPTY_PREVIEW_DRAFT, quotaDemands: [{ quotaId: "quota-1", amount: "0" }], requiredPermissions: "read", limitPermissions: true, allowedPermissions: "read" }, allow, catalog);
  expect(body.requirements).toMatchObject({ quotaDemands: [{ quotaId: "quota-1", amount: 0 }], requiredPermissions: ["read"], allowedPermissions: ["read"] });
  for (const amount of ["", "-1", "1.5", "9007199254740992"]) {
    expect(() => buildTaskPreviewBody("/proj", "task-1", { ...EMPTY_PREVIEW_DRAFT, quotaDemands: [{ quotaId: "quota-1", amount }] }, allow, catalog)).toThrow(PreviewDraftError);
  }
  expect(() => buildTaskPreviewBody("/proj", "task-1", { ...EMPTY_PREVIEW_DRAFT, quotaDemands: [{ quotaId: "q", amount: "1" }, { quotaId: "q", amount: "2" }] }, allow, catalog)).toThrow("Duplicate");
});

test("excluded-only abstention exposes the actual backend restrictions", () => {
  expect(abstentionReasons(preview({ excludedCandidates: [card("no", "excluded", { reasons: ["Owner disallows this harness."] })] }))).toEqual(["Owner disallows this harness."]);
});

test("a conditional payload cannot become a verified recommendation", () => {
  expect(groupedCandidates(preview({ status: "recommended", recommendedCandidate: card("maybe", "conditional") })).recommended).toBeNull();
});

test("API forwards exact calculation input and AbortSignal to both routes with no retries", async () => {
  const calls: { path: string; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  const client = createModelRouterApi(async <T>(requestPath: string, init?: RequestInit, opts?: { retry?: boolean }): Promise<T> => {
    expect(opts?.retry).toBe(false);
    expect(init?.method).toBe("POST");
    calls.push({ path: requestPath, body: JSON.parse(init?.body as string), signal: init?.signal });
    return {} as T;
  });
  const signal = new AbortController().signal;
  const body = buildTaskPreviewBody("/proj", "task-1", EMPTY_PREVIEW_DRAFT, allow, catalog);
  await client.preview(body, signal);
  await client.portfolioPreview({ requests: [body] }, signal);
  expect(calls).toEqual([{ path: "/model-router/preview", body, signal }, { path: "/model-router/portfolio-preview", body: { requests: [body] }, signal }]);
});

test("a late resolved transport response is discarded after invalidation", async () => {
  const session = createPreviewSession();
  let resolve!: (value: string) => void;
  const delayed = new Promise<string>(done => { resolve = done; });
  const first = session.begin();
  let shown: string | null = null;
  const pending = delayed.then(value => { if (first.isCurrent()) shown = value; });
  session.invalidate();
  resolve("obsolete candidate");
  await pending;
  expect(shown).toBeNull();
});
