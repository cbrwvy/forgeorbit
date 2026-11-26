import { afterEach, expect, test } from "bun:test";
import {
  __resetTechnicalDetailsForTest,
  getShowTechnicalDetails,
  parseTechnicalDetails,
  readTechnicalDetails,
  setShowTechnicalDetails,
  TECHNICAL_DETAILS_STORAGE_KEY,
} from "./technical-details-pref";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

afterEach(() => __resetTechnicalDetailsForTest());

test("technical details are off unless the stored value is exactly on", () => {
  expect(parseTechnicalDetails(null)).toBe(false);
  expect(parseTechnicalDetails("off")).toBe(false);
  expect(parseTechnicalDetails("true")).toBe(false);
  expect(parseTechnicalDetails("on")).toBe(true);
  expect(readTechnicalDetails(memoryStorage())).toBe(false);
  expect(readTechnicalDetails(null)).toBe(false);
});

test("the choice is persisted under one key and survives a fresh read", () => {
  const storage = memoryStorage();
  setShowTechnicalDetails(true, storage);
  expect(storage.data.get(TECHNICAL_DETAILS_STORAGE_KEY)).toBe("on");
  expect(getShowTechnicalDetails()).toBe(true);
  expect(readTechnicalDetails(storage)).toBe(true);
  setShowTechnicalDetails(false, storage);
  expect(storage.data.get(TECHNICAL_DETAILS_STORAGE_KEY)).toBe("off");
  expect(readTechnicalDetails(storage)).toBe(false);
});

test("a throwing storage never breaks the preference", () => {
  const broken = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  expect(readTechnicalDetails(broken)).toBe(false);
  expect(() => setShowTechnicalDetails(true, broken)).not.toThrow();
  expect(getShowTechnicalDetails()).toBe(true);
});
