/**
 * FO-DIRECTION12. A plain statement of what a Backlog estimate rests on and what it cannot know, derived
 * from fields the saved estimate already carries (so older revisions explain themselves too). Pure: no
 * numbers are invented here, and nothing here changes a range, a rank or a revision.
 */

/** Comparable completed outcomes a stage needs before its range is read from history (mirrors the forecast). */
export const ESTIMATE_MIN_SAMPLES = 3;

export type EstimateBasisKind = "historical" | "partial" | "heuristic";
export type EstimateInput = "scope" | "resource" | "worker" | "dependencies";
export type EstimateUnknown = "subscription" | "cost" | "account" | "technology" | "human-wait";

/** The slice of a saved estimate the explanation needs. */
export interface EstimateBasisSource {
  roles: Array<"developer" | "reviewer">;
  technology: string;
  category: string;
  complexity: string;
  workerId: string | null;
  dependsOn: string[];
  plannedResource?: { harnessId: string; modelId: string | null; accountId: string | null; mode: string | null };
  developer: { basis: "historical" | "heuristic"; samples: number } | null;
  reviewer: { basis: "historical" | "heuristic"; samples: number } | null;
  plannedUsage: { totals: unknown[] };
}

export interface EstimateBasis {
  kind: EstimateBasisKind;
  required: number;
  stages: Array<{ role: "developer" | "reviewer"; basis: "historical" | "heuristic" | "none"; samples: number }>;
  inputs: EstimateInput[];
  unknowns: EstimateUnknown[];
}

export function describeEstimateBasis(estimate: EstimateBasisSource): EstimateBasis {
  const stages = estimate.roles.map(role => {
    const option = estimate[role];
    return { role, basis: option ? option.basis : "none" as const, samples: option?.samples ?? 0 };
  });
  const historical = stages.filter(stage => stage.basis === "historical").length;
  const kind: EstimateBasisKind = stages.length > 0 && historical === stages.length ? "historical" : historical > 0 ? "partial" : "heuristic";
  const inputs: EstimateInput[] = ["scope", "resource"];
  if (estimate.workerId) inputs.push("worker");
  if (estimate.dependsOn.length > 0) inputs.push("dependencies");
  const unknowns: EstimateUnknown[] = ["subscription"];
  if (estimate.plannedUsage.totals.length === 0) unknowns.push("cost");
  if (!estimate.plannedResource?.accountId) unknowns.push("account");
  if (estimate.technology === "unknown") unknowns.push("technology");
  unknowns.push("human-wait");
  return { kind, required: ESTIMATE_MIN_SAMPLES, stages, inputs, unknowns };
}
