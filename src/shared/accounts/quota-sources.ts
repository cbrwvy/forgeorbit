/** Public documentation audit, not credential discovery. Antigravity and Codex rechecked 2026-11-07 (FO-009F-VERIFIED-QUOTA01). */
export interface QuotaSourceCapability {
  id: string;
  provider: string;
  harnessKinds: string[];
  label: string;
  documentation: "documented" | "user-provided-only" | "unsupported";
  acquisition: "eligible-interface" | "manual-only" | "excluded-cli" | "unsupported";
  officialUrl: string | null;
  checkedAt: string;
  metrics: string;
  authorization: string;
  identity: string;
  windows: string;
  sharedPool: string;
  poolIdentity: "documented" | "unknown";
  limitations: string;
}
const checkedAt = "2026-11-10";
export const QUOTA_SOURCES: readonly QuotaSourceCapability[] = [
  { id: "manual", provider: "*", harnessKinds: [], label: "User-provided observations", documentation: "user-provided-only", acquisition: "manual-only", officialUrl: null, checkedAt, poolIdentity: "unknown",
    metrics: "Explicit counts or typed percentages; unknown fields remain null.", authorization: "Local Owner bearer token.",
    identity: "Declared account only; never provider-verified.", windows: "User-declared independent windows and expiry.", sharedPool: "Unknown.",
    limitations: "Add an Observation manually. Provider Refresh is unavailable for user-provided data." },
  { id: "codex-app-server", provider: "openai", harnessKinds: ["codex"], label: "Codex app-server rate limits", documentation: "documented", acquisition: "eligible-interface",
    officialUrl: "https://learn.chatgpt.com/docs/app-server", checkedAt, poolIdentity: "unknown",
    metrics: "Used percentage per limit bucket, window duration and reset time; exact token/request balance unknown.",
    authorization: "Authenticated ChatGPT app-server connection; API-key mode is not subscription quota authorization.",
    identity: "Standard v2 account/read exposes auth mode, email and plan without a stable subject; workspaceRouting.chatgptAccountId is experimental-only. Identity remains Unassigned / Unverified.",
    windows: "Keep every limit ID and primary/secondary window separate; resetsAt uses epoch seconds.", sharedPool: "Bucket ID alone does not prove a shared pool across accounts.",
    limitations: "Explicit, consented local stdio authentication inspection only. No stable non-experimental subject or verified account binding: quota Refresh remains blocked and no production quota adapter is registered." },
  { id: "anthropic-admin", provider: "anthropic", harnessKinds: ["claude-code"], label: "Anthropic Admin usage and limits", documentation: "documented", acquisition: "eligible-interface",
    officialUrl: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api", checkedAt, poolIdentity: "unknown",
    metrics: "Historical API tokens/cost; separate configured rate limits and Claude Code analytics. Not a personal subscription balance.",
    authorization: "Admin API credential for the organization; workspace API keys are insufficient.",
    identity: "Organization/workspace/API-key or analytics actor dimensions; no current CLI identity proof.",
    windows: "Usage time buckets and configured API rate windows are different facts.", sharedPool: "Organization scope does not prove a personal shared subscription pool.",
    limitations: "No approved Admin connector, credential provisioning or verified organization binding. Personal subscription quota is user-provided only." },
  { id: "cursor-admin", provider: "cursor", harnessKinds: ["cursor"], label: "Cursor Team Admin usage", documentation: "documented", acquisition: "eligible-interface",
    officialUrl: "https://cursor.com/docs/account/teams/admin-api", checkedAt, poolIdentity: "unknown",
    metrics: "Team/member usage events, spending and spend limits; not a personal request/token balance.", authorization: "Admin-provisioned team API key using Basic authentication.",
    identity: "Team member records need explicit verified mapping; email alone is insufficient.", windows: "Date-range usage and billing/spend periods; do not merge.", sharedPool: "Team membership alone is not pool evidence.",
    limitations: "No approved connector, credential provisioning or verified team/member binding. Legacy cookies are excluded." },
  { id: "cursor-org-pool", provider: "cursor", harnessKinds: ["cursor"], label: "Cursor Organization pooled budget", documentation: "documented", acquisition: "eligible-interface",
    officialUrl: "https://cursor.com/docs/account/organizations/organization-admin-api", checkedAt, poolIdentity: "documented",
    metrics: "Organization pool limit, used and remaining cents; per-team spending.", authorization: "Organization API key and matching organizationId.",
    identity: "Verified organization plus linked team identity required; not the current CLI account.", windows: "Contract start/end may be null; no reset or freshness guarantee inferred.",
    sharedPool: "Documented organization-scoped pool; organization and contract identity must be proven before linking accounts.",
    limitations: "A read-only adapter exists. Refresh requires separately authorized organization credentials and an exact organization binding; none are configured." },
  { id: "gemini-cli", provider: "google", harnessKinds: ["gemini"], label: "Gemini CLI quota guidance", documentation: "unsupported", acquisition: "unsupported",
    officialUrl: "https://geminicli.com/docs/resources/quota-and-pricing/", checkedAt, poolIdentity: "unknown",
    metrics: "Plan guidance and Interactive /stats shows model quota where supported; no approved account-bound quota acquisition API found.", authorization: "Login, API key or Vertex credentials depending on product; none read here.",
    identity: "Unknown; plan labels are not account evidence.", windows: "Product-dependent request windows; published maxima do not prove remaining capacity.", sharedPool: "Product-dependent sharing; exact pool identity unknown.",
    limitations: "User-provided only. CLI execution, paid probes and internal Code Assist endpoints are excluded." },
  { id: "antigravity", provider: "google", harnessKinds: ["antigravity"], label: "Antigravity plan guidance", documentation: "unsupported", acquisition: "unsupported",
    officialUrl: "https://www.antigravity.google/docs/plans", checkedAt, poolIdentity: "unknown",
    metrics: "Rolling 5-hour and weekly plan guidance across model groups; agy 1.5.3 CLI/ACP expose no read-only account quota endpoint (interactive /usage TUI and active-session ACP usage_update only).", authorization: "No approved quota authorization mechanism configured.",
    identity: "Unknown; agy CLI/ACP expose no machine-readable account subject.", windows: "Plan-dependent 5-hour and weekly windows; displayed percentages are not unlimited or discrete counts, and no live remaining or reset is inferred from plan guidance.", sharedPool: "Unknown.",
    limitations: "User-provided only. Scraping, consumer OAuth session extraction and internal Cloud Code endpoints are excluded." },
  { id: "deepseek-api-balance", provider: "deepseek", harnessKinds: ["deepseek-dsh"], label: "DeepSeek API balance", documentation: "documented", acquisition: "eligible-interface",
    officialUrl: "https://api-docs.deepseek.com/api/get-user-balance/", checkedAt, poolIdentity: "unknown",
    metrics: "Available API credit by currency; not a request balance or evidence of DSH login.",
    authorization: "An explicitly authorized DeepSeek API key is required.", identity: "The response has no stable subject to match to the DSH account.",
    windows: "No reset or window in the response.", sharedPool: "Unknown.",
    limitations: "Record the displayed API credit from the DeepSeek platform. An account-bound authenticated connector is unavailable." },
  { id: "fx", provider: "fx", harnessKinds: ["fx"], label: "fx CLI usage", documentation: "documented", acquisition: "excluded-cli", officialUrl: "https://fx.sh/docs/using-fx/usage-and-costs", checkedAt, poolIdentity: "unknown",
    metrics: "fx /usage and usage --json expose gateway usage/spend or supported upstream plan data, depending on the current connection.", authorization: "CLI-managed provider login or API key; none read here.", identity: "Current provider/credential source would require CLI execution, excluded here.", windows: "Gateway today/7d/month use UTC; subscription quota windows are provider-specific.", sharedPool: "Upstream account may also be used by other apps; exact pool identity is unproven.",
    limitations: "Record the official fx /usage reading against the declared account. No authorized, independently verified upstream binding is available." },
];
export interface QuotaRefreshAvailability extends QuotaSourceCapability {
  implemented: boolean;
  adapterAvailableInCode?: boolean;
  refreshAvailable: boolean;
  reason: string;
}

export interface QuotaPoolEvidence { id: string; scope: string; window: string; verified: true }
export interface TrustedQuotaEvidence {
  provider: string;
  accountId: string;
  subject: string;
  method: "provider-account" | "organization-member" | "provider-organization";
  period?: { startAt: number | null; endAt: number | null };
  sourceId: string;
  officialUrl: string;
  checkedAt: string;
  receivedAt: number;
  sharedPool: QuotaPoolEvidence | null;
  limitations: string;
}
