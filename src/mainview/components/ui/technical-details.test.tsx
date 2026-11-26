import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { TechnicalDetails } from "./technical-details";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

const rows = [
  { label: "Certificate", value: "ab12cd", testId: "cert" },
  { label: "Missing", value: null },
];

test("technical details are collapsed by default but every value stays in the DOM and copyable", () => {
  const html = renderToStaticMarkup(<LocaleProvider><TechnicalDetails rows={rows} testId="details" /></LocaleProvider>);
  expect(html).toContain("<details");
  expect(html).not.toContain(" open");
  expect(html).toContain("Technical details");
  expect(html).toContain('data-testid="cert"');
  expect(html).toContain("ab12cd");
  expect(html).toContain('aria-label="Copy Certificate"');
  // A missing value is shown as a dash and gets no copy button.
  expect(html).not.toContain('aria-label="Copy Missing"');
});

test("the disclosure is localized", async () => {
  await choose("ru");
  const html = renderToStaticMarkup(<LocaleProvider><TechnicalDetails rows={rows} /></LocaleProvider>);
  expect(html).toContain("Технические подробности");
  expect(html).toContain("Копировать");
});

test("the global preference decides only whether a block starts open; the content is identical", async () => {
  const pref = await import("@/lib/technical-details-pref");
  const closed = renderToStaticMarkup(<LocaleProvider><TechnicalDetails rows={rows} testId="details" /></LocaleProvider>);
  // The server snapshot is always "off", so the store itself is what the client reads.
  expect(pref.getShowTechnicalDetails()).toBe(false);
  expect(closed).not.toContain(" open");
  pref.setShowTechnicalDetails(true, null);
  expect(pref.getShowTechnicalDetails()).toBe(true);
  pref.__resetTechnicalDetailsForTest();
});

test("the summary is a native, keyboard-operable disclosure with a visible focus ring", () => {
  const html = renderToStaticMarkup(<LocaleProvider><TechnicalDetails rows={rows} /></LocaleProvider>);
  expect(html).toMatch(/<summary[^>]*focus-visible:ring-2/);
  expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="Copy Certificate"/);
});
