import { describe, expect, test } from "bun:test";
import {
  RANK_STEP, compareBoardTasks, endRank, groupByUrgency, isUrgency, moveWithinGroup, normalizeUrgency, placementForMoved, planReorder, sortBoardTasks,
} from "./board-order.ts";

const t = (id: string, urgency: number, boardRank: number, createdAt = 1) => ({ id, urgency, boardRank, createdAt });

describe("the displayed order of a column", () => {
  test("urgency descending, then rank, then created time, then id", () => {
    const sorted = sortBoardTasks([t("g", 1, 1), t("c", 4, 5), t("a", 5, 9), t("e", 3, 20), t("d", 3, 10), t("f", 2, 1), t("b", 5, 30), t("x", 3, 20, 0)]);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b", "c", "d", "x", "e", "f", "g"]);
  });
  test("a lower urgency never sorts above a higher one, whatever its rank", () => {
    expect(compareBoardTasks(t("low", 1, -99999), t("high", 5, 99999))).toBeGreaterThan(0);
  });
  test("a missing or corrupt value reads as Normal urgency and sorts last inside its group", () => {
    expect(normalizeUrgency(undefined)).toBe(3);
    expect(normalizeUrgency(9)).toBe(3);
    expect(normalizeUrgency(2.5)).toBe(3);
    expect(isUrgency(5) && isUrgency(1) && !isUrgency(0) && !isUrgency(6) && !isUrgency("3")).toBe(true);
    const sorted = sortBoardTasks([{ id: "n", urgency: 3, boardRank: null }, t("r", 3, 5), { id: "z", boardRank: Number.NaN }]);
    expect(sorted[0]!.id).toBe("r");
  });
  test("groups hold only the urgency levels that contain tasks", () => {
    const groups = groupByUrgency(sortBoardTasks([t("a", 5, 1), t("b", 3, 1), t("c", 3, 2), t("d", 1, 1)]));
    expect(groups.map((g) => [g.urgency, g.tasks.map((x) => x.id)])).toEqual([[5, ["a"]], [3, ["b", "c"]], [1, ["d"]]]);
  });
});

describe("planReorder", () => {
  const group = [{ id: "a", rank: 1024 }, { id: "b", rank: 2048 }, { id: "c", rank: 3072 }];
  const apply = (rows: typeof group, plan: ReturnType<typeof planReorder>) => {
    if (typeof plan === "string") throw new Error(plan);
    const next = new Map(rows.map((r) => [r.id, r.rank]));
    for (const w of plan.writes) next.set(w.id, w.rank);
    return [...next].map(([id, rank]) => ({ id, rank }));
  };
  test("moves one task with one write", () => {
    const plan = planReorder(group, "c", { before: "b" });
    expect(plan).toMatchObject({ order: ["a", "c", "b"], renumbered: false });
    expect(typeof plan !== "string" && plan.writes).toEqual([{ id: "c", rank: 1536 }]);
  });
  test("first and last", () => {
    expect(planReorder(group, "c", "first")).toMatchObject({ order: ["c", "a", "b"] });
    expect(planReorder(group, "a", "last")).toMatchObject({ order: ["b", "c", "a"] });
    const first = planReorder(group, "c", "first");
    expect(typeof first !== "string" && first.writes[0]!.rank).toBe(1024 - RANK_STEP);
  });
  test("is idempotent: planning the same placement again writes nothing", () => {
    const once = planReorder(group, "c", { before: "b" });
    const rows = apply(group, once);
    expect(planReorder(rows, "c", { before: "b" })).toMatchObject({ writes: [], order: ["a", "c", "b"] });
    expect(planReorder(group, "b", { after: "a" })).toMatchObject({ writes: [] });
  });
  test("renumbers only when two neighbours have no room", () => {
    const tight = [{ id: "a", rank: 10 }, { id: "b", rank: 11 }, { id: "c", rank: 500 }];
    const plan = planReorder(tight, "c", { after: "a" });
    expect(plan).toMatchObject({ order: ["a", "c", "b"], renumbered: true });
    expect(apply(tight, plan).sort((x, y) => x.rank - y.rank).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  test("duplicate ranks are repaired deterministically", () => {
    const dupes = [{ id: "a", rank: 5 }, { id: "b", rank: 5 }, { id: "c", rank: 5 }];
    const plan = planReorder(dupes, "c", "first");
    expect(plan).toMatchObject({ order: ["c", "a", "b"], renumbered: true });
    const ranks = apply(dupes, plan).map((r) => r.rank);
    expect(new Set(ranks).size).toBe(3);
  });
  test("refuses an unknown task, an unknown anchor and a task placed against itself", () => {
    expect(planReorder(group, "zzz", "first")).toBe("unknown-task");
    expect(planReorder(group, "a", { after: "zzz" })).toBe("unknown-anchor");
    expect(planReorder(group, "a", { after: "a" })).toBe("self-anchor");
  });
  test("many moves keep every rank distinct and the order equal to the plan", () => {
    let rows = [...group, { id: "d", rank: 4096 }, { id: "e", rank: 5120 }];
    const ids = rows.map((r) => r.id);
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i++) {
      const id = ids[Math.floor(rand() * ids.length)]!;
      const other = ids.filter((x) => x !== id)[Math.floor(rand() * (ids.length - 1))]!;
      const placement = rand() < 0.5 ? { after: other } : { before: other };
      const plan = planReorder(rows, id, placement);
      rows = apply(rows, plan);
      const order = rows.slice().sort((x, y) => x.rank - y.rank).map((r) => r.id);
      expect(order).toEqual((plan as { order: string[] }).order);
      expect(new Set(rows.map((r) => r.rank)).size).toBe(rows.length);
    }
  });
});

describe("helpers", () => {
  test("end rank follows the largest rank", () => {
    expect(endRank([])).toBe(RANK_STEP);
    expect(endRank([1024, 4096, 2048])).toBe(4096 + RANK_STEP);
  });
  test("a moved card is placed against the nearest task of the same project", () => {
    const projectOf = (id: string) => (id.startsWith("x") ? "X" : "Y");
    expect(placementForMoved([{ id: "y1" }, { id: "x1" }, { id: "y2" }], "y2", projectOf)).toEqual({ after: "y1" });
    expect(placementForMoved([{ id: "x1" }, { id: "y1" }, { id: "x2" }], "y1", projectOf)).toBe("last");
    expect(placementForMoved([{ id: "x1" }, { id: "y1" }, { id: "y2" }], "y1", projectOf)).toEqual({ before: "y2" });
  });
  test("moving within a group clamps at both ends", () => {
    const g = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moveWithinGroup(g, "a", -1).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(moveWithinGroup(g, "b", 1).map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(moveWithinGroup(g, "c", "start").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(moveWithinGroup(g, "a", "end").map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});
