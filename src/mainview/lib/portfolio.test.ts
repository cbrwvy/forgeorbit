import { expect, test } from "bun:test";
import {
  buildWhatIfPatch,
  environmentPhaseLabel,
  filterComparison,
  formatCount,
  formatPortfolioMoney,
  isCurrentPortfolioRequest,
  isPortfolioRefreshEvent,
  sortComparison,
  type ComparisonRow,
} from "./portfolio.ts";
import type { ProjectSummary } from "../../shared/portfolio/index.ts";

function row(path: string, patch: Partial<ProjectSummary> = {}): ComparisonRow {
  return {
    project: {
      projectId: path,
      path,
      name: path,
      nameOrigin: "user-provided",
      description: { value: null, origin: "unknown", observedAtMs: null },
      stack: { value: null, origin: "unknown", observedAtMs: null },
      managerConfigured: { value: null, origin: "unknown", observedAtMs: null },
      managerAvailable: { value: null, origin: "unknown", observedAtMs: null },
      freshness: "current",
      countsAreCurrent: true,
      boardObserved: true,
      taskCount: 1,
      columns: null,
      doneCount: 0,
      reviewCount: 0,
      blockedCount: 0,
      archivedCount: 0,
      pipelineStepCount: 0,
      priorityCounts: null,
      dependencyCount: 0,
      activeRunCount: 0,
      failedRunCount: 0,
      orphanedRunCount: 0,
      harnessIds: [],
      agentProfileIds: [],
      runningPipelineCount: 0,
      pausedBatchCount: 0,
      runningBatchCount: 0,
      activeBatchCount: 0,
      environmentConfigured: false,
      environmentPhase: null,
      environmentPhaseOrigin: "unknown",
      environmentRecordedPhase: null,
      environmentPhaseObservedAtMs: null,
      environmentPhaseFreshness: null,
      environmentPhaseNote: null,
      ...patch,
    },
    calendarMs: null,
    cashMinor: null,
    cashCurrency: null,
    confidence: null,
    conflictCount: 0,
  };
}

test("unknown and partial counts are not shown as zero", () => {
  expect(formatCount({ status: "unknown", value: null, knownValue: null, note: null })).toBe("Unknown");
  expect(formatCount({ status: "incomplete", value: null, knownValue: 2, note: null })).toBe("Partial · 2 known");
  expect(formatCount({ status: "known", value: 0, knownValue: 0, note: null })).toBe("0");
});

test("mixed currency money is not given a converted total", () => {
  expect(formatPortfolioMoney({
    status: "mixed-currency",
    money: null,
    knownPortion: null,
    origin: "unknown",
    note: null,
  })).toBe("Mixed currencies");
});

test("sorting and filtering stay on the rows already loaded", () => {
  const rows = [
    row("/b", { taskCount: 1, reviewCount: 2 }),
    row("/a", { taskCount: null, reviewCount: 0 }),
  ];
  expect(sortComparison(rows, "tasks").map((item) => item.project.path)).toEqual(["/b", "/a"]);
  expect(filterComparison(rows, "review", []).map((item) => item.project.path)).toEqual(["/b"]);
});

test("an empty what-if draft does not build a patch", () => {
  expect(buildWhatIfPatch({ excludedProjectIds: [], priorities: [], concurrency: [] })).toBeNull();
  const patch = buildWhatIfPatch({
    excludedProjectIds: ["/a"],
    priorities: [{ projectId: "/b", priority: "high" }],
    concurrency: [{ resourceId: "harness:claude-code", limit: 1 }],
  });
  expect(patch?.excludeProjectIds).toEqual(["/a"]);
  expect(patch?.projectPriorities?.[0]?.origin).toBe("user-provided");
  expect(patch?.concurrency?.[0]?.origin).toBe("user-provided");
});

test("a stale response is ignored and portfolio events are recognized", () => {
  expect(isCurrentPortfolioRequest(1, 2)).toBe(false);
  expect(isCurrentPortfolioRequest(2, 2)).toBe(true);
  expect(isPortfolioRefreshEvent("execution_batch")).toBe(true);
  expect(isPortfolioRefreshEvent("reconnect")).toBe(true);
  expect(isPortfolioRefreshEvent("ping")).toBe(false);
});

test("an old stored environment phase is not shown as current", () => {
  const now = Date.UTC(2026, 9, 24, 12, 0, 0);
  expect(environmentPhaseLabel(null, null, now, 300_000)).toBe("unknown");
  // A phase whose recording time is unknown or old is not the current state.
  expect(environmentPhaseLabel("running", null, now, 300_000)).toMatch(/^unknown \(last recorded running/);
  expect(environmentPhaseLabel("running", now - 60_000, now, 300_000)).toMatch(/^running \(recorded/);
  const old = environmentPhaseLabel("degraded", now - 86_400_000, now, 300_000);
  expect(old).toMatch(/^unknown \(last recorded degraded/);
  expect(old).toContain("not confirmed current");
});
