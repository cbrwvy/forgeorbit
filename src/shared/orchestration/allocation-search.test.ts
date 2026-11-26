import { expect, test } from "bun:test";
import { ALLOCATION_SEARCH_LIMIT, compareAllocations, searchAllocation, type AllocationStage } from "./allocation-search.ts";

const stage = (id: string, dependsOn: string[], options: AllocationStage["options"]): AllocationStage => ({ id, dependsOn, options });
const option = (id: string, accountId: string, durationMs: number, extra: Partial<AllocationStage["options"][number]> = {}) => ({
  id, accountId, durationMs, charge: extra.charge ?? 1, waitMs: extra.waitMs ?? 0, poolId: extra.poolId ?? "shared",
  demand: extra.demand === undefined ? 1 : extra.demand, concurrency: extra.concurrency ?? 1,
  provider: extra.provider ?? null,
});

test("bounded search ranks feasible allocations and refuses unproven optimality", () => {
  const stages = [
    stage("dev-a", [], [option("slow", "a", 50, { charge: 1, waitMs: 0 }), option("fast", "b", 10, { charge: 9, waitMs: 5, poolId: "independent" })]),
    stage("dev-b", ["dev-a"], [option("slow", "a", 50, { charge: 1 }), option("fast", "b", 10, { charge: 9, poolId: "independent" })]),
  ];
  const pools = [{ id: "shared", remaining: 2 }, { id: "independent", remaining: 2 }];
  const ranked = compareAllocations(stages, pools, true);
  expect(ranked.find(row => row.objective === "fastest")).toMatchObject({ feasible: true, optimal: true, assignment: { "dev-a": "fast", "dev-b": "fast" } });
  expect(ranked.find(row => row.objective === "lowest-charge")).toMatchObject({ assignment: { "dev-a": "slow", "dev-b": "slow" } });
  expect(ranked.find(row => row.objective === "minimum-wait")?.assignment["dev-a"]).toBe("slow");
  expect(ranked.find(row => row.objective === "quota-preserving")?.feasible).toBe(true);
  const again = searchAllocation(stages, "fastest", pools, true);
  expect(again.assignment).toEqual(ranked.find(row => row.objective === "fastest")!.assignment);
  const limited = searchAllocation(stages, "fastest", pools, true, 1);
  expect(limited.optimal).toBe(false);
  expect(limited.limit).toBe(1);
  expect(limited.explored).toBeLessThanOrEqual(ALLOCATION_SEARCH_LIMIT);
});

test("strict capacity ignores unknown remaining and assumed replenishment is not an input", () => {
  const stages = [stage("only", [], [option("needs-pool", "a", 5, { demand: 3, poolId: "shared" })])];
  expect(searchAllocation(stages, "fastest", [{ id: "shared", remaining: null }], true)).toMatchObject({ feasible: false, optimal: true });
  expect(searchAllocation(stages, "fastest", [{ id: "shared", remaining: 2 }], true)).toMatchObject({ feasible: false, optimal: true });
  expect(searchAllocation(stages, "quota-preserving", [{ id: "shared", remaining: 4 }], true).assignment).toEqual({ only: "needs-pool" });
  const shared = [
    stage("one", [], [option("a1", "a", 5, { poolId: "shared", demand: 2 }), option("b1", "b", 5, { poolId: "other", demand: 2 })]),
    stage("two", [], [option("a2", "a", 5, { poolId: "shared", demand: 2, concurrency: 2 }), option("b2", "b", 5, { poolId: "other", demand: 2 })]),
  ];
  const preserving = searchAllocation(shared, "quota-preserving", [{ id: "shared", remaining: 3 }, { id: "other", remaining: 3 }], true);
  expect(preserving.feasible).toBe(true);
  expect(new Set(Object.values(preserving.assignment)).size).toBe(2);
});

test("global, cluster, project, account, and pool caps are one shared capacity", () => {
  const free = { poolId: null, demand: null as number | null, charge: 1 };
  const caps = { globalMax: 2, perProjectMax: 2, perClusterMax: 2, perRoleMax: 2 };
  const a = { ...stage("a", [], [option("a1", "acct-a", 10, free)]), projectId: "/p1", clusterId: "c1", role: "developer" };
  const b = { ...stage("b", [], [option("b1", "acct-b", 10, free)]), projectId: "/p2", clusterId: "c1", role: "developer" };
  expect(searchAllocation([a, b], "fastest", [], false, 256, caps).score).toBe(10);
  expect(searchAllocation([a, b], "fastest", [], false, 256, { ...caps, globalMax: 1 }).score).toBe(20);
  expect(searchAllocation([a, b], "fastest", [], false, 256, { ...caps, perClusterMax: 1 }).score).toBe(20);
  expect(searchAllocation(
    [{ ...a, projectId: "/same" }, { ...b, projectId: "/same" }],
    "fastest", [], false, 256, { ...caps, perProjectMax: 1 },
  ).score).toBe(20);
  expect(searchAllocation([
    { ...stage("a", [], [option("a1", "shared-acct", 10, free)]), projectId: "/p1", role: "developer" },
    { ...stage("b", [], [option("b1", "shared-acct", 10, free)]), projectId: "/p2", role: "developer" },
  ], "fastest", [], false, 256, caps).score).toBe(20);
  const paused = searchAllocation([
    { ...a, withheld: "Project is paused or draining." },
    b,
  ], "fastest", [], false, 256, caps);
  expect(paused.assignment).toEqual({ b: "b1" });
  expect(paused.withheld.a).toContain("paused");
  expect(searchAllocation([
    stage("one", [], [option("m1", "acct-a", 5, { poolId: "shared", demand: 2 })]),
    stage("two", [], [option("m2", "acct-b", 5, { poolId: "shared", demand: 2 })]),
  ], "fastest", [{ id: "shared", remaining: 3 }], true, 256, caps).feasible).toBe(false);
  expect(searchAllocation([
    stage("only", [], [option("c", "acct", 5, { ...free, provider: "cursor" })]),
  ], "fastest", [], false, 256, { ...caps, blockedProviders: ["cursor"] }).feasible).toBe(false);
  expect(searchAllocation([a], "fastest", [], false, 256, { globalMax: 1, perRoleMax: 1, occupied: [{ untilMs: 30 }] }).score).toBe(40);
  const many = Array.from({ length: 13 }, (_, index) => stage(`s${index}`, [], [option(`o${index}`, `acct-${index}`, 1, free)]));
  const wide = searchAllocation(many, "fastest", [], false, 256, caps);
  expect(wide.optimal).toBe(false);
  expect(wide.reason).toContain("bounded allocation search");
  const unknown = searchAllocation([a], "fastest", [], false, 256, { ...caps, unmeasured: ["Unknown capacity pool"] });
  expect(unknown.limitations.join(" ")).toContain("Unknown capacity pool");
  expect(unknown.optimal).toBe(true);
});
