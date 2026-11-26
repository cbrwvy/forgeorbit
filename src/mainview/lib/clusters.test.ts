import { expect, test } from "bun:test";
import type { ClusterAggregate } from "../../shared/clusters/aggregate.ts";
import { CLUSTER_RUN_NOTE, FORGEORBIT_COMPANY, type Cluster } from "../../shared/clusters/types.ts";
import type { CountFact, PortfolioEstimation, PortfolioMoney } from "../../shared/portfolio/types.ts";
import {
  additionalCostText,
  archiveConfirmCopy,
  clusterCardMetrics,
  clusterErrorText,
  clusterWriteBody,
  compareClusters,
  environmentLabel,
  isCurrentClusterRequest,
  moveConfirmCopy,
  resourceWarningLines,
  unassignConfirmCopy,
} from "./clusters.ts";

function cluster(partial: Partial<Cluster> & Pick<Cluster, "id" | "name">): Cluster {
  return {
    companyId: FORGEORBIT_COMPANY.id,
    slug: null,
    description: "",
    color: null,
    icon: null,
    notesSummary: null,
    priority: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    projectCount: 2,
    knowledgeOwner: { kind: "cluster", id: partial.id },
    ...partial,
  };
}

const known = (value: number): CountFact => ({ status: "known", value, knownValue: value, note: null });

function money(status: PortfolioMoney["status"], minor: number | null = null): PortfolioMoney {
  const amount = minor == null ? null : { currency: "USD" as const, minor };
  return {
    status,
    money: status === "known" ? amount : null,
    knownPortion: status === "incomplete" ? amount : null,
    origin: "known",
    note: status === "mixed-currency" ? "EUR and USD" : null,
  };
}

function estimation(cash: PortfolioMoney, confidence: PortfolioEstimation["confidence"] = "medium"): PortfolioEstimation {
  return {
    scenarioNote: "expected",
    agent: { status: "known", ms: 3_600_000, knownMs: 3_600_000, origin: "known", note: null },
    calendar: { status: "known", ms: 7_200_000, method: "slowest-project", exact: false, note: null },
    additionalCash: cash,
    apiEquivalent: money("not-requested"),
    subscriptions: money("not-requested"),
    proposedSubscriptionIds: [],
    confidence,
    confidenceNote: "Known for the recorded portion.",
    closestProject: { status: "unknown", projectId: null, calendarMs: null, note: "Not requested." },
    remainingWindow: { status: "unknown", note: "No window was supplied." },
    projects: [],
    simplifications: [],
  };
}

function aggregate(partial: Partial<ClusterAggregate> = {}): ClusterAggregate {
  return {
    memberPaths: ["/a", "/b"],
    observedPaths: ["/a", "/b"],
    omittedPaths: [],
    completeness: "complete",
    notes: [],
    runNote: CLUSTER_RUN_NOTE,
    counts: {
      tasks: known(4),
      runningTasks: known(1),
      pendingReviews: known(2),
      blockers: known(1),
      doneTasks: known(0),
      activeRuns: known(1),
      activeBatches: known(0),
    },
    activeProjects: known(1),
    blockedProjects: known(1),
    environments: { status: "known", counts: { stopped: 2 }, note: null },
    projectEnvironments: [
      { path: "/a", phase: "stopped", recordedPhase: "stopped", freshness: "current" },
      { path: "/b", phase: "stopped", recordedPhase: "stopped", freshness: "current" },
    ],
    estimation: estimation(money("known", 500)),
    dedupedSubscriptionFees: money("not-requested"),
    exclusiveSubscriptionFees: "none",
    sharedSubscriptions: [],
    resources: [],
    conflicts: [],
    quotas: [],
    duplicateTaskIds: [],
    ...partial,
  };
}

test("an empty summary is unknown rather than zero, while membership count stays known", () => {
  const card = clusterCardMetrics(cluster({ id: "c1", name: "Empty", projectCount: 0 }), null, false);
  expect(card.projects).toBe("0");
  expect(card.tasks).toBe("…");
  expect(card.quality).toBe("…");
  const failed = clusterCardMetrics(cluster({ id: "c1", name: "Empty", projectCount: 0 }), null, true);
  expect(failed.quality).toBe("Unknown");
  expect(failed.tasks).toBe("Unknown");
  expect(failed.runs).not.toBe("0");
});

test("partial counts and a stale environment stay labeled", () => {
  const card = clusterCardMetrics(cluster({ id: "c1", name: "Partial" }), aggregate({
    completeness: "partial",
    counts: {
      tasks: { status: "incomplete", value: null, knownValue: 3, note: "missing" },
      runningTasks: known(0),
      pendingReviews: known(0),
      blockers: known(0),
      doneTasks: known(0),
      activeRuns: { status: "unknown", value: null, knownValue: null, note: "missing" },
      activeBatches: known(0),
    },
  }), false);
  expect(card.tasks).toBe("Partial · 3 known");
  expect(card.runs).toBe("Unknown");
  expect(card.quality).toBe("Partial");

  const env = environmentLabel(aggregate({
    environments: { status: "incomplete", counts: {}, note: "stale" },
    projectEnvironments: [{ path: "/a", phase: null, recordedPhase: "running", freshness: "stale" }],
  }));
  expect(env.label).toBe("Partial");
  expect(env.reason).toContain("not shown as current");
  expect(environmentLabel(aggregate({ environments: null, projectEnvironments: [] })).label).toBe("Unknown");
});

test("comparison does not sum shared subscriptions or mixed currencies", () => {
  const compared = compareClusters([
    {
      cluster: cluster({ id: "a", name: "Alpha" }),
      aggregate: aggregate({
        exclusiveSubscriptionFees: "unknown",
        estimation: estimation(money("mixed-currency")),
        dedupedSubscriptionFees: money("known", 2000),
      }),
    },
    {
      cluster: cluster({ id: "b", name: "Beta" }),
      aggregate: aggregate({
        exclusiveSubscriptionFees: "exclusive",
        estimation: estimation(money("known", 100)),
      }),
    },
  ]);
  expect(compared.totals).toBe("omitted");
  expect(compared.reason).toContain("not added together");
  expect(compared.rows[0]?.additionalCosts).toBe("Mixed currencies");
  expect(compared.rows[0]?.additionalReason).toContain("not added to another space");
  expect(compared.rows[1]?.additionalCosts).not.toBe("Mixed currencies");
  expect(JSON.stringify(compared)).not.toContain("2100");
  const missing = compareClusters([{ cluster: cluster({ id: "c", name: "Gamma" }), aggregate: null, unavailableReason: "Summary failed." }]);
  expect(missing.rows[0]?.activeProjects).toBe("Unknown");
  expect(missing.rows[0]?.confidenceReason).toBe("Summary failed.");
});

test("unknown quota is called out and is not described as unlimited", () => {
  const lines = resourceWarningLines(aggregate({
    quotas: [{
      resourceId: "codex-main",
      quota: { kind: "unknown", reason: "not observed" },
      concurrencyLimit: { value: null, origin: "unknown", observedAtMs: null },
      capacity: "unknown",
      quotaTreatment: "unknown",
    }],
  }));
  expect(lines.join(" ")).toContain("not treated as unlimited");
  expect(lines.join(" ")).not.toContain("unbounded");
  expect(additionalCostText(null).text).toBe("Unknown");
  expect(additionalCostText(null).reason).toContain("not treated as zero");
});

test("create body requires a name and can clear optional fields", () => {
  expect(clusterWriteBody({ name: "  ", description: "", slug: "", color: "", icon: "", priority: "" }).ok).toBe(false);
  const body = clusterWriteBody({ name: " Orbit ", description: "Notes", slug: "", color: "#39f", icon: "layers", priority: "" });
  expect(body.ok).toBe(true);
  if (body.ok) {
    expect(body.body.name).toBe("Orbit");
    expect(body.body.slug).toBeNull();
    expect(body.body.priority).toBeNull();
    expect(body.body.color).toBe("#39f");
  }
  expect(clusterWriteBody({ name: "Orbit", description: "", slug: "", color: "", icon: "", priority: "1.5" }).ok).toBe(false);
});

test("archive, move, and unassign copy names the organizational boundary", () => {
  expect(archiveConfirmCopy("Orbit", 2).body).toContain("2 projects");
  expect(archiveConfirmCopy("Orbit", 2).body).toContain("does not change Git");
  expect(archiveConfirmCopy("Orbit", 0).body).not.toContain("0 project");
  const move = moveConfirmCopy("Alpha", "Source", "Dest");
  expect(move.body).toContain("from Source to Dest");
  expect(move.body).toContain("organizational membership");
  expect(unassignConfirmCopy("Alpha", "Source").body).toContain("leaves Source");
});

test("a stale cluster response is ignored and API errors keep the server message", () => {
  expect(isCurrentClusterRequest(2, 2)).toBe(true);
  expect(isCurrentClusterRequest(1, 2)).toBe(false);
  expect(clusterErrorText({ message: "Slug is already in use.", status: 409 })).toBe("Slug is already in use.");
  expect(clusterErrorText({ message: "unauthorized", status: 401 })).toBe("unauthorized");
  expect(clusterErrorText({ message: "Cluster not found.", status: 404 })).toBe("Cluster not found.");
  expect(clusterErrorText({ message: "Invalid color.", status: 400 })).toBe("Invalid color.");
  expect(clusterErrorText(null)).toBe("Couldn't reach spaces.");
});
