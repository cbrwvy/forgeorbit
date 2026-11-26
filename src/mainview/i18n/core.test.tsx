import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "./en";
import { ru } from "./ru";
import { LocaleProvider, I18nText } from "./react";
import { apiErrorText, codeLabel, evidenceLabel } from "./presentation";
import { countLabel, createLocaleStore, detectLocale, formatDate, formatNumber, formatRelative, localeStore, plural, t, translate } from "./core";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

describe("locale detection and existing preferences", () => {
  test.each([[["ru-RU"], "ru"], [["ru-UZ"], "ru"], [["RU"], "ru"], [["en-US"], "en"], [["fr-FR"], "en"], [[], "en"]] as const)("detects %j", (languages, expected) => { expect(detectLocale(languages)).toBe(expected); });
  test("explicit preference overrides system; unknown preference falls back", () => {
    const store = createLocaleStore("ru"); store.reconcile("en"); expect(store.getSnapshot()).toBe("en");
    store.reconcile("invalid"); expect(store.getSnapshot()).toBe("ru");
  });
  test("persists through the existing preference key and publishes immediately", async () => {
    const store = createLocaleStore("en"); const writes: string[][] = []; let notifications = 0;
    store.subscribe(() => notifications++);
    const saving = store.choose("ru", async (key, value) => { writes.push([key, value]); });
    expect(store.getSnapshot()).toBe("ru"); await saving;
    expect(writes).toEqual([["locale", "ru"]]); expect(notifications).toBe(1);
    const restarted = createLocaleStore("en"); restarted.reconcile(writes[0]![1]); expect(restarted.getSnapshot()).toBe("ru");
  });
  test("late boot preferences cannot undo an explicit selection", async () => {
    const store = createLocaleStore("ru"); await store.choose("en", async () => {}); store.reconcile("ru"); expect(store.getSnapshot()).toBe("en");
  });
  test("serializes rapid writes and restores the prior language on failure", async () => {
    const store = createLocaleStore("en"); const writes: string[] = []; let finish!: () => void;
    const first = store.choose("ru", async (_, value) => { writes.push(value); await new Promise<void>(resolve => { finish = resolve; }); });
    await Promise.resolve(); await Promise.resolve();
    const second = store.choose("en", async (_, value) => { writes.push(value); });
    finish(); await Promise.all([first, second]); expect(writes).toEqual(["ru", "en"]); expect(store.getSnapshot()).toBe("en");
    await expect(store.choose("ru", async () => { throw Error("offline"); })).rejects.toThrow("offline"); expect(store.getSnapshot()).toBe("en");
  });
});

test("English and Russian dictionaries have exact key parity and nonempty values", () => {
  expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  expect(Object.values(ru).every(value => typeof value === "string" && value.trim().length > 0)).toBe(true);
});
test("missing translation falls back to English; unknown keys stay visible", () => {
  expect(translate("ru", "settings.language", {}, {})).toBe("Language");
  expect(translate("en", "missing.key" as never, {}, {})).toBe("missing.key");
});
test("interpolation does not recursively evaluate supplied parameters", () => {
  expect(translate("ru", "activity.taskAssigned", { employee: "{count}<script>" })).toContain("{count}<script>");
});
test("React escapes HTML parameters as text", async () => {
  await choose("en");
  const markup = renderToStaticMarkup(createElement(LocaleProvider, null,
    createElement(I18nText, { id: "activity.taskAssigned", parameters: { employee: '<img src=x onerror="alert(1)">' } })));
  expect(markup).not.toContain("<img"); expect(markup).toContain("&lt;img");
});
test.each([[1,"one"],[2,"few"],[5,"many"],[11,"many"],[21,"one"],[22,"few"],[0,"many"],[1.5,"other"]] as const)("Russian plural %s", (n, expected) => {
  expect(plural("ru", n, {one:"one",few:"few",many:"many",other:"other"})).toBe(expected);
});
test("English plurals and Russian count rendering", async () => {
  expect(plural("en", 1, {one:"task",other:"tasks"})).toBe("task"); expect(plural("en", 2, {one:"task",other:"tasks"})).toBe("tasks");
  await choose("ru"); expect([1,2,5,21,22,25].map(n => countLabel(n,"task"))).toEqual(["1 задача","2 задачи","5 задач","21 задача","22 задачи","25 задач"]);
});
test.each([
  [1, "1 commit ahead", "Впереди на 1 коммит"],
  [2, "2 commits ahead", "Впереди на 2 коммита"],
  [5, "5 commits ahead", "Впереди на 5 коммитов"],
  [21, "21 commits ahead", "Впереди на 21 коммит"],
] as const)("commits ahead uses whole count labels for %s in EN/RU", async (count, english, russian) => {
  for (const [locale, expected] of [["en", english], ["ru", russian]] as const) {
    await choose(locale);
    expect(t("common.commit_ahead", { p0: countLabel(count, "commit") })).toBe(expected);
  }
});
test("date, number, relative time and timezone preservation", async () => {
  const stamp = Date.UTC(2026, 0, 12, 14, 35); const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await choose("ru"); expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat("ru-RU").format(1234.5));
  expect(formatDate(stamp)).toBe(new Intl.DateTimeFormat("ru-RU", {dateStyle:"medium",timeStyle:"short"}).format(stamp));
  expect(formatRelative(-1,"day")).toBe("вчера");
  await choose("en"); expect(formatRelative(-1,"day")).toBe("yesterday");
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone); expect(stamp).toBe(Date.UTC(2026,0,12,14,35));
});
test("stable statuses and errors translate without inventing evidence or hiding diagnostics", async () => {
  await choose("ru"); expect(codeLabel("indeterminate")).toBe("неопределённо"); expect(codeLabel("succeeded")).toBe("успешно завершено");
  expect(codeLabel("UNRECOGNIZED_DIAGNOSTIC")).toBe("UNRECOGNIZED_DIAGNOSTIC"); expect(evidenceLabel("unknown")).toBe("Данные неизвестны");
  const message = apiErrorText(409, {code:"unresolved-execution"}, "RAW_RUNTIME_DIAGNOSTIC");
  expect(message).toContain("Сначала уточните"); expect(message).toContain("unresolved-execution"); expect(message).toContain("RAW_RUNTIME_DIAGNOSTIC");
  expect(apiErrorText(403, {}, "security detail")).toContain("Ошибка авторизации");
});
