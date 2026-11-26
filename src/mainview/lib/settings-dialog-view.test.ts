import { describe, expect, test } from "bun:test";
import {
  activeSection,
  backFromSubview,
  initialView,
  isFormSubpage,
  openAgentEditor,
  openEditor,
  openSection,
  openTemplates,
  resolveEscape,
  LEGACY_SECTION_IDS,
  resolveSection,
  SETTINGS_SECTIONS,
  SETTINGS_SUBSECTIONS,
  subsectionsOf,
  type PrimarySectionId,
  type SettingsView,
} from "./settings-dialog-view.ts";
import type { HarnessTemplate } from "../../shared/types.ts";

function template(overrides: Partial<HarnessTemplate> = {}): HarnessTemplate {
  return {
    id: "claude-code-additional",
    label: "Additional Claude Code",
    description: "Another claude-code harness with its own CLAUDE_CONFIG_DIR.",
    kind: "claude-code",
    suggestedHarnessId: "claude-2",
    home: "{dataDir}/harnesses/claude-2",
    bin: null,
    env: {},
    ...overrides,
  };
}

const SECTION_IDS: PrimarySectionId[] = ["general", "providers", "autonomy", "plans", "tools", "library", "advanced"];

test("SETTINGS_SECTIONS lists the sidebar sections in order", () => {
  expect(SETTINGS_SECTIONS).toEqual([
    { id: "general", label: "General" },
    { id: "providers", label: "AI providers and accounts" },
    { id: "autonomy", label: "Autonomy and safety" },
    { id: "plans", label: "Execution plans" },
    { id: "tools", label: "Tools and access" },
    { id: "library", label: "Library" },
    { id: "advanced", label: "Advanced" },
  ]);
});

describe("legacy section ids", () => {
  const expected = {
    harnesses: { section: "providers", anchor: "harnesses" },
    accounts: { section: "providers", anchor: "accounts" },
    ai_router: { section: "providers", anchor: "ai_router" },
    agents: { section: "library", anchor: "agents" },
    pipelines: { section: "library", anchor: "pipelines" },
    git: { section: "tools", anchor: "git" },
    prompts: { section: "library", anchor: "prompts" },
    backup: { section: "advanced", anchor: "backup" },
  } as const;
  for (const id of LEGACY_SECTION_IDS) {
    test(`${id} still opens, on its new section and panel`, () => {
      expect(resolveSection(id)).toEqual(expected[id]);
      expect(openSection(id)).toEqual({ kind: "section", ...expected[id] });
      expect(activeSection(openSection(id))).toBe(expected[id].section);
    });
  }
  test("every subsection belongs to a real section, once", () => {
    const ids = SETTINGS_SUBSECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sub of SETTINGS_SUBSECTIONS) expect(SECTION_IDS).toContain(sub.section);
    for (const section of SECTION_IDS) expect(subsectionsOf(section).length).toBeGreaterThan(0);
  });
  test("an explicit anchor wins over the one a legacy id implies", () => {
    expect(openSection("autonomy", "owner_trust")).toEqual({ kind: "section", section: "autonomy", anchor: "owner_trust" });
  });
});

test("initialView opens on the General section", () => {
  expect(initialView()).toEqual({ kind: "section", section: "general" });
});

describe("openSection", () => {
  for (const id of SECTION_IDS) {
    test(`opens the ${id} section`, () => {
      expect(openSection(id)).toEqual({ kind: "section", section: id });
    });
  }
});

describe("openTemplates", () => {
  test("opens the templates picker view", () => {
    expect(openTemplates()).toEqual({ kind: "templates" });
  });
});

describe("openEditor", () => {
  test("opens the editor for a new harness (null id) with the template payload", () => {
    const tpl = template();
    expect(openEditor(null, tpl)).toEqual({ kind: "editor", harnessId: null, template: tpl });
  });

  test("opens the editor for an existing harness id with the template payload", () => {
    const tpl = template({ id: "codex-additional", kind: "codex", suggestedHarnessId: "codex-2" });
    expect(openEditor("codex-2", tpl)).toEqual({
      kind: "editor",
      harnessId: "codex-2",
      template: tpl,
    });
  });
});

describe("openAgentEditor", () => {
  test("opens the editor for a new agent (null id)", () => {
    expect(openAgentEditor(null)).toEqual({ kind: "agent-editor", profileId: null, duplicateFromId: null });
  });

  test("duplicating carries the source id on a new agent", () => {
    expect(openAgentEditor(null, "prof-1")).toEqual({
      kind: "agent-editor",
      profileId: null,
      duplicateFromId: "prof-1",
    });
  });

  test("editing an existing agent forces duplicateFromId to null", () => {
    expect(openAgentEditor("prof-1", "other")).toEqual({
      kind: "agent-editor",
      profileId: "prof-1",
      duplicateFromId: null,
    });
  });

  test("opens the editor for an existing agent id", () => {
    expect(openAgentEditor("prof-1")).toEqual({ kind: "agent-editor", profileId: "prof-1", duplicateFromId: null });
  });
});

describe("backFromSubview", () => {
  test("the templates view returns the Harnesses section", () => {
    expect(backFromSubview(openTemplates())).toEqual({ kind: "section", section: "providers", anchor: "harnesses" });
  });

  test("the harness editor view returns the Harnesses section", () => {
    expect(backFromSubview(openEditor(null, template()))).toEqual({ kind: "section", section: "providers", anchor: "harnesses" });
  });

  test("the agent editor view returns the Agents section (create and edit)", () => {
    expect(backFromSubview(openAgentEditor(null))).toEqual({ kind: "section", section: "library", anchor: "agents" });
    expect(backFromSubview(openAgentEditor("prof-1"))).toEqual({ kind: "section", section: "library", anchor: "agents" });
    expect(backFromSubview(openAgentEditor(null, "prof-1"))).toEqual({ kind: "section", section: "library", anchor: "agents" });
  });

  for (const id of SECTION_IDS) {
    test(`a ${id} section view returns itself`, () => {
      expect(backFromSubview(openSection(id))).toEqual(openSection(id));
    });
  }
});

describe("activeSection", () => {
  for (const id of SECTION_IDS) {
    test(`a ${id} section view highlights itself`, () => {
      expect(activeSection(openSection(id))).toBe(id);
    });
  }

  test("the templates view highlights AI providers", () => {
    expect(activeSection(openTemplates())).toBe("providers");
  });

  test("the editor view highlights AI providers", () => {
    expect(activeSection(openEditor(null, template()))).toBe("providers");
  });

  test("the agent editor view highlights Library", () => {
    expect(activeSection(openAgentEditor(null))).toBe("library");
    expect(activeSection(openAgentEditor("prof-1"))).toBe("library");
  });
});

describe("resolveEscape", () => {
  for (const id of SECTION_IDS) {
    test(`closes the modal from the ${id} section view`, () => {
      expect(resolveEscape(openSection(id))).toBe("close");
    });
  }

  test("pops to Harnesses from the templates view", () => {
    expect(resolveEscape(openTemplates())).toBe("pop");
  });

  test("pops to Harnesses from the editor view", () => {
    expect(resolveEscape(openEditor("claude-2", template()))).toBe("pop");
  });

  test("pops to Agents from the agent editor view", () => {
    expect(resolveEscape(openAgentEditor(null))).toBe("pop");
    expect(resolveEscape(openAgentEditor("prof-1"))).toBe("pop");
  });
});

describe("isFormSubpage", () => {
  test("the harness editor and agent editor hold a draft", () => {
    expect(isFormSubpage(openEditor(null, template()))).toBe(true);
    expect(isFormSubpage(openAgentEditor(null))).toBe(true);
    expect(isFormSubpage(openAgentEditor("prof-1"))).toBe(true);
    expect(isFormSubpage(openAgentEditor(null, "prof-1"))).toBe(true);
  });

  test("the templates picker holds no draft", () => {
    expect(isFormSubpage(openTemplates())).toBe(false);
  });

  for (const id of SECTION_IDS) {
    test(`a ${id} section view is not a form subpage`, () => {
      expect(isFormSubpage(openSection(id))).toBe(false);
    });
  }
});

describe("round-trip conventions", () => {
  test("openSection(activeSection(v)) is idempotent for a primary section view", () => {
    const view = openSection("tools");
    expect(openSection(activeSection(view))).toEqual(view);
  });

  test("a subpage returns to the section (and panel) it was reached from", () => {
    for (const view of [openTemplates(), openEditor(null, template()), openAgentEditor("prof-1")] as SettingsView[]) {
      const back = backFromSubview(view);
      expect(back.kind === "section" && back.section).toBe(activeSection(view));
      expect(back.kind === "section" && back.anchor).toBeTruthy();
    }
  });
});
