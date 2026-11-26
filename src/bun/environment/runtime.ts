/**
 * The one EnvironmentManager for this Bun process.
 *
 * Desktop boot and the headless core both call {@link startEnvironmentManager}
 * after the database is ready and after orphan reconciliation. Routes never
 * construct a second manager. Shutdown aborts in-flight checks and does not
 * signal processes the user left running.
 */

import path from "node:path";

import type { EnvironmentPhase, OwnershipClass } from "../../shared/environment/types.ts";
import { dataDir } from "../db.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { EnvironmentManager, type EnvironmentNotice } from "./manager.ts";
import { SqliteEnvironmentStore } from "./sqlite-store.ts";

let manager: EnvironmentManager | null = null;
let starting: Promise<void> | null = null;

const LOG_FLUSH_MS = 200;
const LOG_QUEUE_MAX = 40;
const LOG_TEXT_MAX = 2_000;

interface PendingLog {
  projectPath: string;
  profileId: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: number;
}

const pendingLogs: PendingLog[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function getEnvironmentManager(): EnvironmentManager | null {
  return manager;
}

/** Tests install a manager with fake hosts before the first request. */
export function installEnvironmentManager(next: EnvironmentManager): void {
  manager?.dispose();
  manager = next;
  starting = Promise.resolve();
}

export function resetEnvironmentManagerForTests(): void {
  manager?.dispose();
  manager = null;
  starting = null;
  pendingLogs.length = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export async function startEnvironmentManager(): Promise<void> {
  if (manager) return;
  if (starting) return starting;
  starting = (async () => {
    const created = new EnvironmentManager({
      store: new SqliteEnvironmentStore(),
      markerDir: path.join(dataDir, "environment-markers"),
      listener: publishNotice,
    });
    manager = created;
    try {
      await created.restore();
    } catch (error) {
      console.warn(
        `[environment] restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  try {
    await starting;
  } catch (error) {
    starting = null;
    manager = null;
    throw error;
  }
}

/** Abort in-flight operations. Leaves user processes and containers running. */
export function disposeEnvironmentManager(): void {
  manager?.dispose();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingLogs.length = 0;
}

function publishNotice(notice: EnvironmentNotice): void {
  if (notice.line) {
    const text = notice.line.text.length > LOG_TEXT_MAX ? notice.line.text.slice(-LOG_TEXT_MAX) : notice.line.text;
    pendingLogs.push({
      projectPath: notice.projectPath,
      profileId: notice.profileId,
      stream: notice.line.stream,
      text,
      at: notice.line.at,
    });
    while (pendingLogs.length > LOG_QUEUE_MAX) pendingLogs.shift();
    if (!flushTimer) flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
    return;
  }
  broadcastStatus(notice);
}

function broadcastStatus(notice: EnvironmentNotice): void {
  broadcastAppEvent({
    type: "environment_status",
    projectPath: notice.projectPath,
    profileId: notice.profileId,
    phase: notice.status.recordedPhase,
    ownership: notice.status.ownership,
    error: notice.status.lastError,
    errorCode: notice.status.errorCode,
    health: notice.status.health.map((outcome) => ({
      id: outcome.id,
      ok: outcome.ok,
      required: outcome.required,
      detail: outcome.detail,
    })),
    ts: Date.now(),
  });
}

function flushLogs(): void {
  flushTimer = null;
  const batch = pendingLogs.splice(0, pendingLogs.length);
  for (const line of batch) {
    broadcastAppEvent({
      type: "environment_log",
      projectPath: line.projectPath,
      profileId: line.profileId,
      stream: line.stream,
      text: line.text,
      at: line.at,
      ts: Date.now(),
    });
  }
}

export type { EnvironmentPhase, OwnershipClass };
