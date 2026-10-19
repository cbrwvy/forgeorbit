/**
 * Pure helpers for ForgeOrbit's custom URL scheme (`forgeorbit://`, with
 * backward compatibility for legacy `agetor://`), used to deep link from
 * outside the app (e.g. a notification click) back into a specific task:
 *
 *   forgeorbit://task/<taskId>
 *
 * Kept dependency-free and side-effect-free at import time so it's trivially
 * unit-testable and safe to import from both the main process and tests.
 */

/** The app's custom URL scheme, without the trailing colon. */
export const APP_URL_SCHEME = "forgeorbit";

/** Legacy URL scheme accepted for backward compatibility. */
export const LEGACY_APP_URL_SCHEME = "agetor";

/**
 * Builds a deep link that opens a given task, e.g.
 *   buildTaskDeepLink("abc123") -> "forgeorbit://task/abc123"
 * The taskId is percent-encoded so ids containing "/", "?", "#", etc. still
 * round-trip through parseTaskDeepLink.
 */
export function buildTaskDeepLink(taskId: string): string {
  return `${APP_URL_SCHEME}://task/${encodeURIComponent(taskId)}`;
}

/**
 * Parses a `forgeorbit://task/<taskId>` (or legacy `agetor://task/<taskId>`)
 * deep link and returns the decoded taskId, or `null` if the URL is malformed
 * in any way. Never throws.
 */
export function parseTaskDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto !== `${APP_URL_SCHEME}:` && proto !== `${LEGACY_APP_URL_SCHEME}:`) return null;
  if (parsed.host.toLowerCase() !== "task") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;

  // Exactly "/<one-non-empty-segment>" — no extra slashes, no empty segments.
  const match = /^\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;

  const rawId = match[1];
  if (!rawId) return null;

  try {
    const taskId = decodeURIComponent(rawId);
    return taskId.length > 0 ? taskId : null;
  } catch {
    return null;
  }
}
