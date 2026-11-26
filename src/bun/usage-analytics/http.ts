import type { TrustedQuotaRefresh } from "../trusted-quota.ts";
import { isTimeZone, type TrendGrain } from "../../shared/company-analytics.ts";
import type { AnalyticsFilter, ForecastSelection, PricingTerms } from "../../shared/usage-analytics.ts";
import { recordAdjustment } from "./adjustments.ts";
import { analytics, taskBreakdown, usageSelectors, type AnalyticsView } from "./analytics.ts";
import { renderAnalyticsExport } from "./export.ts";
import { bundleDownloadsDir, bundleSaveErrorMessage, writeBundleFile } from "../bundle.ts";
import { analyticsRecords } from "./records.ts";
import { estimateVersions, forecast, optionKey, FORECAST_MAX_TASKS } from "./forecast.ts";
import { createForecastAllocation } from "../allocation-plans.ts";
import { quotaHistory, savePricing, usageResources } from "./resources.ts";

const PREFIX = "/api/usage-analytics";
const FILTERS = ["clusterId", "projectPath", "taskId", "missionId", "specialist", "provider", "model", "accountId", "category"] as const;
const RATE_FIELDS = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const;

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) throw new Error("Invalid selection.");
  return value;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > 64_000) throw new Error("Request is too large.");
  const raw = await request.text();
  if (raw.length > 64_000) throw new Error("Request is too large.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

function filters(query: URLSearchParams): AnalyticsFilter {
  const filter: AnalyticsFilter = {};
  for (const key of FILTERS) {
    const value = query.get(key);
    if (value) filter[key] = text(value);
  }
  for (const key of ["from", "until"] as const) {
    const value = query.get(key);
    if (value == null) continue;
    if (!/^\d{1,15}$/.test(value)) throw new Error("Invalid date range.");
    filter[key] = Number(value);
  }
  if (filter.from !== undefined && filter.until !== undefined && filter.from >= filter.until) throw new Error("Invalid date range.");
  const ids = query.get("taskIds");
  if (ids) {
    const list = ids.split(",").map(value => value.trim()).filter(Boolean);
    if (!list.length || list.length > 50 || list.some(id => !/^[0-9a-f-]{8,36}$/i.test(id))) throw new Error("Choose up to 50 tasks.");
    filter.taskIds = list;
  }
  return filter;
}

function presentation(query: URLSearchParams): AnalyticsView {
  const timeZone = query.get("timeZone") ?? undefined;
  if (timeZone !== undefined && !isTimeZone(timeZone)) throw new Error("Invalid timezone.");
  const grain = query.get("grain");
  if (grain !== null && grain !== "day" && grain !== "week" && grain !== "month") throw new Error("Invalid grouping.");
  return { timeZone, grain: grain === null ? undefined : grain as TrendGrain };
}

function forecastInput(value: Record<string, unknown>): ForecastSelection {
  const output: ForecastSelection = { save: value.save === true, ...(value.compareAllocations === true ? { compareAllocations: true } : {}) };
  for (const key of ["projectPath", "clusterId", "missionId"] as const) {
    if (value[key] != null) output[key] = text(value[key]);
  }
  if (value.taskIds != null) {
    if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > FORECAST_MAX_TASKS) throw new Error("Choose 1–100 tasks.");
    output.taskIds = value.taskIds.map(text);
  }
  if (value.concurrency != null) {
    if (typeof value.concurrency !== "number" || !Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 32) throw new Error("Concurrency must be 1–32.");
    output.concurrency = value.concurrency;
  }
  if (value.projectPaths != null) {
    if (!Array.isArray(value.projectPaths) || !value.projectPaths.length || value.projectPaths.length > 32) throw new Error("Choose 1–32 projects.");
    output.projectPaths = value.projectPaths.map(text);
  }
  if (value.alternative != null) {
    if (typeof value.alternative !== "object" || Array.isArray(value.alternative)) throw new Error("Invalid alternative.");
    const { taskId, optionKey } = value.alternative as Record<string, unknown>;
    output.alternative = { taskId: text(taskId), optionKey: text(optionKey) };
  }
  if (value.assumptions != null) {
    if (typeof value.assumptions !== "object" || Array.isArray(value.assumptions)) throw new Error("Invalid scheduling assumptions.");
    const { unknownCapacity, startAuthorized, refillAtReset, activeReleaseMs, quotaWindows } = value.assumptions as Record<string, unknown>;
    if (startAuthorized != null && typeof startAuthorized !== "boolean" || unknownCapacity != null && typeof unknownCapacity !== "boolean" || refillAtReset != null && typeof refillAtReset !== "boolean" ||
      activeReleaseMs != null && (typeof activeReleaseMs !== "number" || !Number.isSafeInteger(activeReleaseMs) || activeReleaseMs < 0 || activeReleaseMs > 7 * 86_400_000)) {
      throw new Error("Invalid scheduling assumptions.");
    }
    const now = Date.now();
    if (quotaWindows !== undefined && (!Array.isArray(quotaWindows) || quotaWindows.length > 8 ||
      quotaWindows.some(window => !window || typeof window !== "object" || typeof window.poolId !== "string" ||
        window.poolId.length < 1 || window.poolId.length > 512 || !Number.isSafeInteger(window.allowance) || window.allowance < 1 ||
        !Number.isSafeInteger(window.startsAt) || !Number.isSafeInteger(window.endsAt) || window.startsAt <= now ||
        window.endsAt <= window.startsAt || window.endsAt > now + 90 * 86_400_000))) {
      throw new Error("Choose up to eight bounded future quota windows with positive allowances in the pool's native unit.");
    }
    output.assumptions = { unknownCapacity: unknownCapacity === true, startAuthorized: startAuthorized === true, refillAtReset: refillAtReset === true,
      activeReleaseMs: typeof activeReleaseMs === "number" ? activeReleaseMs : undefined, quotaWindows };
  }
  if (output.missionId && (output.taskIds || output.projectPath || output.projectPaths || output.clusterId)) throw new Error("A mission forecast uses its approved scope.");
  return output;
}


/** The export for the scope in the query: one build shared by the download response and the save-to-disk route. */
function buildExport(url: URL) {
  const format = url.searchParams.get("format");
  const report = url.searchParams.get("report");
  if ((format !== "csv" && format !== "json") || (report !== "tasks" && report !== "models" && report !== "runs")) throw new Error("Choose a tasks, models or runs export.");
  const view = presentation(url.searchParams);
  const now = Date.now();
  const filter = filters(url.searchParams);
  // The report and its records read one scope, so an export matches the figures on screen.
  const result = analytics(filter, now, undefined, { ...view, taskLimit: 500 });
  // Every record in the scope, not the screen's capped list: the file must hold what the figures were built from.
  const records = analyticsRecords(filter, now, undefined, Number.MAX_SAFE_INTEGER);
  return renderAnalyticsExport(result, report, format, { timeZone: view.timeZone ?? "UTC", grain: view.grain ?? "day", records });
}

function exportResponse(url: URL): Response {
  const file = buildExport(url);
  return new Response(file.body, { headers: { "content-type": file.type, "content-disposition": `attachment; filename="${file.filename}"`, "cache-control": "no-store" } });
}

/**
 * Save the export beside the app's other exports (Downloads, or `AGETOR_DOWNLOADS_DIR`), never overwriting. A blob
 * `<a download>` does nothing in the packaged WKWebView, so the core writes the file and reports where it went.
 */
function saveExport(url: URL): Response {
  const file = buildExport(url);
  const dir = bundleDownloadsDir();
  try {
    const written = writeBundleFile(dir, file.filename, file.body, { createDir: true });
    return Response.json({ path: written.path, filename: written.filename }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    return Response.json({ error: bundleSaveErrorMessage(cause, "downloads", dir) }, { status: 500 });
  }
}

export async function usageAnalyticsHttp(request: Request, authorized: boolean, sources?: TrustedQuotaRefresh): Promise<Response> {
  if (!authorized) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(request.url);
  if (url.searchParams.has("token")) return Response.json({ error: "Use an authorization header." }, { status: 400 });
  const route = url.pathname.slice(PREFIX.length);
  try {
    if (request.method === "GET") {
      if (route === "/resources") return Response.json(usageResources(sources));
      if (route === "/quota-history") {
        const before = url.searchParams.get("before");
        return Response.json(quotaHistory(text(url.searchParams.get("quotaId")), before === null ? null : Number(before)),
          { headers: { "Cache-Control": "no-store" } });
      }
      if (route === "/selectors") return Response.json(usageSelectors());
      if (route === "/analytics") {
        const view = presentation(url.searchParams);
        return Response.json(analytics(filters(url.searchParams), Date.now(), undefined, view));
      }
      if (route === "/records") return Response.json(analyticsRecords(filters(url.searchParams)), { headers: { "Cache-Control": "no-store" } });
      if (route === "/export") return exportResponse(url);
      if (route === "/task") {
        const id = text(url.searchParams.get("taskId"));
        const breakdown = taskBreakdown(id);
        if (!breakdown) return Response.json({ error: "Task was not found." }, { status: 404 });
        return Response.json({ ...breakdown, revisions: estimateVersions(id) });
      }
    }
    if (request.method === "POST") {
      if (route === "/export/save") return saveExport(url);
      if (route === "/forecast") return Response.json(forecast(forecastInput(await body(request))));
      if (route === "/fallback-proposal") {
        const value = await body(request);
        const taskId = text(value.taskId);
        const selection = { taskIds: [taskId] };
        const baseline = forecast(selection);
        const original = baseline.estimates[0];
        const alternative = { taskId, optionKey: text(value.optionKey) };
        const proposed = forecast({ ...selection, alternative });
        const estimate = proposed.estimates[0];
        const option = estimate?.proposedResource;
        if (!original?.plannedResource || !estimate || !option?.accountId ||
          original.developer && optionKey(original.developer) === alternative.optionKey) {
          throw new Error("Select a different available, registered Developer resource.");
        }
        const a = original.plannedUsage;
        const b = estimate.plannedUsage;
        const prior = a.totals[0], next = b.totals[0];
        const costDelta = a.unknown === 0 && b.unknown === 0 && a.subscription === 0 && b.subscription === 0 &&
          a.totals.length === 1 && b.totals.length === 1 && prior?.kind === "calculated-api" &&
          next?.kind === prior.kind && next.currency === prior.currency ? { amount: next.amount - prior.amount, currency: next.currency } : null;
        return Response.json(createForecastAllocation(taskId, {
          optionId: alternative.optionKey, harnessId: option.harnessId, harnessLabel: option.label, kind: option.provider,
          modelId: option.modelId, modelLabel: option.modelId, modeId: option.mode, modeLabel: option.mode,
          accountId: option.accountId, accountLabel: option.accountLabel, resourceFingerprint: null, eligibility: "eligible",
          eligibilityReasons: [], limitations: [], unknownFacts: [], blockers: [], selectable: true,
        }, {
          original: original.plannedResource,
          reason: original.developer?.eligibility === "eligible" && !baseline.capacity.rows.some(pool => pool.status === "exhausted" || pool.status === "insufficient")
            ? "owner-comparison" : "resource-unavailable",
          timeDeltaMs: estimate.completion.expected - original.completion.expected, costDelta, confidence: estimate.confidence,
          pools: proposed.capacity.rows.map(p => ({ id: p.id, status: p.status, knownDemand: p.knownDemand, unknownStages: p.unknownStages })),
        }), { status: 201 });
      }
      if (route === "/adjustments") {
        const value = await body(request);
        const amount = value.amount;
        if (typeof amount !== "number") throw new Error("Enter an adjustment amount from 0 through 1 billion.");
        const supersedes = value.supersedes == null || value.supersedes === "" ? null : value.supersedes;
        if (supersedes !== null && (typeof supersedes !== "number" || !Number.isInteger(supersedes) || supersedes < 1)) throw new Error("Invalid adjustment revision.");
        return Response.json(recordAdjustment({
          taskId: text(value.taskId), runId: value.runId == null || value.runId === "" ? null : text(value.runId),
          amount, currency: text(value.currency), note: text(value.note), supersedes,
        }), { status: 201 });
      }
      if (route === "/pricing") {
        const value = await body(request);
        const billing = value.billing;
        if (billing !== "api" && billing !== "subscription" && billing !== "internal" && billing !== "unknown") throw new Error("Invalid billing classification.");
        const currency = text(value.currency);
        if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Use a three-letter currency code.");
        const rates = {} as Pick<PricingTerms, typeof RATE_FIELDS[number]>;
        for (const key of RATE_FIELDS) {
          const rate = value[key];
          if (rate != null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1_000_000)) {
            throw new Error("Pricing rates must be between zero and one million.");
          }
          rates[key] = typeof rate === "number" ? rate : null;
        }
        const result = savePricing({
          harnessId: text(value.harnessId), modelId: text(value.modelId), accountId: value.accountId == null ? null : text(value.accountId),
        }, { billing, currency, ...rates });
        return Response.json(result, { status: 201 });
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    // Validation messages are fixed strings. Keep SQLite and parsing details
    // (including fragments of submitted input) out of HTTP error responses.
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "SQLiteError")) {
      return Response.json({ error: "Usage data could not be read or saved." }, { status: 400 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Usage analytics request failed." }, { status: 400 });
  }
}
