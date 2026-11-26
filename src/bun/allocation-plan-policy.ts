/** Load and store FO-ROUTING03 allocation policy (preferences table). */
import {
  parseAllocationPlanPolicy,
  readStoredAllocationPlanPolicy,
} from "../shared/allocation/policy.ts";
import type { AllocationPlanPolicy } from "../shared/allocation/types.ts";
import { preferences } from "./db.ts";

export const ALLOCATION_PLAN_POLICY_KEY = "allocationPlanPolicy";

export function loadAllocationPlanPolicy(): AllocationPlanPolicy {
  return readStoredAllocationPlanPolicy(preferences.get(ALLOCATION_PLAN_POLICY_KEY));
}

export function saveAllocationPlanPolicy(raw: unknown): AllocationPlanPolicy {
  const parsed = parseAllocationPlanPolicy(raw);
  preferences.set(ALLOCATION_PLAN_POLICY_KEY, JSON.stringify(parsed));
  return parsed;
}
