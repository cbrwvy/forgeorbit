import { expect, test } from "bun:test";
import {
  forecastSelectionForProject,
  lockProjectFilter,
  remainingTaskIds,
  tasksInProject,
} from "./project-analytics.ts";

test("remaining tasks skip done, archived and pipeline steps", () => {
  expect(remainingTaskIds([
    { id: "a", column: "ready" },
    { id: "b", column: "done" },
    { id: "c", column: "review", archivedAt: 1 },
    { id: "d", column: "backlog", pipelineParentId: "parent" },
    { id: "e", column: "blocked" },
  ])).toEqual(["a", "e"]);
});

test("a project forecast is read-only and stays on that project", () => {
  const picked = forecastSelectionForProject("/work/alpha", ["t1", "t2"]);
  expect(picked).toEqual({
    partial: false,
    selection: { projectPath: "/work/alpha", taskIds: ["t1", "t2"], save: false },
  });
  expect(forecastSelectionForProject("/work/alpha", [])).toBeNull();
});

test("more than 100 tasks is a partial forecast, not a rejected request", () => {
  const ids = Array.from({ length: 101 }, (_, index) => `t${index}`);
  const picked = forecastSelectionForProject("/work/alpha", ids);
  expect(picked?.partial).toBe(true);
  expect(picked?.selection.taskIds).toHaveLength(100);
  expect(picked?.selection.save).toBe(false);
  expect(picked?.selection.projectPath).toBe("/work/alpha");
});

test("a locked filter cannot be pointed at another project", () => {
  expect(lockProjectFilter("/work/alpha", { projectPath: "/work/beta", from: 5 })).toEqual({
    projectPath: "/work/alpha",
    from: 5,
  });
});

test("rows from another project are left out of the project summary", () => {
  const split = tasksInProject([
    { id: "a", projectPath: "/work/alpha" },
    { id: "b", projectPath: "/work/beta" },
    { id: "c", projectPath: null },
  ], "/work/alpha");
  expect(split.rows.map((row) => row.id)).toEqual(["a", "c"]);
  expect(split.foreign).toBe(1);
});
