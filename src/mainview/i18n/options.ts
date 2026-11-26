/** View-only adapters. All option IDs, capabilities, deny lists and defaults stay canonical. */
export * from "../../shared/types.ts";
import { AGENT_OPTIONS as canonical, EFFORT_OPTIONS as efforts, TASK_TYPES as taskTypes, THEME_PREFERENCES as themes, HARNESS_TEMPLATES as templates, supportedModes as canonicalModes, supportedEfforts as canonicalEfforts, type AgentKind, type AgentOption, type AgentOptions } from "../../shared/types.ts";
import { staticLabel } from "./presentation";
function liveRows<T extends { label: string; hint?: string }>(rows: readonly T[]): T[] {
  // Accessor properties preserve module-level metadata while resolving each label at render time.
  return rows.map(row => ({ ...row, get label() { return staticLabel(row.label); }, ...(row.hint ? { get hint() { return staticLabel(row.hint!); } } : {}) }));
}
export const AGENT_OPTIONS = Object.fromEntries((Object.keys(canonical) as AgentKind[]).map(kind => [kind, {
  get models() { return liveRows(canonical[kind].models); },
  get modes() { return liveRows(canonical[kind].modes); },
  get efforts() { return liveRows(canonical[kind].efforts); },
}])) as Record<AgentKind, AgentOptions>;
export const EFFORT_OPTIONS: AgentOption[] = liveRows(efforts);
export const TASK_TYPES = liveRows(taskTypes);
export const THEME_PREFERENCES = liveRows(themes);
// Template metadata is adapted only while picking; persisted harness names are rendered verbatim.
export const HARNESS_TEMPLATES = liveRows(templates);
export const supportedModes = (agent: AgentKind, model: string | null) => liveRows(canonicalModes(agent, model));

export const supportedEfforts: typeof canonicalEfforts = (...args) => liveRows(canonicalEfforts(...args));
