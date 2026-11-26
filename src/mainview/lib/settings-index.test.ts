import { afterEach, describe, expect, test } from "bun:test";
import { localeStore, t as tr, type TranslationKey } from "@/i18n/core";
import {
  LEGACY_SECTION_IDS,
  LEGACY_SECTION_TARGETS,
  SETTINGS_SECTIONS,
  SETTINGS_SUBSECTIONS,
  openSection,
  sectionOfSubsection,
} from "./settings-dialog-view";
import { SETTINGS_INDEX, searchSettings } from "./settings-index";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(() => choose("en"));
const t = (key: TranslationKey) => tr(key);

describe("old-to-new reachability", () => {
  test("every pre-M4 section id resolves to a real section and panel", () => {
    for (const id of LEGACY_SECTION_IDS) {
      const target = LEGACY_SECTION_TARGETS[id];
      expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain(target.section);
      expect(sectionOfSubsection(target.anchor)).toBe(target.section);
      expect(openSection(id)).toEqual({ kind: "section", section: target.section, anchor: target.anchor });
    }
  });

  test("every panel is findable from the search index", () => {
    const anchors = new Set(SETTINGS_INDEX.map((entry) => entry.anchor));
    for (const sub of SETTINGS_SUBSECTIONS) expect(anchors.has(sub.id)).toBe(true);
  });

  test("index ids are unique and every entry names a panel", () => {
    const ids = SETTINGS_INDEX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of SETTINGS_INDEX) expect(SETTINGS_SUBSECTIONS.some((s) => s.id === entry.anchor)).toBe(true);
  });

  test("every label and description resolves to text in both languages", async () => {
    for (const locale of ["en", "ru"] as const) {
      await choose(locale);
      for (const entry of SETTINGS_INDEX) {
        for (const key of [entry.label, entry.description, ...(entry.keywords ?? [])]) {
          if (!key) continue;
          const text = tr(key);
          expect(text.length).toBeGreaterThan(0);
          // A missing key renders as the key itself.
          expect(text).not.toBe(key);
        }
      }
    }
  });
});

describe("searchSettings", () => {
  test("an empty query returns nothing", () => {
    expect(searchSettings("", t)).toEqual([]);
    expect(searchSettings("   ", t)).toEqual([]);
  });

  test("finds a control by its label and reports its new home", () => {
    const [first] = searchSettings("theme", t);
    expect(first?.entry.id).toBe("theme");
    expect(first?.section).toBe("general");
  });

  test("finds moved settings in their new section", () => {
    expect(searchSettings("technical", t).map((r) => [r.entry.id, r.section])).toContainEqual(["technical_details", "advanced"]);
    expect(searchSettings("emergency", t).map((r) => r.entry.id)).toContain("emergency_stop");
    expect(searchSettings("owner", t).map((r) => r.section)).toContain("autonomy");
    expect(searchSettings("self-improvement", t).map((r) => r.section)).toContain("advanced");
  });

  test("matches descriptions and every token must match", () => {
    expect(searchSettings("getting-started block", t).map((r) => r.entry.id)).toContain("getting_started");
    expect(searchSettings("theme zzzz", t)).toEqual([]);
  });

  test("a label hit outranks a description-only hit", () => {
    const results = searchSettings("density", t).map((r) => r.entry.id);
    expect(results[0]).toBe("density");
  });

  test("works in Russian and never matches a stored value", async () => {
    await choose("ru");
    const ru = (key: TranslationKey) => tr(key);
    expect(searchSettings("тема", ru, "ru").map((r) => r.entry.id)).toContain("theme");
    expect(searchSettings("sk-ant-secret", ru, "ru")).toEqual([]);
  });
});
