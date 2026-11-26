/** Existing, fixed Claude print policy. Monetary threshold is an estimate, not a billing cap. */
export const BOUNDED_CLAUDE = { maxTurns: 6, maxBudgetUsd: 0.25, timeoutMs: 180_000 } as const;
export const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"];
export const CLAUDE_EDIT_TOOLS = [...CLAUDE_READ_TOOLS, "Edit", "Write"];
export interface ApprovedWorkflowExecution {
  implementerAccountProfile?: { id: string; displayName: string } | null;
  reviewerAccountProfile?: { id: string; displayName: string } | null;
  implementerMode: string;
  reviewerMode: string;
  implementerHarnessKey: string;
  reviewerHarnessKey: string;
  boundedPolicy: { maxTurns: number; maxBudgetUsd: number; timeoutMs: number; developerTools: string[]; reviewerTools: string[] } | null;
}
