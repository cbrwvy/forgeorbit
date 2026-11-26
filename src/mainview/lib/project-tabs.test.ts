import { expect, test } from "bun:test";
import { isMorePage, PROJECT_MORE_PAGES, PROJECT_PRIMARY_TABS, projectTabFor } from "./navigation.ts";
import { parseWorkspace, visibleWorkspacePage, type WorkspacePage } from "./workspace.ts";

// Every project page id that existed before M5 must still resolve to a tab.
const PRE_M5_PROJECT_PAGES: WorkspacePage[] = ["overview", "board", "estimates", "environment", "manager", "settings", "knowledge", "brain"];

test("every pre-M5 project page is reachable from a primary tab or the More menu", () => {
  const reachable = new Set<WorkspacePage>([...PROJECT_PRIMARY_TABS.map((t) => t.page), ...PROJECT_MORE_PAGES.map((m) => m.page)]);
  for (const page of PRE_M5_PROJECT_PAGES) expect(reachable.has(page)).toBe(true);
});

test("old pages map to their new owner tab", () => {
  expect(projectTabFor("overview")).toBe("overview");
  expect(projectTabFor("board")).toBe("board");
  expect(projectTabFor("usage")).toBe("usage");
  expect(projectTabFor("manager")).toBe("manager");
  expect(projectTabFor("team")).toBe("team");
  for (const page of ["estimates", "environment", "knowledge", "brain", "settings"] as const) {
    expect(projectTabFor(page)).toBe("more");
    expect(isMorePage(page)).toBe(true);
  }
});

test("test ids of the moved tabs are the pre-M5 ids", () => {
  expect(PROJECT_MORE_PAGES.map((m) => m.testId).sort()).toEqual([
    "project-page-brain", "project-page-environment", "project-page-estimates", "project-page-knowledge", "project-page-settings",
  ]);
  expect(PROJECT_PRIMARY_TABS.map((t) => t.testId)).toEqual(["project-page-overview", "project-page-board", "project-page-analytics", "project-page-manager", "project-page-team"]);
});

test("saved selections for every old project page still parse and stay on the project", () => {
  for (const page of [...PRE_M5_PROJECT_PAGES, "team" as const]) {
    const parsed = parseWorkspace({ scope: "project", path: "/p", page });
    expect(parsed).toEqual({ scope: "project", path: "/p", page });
    expect(visibleWorkspacePage(parsed!)).toBe(page);
  }
  const analytics = parseWorkspace({ scope: "project", path: "/p", page: "usage" });
  expect(analytics).toEqual({ scope: "project", path: "/p", page: "usage" });
  expect(visibleWorkspacePage(analytics!)).toBe("usage");
  expect(visibleWorkspacePage({ scope: "all", page: "usage" })).toBe("overview");
});

test("the project-only team page falls back to the overview on the global scope", () => {
  expect(visibleWorkspacePage({ scope: "all", page: "team" })).toBe("overview");
});
