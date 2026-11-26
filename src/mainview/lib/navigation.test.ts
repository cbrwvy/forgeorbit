import { expect, test } from "bun:test";
import { PRIMARY_NAV, navTargetFor, sectionTabsFor, type NavTarget } from "./navigation.ts";
import { parseWorkspace, readWorkspace, visibleWorkspacePage, WORKSPACE_STORAGE_KEY, type WorkspacePage, type WorkspaceSelection } from "./workspace.ts";

test("the rail is Home, Workspaces, AI Team and Knowledge", () => {
  expect(PRIMARY_NAV.map((item) => item.id)).toEqual(["home", "workspaces", "team", "knowledge"]);
  expect(PRIMARY_NAV.map((item) => item.testId)).toEqual([
    "workspace-overview", "workspace-workspaces", "workspace-company", "workspace-knowledge",
  ]);
  for (const item of PRIMARY_NAV) expect(navTargetFor({ scope: "all", page: item.page })).toBe(item.id);
});

const HISTORICAL: Record<string, { target: NavTarget | null; page: WorkspacePage; visible: WorkspacePage }> = {
  overview: { target: "home", page: "overview", visible: "overview" },
  attention: { target: "home", page: "attention", visible: "attention" },
  portfolio: { target: "workspaces", page: "portfolio", visible: "portfolio" },
  clusters: { target: "workspaces", page: "clusters", visible: "clusters" },
  projects: { target: "workspaces", page: "projects", visible: "projects" },
  company: { target: "team", page: "company", visible: "company" },
  knowledge: { target: "knowledge", page: "knowledge", visible: "knowledge" },
  brain: { target: "knowledge", page: "brain", visible: "brain" },
  // Analytics and Missions left the rail. Stored values stay readable and open Home.
  usage: { target: "home", page: "usage", visible: "overview" },
  missions: { target: "home", page: "missions", visible: "overview" },
  board: { target: null, page: "board", visible: "board" },
  browser: { target: "tools", page: "browser", visible: "browser" },
  "native-computer": { target: "tools", page: "native-computer", visible: "native-computer" },
};

test("historical stored destinations keep their page id and resolve to the new destination", () => {
  for (const [stored, expected] of Object.entries(HISTORICAL)) {
    const storage = { getItem: (key: string) => key === WORKSPACE_STORAGE_KEY ? JSON.stringify({ scope: "all", page: stored }) : null, setItem: () => {} };
    const selection = readWorkspace(storage);
    expect(selection).toEqual({ scope: "all", page: expected.page });
    expect(visibleWorkspacePage(selection)).toBe(expected.visible);
    expect(navTargetFor(selection)).toBe(expected.target);
  }
});

test("project-only pages stored on the global scope fall back to Home", () => {
  for (const page of ["estimates", "environment", "manager", "settings"] as const) {
    expect(visibleWorkspacePage({ scope: "all", page })).toBe("overview");
    expect(navTargetFor({ scope: "all", page })).toBe("home");
  }
});

test("an unknown stored page is rejected instead of opening something unrelated", () => {
  expect(parseWorkspace({ scope: "all", page: "insights" })).toBeNull();
  expect(parseWorkspace({ scope: "all", page: "home" })).toBeNull();
  expect(parseWorkspace({ scope: "all", page: "projects" })).toEqual({ scope: "all", page: "projects" });
});

test("a project and a space belong to Workspaces, and project analytics stays on the project", () => {
  const pages: WorkspacePage[] = ["overview", "board", "usage", "estimates", "environment", "manager", "settings", "knowledge", "brain"];
  for (const page of pages) expect(navTargetFor({ scope: "project", path: "/work/alpha", page })).toBe("workspaces");
  expect(visibleWorkspacePage({ scope: "project", path: "/work/alpha", page: "usage" })).toBe("usage");
  expect(navTargetFor({ scope: "cluster", id: "c1", page: "clusters" })).toBe("workspaces");
  expect(visibleWorkspacePage({ scope: "project", path: "/work/alpha", page: "projects" })).toBe("overview");
});

test("merged destinations expose their pages as tabs", () => {
  const ids = (selection: WorkspaceSelection) => sectionTabsFor(selection)?.tabs.map((tab) => tab.testId);
  expect(ids({ scope: "all", page: "projects" })).toEqual(["projects-tab-directory", "workspace-portfolio"]);
  expect(sectionTabsFor({ scope: "all", page: "portfolio" })?.current).toBe("portfolio");
  expect(sectionTabsFor({ scope: "cluster", id: "c1", page: "clusters" })).toBeNull();
  expect(sectionTabsFor({ scope: "all", page: "clusters" })).toBeNull();
  expect(ids({ scope: "all", page: "knowledge" })).toEqual(["knowledge-tab-notes", "workspace-brain"]);
  expect(sectionTabsFor({ scope: "all", page: "brain" })).toMatchObject({ group: "knowledge", current: "brain" });
  expect(ids({ scope: "all", page: "browser" })).toEqual(["workspace-browser", "workspace-native-computer"]);
  expect(sectionTabsFor({ scope: "all", page: "native-computer" })).toMatchObject({ group: "tools", current: "native-computer" });
});

test("standalone pages and project workspaces have no section tabs", () => {
  for (const page of ["overview", "attention", "board", "company"] as const) {
    expect(sectionTabsFor({ scope: "all", page })).toBeNull();
  }
  expect(sectionTabsFor({ scope: "project", path: "/work/alpha", page: "knowledge" })).toBeNull();
  expect(sectionTabsFor({ scope: "project", path: "/work/alpha", page: "usage" })).toBeNull();
});
