/**
 * Offline scenarios for task runs (Developer and Reviewer) that end the way a Codex process ends when
 * the provider answers a request with a usage-limit refusal, and the look-alikes that must NOT count as
 * one. Used by the fake Codex driver only (`AGETOR_CODEX_DRIVER=fake`). Nothing here contacts a provider.
 *
 * A task prompt carries `__fake_provider__:<variant>`. A QC Reviewer takes `USAGE_LIMIT` through the
 * existing fake verdict token instead (`AGETOR_FAKE_QC_VERDICT`).
 */
export const FAKE_PROVIDER_PROMPT_MARKER = "__fake_provider__:";
export const FAKE_QC_USAGE_LIMIT_TOKEN = "USAGE_LIMIT";

export interface FakeProviderScenario {
  code: number;
  assistant: string | null;
  stderrEvents: { data: string; lineUuid?: string }[];
}

const SENTENCE = (clock: string) =>
  `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${clock}.`;

export const FAKE_QC_USAGE_LIMIT_CLOCK = "Nov 16th, 2026 9:31 PM";

/** The scenario a task prompt asks for, or null when it names none. */
export function fakeProviderScenario(prompt: string): FakeProviderScenario | null {
  const at = prompt.lastIndexOf(FAKE_PROVIDER_PROMPT_MARKER);
  if (at < 0) return null;
  const variant = /^[a-z-]+/.exec(prompt.slice(at + FAKE_PROVIDER_PROMPT_MARKER.length))?.[0] ?? "";
  switch (variant) {
    case "usage-limit": return { code: 1, assistant: null, stderrEvents: [{ data: SENTENCE(FAKE_QC_USAGE_LIMIT_CLOCK), lineUuid: "error:1" }] };
    case "usage-limit-clock": return { code: 1, assistant: null, stderrEvents: [{ data: SENTENCE("9:31 PM"), lineUuid: "turn.failed:1" }] };
    case "usage-limit-token": return { code: 1, assistant: null, stderrEvents: [{ data: JSON.stringify({ type: "error", error: { codex_error_info: "usage_limit_exceeded" } }), lineUuid: "error:1" }] };
    // Model text that merely resembles the refusal, on a failed run with an unrelated provider error.
    case "text": return { code: 1, assistant: SENTENCE(FAKE_QC_USAGE_LIMIT_CLOCK), stderrEvents: [{ data: "codex turn failed", lineUuid: "error:1" }] };
    // The sentence on a stderr line the adapter did not mark as a provider error.
    case "unmarked": return { code: 1, assistant: null, stderrEvents: [{ data: SENTENCE(FAKE_QC_USAGE_LIMIT_CLOCK) }] };
    case "rate-limit": return { code: 1, assistant: null, stderrEvents: [{ data: "Rate limit reached for requests. Please try again in 20s.", lineUuid: "error:1" }] };
    case "auth": return { code: 1, assistant: null, stderrEvents: [{ data: "401 Unauthorized: authentication failed. Run codex login.", lineUuid: "error:1" }] };
    case "unsupported-model": return { code: 1, assistant: null, stderrEvents: [{ data: "model_not_found: model is unavailable for this account.", lineUuid: "error:1" }] };
    case "permission": return { code: 1, assistant: null, stderrEvents: [{ data: "403 Forbidden: permission denied.", lineUuid: "error:1" }] };
    case "network": return { code: 1, assistant: null, stderrEvents: [{ data: "Connection timed out.", lineUuid: "error:1" }] };
    // The model's own message resembling the sentence, on a SUCCESSFUL run: not a refusal, an ordinary answer.
    case "ok-text": return { code: 0, assistant: SENTENCE(FAKE_QC_USAGE_LIMIT_CLOCK), stderrEvents: [] };
    default: return null;
  }
}

/** The Reviewer's refusal, as the QC fake driver emits it. */
export function fakeQcUsageLimitEvents(): { data: string; lineUuid: string }[] {
  return [{ data: SENTENCE(FAKE_QC_USAGE_LIMIT_CLOCK), lineUuid: "error:1" }];
}
