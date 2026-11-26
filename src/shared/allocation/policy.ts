import {
  ALLOCATION_PLAN_LIMITS,
  DEFAULT_ALLOCATION_PLAN_POLICY,
  type AllocationPlanPolicy,
} from "./types.ts";

const SAFE = /^[^\x00-\x1f\x7f]+$/;

function list(value: unknown, label: string, max: number): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > max) throw `Invalid ${label}.`;
  const out = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 200 || !SAFE.test(item)) throw `Invalid ${label}.`;
    return item.trim();
  });
  return [...new Set(out)].sort();
}

export function parseAllocationPlanPolicy(value: unknown): AllocationPlanPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw "Expected an allocation policy object.";
  const record = value as Record<string, unknown>;
  const allowed = [
    "allowedHarnessIds",
    "preferredHarnessIds",
    "allowedAccountIds",
    "preferredAccountIds",
    "unknownQuotaRequiresAcknowledgement",
    "maxTasks",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw "Unsupported allocation policy field.";
  const maxTasks =
    record.maxTasks === undefined
      ? DEFAULT_ALLOCATION_PLAN_POLICY.maxTasks
      : typeof record.maxTasks === "number" && Number.isSafeInteger(record.maxTasks) && record.maxTasks >= 1 && record.maxTasks <= ALLOCATION_PLAN_LIMITS.maxTasks
        ? record.maxTasks
        : (() => {
            throw "Invalid maxTasks.";
          })();
  if (record.unknownQuotaRequiresAcknowledgement !== undefined && typeof record.unknownQuotaRequiresAcknowledgement !== "boolean") {
    throw "Invalid unknownQuotaRequiresAcknowledgement.";
  }
  return {
    allowedHarnessIds: list(record.allowedHarnessIds, "allowedHarnessIds", 50),
    preferredHarnessIds: list(record.preferredHarnessIds, "preferredHarnessIds", 50),
    allowedAccountIds: list(record.allowedAccountIds, "allowedAccountIds", 50),
    preferredAccountIds: list(record.preferredAccountIds, "preferredAccountIds", 50),
    requireReviewerReadOnly: true,
    unknownQuotaRequiresAcknowledgement:
      record.unknownQuotaRequiresAcknowledgement ?? DEFAULT_ALLOCATION_PLAN_POLICY.unknownQuotaRequiresAcknowledgement,
    maxTasks,
  };
}

export function readStoredAllocationPlanPolicy(raw: string | null): AllocationPlanPolicy {
  if (!raw) return { ...DEFAULT_ALLOCATION_PLAN_POLICY };
  try {
    return parseAllocationPlanPolicy(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ALLOCATION_PLAN_POLICY };
  }
}
