import { readdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** SDK non-dev output is an extractor, not the runtime .app. Inspect an
 * isolated unpacked COPY of its embedded archive; never edit signed bytes. */
export function runtimeApp(app: string, project: string): string {
  const resources = path.join(app, "Contents/Resources");
  try { if (readdirSync(resources).includes("app")) return app; } catch { return app; }
  const packed = readdirSync(resources).filter(n => n.endsWith(".tar.zst"));
  if (packed.length !== 1) throw new Error("Missing/ambiguous inner app archive");
  const temp = mkdtempSync(path.join(path.dirname(app), "verify-inner-"));
  const zstd = path.join(project, "node_modules/electrobun/dist-macos-arm64/zig-zstd");
  const tar = path.join(temp, "inner.tar");
  function run(cmd: string[]) {
    const p = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (p.status !== 0) throw new Error("Inner artifact inspection failed: " + p.stderr);
    return p.stdout;
  }
  run([zstd, "decompress", "-i", path.join(resources, packed[0]!), "-o", tar]);
  const names = run(["/usr/bin/tar", "-tf", tar]).split("\n").filter(Boolean);
  const root = path.basename(app);
  if (names.some(n => !n.startsWith(root + "/") && n !== root) || names.some(n => n.split("/").includes(".."))) throw new Error("Unsafe inner archive paths");
  // Current non-CEF ForgeOrbit bundles require no archive links. Reject rather
  // than extracting an unreviewed link/hardlink layout.
  if (run(["/usr/bin/tar", "-tvf", tar]).split("\n").some(n => n.startsWith("l") || n.startsWith("h"))) throw new Error("Unreviewed inner archive links");
  run(["/usr/bin/tar", "-xpf", tar, "-C", temp]);
  return path.join(temp, root);
}
