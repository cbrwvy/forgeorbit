import { describe, expect, test } from "bun:test";
import { RoleCatalogService, CatalogError } from "./role-catalog.ts";

describe("RoleCatalogService", () => {
  const service = new RoleCatalogService();

  test("loads complete catalog with exactly 283 profiles", () => {
    service.initialize();
    const manifest = service.getManifestSummary();
    expect(manifest.totalProfiles).toBe(283);
    expect(manifest.license).toBe("MIT");
    expect(manifest.sourceCommit).toBe("b37b5bb33b78f2c1d6567d98e25ca818e3259219");

    const allRoles = service.listRoles();
    expect(allRoles.length).toBe(283);
  });

  test("loads all 18 divisions with accurate counts", () => {
    const divisions = service.getDivisions();
    expect(divisions.length).toBe(18);

    const ids = divisions.map((d) => d.id).sort();
    expect(ids).toEqual([
      "academic",
      "design",
      "engineering",
      "finance",
      "game-development",
      "gis",
      "healthcare",
      "marketing",
      "paid-media",
      "product",
      "project-management",
      "research",
      "sales",
      "security",
      "spatial-computing",
      "specialized",
      "support",
      "testing",
    ].sort());

    const totalCount = divisions.reduce((acc, d) => acc + d.count, 0);
    expect(totalCount).toBe(283);
  });

  test("handles nested game-development profiles", () => {
    const blender = service.getRole("blender-addon-engineer");
    expect(blender.division).toBe("game-development");
    expect(blender.sourcePath).toBe("game-development/blender/blender-addon-engineer.md");
    expect(blender.originalMarkdown.length).toBeGreaterThan(100);

    const godot = service.getRole("godot-multiplayer-engineer");
    expect(godot.division).toBe("game-development");
    expect(godot.sourcePath).toBe("game-development/godot/godot-multiplayer-engineer.md");

    const unreal = service.getRole("unreal-multiplayer-architect");
    expect(unreal.division).toBe("game-development");
    expect(unreal.sourcePath).toBe("game-development/unreal-engine/unreal-multiplayer-architect.md");
  });

  test("correctly parses YAML frontmatter and extracts metadata", () => {
    const role = service.getRole("engineering-backend-architect");
    expect(role.name).toBe("Backend Architect");
    expect(role.division).toBe("engineering");
    expect(role.color).toBeTruthy();
    expect(role.emoji).toBeTruthy();
    expect(role.frontmatter.name).toBe("Backend Architect");
    expect(role.originalMarkdown).toContain("Backend Architect");
    expect(role.sha256).toBe("45d94306c8f0f4c51efb76066008297fa4e87ce5b69f509cfede224084b74dfb");
  });

  test("filters roles by division and searches by text", () => {
    const eng = service.listRoles({ division: "engineering" });
    expect(eng.length).toBe(66);
    expect(eng.every((r) => r.division === "engineering")).toBe(true);

    const searchResults = service.listRoles({ search: "architect" });
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.some((r) => r.slug === "engineering-backend-architect")).toBe(true);
  });

  test("validates slug and rejects invalid formats and path traversal", () => {
    expect(() => service.getRole("")).toThrow(CatalogError);
    expect(() => service.getRole("../secret")).toThrow(CatalogError);
    expect(() => service.getRole("engineering/backend-architect")).toThrow(CatalogError);
    expect(() => service.getRole("invalid_underscore")).toThrow(CatalogError);
    expect(() => service.getRole("nonexistent-role-slug-xyz")).toThrow(CatalogError);
  });
});
