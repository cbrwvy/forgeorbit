import type { EstimationResult } from "../../shared/estimation/types.ts";
import type { RoutingPreview } from "../../shared/model-router/types.ts";
import type { ModelRouterResourceContext } from "../../shared/model-router/resource-context.ts";
import type { TaskPreviewRequest, PortfolioPreviewRequest } from "./model-router-preview.ts";

export interface TaskPreviewResponse {
  preview: RoutingPreview;
  planningEstimate: EstimationResult | null;
}

export interface PortfolioPreviewResponse {
  readOnly: true;
  execution: "preview-only";
  previews: RoutingPreview[];
  planningEstimates: { taskId: string; estimate: EstimationResult | null }[];
}

type Transport = <T>(
  path: string,
  init?: RequestInit,
  opts?: { retry?: boolean },
) => Promise<T>;

/**
 * Read-only client for the existing model-router endpoints.
 * Uses the caller's bearer transport. Preview is not retried: a retry during
 * fast task switching would repeat a calculation the owner already replaced.
 * The body is calculation input only. This module has no credential, home,
 * or command fields and does not start a harness.
 */
export function createModelRouterApi(request: Transport) {
  const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), signal }, { retry: false });
  const get = <T>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: "GET", signal }, { retry: false });
  return {
    managerRecommendations: (body: { role: "project-manager" | "head"; harnessId: string; model: string }, signal?: AbortSignal) => post<import("../../shared/execution/executor-routing.ts").ExecutorRecommendations>("/model-router/manager-recommendations", body, signal),
    resourceContext: (signal?: AbortSignal) => get<ModelRouterResourceContext>("/model-router/resource-context", signal),
    preview: (body: TaskPreviewRequest, signal?: AbortSignal) =>
      post<TaskPreviewResponse>("/model-router/preview", body, signal),
    portfolioPreview: (body: PortfolioPreviewRequest, signal?: AbortSignal) =>
      post<PortfolioPreviewResponse>("/model-router/portfolio-preview", body, signal),
  };
}

/** One in-flight preview. A newer begin() aborts the previous signal. */
export function createPreviewSession() {
  let latest = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      latest += 1;
      controller?.abort();
      controller = new AbortController();
      const id = latest;
      const signal = controller.signal;
      return { id, signal, isCurrent: () => id === latest && !signal.aborted };
    },
    invalidate() {
      latest += 1;
      controller?.abort();
      controller = null;
    },
  };
}
