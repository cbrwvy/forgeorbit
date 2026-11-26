import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import config from "../../../tailwind.config.js";

/**
 * FO-UX02-B guard for the token layer in index.css / tailwind.config.js:
 * (1) a Tailwind utility whose CSS variable is missing renders transparent or
 * unsized without any error, so every `var(--x)` the config references must
 * exist; (2) text, fill and focus-ring pairs must keep their WCAG contrast in
 * both themes, including text on the translucent glass surfaces composited over
 * the brightest canvas glow.
 */

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n  }", start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = block(":root");
const dark = { ...light, ...block(".dark") };

function referencedVars(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") for (const m of value.matchAll(/var\((--[a-z0-9-]+)/g)) into.add(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => referencedVars(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => referencedVars(v, into));
  return into;
}

test("every CSS variable the Tailwind theme references is defined in :root", () => {
  const theme = (config as { theme: { extend: Record<string, unknown> } }).theme.extend;
  const refs = referencedVars(theme);
  expect(refs.size).toBeGreaterThan(30);
  expect([...refs].filter((name) => !(name in light))).toEqual([]);
});

test("theme-dependent tokens are defined for both themes", () => {
  const pairs = ["--background", "--foreground", "--card", "--muted-foreground", "--ring", "--brand", "--brand-foreground", "--selected", "--glass-surface", "--glass-elevated", "--glass-floating", "--glow-alpha", "--chrome", "--brand-solid", "--primary", "--border", "--input", "--shadow", "--shadow-strength"];
  const darkOwn = block(".dark");
  expect(pairs.filter((name) => !(name in darkOwn))).toEqual([]);
});

// --- colour maths ----------------------------------------------------------
type RGB = [number, number, number];
function hsl(value: string): RGB {
  const [h, s, l] = value.split(/\s+/).map((p) => parseFloat(p));
  const sat = s! / 100, lig = l! / 100, c = (1 - Math.abs(2 * lig - 1)) * sat, hp = (h! % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1)), m = lig - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [(r! + m) * 255, (g! + m) * 255, (b! + m) * 255];
}
const over = (top: RGB, alpha: number, bottom: RGB): RGB => top.map((v, i) => v * alpha + bottom[i]! * (1 - alpha)) as RGB;
const lum = ([r, g, b]: RGB) => { const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  const c = (token: string) => hsl(t[`--${token}`]!);
  const num = (token: string) => parseFloat(t[`--${token}`]!);

  test(`${name}: text pairs keep AA (4.5:1)`, () => {
    const pairs: [string, string][] = [
      ["foreground", "background"], ["card-foreground", "card"], ["foreground", "card"],
      ["muted-foreground", "background"], ["muted-foreground", "card"], ["muted-foreground", "muted"],
      ["primary-foreground", "primary"], ["brand-foreground", "brand"], ["brand", "background"], ["brand", "card"],
      ["success", "background"], ["warning", "background"], ["info", "background"], ["danger", "background"],
      ["success", "card"], ["warning", "card"], ["info", "card"], ["danger", "card"],
      // FO-UX-VISUAL01: the shell frame and the filled primary action.
      ["foreground", "chrome"], ["muted-foreground", "chrome"], ["brand-solid-foreground", "brand-solid"],
      ["primary", "background"], ["primary", "card"], ["destructive-foreground", "destructive"],
    ];
    const low = pairs.map(([fg, bg]) => ({ fg, bg, r: ratio(c(fg), c(bg)) })).filter((p) => p.r < 4.5);
    expect(low).toEqual([]);
  });

  test(`${name}: focus ring is a visible non-text indicator (3:1) on page and card`, () => {
    expect(ratio(c("ring"), c("background"))).toBeGreaterThanOrEqual(3);
    expect(ratio(c("ring"), c("card"))).toBeGreaterThanOrEqual(3);
  });

  test(`${name}: glass stays AA for text over the brightest canvas glow`, () => {
    const alpha = num("glow-alpha");
    // Worst case: both glows at full strength on top of each other.
    const canvas = over(c("glow-blue"), alpha * 0.8, over(c("glow-violet"), alpha, c("background")));
    const checks: string[] = [];
    for (const surface of ["glass-surface", "glass-elevated"]) {
      const glass = over(c(surface), num(`${surface}-alpha`), canvas);
      for (const fg of ["foreground", "muted-foreground"]) {
        const r = ratio(c(fg), glass);
        if (r < 4.5) checks.push(`${fg} on ${surface}: ${r.toFixed(2)}`);
      }
      // Selected nav item on glass.
      const selected = over(c("selected"), num("selected-alpha"), glass);
      const r = ratio(c("foreground"), selected);
      if (r < 4.5) checks.push(`foreground on selected ${surface}: ${r.toFixed(2)}`);
    }
    expect(checks).toEqual([]);
  });

  test(`${name}: popovers stay AA even over content of the opposite colour`, () => {
    // Overlays sit on arbitrary page content. Worst case: the 6% see-through
    // share is pure foreground-coloured content (white text under a light
    // popover, black under a dark one); blur only softens it further.
    const low: string[] = [];
    for (const surface of ["glass-surface", "glass-elevated"]) {
      const glass = over(c(surface), num(`${surface}-alpha`), c("foreground"));
      for (const fg of ["foreground", "muted-foreground"]) {
        const r = ratio(c(fg), glass);
        if (r < 4.5) low.push(`${fg} on ${surface}: ${r.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });

  test(`${name}: floating glass is visibly see-through (20-35%) with 20-32px blur and keeps AA`, () => {
    const a = num("glass-floating-alpha");
    expect(a).toBeGreaterThanOrEqual(0.65);
    expect(a).toBeLessThanOrEqual(0.8);
    const blur = parseFloat(t["--glass-floating-blur"]!);
    expect(blur).toBeGreaterThanOrEqual(20);
    expect(blur).toBeLessThanOrEqual(32);
    // Text sits on the surface over (1) the brightest canvas glow and (2) page content as
    // dark as the foreground colour (a black button behind a light popover, and vice versa).
    const glowAlpha = num("glow-alpha");
    const canvas = over(c("glow-blue"), glowAlpha * 0.8, over(c("glow-violet"), glowAlpha, c("background")));
    const low: string[] = [];
    for (const [where, behind] of [["canvas", canvas], ["opposite content", c("foreground")]] as const) {
      const glass = over(c("glass-floating"), a, behind);
      const r = ratio(c("foreground"), glass);
      if (r < 4.5) low.push(`foreground on floating over ${where}: ${r.toFixed(2)}`);
    }
    const onCanvas = over(c("glass-floating"), a, canvas);
    if (ratio(c("muted-foreground"), onCanvas) < 4.5) low.push("muted-foreground on floating over canvas");
    expect(low).toEqual([]);
  });

  test(`${name}: glass transparency stays within 5-12% and blur within 12-20px`, () => {
    for (const k of ["glass-surface-alpha", "glass-elevated-alpha"]) {
      const a = num(k);
      expect(a).toBeGreaterThanOrEqual(0.88);
      expect(a).toBeLessThanOrEqual(0.95);
    }
    for (const k of ["glass-blur", "glass-blur-elevated"]) {
      const px = parseFloat(t[`--${k}`]!);
      expect(px).toBeGreaterThanOrEqual(12);
      expect(px).toBeLessThanOrEqual(20);
    }
    expect(num("glow-alpha")).toBeLessThanOrEqual(0.12);
  });
}

test("type, radius and control-height tokens match the approved scale", () => {
  const px = (v: string) => parseFloat(v) * (v.endsWith("rem") ? 16 : 1);
  expect([light["--text-base"], light["--text-secondary"], light["--text-caption"]].map((v) => px(v!))).toEqual([14, 13, 12]);
  expect([light["--radius"], light["--radius-surface"], light["--radius-panel"]].map((v) => px(v!))).toEqual([8, 12, 16]);
  expect(px(light["--control-h"]!)).toBe(36);
  expect(css).toMatch(/\[data-density="compact"\] \{[^}]*--control-h: 2rem;/);
  expect(css).toMatch(/\[data-density="comfortable"\] \{[^}]*--control-h: 2\.5rem;/);
});

test("FO-UX-VISUAL01: the content island stands apart from the window frame in both themes", () => {
  // The island (--background) and the frame (--chrome) must differ enough to
  // read as two surfaces without a heavy border, but stay a calm neutral pair.
  for (const t of [light, dark]) {
    const r = ratio(hsl(t["--background"]!), hsl(t["--chrome"]!));
    expect(r).toBeGreaterThan(1.04);
    expect(r).toBeLessThan(1.6);
  }
  // Motion stays within the 120-200ms band.
  for (const k of ["--duration-fast", "--duration-base", "--duration-slow"]) {
    const ms = parseFloat(light[k]!);
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThanOrEqual(200);
  }
});

test("density overrides move control height and rhythm together, in multiples of 4px", () => {
  const px = (v: string) => parseFloat(v) * (v.endsWith("rem") ? 16 : 1);
  const compact = /\[data-density="compact"\] \{([^}]*)\}/.exec(css)![1]!;
  const comfy = /\[data-density="comfortable"\] \{([^}]*)\}/.exec(css)![1]!;
  const read = (blockText: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(blockText)?.[1]?.trim();
  for (const name of ["--control-h", "--space-stack", "--space-row"]) {
    expect(read(compact, name), `compact ${name}`).toBeDefined();
    expect(read(comfy, name), `comfortable ${name}`).toBeDefined();
  }
  const heights = [read(compact, "--control-h")!, light["--control-h"]!, read(comfy, "--control-h")!].map(px);
  expect(heights).toEqual([32, 36, 40]);
  for (const v of [light["--space-page"], light["--space-stack"], light["--space-row"], read(compact, "--space-row"), read(comfy, "--space-row"), read(compact, "--space-stack"), read(comfy, "--space-stack")]) {
    expect(px(v!) % 4, v).toBe(0);
  }
  // Body text never shrinks with density.
  expect(compact).not.toContain("--text-base");
});

test("layer scale: dock < RunPanel(40) < dialogs/menus(50) < portaled popovers", () => {
  const dock = parseInt(light["--z-dock"]!, 10);
  const popover = parseInt(light["--z-popover"]!, 10);
  expect(dock).toBeGreaterThan(30);
  expect(dock).toBeLessThan(40);
  expect(popover).toBeGreaterThan(50);
  const theme = (config as { theme: { extend: { zIndex: Record<string, string> } } }).theme.extend.zIndex;
  expect(theme.popover).toBe("var(--z-popover)");
});
