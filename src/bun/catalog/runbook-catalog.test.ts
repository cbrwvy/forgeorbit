import { describe, expect, it } from "bun:test";
import { RunbookCatalogService, RunbookError } from "./runbook-catalog.ts";
import { RoleCatalogService } from "./role-catalog.ts";

describe("RunbookCatalogService", () => {
  const catalog = new RoleCatalogService();
  const service = new RunbookCatalogService({ catalog });

  it("lists all local runbooks with correct counts", () => {
    const list = service.listRunbooks();
    expect(list.length).toBe(4);
    const slugs = list.map((r) => r.slug);
    expect(slugs).toContain("startup-mvp");
    expect(slugs).toContain("enterprise-feature");
    expect(slugs).toContain("marketing-campaign");
    expect(slugs).toContain("incident-response");

    const mvp = list.find((r) => r.slug === "startup-mvp")!;
    expect(mvp.title).toBe("Startup MVP Build");
    expect(mvp.mode).toBe("NEXUS-Sprint");
    expect(mvp.duration).toBe("4-6 weeks");
    expect(mvp.totalAgents).toBe(18);
    expect(mvp.groups.length).toBe(3);
  });

  it("gets full runbook detail and hydrates agent roles from catalog", () => {
    const mvp = service.getRunbook("startup-mvp");
    expect(mvp.slug).toBe("startup-mvp");
    expect(mvp.roster.length).toBe(3);

    const coreGroup = mvp.roster.find((g) => g.group === "Core Team")!;
    expect(coreGroup).toBeDefined();
    expect(coreGroup.activation).toBe("always");

    const frontend = coreGroup.agents.find((a) => a.slug === "engineering-frontend-developer")!;
    expect(frontend).toBeDefined();
    expect(frontend.division).toBe("engineering");
    expect(frontend.emoji).toBeDefined();
    expect(frontend.color).toBeDefined();
    expect(frontend.name).toBe("Frontend Developer");
  });

  it("throws 404 for nonexistent runbook", () => {
    expect(() => service.getRunbook("nonexistent-scenario")).toThrow(RunbookError);
    try {
      service.getRunbook("nonexistent-scenario");
    } catch (err) {
      expect((err as RunbookError).status).toBe(404);
    }
  });

  it("throws 400 for empty or invalid slug", () => {
    expect(() => service.getRunbook("")).toThrow(RunbookError);
    expect(() => service.getRunbook(null as any)).toThrow(RunbookError);
  });
});
