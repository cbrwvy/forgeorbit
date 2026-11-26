import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../index.css", import.meta.url)).text();

/** The glass foundation is tokens plus the media fallbacks. Components must
 *  not invent their own blur; this file is the contract those classes read. */
test("liquid-glass tokens exist for both themes", () => {
  for (const token of [
    "--glass-surface",
    "--glass-surface-alpha",
    "--glass-elevated",
    "--glass-border",
    "--glass-blur",
    "--surface-solid",
    "--hover",
    "--selected",
    "--success",
    "--warning",
    "--danger",
  ]) {
    expect(css.includes(token)).toBe(true);
  }
  const root = css.indexOf(":root");
  const dark = css.indexOf(".dark {");
  expect(root).toBeGreaterThanOrEqual(0);
  expect(dark).toBeGreaterThan(root);
  expect(css.indexOf("--glass-surface:", root)).toBeLessThan(dark);
  expect(css.indexOf("--glass-surface:", dark)).toBeGreaterThan(dark);
});

test("reduced motion, reduced transparency, and missing backdrop-filter have fallbacks", () => {
  expect(css.includes("@media (prefers-reduced-motion: reduce)")).toBe(true);
  expect(css.includes("@media (prefers-reduced-transparency: reduce)")).toBe(true);
  expect(css.includes("backdrop-filter: none")).toBe(true);
  expect(css.includes("@supports not ((backdrop-filter: blur(1px))")).toBe(true);
  expect(css.includes(".glass-surface")).toBe(true);
  expect(css.includes(".glass-column")).toBe(true);
  expect(css.includes(".surface-solid")).toBe(true);
});
