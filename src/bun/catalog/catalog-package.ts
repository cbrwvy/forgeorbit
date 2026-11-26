/** Artifact verification shared by the build hook and offline packaging tests. */
import { readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { verifyCatalogIntegrity } from "./catalog-resources.ts";
import { RoleCatalogService } from "./role-catalog.ts";
import { RunbookCatalogService } from "./runbook-catalog.ts";

export function catalogInventory(root: string): string[] {
  const files: string[] = [];
  function walk(relative: string) {
    for (const entry of readdirSync(path.join(root, relative)).sort()) {
      const name = relative ? `${relative}/${entry}` : entry;
      const stat = lstatSync(path.join(root, name));
      if (stat.isDirectory()) walk(name);
      else if (stat.isFile()) files.push(name);
      else throw new Error(`Non-regular catalog entry: ${name}`);
    }
  }
  walk("");
  return files.sort();
}

export function verifyCatalogPackage(root: string) {
  const manifest = verifyCatalogIntegrity(root);
  const inventory = catalogInventory(root);
  const expected = [...manifest.files.map((file) => file.path), "catalog-manifest.json", "PROVENANCE.md", ".gitattributes"].sort();
  if (JSON.stringify(inventory) !== JSON.stringify(expected)) throw new Error("Catalog artifact file inventory differs from the committed snapshot.");
  const catalog = new RoleCatalogService(root);
  const roles = catalog.listRoles();
  const divisions = catalog.getDivisions();
  if (roles.length !== 283 || divisions.length !== 18) throw new Error("Expected 283 profiles across 18 divisions.");
  for (const division of divisions) {
    if (division.count !== manifest.counts_by_division[division.id]) throw new Error(`Division count mismatch: ${division.id}`);
  }
  const runbooks = new RunbookCatalogService({ catalog });
  const list = runbooks.listRunbooks();
  const references = list.flatMap((runbook) => runbooks.getRunbook(runbook.slug).roster.flatMap((group) => group.agents.map((agent) => agent.slug)));
  for (const slug of references) catalog.getRole(slug); // No placeholder counts as resolution.
  if (list.length !== 4 || references.length !== 64 || new Set(references).size !== 36) {
    throw new Error("Expected 4 runbooks, 64 resolved roster references and 36 unique slugs.");
  }
  const nestedGames = roles.filter((role) => role.division === "game-development" && role.sourcePath.split("/").length === 3);
  const engines = [...new Set(nestedGames.map((role) => role.sourcePath.split("/")[1]))].sort();
  if (JSON.stringify(engines) !== JSON.stringify(["blender", "godot", "roblox-studio", "unity", "unreal-engine"])) {
    throw new Error("Nested game-development engine directories missing.");
  }
  for (const role of nestedGames) catalog.getRole(role.slug);
  return { files: inventory.length, verifiedManifestEntries: manifest.files.length, profiles: roles.length, divisions: divisions.length,
    runbooks: list.length, rosterReferences: references.length, uniqueSlugs: new Set(references).size, nestedGameProfiles: nestedGames.length, engines };
}
