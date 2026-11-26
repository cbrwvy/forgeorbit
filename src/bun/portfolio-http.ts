/**
 * GET /portfolio/analysis (FO-008B).
 *
 * Reads a snapshot and returns `analyzePortfolio`. Nothing is written, and
 * no harness, model, or container is started.
 */

import { analyzePortfolio } from "../shared/portfolio/index.ts";
import type { PortfolioAnalysis, PortfolioSnapshotInput } from "../shared/portfolio/types.ts";
import { buildPortfolioSnapshot } from "./portfolio-adapter.ts";

const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export interface PortfolioAnalysisResponse {
  analysis: PortfolioAnalysis;
  snapshot: PortfolioSnapshotInput;
  adapterWarnings: string[];
  capturedAtMs: number;
  accountResources: ReturnType<typeof buildPortfolioSnapshot>["accountResources"];
}

export function getPortfolioAnalysis(): { status: number; body: PortfolioAnalysisResponse | { error: string } } {
  let built;
  try {
    built = buildPortfolioSnapshot();
  } catch {
    return { status: 500, body: { error: "Portfolio data could not be read. Counts were not replaced with zeros." } };
  }
  const analysis = analyzePortfolio(built.snapshot);
  const body: PortfolioAnalysisResponse = {
    analysis,
    accountResources: built.accountResources,
    snapshot: built.snapshot,
    adapterWarnings: built.warnings,
    capturedAtMs: built.snapshot.capturedAtMs,
  };
  const bytes = byteLength(body);
  if (bytes > RESPONSE_MAX_BYTES) {
    return {
      status: 413,
      body: { error: `Portfolio analysis is ${bytes} bytes, above the ${RESPONSE_MAX_BYTES} byte response limit.` },
    };
  }
  if (!analysis.ok) {
    const detail = analysis.issues.find((issue) => issue.severity === "error")?.message ?? "The snapshot was rejected.";
    return { status: 422, body: { error: `Portfolio analysis was not produced. ${detail}` } };
  }
  return { status: 200, body };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
