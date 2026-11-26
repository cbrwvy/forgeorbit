import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG_RESOURCE_PATH } from "./catalog-resources.ts";
import { catalogInventory, verifyCatalogPackage } from "./catalog-package.ts";

// Explicit opt-in: ordinary unit tests do not require building a native artifact.
const artifact = process.env.FORGEORBIT_CATALOG_ARTIFACT;
(artifact ? test : test.skip)("actual Electrobun artifact is complete, relocatable and fails diagnostically without breaking legacy Employee HTTP", async () => {
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-pkg01-artifact-")));
  try {
    const relocated = path.join(temp, "Relocated Forge Orbit.app");
    cpSync(artifact!, relocated, { recursive: true });
    const app = path.join(relocated, "Contents/Resources/app");
    const root = path.join(app, CATALOG_RESOURCE_PATH);
    const source = path.resolve(import.meta.dir, "../../..", CATALOG_RESOURCE_PATH);
    expect(verifyCatalogPackage(root)).toMatchObject({ files: 307, verifiedManifestEntries: 304, profiles: 283, divisions: 18, runbooks: 4, rosterReferences: 64, uniqueSlugs: 36 });
    expect(catalogInventory(root)).toEqual(catalogInventory(source));
    for (const file of catalogInventory(source)) expect(readFileSync(path.join(root, file)).equals(readFileSync(path.join(source, file)))).toBe(true);

    // Host Bun executes only this headless bundle. Never execute .app/bun/index.js,
    // Contents/MacOS/bun, launcher, main.js, WKWebView, or a native UI.
    const probe = path.join(app, "bun/catalog-packaging-probe.js");
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixtures/catalog-packaging-probe.ts")], outdir: path.dirname(probe), naming: path.basename(probe), target: "bun" });
    expect(build.success).toBe(true);
    const home = path.join(temp, "home");
    const unrelated = path.join(temp, "unrelated-cwd");
    mkdirSync(home); mkdirSync(unrelated);
    async function run(cwd: string, mode = "healthy") {
      const result = Bun.spawn([process.env.FORGEORBIT_CATALOG_PROBE_BUN ?? process.execPath, probe, mode], { cwd,
        env: { HOME: home, AGETOR_DATA_DIR: path.join(home, "data"), NODE_ENV: "production", PATH: "/usr/bin:/bin", AGETOR_USAGE_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(report.root).toBe(root);
      expect(report.legacyEmployeeHttp).toBe("PASS");
      console.log("[FO-PKG01]", JSON.stringify(report));
    }
    await run("/");
    await run(unrelated);
    // Put a complete decoy in cwd: damaged/missing bundles may not use it.
    const decoy = path.join(unrelated, CATALOG_RESOURCE_PATH);
    cpSync(root, decoy, { recursive: true });
    renameSync(root, `${root}.saved`);
    await run(unrelated, "degraded");
    renameSync(`${root}.saved`, root);
    writeFileSync(path.join(root, "strategy/runbooks.json"), "corrupt");
    await run(unrelated, "degraded");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 60_000);
