import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { RuntimeSafetyNotice } from "./runtime-safety-notice";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

const outsideDetails = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, " ");

test("the safety sentence stays visible; the longer explanation is one click away and never removed", () => {
  const html = renderToStaticMarkup(<LocaleProvider><RuntimeSafetyNotice liveTestId="live" channelTestId="channel" /></LocaleProvider>);
  expect(outsideDetails(html)).toContain("Live provider launch is unavailable");
  expect(outsideDetails(html)).not.toContain("This screen cannot approve it");
  expect(html).toContain('data-testid="channel"');
  expect(html).toContain("This screen cannot approve it");
  expect(html).toMatch(/<summary[^>]*focus-visible:ring-2/);
});

test("the notice is localized", async () => {
  await choose("ru");
  const html = renderToStaticMarkup(<LocaleProvider><RuntimeSafetyNotice /></LocaleProvider>);
  expect(html).toContain("Живой запуск провайдера недоступен");
  expect(html).toContain("Почему ИИ нельзя запустить отсюда");
});
