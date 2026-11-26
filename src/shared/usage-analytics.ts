export const RUN_USAGE_STATUS_PREFIX = "usage-accounting: ";

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface MoneyAmount {
  amount: number;
  currency: string;
}

export type CostKind = "reported-api" | "calculated-api" | "subscription" | "internal" | "unknown";
export interface RunCost {
  kind: CostKind;
  money: MoneyAmount | null;
  pricingId: number | null;
  source: string | null;
}

export interface PricingTerms {
  billing: "api" | "subscription" | "internal" | "unknown";
  currency: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
}

export interface AnalyticsFilter {
  from?: number;
  until?: number;
  clusterId?: string;
  projectPath?: string;
  taskId?: string;
  taskIds?: string[];
  missionId?: string;
  specialist?: string;
  provider?: string;
  model?: string;
  accountId?: string;
  category?: string;
}

/** A recorded fixture must not be presented as a live provider report. */
export function isSyntheticEvidenceSource(source: string | null | undefined): boolean {
  return typeof source === "string" && /synthetic|fixture/i.test(source);
}

export interface QuotaPlanningWindow {
  poolId: string;
  startsAt: number;
  endsAt: number;
  allowance: number;
}

export interface ForecastSelection {
  taskIds?: string[];
  projectPath?: string;
  projectPaths?: string[];
  clusterId?: string;
  missionId?: string;
  concurrency?: number;
  save?: boolean;
  /** Server-internal (never read from a request body): freeze an estimate for an unstarted Backlog, Inbox or Ready task at a supervised Start. */
  freezeBaseline?: boolean;
  alternative?: { taskId: string; optionKey: string };
  /** Read-only bounded comparison. It does not change the approved plan. */
  compareAllocations?: boolean;
  assumptions?: {
    unknownCapacity?: boolean;
    startAuthorized?: boolean;
    activeReleaseMs?: number;
    refillAtReset?: boolean;
    quotaWindows?: QuotaPlanningWindow[];
  };
}

/** Only an explicit billing receipt counts; CLI estimates are a separate field. */
export function providerBill(value: unknown): MoneyAmount | null {
  const row = value as Partial<MoneyAmount> | null;
  return row && typeof row.amount === "number" && Number.isFinite(row.amount) && row.amount >= 0 &&
    typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? { amount: row.amount, currency: row.currency } : null;
}
