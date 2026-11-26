import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { ProjectSidebar } from "../ProjectSidebar";
import { SectionTabs } from "../SectionTabs";
import { navTargetFor, sectionTabsFor } from "@/lib/navigation";
import type { Project } from "../../../../shared/types.ts";
import { visibleWorkspacePage } from "@/lib/workspace";
import { NativeComputerUse } from "./NativeComputerUse";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

const project = { path: "/Users/qa/alpha", name: "Alpha", addedAt: 1 } as Project;

test("native computer page distinguishes owner control from unavailable agent control in English and Russian", async () => {
  const english = renderToStaticMarkup(
    <LocaleProvider>
      <NativeComputerUse />
    </LocaleProvider>,
  );
  expect(english).toContain('data-testid="native-page"');
  expect(english).toContain('data-testid="native-start"');
  expect(english).toContain('data-testid="native-agent-unavailable"');
  expect(english).toContain("Owner-controlled native session");
  expect(english).toContain("The manager cannot control the computer on its own.");
  expect(english).toContain("Checking macOS permissions…");
  expect(english).not.toContain('data-testid="native-agent-start"');

  await choose("ru");
  const russian = renderToStaticMarkup(
    <LocaleProvider>
      <NativeComputerUse />
    </LocaleProvider>,
  );
  expect(russian).toContain("Нативный сеанс под управлением владельца");
  expect(russian).toContain("Самостоятельно менеджер не управляет компьютером.");
  expect(russian).toContain("Проверка разрешений macOS…");
  expect(russian).not.toContain("Owner-controlled native session");

  const sidebar = renderToStaticMarkup(
    <LocaleProvider>
      <ProjectSidebar
        projects={[project]}
        selection={{ scope: "all", page: "native-computer" }}
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
      <SectionTabs model={sectionTabsFor({ scope: "all", page: "native-computer" })!} onSelect={() => {}} />
    </LocaleProvider>,
  );
  // M3: Native Computer left the rail; it is a Settings tool with its own tab strip.
  expect(sidebar).not.toContain('data-testid="workspace-native-computer"');
  expect(navTargetFor({ scope: "all", page: "native-computer" })).toBe("tools");
  expect(tabs).toContain('data-testid="workspace-native-computer"');
  expect(tabs).toContain("Нативный компьютер");
  expect(visibleWorkspacePage({ scope: "all", page: "native-computer" })).toBe("native-computer");
  expect(visibleWorkspacePage({ scope: "project", path: project.path, page: "native-computer" })).toBe("overview");
});
