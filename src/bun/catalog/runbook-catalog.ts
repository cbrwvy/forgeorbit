/**
 * Local Runbook Catalog Service (FO-014C).
 *
 * Reads NEXUS scenario runbooks offline from local strategy/runbooks.json.
 * Resolves agent rosters against RoleCatalogService offline.
 * Never executes markdown playbooks, never installs external agents,
 * never accesses GitHub, and never automatically activates roles.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getRoleCatalogService, RoleCatalogService } from "./role-catalog.ts";
import { verifyCatalogIntegrity } from "./catalog-resources.ts";
import type {
  RunbookDetail,
  RunbookRosterAgentSummary,
  RunbookSummary,
} from "../../shared/hiring/types.ts";

export class RunbookError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "RunbookError";
  }
}

interface RawRunbookRosterGroup {
  group: string;
  activation: string;
  agents: string[];
}

interface RawRunbookEntry {
  slug: string;
  title: string;
  mode: string;
  duration: string;
  summary: string;
  doc: string;
  roster: RawRunbookRosterGroup[];
}

interface RawRunbooksFile {
  _note?: string;
  runbooks: RawRunbookEntry[];
}

export class RunbookCatalogService {
  private readonly catalog: RoleCatalogService;
  private readonly catalogDir: string;
  private runbooksCache: Map<string, RawRunbookEntry> | null = null;

  constructor(options: { catalog?: RoleCatalogService; catalogDir?: string } = {}) {
    this.catalog = options.catalog ?? getRoleCatalogService();
    this.catalogDir = options.catalogDir ?? this.catalog.getCatalogDir();
  }

  private load(): Map<string, RawRunbookEntry> {
    if (this.runbooksCache) return this.runbooksCache;

    this.catalog.initialize();
    if (this.catalogDir !== this.catalog.getCatalogDir()) verifyCatalogIntegrity(this.catalogDir);
    const foundPath = path.join(this.catalogDir, "strategy", "runbooks.json");
    if (!existsSync(foundPath)) {
      throw new RunbookError(`Runbooks file not found at ${foundPath}.`, 500);
    }

    try {
      const content = readFileSync(foundPath, "utf-8");
      const parsed = JSON.parse(content) as RawRunbooksFile;
      const map = new Map<string, RawRunbookEntry>();
      for (const item of parsed.runbooks) {
        map.set(item.slug, item);
      }
      this.runbooksCache = map;
      return map;
    } catch (err) {
      throw new RunbookError(
        `Failed to parse runbooks.json: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  }

  public listRunbooks(): RunbookSummary[] {
    const map = this.load();
    const result: RunbookSummary[] = [];

    for (const item of map.values()) {
      const totalAgents = item.roster.reduce((sum, g) => sum + g.agents.length, 0);
      result.push({
        slug: item.slug,
        title: item.title,
        mode: item.mode,
        duration: item.duration,
        summary: item.summary,
        doc: item.doc,
        totalAgents,
        groups: item.roster.map((g) => ({
          group: g.group,
          activation: g.activation,
          count: g.agents.length,
        })),
      });
    }

    return result;
  }

  public getRunbook(slugInput: unknown): RunbookDetail {
    if (typeof slugInput !== "string" || !slugInput.trim()) {
      throw new RunbookError("Invalid runbook slug.", 400);
    }
    const slug = slugInput.trim();
    const map = this.load();
    const item = map.get(slug);

    if (!item) {
      throw new RunbookError(`Runbook "${slug}" not found.`, 404);
    }

    const totalAgents = item.roster.reduce((sum, g) => sum + g.agents.length, 0);

    const roster = item.roster.map((g) => {
      const agents: RunbookRosterAgentSummary[] = [];
      for (const agentSlug of g.agents) {
        try {
          const role = this.catalog.getRole(agentSlug);
          agents.push({
            slug: role.slug,
            name: role.name,
            division: role.division,
            color: role.color,
            emoji: role.emoji,
            vibe: role.vibe ?? "",
            description: role.description,
          });
        } catch {
          agents.push({
            slug: agentSlug,
            name: agentSlug,
            division: "other",
            color: "#6b7280",
            emoji: "🤖",
            vibe: "",
            description: "",
          });
        }
      }
      return {
        group: g.group,
        activation: g.activation,
        agents,
      };
    });

    return {
      slug: item.slug,
      title: item.title,
      mode: item.mode,
      duration: item.duration,
      summary: item.summary,
      doc: item.doc,
      totalAgents,
      groups: item.roster.map((g) => ({
        group: g.group,
        activation: g.activation,
        count: g.agents.length,
      })),
      roster,
    };
  }
}

let runbookSingleton: RunbookCatalogService | null = null;
export function getRunbookCatalogService(): RunbookCatalogService {
  if (!runbookSingleton) {
    runbookSingleton = new RunbookCatalogService();
  }
  return runbookSingleton;
}
