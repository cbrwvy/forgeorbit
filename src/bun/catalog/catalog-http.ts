/**
 * Role Catalog HTTP API (FO-014B).
 *
 * Exposes offline catalog reading over HTTP with Bearer authentication.
 */

import { CatalogError, RoleCatalogService, getRoleCatalogService } from "./role-catalog.ts";
import { getRunbookCatalogService, RunbookCatalogService, RunbookError } from "./runbook-catalog.ts";

export interface CatalogHttpDeps {
  service?: RoleCatalogService;
  runbooks?: RunbookCatalogService;
}

export async function catalogHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: CatalogHttpDeps = {},
): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });

  if (!bearerAuthorized) {
    return reply({ error: "unauthorized" }, 401);
  }

  try {
    const service = deps.service ?? getRoleCatalogService();
    const url = new URL(req.url);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          throw new CatalogError("Invalid path encoding.", 400);
        }
      });

    if (segments[0] !== "catalog") {
      return reply({ error: "not found" }, 404);
    }

    const head = segments[1];
    const tail = segments[2];

    if (req.method !== "GET") {
      return reply({ error: "method not allowed" }, 405);
    }

    if (!head || head === "roles") {
      if (!tail) {
        const search = url.searchParams.get("search") || undefined;
        const division = url.searchParams.get("division") || undefined;
        const roles = service.listRoles({ search, division });
        const manifest = service.getManifestSummary();
        const divisions = service.getDivisions();

        return reply({
          roles,
          total: roles.length,
          allTotal: manifest.totalProfiles,
          divisions,
          divisionsMetadata: manifest.divisionsMetadata,
          countsByDivision: manifest.countsByDivision,
        });
      }

      // GET /catalog/roles/:slug
      const role = service.getRole(tail);
      return reply({ role });
    }

    if (head === "divisions" && !tail) {
      return reply({ divisions: service.getDivisions() });
    }

    if (head === "manifest" && !tail) {
      return reply({ manifest: service.getManifestSummary() });
    }

    if (head === "runbooks") {
      const runbookService = deps.runbooks ?? getRunbookCatalogService();
      if (!tail) {
        return reply({ runbooks: runbookService.listRunbooks() });
      }
      return reply({ runbook: runbookService.getRunbook(tail) });
    }

    return reply({ error: "not found" }, 404);
  } catch (error) {
    const status = error instanceof CatalogError || error instanceof RunbookError ? error.status : 500;
    const message = error instanceof CatalogError || error instanceof RunbookError ? error.message : "Catalog request failed.";
    return reply({ error: message }, status);
  }
}
