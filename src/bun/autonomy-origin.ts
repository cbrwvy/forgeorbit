/**
 * The origin mark for Runs ForgeOrbit makes on its own authority (FO-ORCH08).
 * Kept free of imports so the orchestrator and the pipeline runner can use it
 * without loading the enforcement module (which depends on both). The guard in
 * `autonomy.ts` reads it when a Run is recorded.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AutonomyOrigin } from "../shared/autonomy.ts";

const originStore = new AsyncLocalStorage<AutonomyOrigin>();

/** Run `fn` as a Run ForgeOrbit chose to make. Everything it awaits inherits the mark. */
export function withAutonomyOrigin<T>(origin: AutonomyOrigin, fn: () => T): T {
  return originStore.run(origin, fn);
}

export function currentAutonomyOrigin(): AutonomyOrigin | undefined {
  return originStore.getStore();
}

export class AutonomyRefusedError extends Error {
  constructor(readonly code: string, readonly reason: string, readonly batchId: string | null = null) {
    super(reason);
    this.name = "AutonomyRefusedError";
  }
}
