import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { ProjectHeader } from "../ProjectHeader";
import { ProjectSidebar } from "../ProjectSidebar";
import { SectionTabs } from "../SectionTabs";
import { navTargetFor, PROJECT_MORE_PAGES, sectionTabsFor } from "@/lib/navigation";
import type { Project } from "../../../../shared/types.ts";
import { BrainBrowser } from "./BrainBrowser";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

const project = {
  path: "/Users/qa/alpha",
  name: "Alpha",
  addedAt: 1,
} as Project;

test("brain page renders an owner form in English and Russian", async () => {
  const english = renderToStaticMarkup(
    <LocaleProvider>
      <BrainBrowser scope={{ kind: "company" }} heading="Company memory" />
    </LocaleProvider>,
  );
  expect(english).toContain('data-testid="brain-page"');
  expect(english).toContain('data-testid="brain-title"');
  expect(english).toContain('data-testid="brain-save"');
  expect(english).toContain("Save memory");
  expect(english).toContain("do not replace project rules");

  await choose("ru");
  const russian = renderToStaticMarkup(
    <LocaleProvider>
      <BrainBrowser scope={{ kind: "project", projectPath: project.path }} heading="Память: Alpha" />
    </LocaleProvider>,
  );
  expect(russian).toContain("Сохранить запись");
  expect(russian).toContain("Показать память компании");
  expect(russian).toContain('data-testid="brain-inherit"');
  expect(russian).not.toContain("Save memory");
});

test("navigation exposes Brain without removing Knowledge", async () => {
  await choose("ru");
  const sidebar = renderToStaticMarkup(
    <LocaleProvider>
      <ProjectSidebar
        projects={[project]}
        selection={{ scope: "all", page: "brain" }}
        collapsed={false}
        onCollapsedChange={() => {}}
        active="knowledge"
        onNavigate={() => {}}
        onOpenSettings={() => {}}
        onOpenProject={() => {}}
        onAddFolder={() => {}}
        onProjectsChanged={() => {}}
      />
    </LocaleProvider>,
  );
  const tabs = renderToStaticMarkup(
    <LocaleProvider>
      <SectionTabs model={sectionTabsFor({ scope: "all", page: "brain" })!} onSelect={() => {}} />
    </LocaleProvider>,
  );
  // M3: one Knowledge destination on the rail; Notes and Memory are its two tabs.
  expect(sidebar).toContain('data-testid="workspace-knowledge"');
  expect(sidebar).not.toContain('data-testid="workspace-brain"');
  expect(navTargetFor({ scope: "all", page: "brain" })).toBe("knowledge");
  expect(tabs).toContain('data-testid="workspace-brain"');
  expect(tabs).toContain('data-testid="knowledge-tab-notes"');
  expect(tabs).toContain("Заметки");
  expect(tabs).toContain("Память");
  expect(sidebar).toContain("Знания");

  const header = renderToStaticMarkup(
    <LocaleProvider>
      <ProjectHeader
        project={project}
        page="brain"
        homeDir="/Users/qa"
        onPageChange={() => {}}
        onNewTask={() => {}}
        onOpenCluster={() => {}}
      />
    </LocaleProvider>,
  );
  // M5: Notes and Memory are separate entries of the project's More menu; with
  // Memory open the More button is the selected one and names it.
  expect(header).toContain('data-testid="project-more"');
  expect(header).toContain('data-current="true"');
  expect(header).toContain("Память");
  expect(PROJECT_MORE_PAGES.map((item) => item.testId)).toEqual(expect.arrayContaining(["project-page-knowledge", "project-page-brain"]));
});
