/**
 * What-if is a pure copy. The caller's request is not modified, and nothing
 * is persisted.
 */

import type { EstimationIssue, EstimationRequest, WhatIfPatch, WorkItemInput } from "./types.ts";

function issue(path: string, message: string): EstimationIssue {
  return { severity: "error", code: "what-if-target", path, message };
}

export function applyWhatIf(request: EstimationRequest, patch: WhatIfPatch): { request: EstimationRequest; issues: EstimationIssue[] } {
  const next = structuredClone(request);
  const issues: EstimationIssue[] = [];

  if (patch.dropItemIds) {
    const drop = new Set(patch.dropItemIds);
    for (const id of drop) {
      if (!next.items.some((item) => item.id === id)) issues.push(issue(`items.${id}`, `What-if cannot drop unknown item ${id}.`));
    }
    next.items = next.items.filter((item) => !drop.has(item.id));
  }

  if (patch.upsertItems) {
    for (const item of patch.upsertItems) {
      const index = next.items.findIndex((current) => current.id === item.id);
      if (index >= 0) next.items[index] = structuredClone(item);
      else next.items.push(structuredClone(item));
    }
  }

  const find = (itemId: string, stageId: string): { item: WorkItemInput; stageIndex: number } | null => {
    const item = next.items.find((current) => current.id === itemId);
    if (!item) return null;
    const stageIndex = item.stages.findIndex((stage) => stage.id === stageId);
    if (stageIndex < 0) return null;
    return { item, stageIndex };
  };

  for (const change of patch.stageEfforts ?? []) {
    const found = find(change.itemId, change.stageId);
    if (!found) {
      issues.push(issue(`items.${change.itemId}.stages.${change.stageId}`, "What-if effort target was not found."));
      continue;
    }
    const stage = found.item.stages[found.stageIndex];
    if (!stage) continue;
    stage.effort = change.effort === null ? null : structuredClone(change.effort);
  }

  for (const change of patch.stageAssignments ?? []) {
    const found = find(change.itemId, change.stageId);
    if (!found) {
      issues.push(issue(`items.${change.itemId}.stages.${change.stageId}`, "What-if assignment target was not found."));
      continue;
    }
    const stage = found.item.stages[found.stageIndex];
    if (!stage) continue;
    if ("harnessId" in change) stage.harnessId = change.harnessId;
    if ("modelId" in change) stage.modelId = change.modelId;
    if ("accountId" in change) stage.accountId = change.accountId;
    if ("consumption" in change) stage.consumption = change.consumption === undefined ? stage.consumption : structuredClone(change.consumption);
  }

  for (const change of patch.dependencies ?? []) {
    const item = next.items.find((current) => current.id === change.itemId);
    if (!item) {
      issues.push(issue(`items.${change.itemId}.dependsOn`, "What-if dependency target was not found."));
      continue;
    }
    item.dependsOn = [...change.dependsOn];
  }

  if (patch.parallelism) next.parallelism = structuredClone(patch.parallelism);
  if (patch.budget) next.budget = structuredClone(patch.budget);
  if (patch.allocation) next.allocation = structuredClone(patch.allocation);
  if (patch.machine) next.machine = structuredClone(patch.machine);
  if (patch.exchangeRates) next.exchangeRates = structuredClone(patch.exchangeRates);
  if ("apiRates" in patch) next.apiRates = patch.apiRates === null || patch.apiRates === undefined ? patch.apiRates ?? null : structuredClone(patch.apiRates);

  for (const account of patch.upsertAccounts ?? []) {
    const index = next.accounts.findIndex((current) => current.id === account.id);
    if (index >= 0) next.accounts[index] = structuredClone(account);
    else next.accounts.push(structuredClone(account));
  }
  for (const subscription of patch.upsertSubscriptions ?? []) {
    const index = next.subscriptions.findIndex((current) => current.id === subscription.id);
    if (index >= 0) next.subscriptions[index] = structuredClone(subscription);
    else next.subscriptions.push(structuredClone(subscription));
  }

  return { request: next, issues };
}
