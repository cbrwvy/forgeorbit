/**
 * DeepSeek quota/balance provider — official read-only `/user/balance` endpoint.
 * Zero inference cost, strictly fail-soft (never throws into the poller), and
 * never fabricates numbers when no API key is configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Harness, HarnessQuota, QuotaMeter } from "../../shared/types.ts";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const FETCH_TIMEOUT_MS = 5000;

export function deepseekHome(harness: Harness): string {
  if (harness.home) return harness.home;
  const envHome = harness.env.DSH_HOME ?? process.env.DSH_HOME;
  if (envHome && envHome.trim()) return envHome.trim();
  return path.join(homedir(), ".dsh");
}

/**
 * Check whether DeepSeek has local credentials configured (API key env var or
 * non-empty `$DSH_HOME/.credentials.yaml` records). Read-only, never returns
 * secrets to callers.
 */
export function hasDeepSeekLocalCredentials(harness: Harness, env?: Record<string, string>): boolean {
  const effectiveKey = readDeepSeekApiKey(harness, env);
  if (effectiveKey) return true;
  try {
    const credsPath = path.join(deepseekHome(harness), ".credentials.yaml");
    if (!existsSync(credsPath)) return false;
    const raw = readFileSync(credsPath, "utf8");
    return /\brecords\s*:\s*\n\s*-/.test(raw) || /\b(?:token|secret)\s*:\s*["']?[^\s"']+/.test(raw);
  } catch {
    return false;
  }
}

/**
 * Resolve a DeepSeek API key (`sk-...`) from `harness.env`, `process.env`
 * (only when `harness.home === null`), or a DeepSeek `secret:` entry in
 * `$DSH_HOME/.credentials.yaml`. Returns `null` when only non-API-key auth is
 * present. Never throws.
 */
export function readDeepSeekApiKey(harness: Harness, env?: Record<string, string>): string | null {
  const fromHarness = harness.env.DEEPSEEK_API_KEY?.trim();
  if (fromHarness) return fromHarness;
  const fromEnv = env?.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (harness.home === null) {
    const ambient = process.env.DEEPSEEK_API_KEY?.trim();
    if (ambient) return ambient;
  }
  try {
    const credsPath = path.join(deepseekHome(harness), ".credentials.yaml");
    if (!existsSync(credsPath)) return null;
    const raw = readFileSync(credsPath, "utf8");
    // Match `secret: sk-...` or `secret: "sk-..."` inside `.credentials.yaml`
    const match = raw.match(/\bsecret\s*:\s*["']?(sk-[A-Za-z0-9_-]{12,})["']?/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface DeepSeekBalancePayload {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: string | number;
    granted_balance?: string | number;
    topped_up_balance?: string | number;
  }>;
}

/**
 * Pure parser for `GET https://api.deepseek.com/user/balance`.
 * Never invents a percentage denominator when only a monetary balance exists:
 * reports a clear balance meter (`0% used` when positive balance is available,
 * `100% used` when `is_available === false` or `total_balance <= 0`) and puts
 * the exact balance string in `planType` and meter `scope`.
 */
export function parseDeepSeekBalance(
  payload: unknown,
): { meters: QuotaMeter[]; planType: string | null } {
  if (!payload || typeof payload !== "object") return { meters: [], planType: null };
  const body = payload as DeepSeekBalancePayload;
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const available = body.is_available === true;

  const meters: QuotaMeter[] = [];
  let planSummary: string | null = null;

  for (const info of infos) {
    if (!info || typeof info !== "object") continue;
    const currency = typeof info.currency === "string" && info.currency.trim() ? info.currency.trim() : "USD";
    const totalNum = Number(info.total_balance);
    if (!Number.isFinite(totalNum)) continue;
    const formatted = `${totalNum.toFixed(2)} ${currency}`;
    if (!planSummary) planSummary = formatted;
    const hasFunds = available && totalNum > 0;
    meters.push({
      id: `balance_${currency.toLowerCase()}`,
      label: `Balance (${currency})`,
      scope: formatted,
      usedPercent: hasFunds ? 0 : 100,
      resetsAtMs: null,
    });
  }

  if (meters.length === 0 && typeof body.is_available === "boolean") {
    meters.push({
      id: "balance_status",
      label: "API balance",
      usedPercent: available ? 0 : 100,
      resetsAtMs: null,
    });
  }

  return { meters, planType: planSummary };
}

export async function fetchDeepSeekQuota(harness: Harness): Promise<HarnessQuota> {
  const now = Date.now();
  const apiKey = readDeepSeekApiKey(harness);
  if (!apiKey) {
    return {
      harnessId: harness.id,
      kind: harness.kind,
      planType: null,
      status: "unavailable",
      source: "api",
      fetchedAtMs: now,
      meters: [],
      reason: "DeepSeek balance requires DEEPSEEK_API_KEY (or an API key in ~/.dsh/.credentials.yaml).",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        harnessId: harness.id,
        kind: harness.kind,
        planType: null,
        status: "error",
        source: "api",
        fetchedAtMs: Date.now(),
        meters: [],
        reason: `DeepSeek balance endpoint returned HTTP ${res.status}.`,
      };
    }
    const body: unknown = await res.json();
    const { meters, planType } = parseDeepSeekBalance(body);
    return {
      harnessId: harness.id,
      kind: harness.kind,
      planType,
      status: meters.length > 0 ? "ok" : "unavailable",
      source: "api",
      fetchedAtMs: Date.now(),
      meters,
      reason: meters.length > 0 ? null : "DeepSeek returned no balance details.",
    };
  } catch {
    return {
      harnessId: harness.id,
      kind: harness.kind,
      planType: null,
      status: "error",
      source: "api",
      fetchedAtMs: Date.now(),
      meters: [],
      reason: "Could not reach DeepSeek balance API.",
    };
  } finally {
    clearTimeout(timer);
  }
}
