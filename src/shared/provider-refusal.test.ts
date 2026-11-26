import { expect, test } from "bun:test";
import {
  codexUsageLimitRetryHint,
  legacyCodexUsageLimitLine,
  trustedCodexQuotaProof,
} from "./codex-quota-failure.ts";
import { PROVIDER_REFUSAL_PREFLIGHT_WARNING, refusalApplies } from "./provider-refusal.ts";
import { evaluateAccountEligibility, type AccountResourceEvidence } from "./model-router/account-eligibility.ts";
import { knownText } from "../mainview/lib/known-text.ts";

const PREFIX = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at";
const DATED = `${PREFIX} Nov 16th, 2026 9:31 PM.`;
const CLOCK = `${PREFIX} 9:31 PM.`;
const SESSION = "0194f6a2-8b1c-7d3e-9f40-1a2b3c4d5e6f";
const run = (over: Partial<{ status: string; agent: string; codexSessionId: string | null }> = {}) =>
  ({ status: "failed", agent: "codex", codexSessionId: SESSION, ...over });
const stderr = (data: string, lineUuid: string | null = "error:1") => ({ stream: "stderr", data, lineUuid });

test("the dated and the clock-only provider sentence are both recognized, and the hint is kept verbatim", () => {
  expect(legacyCodexUsageLimitLine(DATED)).toBe(true);
  expect(legacyCodexUsageLimitLine(CLOCK)).toBe(true);
  // No time zone is stated, so the hint is never converted or completed.
  expect(codexUsageLimitRetryHint(DATED)).toBe("Nov 16th, 2026 9:31 PM");
  expect(codexUsageLimitRetryHint(CLOCK)).toBe("9:31 PM");
});

test("a missing, extended or malformed hint yields no hint and no proof from that line", () => {
  expect(codexUsageLimitRetryHint("You've hit your usage limit.")).toBeNull();
  expect(codexUsageLimitRetryHint(`${DATED} Please wait.`)).toBeNull();
  expect(codexUsageLimitRetryHint(`${PREFIX} tomorrow.`)).toBeNull();
  expect(codexUsageLimitRetryHint(`${PREFIX} Nov 99th, 2026 9:31 PM.`)).toBeNull();
  expect(legacyCodexUsageLimitLine(`${PREFIX} 13:31 PM.`)).toBe(false);
});

test("proof needs provider process evidence: failed Codex run, session id, provider line id", () => {
  expect(trustedCodexQuotaProof(run(), [stderr(DATED)])).toEqual({ detail: "codex-cli-usage-limit" });
  expect(trustedCodexQuotaProof(run({ agent: "codex-profile-0194f6a2-8b1c-7d3e-9f40-1a2b3c4d5e6f" }), [stderr(CLOCK, "turn.failed:2")])).toEqual({ detail: "codex-cli-usage-limit" });
  expect(trustedCodexQuotaProof(run({ status: "succeeded" }), [stderr(DATED)])).toBeNull();
  expect(trustedCodexQuotaProof(run({ codexSessionId: null }), [stderr(DATED)])).toBeNull();
  expect(trustedCodexQuotaProof(run({ agent: "claude-code" }), [stderr(DATED)])).toBeNull();
  // No provider line id: stderr text alone is not proof.
  expect(trustedCodexQuotaProof(run(), [stderr(DATED, null)])).toBeNull();
});

test("model text that resembles a quota error is not proof", () => {
  expect(trustedCodexQuotaProof(run(), [{ stream: "assistant", data: DATED, lineUuid: "error:1" }])).toBeNull();
  expect(trustedCodexQuotaProof(run(), [{ stream: "user", data: DATED, lineUuid: "error:1" }])).toBeNull();
  expect(trustedCodexQuotaProof(run(), [{ stream: "status", data: DATED, lineUuid: "error:1" }])).toBeNull();
  expect(trustedCodexQuotaProof(run(), [stderr("Rate limit reached for gpt-6.1-sol. Try again in 20s.", "error:1")])).toBeNull();
  expect(trustedCodexQuotaProof(run(), [stderr("codex turn failed", "error:1")])).toBeNull();
  expect(trustedCodexQuotaProof(run(), [stderr("401 Unauthorized: invalid credentials", "error:1")])).toBeNull();
});

test("the machine token is proof on its own and carries no hint", () => {
  expect(trustedCodexQuotaProof(run(), [stderr('{"codex_error_info":"usage_limit_exceeded"}', null)])).toEqual({ detail: "usage_limit_exceeded" });
});

const scope = { harnessId: "codex-profile-a", accountId: "acct-a", modelId: "gpt-6.1-sol" };
const refusal = { ...scope, supersededAt: null };

test("a refusal covers only the account and model it was observed on", () => {
  expect(refusalApplies(refusal, scope)).toBe(true);
  expect(refusalApplies(refusal, { ...scope, accountId: "acct-b" })).toBe(false);
  expect(refusalApplies(refusal, { ...scope, accountId: null })).toBe(false);
  expect(refusalApplies(refusal, { ...scope, harnessId: "codex" })).toBe(false);
  expect(refusalApplies(refusal, { ...scope, modelId: "gpt-6-luna" })).toBe(false);
  // An unidentified account is its own scope and never covers a registered one.
  expect(refusalApplies({ ...refusal, accountId: null }, scope)).toBe(false);
  expect(refusalApplies({ ...refusal, accountId: null }, { ...scope, accountId: null })).toBe(true);
  // No model recorded: the account's requests are covered.
  expect(refusalApplies({ ...refusal, modelId: null }, { ...scope, modelId: "gpt-6-luna" })).toBe(true);
  expect(refusalApplies({ ...refusal, supersededAt: 5 }, scope)).toBe(false);
});

const evidence: AccountResourceEvidence = { account: { id: "acct-a", label: "A", provider: "openai" }, fingerprint: "digest", configuration: "valid", authentication: "authenticated", model: "supported", capabilities: ["read-only"], access: "read-only" };
const base = { evidence, role: "head" as const, kind: "codex", enabled: true, installed: true, modeSupported: true, policyBlocked: false, permissionBlocked: false };

test("a refusal makes the resource Unknown, never ineligible and never eligible, and keeps the sign-in fact", () => {
  expect(evaluateAccountEligibility(base).state).toBe("eligible");
  const refused = evaluateAccountEligibility({ ...base, evidence: { ...evidence, providerRefusal: { ...refusal, id: "r", kind: "usage-limit", provider: "codex", observedAt: 1, surface: "head-turn", proof: "codex-cli-usage-limit", retryHint: null, diagnostics: "" } } });
  expect(refused.state).toBe("unknown");
  expect(refused.reasons.map((r) => r.code)).toEqual(["provider-usage-limit-refused"]);
  expect(refused.evidence.authentication).toBe("authenticated");
});

test("the preflight sentence has an exact Russian rendering", () => {
  expect(knownText(PROVIDER_REFUSAL_PREFLIGHT_WARNING, "ru")).not.toBe(PROVIDER_REFUSAL_PREFLIGHT_WARNING);
});
