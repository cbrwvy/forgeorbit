/**
 * FO-BROWSER01. Owner-controlled browser session contract.
 * Webpage content is untrusted data. These types carry no cookies,
 * storage, or hidden form values.
 */

export const BROWSER_LIMITS = {
  maxActiveSessions: 1,
  idleTimeoutMs: 15 * 60 * 1000,
  maxLifetimeMs: 60 * 60 * 1000,
  maxVisibleTextChars: 16_000,
  maxLinks: 50,
  maxLinkTextChars: 200,
  maxTitleChars: 300,
  maxScreenshotBytes: 1_500_000,
  maxHistory: 40,
  maxUrlChars: 2_048,
  navigationTimeoutMs: 20_000,
  maxOrigins: 4,
} as const;

export type BrowserSessionState = "starting" | "active" | "closing" | "closed" | "failed";

export type BrowserRefusalCode =
  | "invalid_request"
  | "https_required"
  | "scheme_forbidden"
  | "credentials_in_url"
  | "private_network"
  | "loopback_forbidden"
  | "metadata_endpoint"
  | "origin_not_approved"
  | "protocol_downgrade"
  | "redirect_forbidden"
  | "download_forbidden"
  | "dns_rebinding"
  | "dns_unresolved"
  | "link_not_permitted"
  | "link_stale"
  | "no_history"
  | "session_limit"
  | "session_closed"
  | "session_expired"
  | "session_failed"
  | "not_found"
  | "browser_runtime_unavailable"
  | "browser_crashed";

export interface BrowserSessionView {
  id: string;
  createdAt: number;
  url: string | null;
  history: string[];
  state: BrowserSessionState;
  ownerId: "owner";
  approvedOrigins: string[];
  expiresAt: number;
  idleTimeoutMs: number;
  lastActivityAt: number;
  pid: number | null;
  /** Last page title read by an observation. Empty until the Owner or a grant reads the page. */
  pageTitle: string | null;
  error: { code: string; message: string } | null;
  /** Cookies and site data exist only inside this session's profile, then the profile is deleted. */
  storage: "ephemeral-session-profile";
  /** Agent browser control is a later milestone. This field is never "available" in FO-BROWSER01. */
  agentControl: "unavailable";
}

export interface BrowserLink {
  id: string;
  href: string;
  text: string;
  permitted: boolean;
}

export interface BrowserObservation {
  sessionId: string;
  observationId: string;
  url: string | null;
  title: string;
  navigationState: "idle" | "complete";
  visibleText: string;
  textChars: number;
  textTruncated: boolean;
  links: BrowserLink[];
  linksTruncated: boolean;
  screenshot: { available: boolean; bytes: number; capturedAt: number | null };
  observedAt: number;
  contentBytes: number;
  untrusted: true;
}
