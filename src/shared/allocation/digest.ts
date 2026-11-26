import { createHash } from "node:crypto";
import type { AllocationPlanBody, AllocationPlanRecord } from "./types.ts";

export function allocationPlanDigest(plan: AllocationPlanBody): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function allocationRecordDigest(record: Pick<AllocationPlanRecord, "plan" | "revision">): string {
  return allocationPlanDigest({ ...record.plan, capturedAt: record.plan.capturedAt });
}
