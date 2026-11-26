import type { TaskRequirements } from "./types.ts";
/** Only explicit structured facts. No prompt/title heuristics. */
export function analyzeTaskRequirements(input: Pick<TaskRequirements, "taskId" | "projectId"> & Partial<Omit<TaskRequirements, "taskId" | "projectId">>): TaskRequirements {
  return { type: "general", complexity: "unknown", priority: null, capabilities: [], tools: [],
    requiredPermissions: [], allowedPermissions: null, contextTokens: null, quotaDemands: [], provenance: [], ...input };
}
