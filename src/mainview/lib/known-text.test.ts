import { describe, expect, test } from "bun:test";
import { knownText } from "./known-text";

describe("knownText", () => {
  test("English is never changed", () => {
    expect(knownText("Do not start the project.", "en")).toBe("Do not start the project.");
    expect(knownText("Create the folder /a/b.", "en")).toBe("Create the folder /a/b.");
  });
  test("known sentences are translated outside English", () => {
    expect(knownText("Do not start the project.", "ru")).toBe("Не запускать проект.");
    expect(knownText("Not found", "ru")).toBe("Не найдено");
  });
  test("dynamic known sentences keep their parameter", () => {
    expect(knownText("Create the folder /a/b.", "ru")).toBe("Создать папку /a/b.");
    expect(knownText("Assigns specialist Ada to task.", "ru")).toBe("Назначает специалиста Ada на задачу.");
    expect(knownText("Updates task priority to high.", "ru")).toBe("Меняет приоритет задачи на high.");
  });
  test("unknown text, including model-written text, is shown verbatim", () => {
    expect(knownText("Add GET /health that answers ok.", "ru")).toBe("Add GET /health that answers ok.");
    expect(knownText("", "ru")).toBe("");
  });
});
