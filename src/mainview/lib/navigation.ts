/**
 * Global navigation: Home, Workspaces, AI Team and Knowledge, plus Settings.
 *
 * Workspaces is the user-facing name of a cluster. Projects and tasks are reached
 * by opening a space, then a project board. Analytics is a tab on that board.
 * Execution plans live in Settings. Stored `agetor:workspace` page ids are still
 * valid; this module only decides which rail item owns a page.
 */
import { visibleWorkspacePage, type WorkspacePage, type WorkspaceSelection } from "./workspace.ts";

export type PrimaryNav = "home" | "workspaces" | "team" | "knowledge";
/** `tools` is Browser / Native Computer: reached from Settings, not a rail item. */
export type NavTarget = PrimaryNav | "tools";

export interface PrimaryNavItem {
  id: PrimaryNav;
  /** Page the rail item opens (always the global scope). */
  page: WorkspacePage;
  /** The rail test id. Six are the pre-M3 ids of the same pages. */
  testId: string;
  labelKey: `nav.${PrimaryNav}`;
}

export const PRIMARY_NAV: readonly PrimaryNavItem[] = [
  { id: "home", page: "overview", testId: "workspace-overview", labelKey: "nav.home" },
  { id: "workspaces", page: "clusters", testId: "workspace-workspaces", labelKey: "nav.workspaces" },
  { id: "team", page: "company", testId: "workspace-company", labelKey: "nav.team" },
  { id: "knowledge", page: "knowledge", testId: "workspace-knowledge", labelKey: "nav.knowledge" },
];

const GLOBAL_PAGE_TARGET: Record<WorkspacePage, NavTarget | null> = {
  overview: "home",
  attention: "home",
  projects: "workspaces",
  portfolio: "workspaces",
  clusters: "workspaces",
  // The global task board is no longer a rail item. A stored value can still open it.
  board: null,
  // Execution plans moved to Settings. A stored missions page is shown as Home.
  missions: null,
  company: "team",
  knowledge: "knowledge",
  brain: "knowledge",
  // Company-wide Analytics left the rail. A project board owns its Analytics tab.
  usage: null,
  browser: "tools",
  "native-computer": "tools",
  estimates: "home",
  environment: "home",
  manager: "home",
  settings: "home",
  recurring: "home",
  team: "home",
};

/** The destination that owns the selection. A project and a space both belong
 *  to Workspaces. Pages that left the rail return null. */
export function navTargetFor(selection: WorkspaceSelection): NavTarget | null {
  if (selection.scope === "project" || selection.scope === "cluster") return "workspaces";
  return GLOBAL_PAGE_TARGET[visibleWorkspacePage(selection)];
}

export type SectionGroup = "projects" | "knowledge" | "tools";

export interface SectionTab {
  page: WorkspacePage;
  /** Tabs that were rail items before M3 keep that rail test id. */
  testId: string;
  labelKey: string;
}

const SECTION_TABS: Record<SectionGroup, readonly SectionTab[]> = {
  projects: [
    { page: "projects", testId: "projects-tab-directory", labelKey: "nav.tab.directory" },
    { page: "portfolio", testId: "workspace-portfolio", labelKey: "nav.tab.portfolio" },
  ],
  knowledge: [
    { page: "knowledge", testId: "knowledge-tab-notes", labelKey: "nav.tab.notes" },
    { page: "brain", testId: "workspace-brain", labelKey: "nav.tab.memory" },
  ],
  tools: [
    { page: "browser", testId: "workspace-browser", labelKey: "nav.tab.browser" },
    { page: "native-computer", testId: "workspace-native-computer", labelKey: "nav.tab.native" },
  ],
};

export interface SectionTabs {
  group: SectionGroup;
  tabs: readonly SectionTab[];
  /** Page of the selected tab. A cluster dashboard selects the groups tab. */
  current: WorkspacePage;
}

/** In-page tabs of a merged destination; null where the page stands alone, on a
 *  space dashboard, or in a project (which has its own tab strip). */
export function sectionTabsFor(selection: WorkspaceSelection): SectionTabs | null {
  if (selection.scope === "project" || selection.scope === "cluster") return null;
  const page = visibleWorkspacePage(selection);
  for (const group of ["projects", "knowledge", "tools"] as const) {
    const tabs = SECTION_TABS[group];
    if (tabs.some((tab) => tab.page === page)) return { group, tabs, current: page };
  }
  return null;
}

/**
 * Project workspace tabs (FO-UX-SIMPLIFY02-M5): four primary tabs plus a "More"
 * menu. No page id was removed or renamed — `estimates`, `environment`,
 * `knowledge`, `brain`, `settings` and `manager` are the same ids as before, so a
 * stored `agetor:workspace` value, a deep link or a notification opens the same
 * screen. This only decides which tab owns a page.
 *
 * Old → new:
 *   overview            → Overview                       (unchanged)
 *   board               → Tasks                          (was "Board")
 *   usage               → Analytics                      (project-scoped; was a global rail item)
 *   manager             → Plan and Execution             (unchanged page, same label)
 *   (new) team          → Team                           (project team + assignment/hiring proposals; was inside Overview)
 *   estimates           → More ▸ Estimates
 *   environment         → More ▸ Environment
 *   knowledge           → More ▸ Notes                   (project Knowledge; not Memory)
 *   brain               → More ▸ Memory                  (project Brain; separate consent flow)
 *   settings            → More ▸ Project rules
 *   Head of PM button   → header "Ask Head of PM"        (opens the dock scoped to this project)
 */
export type ProjectTab = "overview" | "board" | "usage" | "manager" | "team" | "more";

export const PROJECT_PRIMARY_TABS: readonly { tab: Exclude<ProjectTab, "more">; page: WorkspacePage; testId: string; labelKey: string }[] = [
  { tab: "overview", page: "overview", testId: "project-page-overview", labelKey: "common.overview" },
  { tab: "board", page: "board", testId: "project-page-board", labelKey: "nav.tasks" },
  { tab: "usage", page: "usage", testId: "project-page-analytics", labelKey: "nav.analytics" },
  { tab: "manager", page: "manager", testId: "project-page-manager", labelKey: "headPm.unified.legacy" },
  { tab: "team", page: "team", testId: "project-page-team", labelKey: "m5.tab.team" },
];

/** Pages reachable from the More menu. Test ids are the pre-M5 tab ids. */
export const PROJECT_MORE_PAGES: readonly { page: WorkspacePage; testId: string; labelKey: string; accessibleLabelKey?: string }[] = [
  { page: "recurring", testId: "project-page-recurring", labelKey: "kanban.recurring.nav" },
  { page: "estimates", testId: "project-page-estimates", labelKey: "common.estimates" },
  { page: "environment", testId: "project-page-environment", labelKey: "common.environment" },
  { page: "knowledge", testId: "project-page-knowledge", labelKey: "nav.tab.notes" },
  { page: "brain", testId: "project-page-brain", labelKey: "nav.tab.memory", accessibleLabelKey: "brain.project_nav" },
  { page: "settings", testId: "project-page-settings", labelKey: "m5.more.rules" },
];

/** The tab that owns a project page. Pages outside the project set read as Overview. */
export function projectTabFor(page: WorkspacePage): ProjectTab {
  switch (page) {
    case "board":
    case "usage":
    case "manager":
    case "team":
      return page;
    case "recurring":
    case "estimates":
    case "environment":
    case "knowledge":
    case "brain":
    case "settings":
      return "more";
    default:
      return "overview";
  }
}

export function isMorePage(page: WorkspacePage): boolean {
  return projectTabFor(page) === "more";
}
