/**
 * Local links for a project (website, API, admin, docs).
 *
 * Availability follows that link's own health check. A failing optional
 * service does not hide the other links, and nothing in this module opens a
 * browser — display and launch stay separate.
 */

import type { EnvironmentUrl, HealthOutcome, UrlAvailability } from "./types.ts";

export function urlAvailability(
  urls: readonly EnvironmentUrl[],
  outcomes: readonly HealthOutcome[],
): UrlAvailability[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  return urls.map((url) => {
    if (url.healthCheckId === null) {
      return {
        id: url.id,
        name: url.name,
        role: url.role,
        url: url.url,
        optional: url.optional,
        status: "unknown",
        detail: null,
      };
    }
    const outcome = byId.get(url.healthCheckId);
    if (!outcome) {
      return {
        id: url.id,
        name: url.name,
        role: url.role,
        url: url.url,
        optional: url.optional,
        status: "unknown",
        detail: "health check has not run",
      };
    }
    return {
      id: url.id,
      name: url.name,
      role: url.role,
      url: url.url,
      optional: url.optional,
      status: outcome.ok ? "up" : "down",
      detail: outcome.detail,
    };
  });
}
