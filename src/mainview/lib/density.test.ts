import { expect, test } from "bun:test";
import { applyDensity, DENSITY_STORAGE_KEY, parseDensity, readDensity, writeDensity } from "./density";

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[DENSITY_STORAGE_KEY, initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};
const root = () => {
  const attrs = new Map<string, string>();
  return { attrs, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) };
};

test("only the three known densities are accepted; everything else is default", () => {
  expect(["compact", "default", "comfortable"].map(parseDensity)).toEqual(["compact", "default", "comfortable"]);
  for (const bad of [undefined, null, "", "dense", "COMPACT", 3]) expect(parseDensity(bad)).toBe("default");
});

test("read and write survive missing and throwing storage", () => {
  expect(readDensity(memory("compact"))).toBe("compact");
  expect(readDensity(memory())).toBe("default");
  expect(readDensity(null)).toBe("default");
  const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  expect(readDensity(throwing)).toBe("default");
  expect(() => writeDensity("comfortable", throwing)).not.toThrow();
  const m = memory();
  writeDensity("comfortable", m);
  expect(m.data.get(DENSITY_STORAGE_KEY)).toBe("comfortable");
});

test("default density leaves <html> pristine; the others set data-density", () => {
  const r = root();
  applyDensity("compact", r);
  expect(r.attrs.get("data-density")).toBe("compact");
  applyDensity("default", r);
  expect(r.attrs.has("data-density")).toBe(false);
  applyDensity("comfortable", r);
  expect(r.attrs.get("data-density")).toBe("comfortable");
});
