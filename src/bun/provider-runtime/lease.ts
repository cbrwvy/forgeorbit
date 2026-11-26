import { readFileSync } from "node:fs";

/**
 * In-memory dispatch lease for one task launch.
 * The production scheduler opens it. spawnAgent consumes it.
 * A restart reads durable run rows, not this map.
 */
export type RecordedOutcome = "succeeded" | "provider-error" | "timeout" | "indeterminate" | "hold";

export interface TokenEvidence {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface DispatchLease {
  taskId: string;
  accountId: string;
  role: "developer" | "reviewer";
  transport: "recorded" | "codex-live" | "claude-live";
  outcome: RecordedOutcome;
  readOnly: boolean;
  providerId: string;
  modelId: string;
  argv: string[];
  tokens: TokenEvidence | null;
}

const leases = new Map<string, DispatchLease>();
const outcomes = new Map<string, RecordedOutcome>();
const fixtures = new Map<string, { outcome: RecordedOutcome; tokens: TokenEvidence | null }>();

function key(taskId: string, role: "developer" | "reviewer"): string {
  return `${taskId}:${role}`;
}

/** Test and scenario seam. Production launches use the succeeded default. */
export function noteProviderFixture(taskId: string, role: "developer" | "reviewer", fixture: { outcome: RecordedOutcome; tokens: TokenEvidence | null }): void {
  fixtures.set(key(taskId, role), fixture);
}

const OUTCOMES = new Set<RecordedOutcome>(["succeeded", "provider-error", "timeout", "indeterminate", "hold"]);

function fixtureFromFile(taskId: string, role: "developer" | "reviewer"): { outcome: RecordedOutcome; tokens: TokenEvidence | null } | null {
  if (process.env.AGETOR_CODEX_DRIVER !== "fake" && process.env.AGETOR_CLAUDE_DRIVER !== "fake") return null;
  const file = process.env.AGETOR_PROVIDER_FIXTURE_FILE;
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { outcome?: string; tokens?: TokenEvidence | null }>;
    const row = parsed[`${taskId}:${role}`];
    if (!row || !OUTCOMES.has(row.outcome as RecordedOutcome)) return null;
    return { outcome: row.outcome as RecordedOutcome, tokens: row.tokens ?? null };
  } catch {
    return null;
  }
}

export function fixtureFor(taskId: string, role: "developer" | "reviewer"): { outcome: RecordedOutcome; tokens: TokenEvidence | null } {
  return fixtures.get(key(taskId, role)) ?? fixtureFromFile(taskId, role) ?? {
    outcome: "succeeded",
    tokens: role === "reviewer"
      ? { input: 11, output: 3, cacheRead: 2, cacheWrite: null }
      : { input: 20, output: 5, cacheRead: 4, cacheWrite: 1 },
  };
}

export function openDispatchLease(lease: DispatchLease): void {
  leases.set(lease.taskId, lease);
}

export function peekDispatchLease(taskId: string): DispatchLease | null {
  return leases.get(taskId) ?? null;
}

export function consumeDispatchLease(taskId: string): DispatchLease | null {
  const lease = leases.get(taskId) ?? null;
  if (lease) leases.delete(taskId);
  return lease;
}

export function dropDispatchLease(taskId: string): void {
  leases.delete(taskId);
  outcomes.delete(taskId);
}

export function armRecordedOutcome(taskId: string, outcome: RecordedOutcome): void {
  outcomes.set(taskId, outcome);
}

export function consumeRecordedOutcome(taskId: string): RecordedOutcome | null {
  const outcome = outcomes.get(taskId) ?? null;
  if (outcome) outcomes.delete(taskId);
  return outcome;
}
