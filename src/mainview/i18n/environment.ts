export * from "../../shared/environment/present.ts";
import { PHASE_LABELS as canonical, ownershipLabel as canonicalOwnership, blockingReason as canonicalBlocking } from "../../shared/environment/present.ts";
import { staticLabel } from "./presentation";
export const PHASE_LABELS = Object.defineProperties({}, Object.fromEntries(Object.entries(canonical).map(([code, label]) => [code, { enumerable: true, get: () => staticLabel(label) }]))) as typeof canonical;
export const ownershipLabel: typeof canonicalOwnership = ownership => staticLabel(canonicalOwnership(ownership));
export const blockingReason: typeof canonicalBlocking = (phase, ownership) => {
  const reason = canonicalBlocking(phase, ownership); return reason ? staticLabel(reason) : null;
};
