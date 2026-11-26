import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { ProjectSidebar } from "../ProjectSidebar";
import { SectionTabs } from "../SectionTabs";
import { navTargetFor, sectionTabsFor } from "@/lib/navigation";
import type { Project } from "../../../../shared/types.ts";
import { visibleWorkspacePage } from "@/lib/workspace";
import { BrowserComputerUse } from "./BrowserComputerUse";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

const project = { path: "/Users/qa/alpha", name: "Alpha", addedAt: 1 } as Project;

test("browser page distinguishes owner control from unavailable agent control in English and Russian", async () => {
  const english = renderToStaticMarkup(
    <LocaleProvider>
      <BrowserComputerUse />
    </LocaleProvider>,
  );
  expect(english).toContain('data-testid="browser-page"');
  expect(english).toContain('data-testid="browser-start"');
  expect(english).toContain('data-testid="browser-agent-unavailable"');
  expect(english).toContain("Start browser session");
  expect(english).toContain("The manager cannot browse on its own.");
  expect(english).not.toContain('data-testid="browser-agent-start"');

  await choose("ru");
  const russian = renderToStaticMarkup(
    <LocaleProvider>
      <BrowserComputerUse />
    </LocaleProvider>,
  );
  expect(russian).toContain("Начать сеанс браузера");
  expect(russian).toContain("Самостоятельно менеджер не просматривает страницы.");
  expect(russian).toContain("Нет сеанса");
  expect(russian).not.toContain("Start browser session");

  const sidebar = renderToStaticMarkup(
    <LocaleProvider>
      <ProjectSidebar
        projects={[project]}
        selection={{ scope: "all", page: "browser" }}
        collapsed={false}
        onCollapsedChange={() => {}}
        active="tools"
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
      <SectionTabs model={sectionTabsFor({ scope: "all", page: "browser" })!} onSelect={() => {}} />
    </LocaleProvider>,
  );
  // M3: Browser left the rail; it is a Settings tool with its own tab strip.
  expect(sidebar).not.toContain('data-testid="workspace-browser"');
  expect(navTargetFor({ scope: "all", page: "browser" })).toBe("tools");
  expect(tabs).toContain('data-testid="workspace-browser"');
  expect(tabs).toContain("Браузер");
  expect(visibleWorkspacePage({ scope: "all", page: "browser" })).toBe("browser");
  expect(visibleWorkspacePage({ scope: "project", path: project.path, page: "browser" })).toBe("overview");
});

test("the browser page follows a session that a manager moved, without replacing the page observation on every tick", () => {
  // Direction 19: the page used to keep showing the old title, text and screenshot after a granted manager action.
  // There is no DOM here, so the rule is pinned in the source: poll the session view, and read a new observation only
  // when the address, the state or the history changed (reading one replaces the id an Owner grant is bound to).
  const source = readFileSync(path.join(import.meta.dir, "BrowserComputerUse.tsx"), "utf8");
  expect(source).toContain("window.setInterval");
  expect(source).toContain("api.browserSession(shown.id)");
  expect(source).toContain('next.state !== "active" || next.url !== (observation?.url ?? shown.url) || next.history.length !== shown.history.length');
  expect(source).toContain("if (!moved) return;");
  expect(source.match(/api\.browserObservation\(/g)?.length).toBe(1);
});
