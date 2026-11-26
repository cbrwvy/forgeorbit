import { afterEach, expect, test } from "bun:test";
import { localeStore } from "@/i18n/core";
import { contextSourceDetail, contextSourceLabel } from "./manager-source-text";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

test("English context rows are shown exactly as the server wrote them", async () => {
  await choose("en");
  const source = { label: "Board tasks", detail: "3 of 5 active tasks listed, 2 archived counted." };
  expect(contextSourceLabel(source)).toBe("Board tasks");
  expect(contextSourceDetail(source)).toBe("3 of 5 active tasks listed, 2 archived counted.");
});

test("known server sentences are rendered in Russian and unknown ones stay verbatim", async () => {
  await choose("ru");
  expect(contextSourceLabel({ label: "Project identity", detail: "" })).toBe("Сведения о проекте");
  expect(contextSourceLabel({ label: "IDEA.md", detail: "" })).toBe("IDEA.md");
  expect(contextSourceDetail({ label: "x", detail: "Not found in the project." })).toBe("Не найдено в проекте.");
  expect(contextSourceDetail({ label: "x", detail: "No tasks on the board for this project." })).toBe("В проекте нет задач на доске.");
  expect(contextSourceDetail({ label: "x", detail: "3 of 5 active tasks listed, 2 archived counted." })).toBe("Показано 3 из 5 активных задач, архивных учтено: 2.");
  expect(contextSourceDetail({ label: "x", detail: "First 4,000 characters (secrets redacted)." })).toBe("Первые 4,000 символов (секреты скрыты).");
  expect(contextSourceDetail({ label: "x", detail: "Name, folder, No stack detected, description." })).toBe("Название, папка, стек не определён, описание.");
  expect(contextSourceDetail({ label: "x", detail: "2 confirmed." })).toBe("Подтверждено: 2.");
  expect(contextSourceDetail({ label: "x", detail: "app: running (last error: boom)" })).toBe("app: running (last error: boom)");
});
