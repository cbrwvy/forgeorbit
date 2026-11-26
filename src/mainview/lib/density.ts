/**
 * Control density (FO-UX02-B): Compact 32px / Default 36px / Comfortable 40px
 * interactive controls, driven by `--control-h` in index.css through
 * `html[data-density]`.
 *
 * localStorage for the same reason as `panel-collapse.ts`: pure webview
 * chrome that must resolve before the first paint. `index.html` carries an
 * inline copy of `parseDensity` for the boot path (no module can load yet) —
 * keep the key and the accepted values in sync.
 */

export const DENSITY_STORAGE_KEY = "agetor:density";
export const DENSITIES = ["compact", "default", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];
export const DEFAULT_DENSITY: Density = "default";

type DensityStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): DensityStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Anything that is not one of the three known values reads as the default. */
export function parseDensity(value: unknown): Density {
  return (DENSITIES as readonly unknown[]).includes(value) ? (value as Density) : DEFAULT_DENSITY;
}

export function readDensity(storage: DensityStorage | null = defaultStorage()): Density {
  try {
    return parseDensity(storage?.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return DEFAULT_DENSITY;
  }
}

/** Best-effort: a throwing or full storage must never break the UI. */
export function writeDensity(density: Density, storage: DensityStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    /* ignore */
  }
}

/** Default is represented by the absence of the attribute. */
export function applyDensity(density: Density, root: Pick<HTMLElement, "setAttribute" | "removeAttribute"> = document.documentElement): void {
  if (density === DEFAULT_DENSITY) root.removeAttribute("data-density");
  else root.setAttribute("data-density", density);
}
