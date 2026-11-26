import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import type { ProjectLifecycleSnapshot } from "../../../shared/project-lifecycle.ts";
import type { Project } from "../../../shared/types.ts";
import { lifecycleActionFor, ProjectHeader } from "./ProjectHeader";
import { ProjectSidebar } from "./ProjectSidebar";
import { ProjectDirectoryList } from "./WorkspaceOverview";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

function makeSnapshot(overrides: Partial<ProjectLifecycleSnapshot> = {}): ProjectLifecycleSnapshot {
  return {
    projectPath: "/Users/qa/proj-alpha",
    state: "running",
    persistedState: "running",
    launchesBlocked: false,
    waitingForActiveWork: false,
    activeExecutions: 0,
    activeBreakdown: { taskRuns: 0, managerTurns: 0, interviewTurns: 0 },
    canStart: false,
    canStop: true,
    startUnavailableCode: "already-running",
    startUnavailableReason: "Project is already running.",
    stopUnavailableCode: null,
    stopUnavailableReason: null,
    blockerReason: null,
    updatedAt: 1700000000000,
    reason: null,
    ...overrides,
  };
}

function makeProject(lifecycle: ProjectLifecycleSnapshot): Project {
  return {
    path: lifecycle.projectPath,
    name: "Alpha",
    addedAt: 1700000000000,
    branchConfig: null,
    lifecycle,
  };
}

describe("Project lifecycle Owner UI & EN/RU localization", () => {
  test("renders Running state with Start disabled and Stop enabled", () => {
    const project = makeProject(makeSnapshot());
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectHeader
          project={project}
          page="board"
          homeDir="/Users/qa"
          onPageChange={() => {}}
          onNewTask={() => {}}
          onOpenCluster={() => {}}
        />
      </LocaleProvider>,
    );
    expect(html).toContain('data-testid="project-lifecycle-bar"');
    expect(html).toContain('data-state="running"');
    expect(html).toContain("Open for work");
    expect(html).not.toContain('data-testid="project-lifecycle-launches-blocked"');
    // One primary action, chosen from the state: Stop is offered and enabled, Start is not shown.
    expect(html).toContain('data-testid="project-lifecycle-stop"');
    expect(html).not.toContain('data-testid="project-lifecycle-start"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="project-lifecycle-stop"/);
    expect(html).not.toContain('data-testid="project-lifecycle-unavailable-reason"');
  });

  test("renders Draining state with active execution count, waiting notice, blocked launches, and both controls disabled", () => {
    const project = makeProject(makeSnapshot({
      state: "draining",
      persistedState: "draining",
      launchesBlocked: true,
      waitingForActiveWork: true,
      activeExecutions: 2,
      activeBreakdown: { taskRuns: 2, managerTurns: 0, interviewTurns: 0 },
      canStart: false,
      canStop: false,
      startUnavailableCode: "draining-active-work",
      stopUnavailableCode: "already-draining",
    }));
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectHeader
          project={project}
          page="overview"
          homeDir="/Users/qa"
          onPageChange={() => {}}
          onNewTask={() => {}}
          onOpenCluster={() => {}}
        />
      </LocaleProvider>,
    );
    expect(html).toContain('data-state="draining"');
    // Draining reads as stopping with the count, never as Paused.
    expect(html).toContain("Stopping — 2 still finishing");
    expect(html).not.toContain("Paused");
    expect(html).toContain("Stopping…");
    expect(html).toContain("Stop already requested — waiting for 2 active AI execution(s) to finish.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="project-lifecycle-stop"/);
    expect(html).not.toContain('data-testid="project-lifecycle-start"');
  });

  test("renders Paused and Invalid states in Russian and badges non-running projects in Sidebar and Overview", async () => {
    await choose("ru");
    const pausedProject = makeProject(makeSnapshot({
      state: "paused",
      persistedState: "paused",
      launchesBlocked: true,
      canStart: true,
      canStop: false,
      startUnavailableCode: null,
      stopUnavailableCode: "already-paused",
    }));
    const headerHtml = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectHeader
          project={pausedProject}
          page="manager"
          homeDir="/Users/qa"
          onPageChange={() => {}}
          onNewTask={() => {}}
          onOpenCluster={() => {}}
        />
      </LocaleProvider>,
    );
    expect(headerHtml).toContain('data-state="paused"');
    expect(headerHtml).toContain("Приостановлен — новые запуски ИИ не стартуют");
    expect(headerHtml).toContain('data-testid="project-lifecycle-start"');
    expect(headerHtml).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="project-lifecycle-start"/);
    expect(headerHtml).not.toContain('data-testid="project-lifecycle-stop"');

    const sidebarHtml = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectSidebar
          projects={[pausedProject]}
          selection={{ scope: "all", page: "overview" }}
          collapsed={false}
          onCollapsedChange={() => {}}
          activity={new Map()}
          attentionCount={0}
          active="home"
          onNavigate={() => {}}
          onOpenSettings={() => {}}
          onOpenProject={() => {}}
          onAddFolder={() => {}}
          onProjectsChanged={() => {}}
        />
      </LocaleProvider>,
    );
    expect(sidebarHtml).toContain('data-testid="project-nav-lifecycle-badge"');
    expect(sidebarHtml).toContain("Приостановлен");

    const overviewHtml = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectDirectoryList
          projects={[pausedProject]}
          summaries={new Map()}
          homeDir="/Users/qa"
          onOpenProject={() => {}}
          onAddFolder={() => {}}
        />
      </LocaleProvider>,
    );
    expect(overviewHtml).toContain('data-testid="overview-project-lifecycle-badge"');
    expect(overviewHtml).toContain("Приостановлен");

    const invalidProject = makeProject(makeSnapshot({
      state: "invalid",
      persistedState: "corrupt",
      launchesBlocked: true,
      canStart: false,
      canStop: true,
      startUnavailableCode: "invalid-state",
      stopUnavailableCode: null,
    }));
    const invalidHtml = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectHeader
          project={invalidProject}
          page="board"
          homeDir="/Users/qa"
          onPageChange={() => {}}
          onNewTask={() => {}}
          onOpenCluster={() => {}}
        />
      </LocaleProvider>,
    );
    expect(invalidHtml).toContain('data-state="invalid"');
    expect(invalidHtml).toContain("Требует внимания");
  });

  test("lifecycle action follows the real state and keeps disabled reasons", () => {
    expect(lifecycleActionFor(makeSnapshot())).toMatchObject({ kind: "stop", enabled: true });
    expect(lifecycleActionFor(makeSnapshot({ state: "paused", canStart: true, canStop: false }))).toMatchObject({ kind: "start", enabled: true });
    const draining = lifecycleActionFor(makeSnapshot({ state: "draining", canStart: false, canStop: false, activeExecutions: 3, startUnavailableCode: "draining-active-work", stopUnavailableCode: "already-draining" }));
    expect(draining).toMatchObject({ kind: "stop", enabled: false, draining: true });
    expect(draining.reason).toContain("3");
    const recovering = lifecycleActionFor(makeSnapshot({ state: "recovering", canStart: false, canStop: false, startUnavailableCode: "recovering", stopUnavailableCode: null }));
    expect(recovering).toMatchObject({ kind: "start", enabled: false });
    expect(recovering.reason).toBeTruthy();
  });

  test("project header keeps Ask Head of PM and New Task, and moves the folder path into Details", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <ProjectHeader
          project={makeProject(makeSnapshot())}
          page="overview"
          homeDir="/Users/qa"
          onPageChange={() => {}}
          onOpenHead={() => {}}
          onNewTask={() => {}}
          onOpenCluster={() => {}}
        />
      </LocaleProvider>,
    );
    expect(html).toContain('data-testid="project-open-head-pm"');
    expect(html).toContain("Ask Head of PM");
    expect(html).toContain('data-testid="project-new-task"');
    expect(html).toContain('data-testid="project-header-details-toggle"');
    expect(html).not.toContain('data-testid="project-header-path"');
    expect(html).toContain('data-testid="project-page-team"');
  });
});
