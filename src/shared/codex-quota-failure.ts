/**
 * Trusted Codex quota-failure proof.
 *
 * Recovery and queue classification share this matcher. It accepts the
 * machine token `usage_limit_exceeded` and one exact Codex CLI diagnostic
 * sentence. It does not treat the words "quota" or "rate limit" as proof.
 *
 * The sentence match is the legacy CLI shape persisted on stderr when the
 * adapter stored `error.message` and dropped `codex_error_info`. Callers that
 * authorize recovery must still bind that sentence to a failed Codex run,
 * a Codex session id, and a `error:` / `turn.failed:` process event.
 */

export const CODEX_QUOTA_MACHINE_TOKEN = "usage_limit_exceeded";

/**
 * Whole-line Codex CLI usage-limit diagnostic. The clock is the only variable: older CLIs print
 * `9:31 PM`, 0.162 prints `Nov 16th, 2026 9:31 PM`. Neither states a time zone.
 */
const LEGACY_CODEX_USAGE_LIMIT_LINE =
  /^You['\u2019]ve hit your usage limit\. Upgrade to Pro \(https:\/\/chatgpt\.com\/explore\/pro\), visit https:\/\/chatgpt\.com\/settings\/usage to purchase more credits or try again at (?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01])(?:st|nd|rd|th), [0-9]{4} )?(?:[1-9]|1[0-2]):[0-5][0-9] [AP]M\.$/;

/** Line ids assigned by the Codex JSON adapter for provider error events. */
const CODEX_PROVIDER_ERROR_LINE = /^(?:error|turn\.failed):[0-9]{1,6}$/;

const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_PROFILE_AGENT = /^codex-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CodexQuotaProofDetail = "usage_limit_exceeded" | "codex-cli-usage-limit";

export interface CodexQuotaEvent {
  stream: string;
  data: string;
  lineUuid?: string | null;
  subagentId?: string | null;
}

export interface CodexQuotaRun {
  status: string;
  agent: string;
  codexSessionId: string | null;
}

export function isCodexProviderAgent(agent: string): boolean {
  return agent === "codex" || CODEX_PROFILE_AGENT.test(agent);
}

/**
 * The provider's own retry words from a matching usage-limit line, verbatim, or null.
 * The text names no time zone, so callers must not turn it into a clock time.
 */
export function codexUsageLimitRetryHint(text: string): string | null {
  const line = text.trim();
  if (!LEGACY_CODEX_USAGE_LIMIT_LINE.test(line)) return null;
  const at = line.lastIndexOf("try again at ");
  return at < 0 ? null : line.slice(at + "try again at ".length).replace(/\.$/, "");
}

export function legacyCodexUsageLimitLine(text: string): boolean {
  return LEGACY_CODEX_USAGE_LIMIT_LINE.test(text.trim());
}

/**
 * Text-only predicate for a stderr blob or a pause reason.
 * A legacy hit must be an entire line. Surrounding prose does not qualify.
 */
export function runStderrProvesQuotaExhausted(stderrText: string): boolean {
  if (stderrText.includes(CODEX_QUOTA_MACHINE_TOKEN)) return true;
  return stderrText.split(/\r?\n/).some((line) => legacyCodexUsageLimitLine(line));
}

function mainStderr(events: CodexQuotaEvent[]): CodexQuotaEvent[] {
  return events.filter((event) => event.stream === "stderr" && (event.subagentId == null || event.subagentId === ""));
}

/**
 * Process-bound proof. Machine token: failed-process stderr on this run.
 * Legacy sentence: that, plus a Codex provider agent, a Codex session id,
 * and a Codex `error` or `turn.failed` line id. Assistant, user, and status
 * text never qualifies.
 */
export function trustedCodexQuotaProof(run: CodexQuotaRun, events: CodexQuotaEvent[]): { detail: CodexQuotaProofDetail } | null {
  if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "orphaned") return null;
  const stderr = mainStderr(events);
  if (stderr.some((event) => event.data.includes(CODEX_QUOTA_MACHINE_TOKEN))) {
    return { detail: "usage_limit_exceeded" };
  }
  const legacy = stderr.some((event) =>
    CODEX_PROVIDER_ERROR_LINE.test(event.lineUuid ?? "") && legacyCodexUsageLimitLine(event.data),
  );
  if (!legacy) return null;
  if (!isCodexProviderAgent(run.agent)) return null;
  if (!run.codexSessionId || !CODEX_SESSION_ID.test(run.codexSessionId)) return null;
  return { detail: "codex-cli-usage-limit" };
}
