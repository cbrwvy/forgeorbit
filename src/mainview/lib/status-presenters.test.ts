import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { localeStore } from "@/i18n/core";
import {
  availabilityText,
  columnLabel,
  costCoverageText,
  executionReadyText,
  operationAccountText,
  ownerCodeText,
  plainStatusCode,
  quotaOriginText,
} from "./status-presenters";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

test("the audit's example codes map to plain Russian and English, and keep the raw code when unmapped", async () => {
  await choose("ru");
  expect(plainStatusCode("owner-se-key-storage-unavailable")).toBe("Не удалось настроить подтверждение владельца.");
  expect(plainStatusCode("executionReady:false")).toBe("Запуск пока недоступен");
  expect(plainStatusCode("unknown-subscription")).toBe("Расход подписки неизвестен");
  expect(plainStatusCode("unbound")).toBe("Аккаунт не подтверждён");
  expect(plainStatusCode("some-future-code")).toBeNull();
  await choose("en");
  expect(plainStatusCode("owner-se-key-storage-unavailable")).toBe("Couldn't set up Owner confirmation.");
  expect(plainStatusCode("unknown-subscription")).toBe("Subscription usage is unknown");
});

test("an unknown cost, quota, availability or account is never presented as zero, free or available", async () => {
  for (const locale of ["en", "ru"] as const) {
    await choose(locale);
    expect(costCoverageText("unknown-subscription")).not.toBe(costCoverageText("none"));
    expect(costCoverageText(undefined)).toBe(localeStore.getSnapshot() === "ru" ? "Неизвестно" : "Unknown");
    expect(availabilityText(null)).toBe(locale === "ru" ? "Неизвестно" : "Unknown");
    expect(availabilityText("unavailable")).not.toBe(availabilityText("available"));
    expect(quotaOriginText(undefined)).toBe(quotaOriginText("unknown"));
    expect(operationAccountText("unbound")).not.toBe("unbound");
    expect(operationAccountText("")).not.toBe(operationAccountText("unbound"));
  }
});

test("execution readiness is only claimed for an explicit true", async () => {
  await choose("en");
  expect(executionReadyText(true)).toBe("Ready to run");
  expect(executionReadyText(false)).toBe("Running isn't available yet");
  expect(executionReadyText(null)).toBe("Running isn't available yet");
  expect(executionReadyText(undefined)).toBe("Running isn't available yet");
});

test("unmapped canonical values fall back to the raw value, never to a reassuring label", () => {
  expect(costCoverageText("brand-new-coverage")).toBe("brand-new-coverage");
  expect(quotaOriginText("brand-new-origin")).toBe("brand-new-origin");
  expect(availabilityText("limited")).toBe("limited");
  expect(columnLabel("custom-column")).toBe("custom-column");
});

test("kanban columns have one localized name each; ids stay canonical", async () => {
  await choose("ru");
  expect(["backlog", "inbox", "ready", "running", "blocked", "review", "done"].map(columnLabel)).toEqual([
    "Бэклог", "Входящие", "Готово к запуску", "Выполняется", "Заблокировано", "Проверка", "Выполнено",
  ]);
  await choose("en");
  expect(["backlog", "inbox", "ready", "running", "blocked", "review", "done"].map(columnLabel)).toEqual([
    "Backlog", "Inbox", "Ready", "Running", "Blocked", "Review", "Done",
  ]);
});

test("every Owner-trust and native-helper code the code base can emit has a plain-language sentence", async () => {
  const roots = ["src/bun/owner-trust", "src/shared/owner-trust"];
  const codes = new Set<string>();
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".ts") || name.includes(".test.") || name.endsWith(".suite.ts")) continue;
      const text = readFileSync(`${root}/${name}`, "utf8");
      for (const match of text.matchAll(/(?:code:\s*|refused\(|fail\()"((?:owner|helper|native|application|authentication|caller|secure)-[a-z0-9-]+)"/g)) codes.add(match[1]!);
    }
  }
  for (const swift of readFileSync("native/owner-trust/main.swift", "utf8").matchAll(/fail\("([a-z0-9-]+)"/g)) codes.add(swift[1]!);
  expect(codes.size).toBeGreaterThan(20);
  const generic = (locale: "en" | "ru") => { void locale; return ownerCodeText("code-that-does-not-exist"); };
  for (const locale of ["en", "ru"] as const) {
    await choose(locale);
    const fallback = generic(locale);
    const unmapped = [...codes].filter((code) => ownerCodeText(code) === fallback);
    expect(unmapped).toEqual([]);
  }
});
