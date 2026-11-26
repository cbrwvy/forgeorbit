import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LocaleProvider } from "../../i18n/react";
import { localeStore, translate } from "../../i18n/core";
import { SearchSelect } from "./search-select";
import { MultiSearchSelect } from "./multi-search-select";
import { TaskLaunchPickers, type TaskLaunch } from "../kanban/TaskLaunchPickers";
import { USER_MD_COMPONENTS, ASSISTANT_MD_COMPONENTS } from "../kanban/md-components";

afterEach(async () => { await localeStore.choose("en", async () => {}); });

test("closed pickers expose popup state and preserve disabled controls", () => {
  for (const disabled of [false, true]) {
    const html = renderToStaticMarkup(<LocaleProvider>
      <SearchSelect value="p" onChange={() => { throw Error("render cannot select"); }} items={[{ value: "p", label: "Original project" }]} disabled={disabled} />
      <MultiSearchSelect values={[]} onChange={() => { throw Error("render cannot select"); }} items={[]} emptyLabel="All types" disabled={disabled} />
    </LocaleProvider>);
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(2);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain("Original project");
    expect((html.match(/ disabled=""/g) ?? []).length).toBe(disabled ? 2 : 0);
  }
});

test.each(["en", "ru"] as const)("%s launch form labels resolve to unique controls and retain the selected harness", async locale => {
  await localeStore.choose(locale, async () => {});
  const launch = {
    harnesses: [], availableHarnesses: [{ id: "claude-code", kind: "claude-code", label: "Claude Code" }, { id: "antigravity", kind: "antigravity", label: "Antigravity" }],
    agents: [], agent: "claude-code", kind: "claude-code", mode: "auto", modes: [{ id: "auto", label: "Auto" }],
    model: "opus", models: [{ id: "opus", label: "Opus" }], effort: null, efforts: [], profiles: [], selectedProfile: null,
  } as unknown as TaskLaunch;
  const html = renderToStaticMarkup(<LocaleProvider><TaskLaunchPickers launch={launch} hideProfilePicker /><TaskLaunchPickers launch={launch} hideProfilePicker /></LocaleProvider>);
  const labels = [...html.matchAll(/<label for="([^"]+)"[^>]*>(.*?)<\/label>/g)];
  expect(labels).toHaveLength(6);
  expect(new Set(labels.map(match => match[1])).size).toBe(6);
  const controlIds = [...html.matchAll(/<select\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  expect(controlIds.sort()).toEqual(labels.map(match => match[1]).sort());
  for (const key of ["common.mode", "common.model", "common.effort"] as const) expect(html).toContain(translate(locale, key));
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
  expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
});

test.each(["en", "ru"] as const)("%s user and assistant Markdown tables preserve content and expose a named keyboard scroll region", async locale => {
  await localeStore.choose(locale, async () => {});
  for (const components of [USER_MD_COMPONENTS, ASSISTANT_MD_COMPONENTS]) {
    const html = renderToStaticMarkup(<LocaleProvider><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{"| Original identifier | Value |\n| --- | --- |\n| a_b_c | 42 |"}</ReactMarkdown></LocaleProvider>);
    expect(html).toContain('role="region"');
    expect(html).toContain(`aria-label="${translate(locale, "common.scrollable_table")}"`);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>a_b_c</td>");
    expect(html).toContain("<td>42</td>");
  }
});
