import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG_RESOURCE_PATH, resolveCatalogDir } from "./catalog-resources.ts";
import { RoleCatalogService } from "./role-catalog.ts";
import { RunbookCatalogService } from "./runbook-catalog.ts";

const temp = mkdtempSync(path.join(tmpdir(), "fo-pkg01-resources-"));
const source = path.resolve(import.meta.dir, "../../..", CATALOG_RESOURCE_PATH);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

test("packaged resolution is independent of cwd, environment mode, existence and checkout", () => {
  const expected = `/relocated/Forge Orbit.app/Contents/Resources/app/${CATALOG_RESOURCE_PATH}`;
  expect(resolveCatalogDir(undefined, { execPath: "/relocated/Forge Orbit.app/Contents/MacOS/bun", moduleDir: import.meta.dir, env: {} })).toBe(expected);
  expect(resolveCatalogDir(undefined, { execPath: "/opt/bin/bun", moduleDir: "/relocated/Forge Orbit.app/Contents/Resources/app/bun", env: { NODE_ENV: "production" } })).toBe(expected);
  expect(resolveCatalogDir(undefined, { execPath: "/opt/bin/bun", moduleDir: import.meta.dir, env: { NODE_ENV: "test" } })).toBe(source);
  expect(resolveCatalogDir(undefined, { execPath: "/opt/bin/bun", moduleDir: import.meta.dir, env: { NODE_ENV: "production" } })).toBe(`/opt/Resources/app/${CATALOG_RESOURCE_PATH}`);
});

test("explicit missing overrides are authoritative; relative overrides are rejected", () => {
  expect(resolveCatalogDir("/missing/catalog")).toBe("/missing/catalog");
  expect(resolveCatalogDir(undefined, { env: { FORGEORBIT_CATALOG_PATH: "/missing/path", FORGEORBIT_CATALOG_DIR: "/other" } })).toBe("/missing/path");
  expect(resolveCatalogDir(undefined, { env: { FORGEORBIT_CATALOG_DIR: "/legacy/override" } })).toBe("/legacy/override");
  expect(() => resolveCatalogDir("relative")).toThrow("absolute path");
  expect(() => new RoleCatalogService("/missing/catalog").listRoles()).toThrow("/missing/catalog");
});

for (const file of ["catalog-manifest.json", "PROVENANCE.md", "LICENSE", "README.md", "strategy/runbooks.json", "strategy/runbooks/scenario-startup-mvp.md", "game-development/unity/unity-shader-graph-artist.md"]) {
  test(`diagnoses damaged ${file} before exposing roles or runbooks`, () => {
    const dir = path.join(temp, String(Math.random()));
    cpSync(source, dir, { recursive: true });
    writeFileSync(path.join(dir, file), "corrupt");
    const catalog = new RoleCatalogService(dir);
    expect(() => catalog.listRoles()).toThrow(/Offline catalog unavailable or corrupt/);
    expect(() => new RunbookCatalogService({ catalog }).listRunbooks()).toThrow(/Offline catalog unavailable or corrupt/);
  });
}

test("missing strategy does not fall back to the checkout; symlink profiles are refused", () => {
  const dir = path.join(temp, "missing-strategy");
  cpSync(source, dir, { recursive: true });
  rmSync(path.join(dir, "strategy"), { recursive: true });
  expect(() => new RunbookCatalogService({ catalog: new RoleCatalogService(dir) }).listRunbooks()).toThrow("strategy/");
  const linkDir = path.join(temp, "linked-profile");
  cpSync(source, linkDir, { recursive: true });
  const relative = "engineering/engineering-backend-architect.md";
  rmSync(path.join(linkDir, relative));
  symlinkSync(path.join(source, relative), path.join(linkDir, relative));
  expect(() => new RoleCatalogService(linkDir).listRoles()).toThrow("without symlinks");
});
