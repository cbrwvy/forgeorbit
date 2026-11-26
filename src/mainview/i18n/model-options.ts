export * from "../../shared/model-options.ts";
import { mergeModelOptions as canonical } from "../../shared/model-options.ts";
import { staticLabel } from "./presentation";
/** Display metadata only. Discovery trust, IDs, effort sets and unlisted flags come from the canonical merge. */
export const mergeModelOptions: typeof canonical = input => {
  const curated = new Set(input.curated.map(row => row.id));
  return canonical(input).map(row => ({
    ...row,
    get label() { return curated.has(row.id) ? staticLabel(row.label) : row.label; },
    ...(row.hint ? { get hint() { return staticLabel(row.hint!); } } : {}),
  }));
};
