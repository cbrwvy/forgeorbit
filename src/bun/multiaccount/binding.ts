/** Launch binding. A requested account is refused rather than replaced. */
import type { Database } from "bun:sqlite";
import { AccountCoreError } from "../account-core.ts";
import { assertCodexProfileAuthentication, isCodexProfile, selectedCodexAccount } from "../codex-profiles.ts";
import { assertClaudeProfileAuthentication, isClaudeProfile, selectedClaudeAccount } from "../claude-profiles.ts";
import { db, harnesses } from "../db.ts";
import { isBlockedProvider } from "../../shared/autonomy-policy.ts";
import { executionFingerprint, type FrozenExecutionResource } from "../../shared/accounts/execution-profile.ts";
import { readExecutionMeta } from "./registry.ts";

export interface BindingRequest {
  harnessId: string;
  accountId?: string | null;
  modelId: string;
  mode: string;
  provider?: string | null;
  fingerprint?: string | null;
}

export type BindingDecision = { ok: true; frozen: FrozenExecutionResource | null } | { ok: false; reason: string };

function fail(reason: string): BindingDecision {
  return { ok: false, reason };
}

/** Structural check. Does not spawn a provider CLI and does not select a substitute. */
export function explainBinding(request: BindingRequest, database: Database = db): BindingDecision {
  const blocked = isBlockedProvider(request.provider ?? request.harnessId, request.modelId);
  if (blocked) return fail(blocked);
  const harness = harnesses.get(request.harnessId);
  const managed = Boolean(harness && (isCodexProfile(harness) || isClaudeProfile(harness)));
  if (!request.accountId && !managed) return { ok: true, frozen: null };
  if (!request.accountId) return fail("A managed profile requires its registered account. The ambient default was not used.");
  if (!harness) return fail("Execution resource is missing. No other account was selected.");
  const meta = readExecutionMeta(database, request.accountId);
  if (meta.disabled || !harness.enabled) return fail("This account profile is disabled. A different profile was not selected.");
  try {
    if (isCodexProfile(harness)) {
      const account = selectedCodexAccount(harness);
      if (!account || account.id !== request.accountId) return fail("Account mismatch. The task stays on the requested profile.");
      const profile = account.codexProfile!;
      const frozen: Omit<FrozenExecutionResource, "fingerprint"> = {
        accountId: account.id,
        provider: account.provider,
        harnessId: harness.id,
        modelId: request.modelId,
        mode: request.mode,
        directory: profile.directory,
        directoryIdentity: profile.directoryIdentity,
      };
      const fingerprint = executionFingerprint(frozen);
      if (request.fingerprint && request.fingerprint !== fingerprint) return fail("Execution fingerprint changed. Launch was blocked instead of switching accounts.");
      if (meta.models.length > 0 && !meta.models.some((model) => model.id === request.modelId)) return fail("This model is not eligible on the requested account.");
      return { ok: true, frozen: { ...frozen, fingerprint } };
    }
    if (isClaudeProfile(harness)) {
      const account = selectedClaudeAccount(harness);
      if (!account || account.id !== request.accountId) return fail("Account mismatch. The task stays on the requested profile.");
      const profile = account.claudeProfile!;
      const frozen: Omit<FrozenExecutionResource, "fingerprint"> = {
        accountId: account.id,
        provider: account.provider,
        harnessId: harness.id,
        modelId: request.modelId,
        mode: request.mode,
        directory: profile.directory,
        directoryIdentity: profile.directoryIdentity,
      };
      const fingerprint = executionFingerprint(frozen);
      if (request.fingerprint && request.fingerprint !== fingerprint) return fail("Execution fingerprint changed. Launch was blocked instead of switching accounts.");
      if (meta.models.length > 0 && !meta.models.some((model) => model.id === request.modelId)) return fail("This model is not eligible on the requested account.");
      return { ok: true, frozen: { ...frozen, fingerprint } };
    }
    return fail("The requested account is not bound to this execution resource. No fallback account was used.");
  } catch (error) {
    return fail(error instanceof AccountCoreError ? error.message : "The requested account cannot launch. No fallback account was used.");
  }
}

/** Re-checks the selected profile's own authentication immediately before launch. */
export async function authenticateBinding(request: BindingRequest, database: Database = db): Promise<BindingDecision> {
  const structural = explainBinding(request, database);
  if (!structural.ok || !structural.frozen) return structural;
  const harness = harnesses.get(request.harnessId);
  if (!harness) return fail("Execution resource disappeared before launch.");
  try {
    if (isCodexProfile(harness)) await assertCodexProfileAuthentication(harness);
    if (isClaudeProfile(harness)) await assertClaudeProfileAuthentication(harness);
  } catch (error) {
    return fail(error instanceof AccountCoreError ? error.message : "Authentication check failed. No other account was selected.");
  }
  return explainBinding(request, database);
}

export function profileCapacityAllows(
  database: Database,
  accountId: string | undefined,
  perAccountMax: number,
  occupiedByAccount: Map<string, number>,
): { allow: boolean; reason?: string } {
  if (!accountId) return { allow: true };
  const occupied = occupiedByAccount.get(accountId) ?? 0;
  const meta = readExecutionMeta(database, accountId);
  const accountCap = meta.concurrencyLimit ?? perAccountMax;
  if (occupied >= Math.min(perAccountMax, accountCap)) {
    return { allow: false, reason: `Account concurrency limit (${Math.min(perAccountMax, accountCap)}) is full.` };
  }
  const provider = database.query<{ provider: string }, [string]>("SELECT provider FROM resource_accounts WHERE id = ?").get(accountId)?.provider;
  if (provider) {
    const siblings = database.query<{ id: string }, [string]>("SELECT id FROM resource_accounts WHERE provider = ?").all(provider);
    let shared: number | null = null;
    for (const sibling of siblings) {
      const limit = readExecutionMeta(database, sibling.id).providerSharedLimit;
      if (limit != null) shared = shared == null ? limit : Math.min(shared, limit);
    }
    if (shared != null) {
      let used = 0;
      for (const [id, count] of occupiedByAccount) {
        const other = database.query<{ provider: string }, [string]>("SELECT provider FROM resource_accounts WHERE id = ?").get(id)?.provider;
        if (other === provider) used += count;
      }
      if (used >= shared) return { allow: false, reason: `Shared provider concurrency limit (${shared}) is full.` };
    }
  }
  return { allow: true };
}

export function reservationBlocksRelaunch(status: string | null | undefined): boolean {
  return status === "reserved" || status === "starting" || status === "running" || status === "awaiting_qc" || status === "qc_running";
}
