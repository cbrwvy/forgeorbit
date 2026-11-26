/**
 * Read-only roll-up of what waits for the Owner outside the board (FO-UX02-E).
 *
 * The "Needs you" page and the Head of PM orb both need the same answer for
 * approvals that live in other stores. Every row here is a fact the core already
 * stores — pending task proposals, delegations the owner has not approved (or
 * that failed and can be retried) and execution batches that stopped moving
 * (paused / approved-but-not-started / stopped on a limit). Nothing is approved,
 * started or changed, no model is called, and there is no second workflow: each
 * row only points at the existing card or screen.
 */

import { db } from "./db.ts";
import { listWorkflowHolds } from "./pm-orchestrated-workflow.ts";
import { listOrchestratedBatchHolds } from "./pm-orchestrated-batch.ts";
import { listPendingPermissionRows } from "./project-permissions.ts";
import { handsoffStore } from "./handsoff/store.ts";
import { listDeploymentRequestHolds, listDeploymentExecutionAuthHolds } from "./deployment-request-core.ts";

export type { OwnerActionRow, BatchHoldRow, OwnerActionsPayload } from "../shared/owner-actions.ts";
import type { BatchHoldRow, OwnerActionsPayload } from "../shared/owner-actions.ts";

function parse(data: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, fallback = ""): string => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : fallback);

export function readOwnerActions(): OwnerActionsPayload {
  let memoryProposals: import("../shared/owner-actions.ts").MemoryProposalActionRow[] = [];
  try {
    memoryProposals = db
      .query<{ id: string; title: string; source_project_path: string | null; scope_kind: "company" | "project"; scope_id: string; manager_kind: "project-manager" | "head-of-pm" }, []>(
        `SELECT id, title, source_project_path, scope_kind, scope_id, manager_kind
         FROM brain_memory_proposals WHERE status = 'pending' ORDER BY created_at DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        title: text(row.title, row.id),
        projectPath: row.scope_kind === "project" ? row.scope_id : (row.source_project_path ?? ""),
        managerKind: row.manager_kind,
        scopeKind: row.scope_kind,
      }));
  } catch {
    memoryProposals = [];
  }
  const proposals = db
    .query<{ id: string; project_path: string; data: string }, []>(
      `SELECT id, project_path, data FROM project_manager_proposals WHERE status = 'pending' ORDER BY created_at DESC`,
    )
    .all()
    .map((row) => ({ projectPath: row.project_path, id: row.id, title: text(parse(row.data)?.title, row.id) }));
  // Same rule as the portfolio panel: proposed, or failed and retryable.
  const delegations = db
    .query<{ id: string; project_path: string; data: string }, []>(
      `SELECT id, project_path, data FROM portfolio_manager_delegations WHERE status IN ('proposed', 'failed') ORDER BY created_at DESC`,
    )
    .all()
    .map((row) => ({ projectPath: row.project_path, id: row.id, title: text(parse(row.data)?.title ?? parse(row.data)?.request, row.id) }));
  const batchHolds = db
    .query<{ id: string; project_path: string; status: BatchHoldRow["status"]; data: string }, []>(
      `SELECT id, project_path, status, data FROM project_execution_batches WHERE status IN ('paused', 'approved', 'stopped') ORDER BY updated_at DESC`,
    )
    .all()
    .map((row) => ({ projectPath: row.project_path, id: row.id, status: row.status, title: text(parse(row.data)?.title, row.id) }));
  return {
    proposals,
    memoryProposals,
    delegations,
    batchHolds,
    orchestratedWorkflowHolds: listWorkflowHolds(),
    orchestratedBatchHolds: listOrchestratedBatchHolds() as import("../shared/owner-actions.ts").OrchestratedBatchHoldRow[],
    deploymentRequestHolds: listDeploymentRequestHolds(db),
    deploymentExecutionAuthHolds: listDeploymentExecutionAuthHolds(db),
    projectPermissionRequests: listPendingPermissionRows(),
    handsoffBlockers: handsoffStore.listOpenRuns().filter((run) => run.status === "needs-owner" && run.blocker).map((run) => ({
      projectPath: run.projectPath,
      id: run.id,
      taskId: run.taskId,
      title: text(db.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?").get(run.taskId)?.title, run.taskId),
      code: run.blocker!.code,
      message: run.blocker!.message.slice(0, 400),
      action: run.blocker!.action,
    })),
  };
}
