#!/usr/bin/env bun
// Prepares vendor/tmux/<arch>/ with a relocatable tmux binary that the
// packaged .app can ship. The runtime resolver (src/bun/tmux-resolution.ts)
// expects: vendor/tmux/<arch>/tmux plus any sibling dylibs.
//
// Source strategy on macOS arm64: prefer a local tmux whose Mach-O minos is
// at or below MACOS_DEPLOYMENT_TARGET. A Homebrew bottle built on this host
// stamps the host SDK (minos 27) and cannot be vendored. In that case
// scripts/build-portable-tmux.ts compiles the pinned sources with an explicit
// -target. Load commands are then rewritten to @executable_path/<libname>.
//
// Idempotent: if the vendored files already exist and aren't older than the
// system tmux, the script is a fast no-op.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, chmod, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensurePortableTmuxBinary } from "./build-portable-tmux.ts";
import { MACOS_DEPLOYMENT_TARGET, machOMinOS, versionAtMost } from "./macos-deployment.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
// arm64-only by deliberate choice (see project-arm64-only memory). The
// runtime resolver in src/bun/tmux-resolution.ts hardcodes the same arch
// path, so this assert keeps both ends in lockstep — if we ever revisit
// the decision, both must move together.
const ARCH = "arm64";
const VENDOR_DIR = path.join(REPO_ROOT, "vendor", "tmux", ARCH);

function fail(msg: string): never {
  console.error(`[fetch-tmux] ${msg}`);
  process.exit(1);
}

/** MH_MAGIC_64 / MH_CIGAM_64. A cached shell stub must not be reused. */
export function isMachO64(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) !== 4) return false;
    const magic = buf.readUInt32LE(0);
    return magic === 0xfeedfacf || magic === 0xcffaedfe;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function run(cmd: string[], opts: { silent?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (code !== 0) {
    if (!opts.silent) console.error(err.trim() || out.trim());
    throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  }
  return out.trim();
}

async function which(bin: string): Promise<string | null> {
  try {
    return await run(["/usr/bin/which", bin]);
  } catch {
    return null;
  }
}

/**
 * Parse `otool -L <bin>` into a list of dylib load-command paths (skipping
 * the first line, which echoes the binary itself).
 */
async function loadCommands(bin: string): Promise<string[]> {
  const out = await run(["otool", "-L", bin]);
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+\(/)[0]!.trim())
    .filter(Boolean);
}

/** Absolute dylibs outside the OS library roots. Homebrew and our prefix both match. */
function isBundledDepPath(p: string): boolean {
  return p.startsWith("/") && !p.startsWith("/usr/lib/") && !p.startsWith("/System/");
}

/**
 * Resolve every non-system dylib reachable from `bin`. The dylibs themselves
 * can load other dylibs, so we walk the graph. Deduplication is keyed on the
 * path we *enqueue* — to avoid an infinite loop on LC_ID_DYLIB entries (a
 * dylib lists itself as its first load command).
 */
async function resolveBundledDeps(bin: string): Promise<Set<string>> {
  const seen = new Set<string>([bin]);
  const queue = [bin];
  while (queue.length) {
    const next = queue.shift()!;
    const deps = await loadCommands(next);
    for (const d of deps) {
      if (!isBundledDepPath(d)) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      queue.push(d);
    }
  }
  seen.delete(bin);
  return seen;
}

/**
 * Rewrite every non-system dylib reference in `target` to load from
 * `@executable_path/<basename>`. Applied to both the main tmux binary and to
 * each shipped dylib (dylibs reference each other).
 */
async function rewriteLoadCommands(target: string): Promise<void> {
  const deps = await loadCommands(target);
  for (const d of deps) {
    if (!isBundledDepPath(d)) continue;
    const base = path.basename(d);
    await run(["install_name_tool", "-change", d, `@executable_path/${base}`, target]);
  }
  // For dylibs, also update the LC_ID_DYLIB so the file knows its own
  // @executable_path identity (otherwise tmux loading libfoo with id =
  // an absolute prefix path will still fail under SIP-tightened
  // resolution on some macOS versions).
  if (target.endsWith(".dylib")) {
    const base = path.basename(target);
    await run(["install_name_tool", "-id", `@executable_path/${base}`, target]);
  }
}

async function sourceWithinTarget(bin: string): Promise<boolean> {
  const minos = await machOMinOS(bin);
  if (!minos || !versionAtMost(minos, MACOS_DEPLOYMENT_TARGET)) return false;
  for (const dep of await resolveBundledDeps(bin)) {
    const depMinos = await machOMinOS(dep);
    if (!depMinos || !versionAtMost(depMinos, MACOS_DEPLOYMENT_TARGET)) return false;
  }
  return true;
}

async function vendoredIsCurrent(
  targetTmux: string,
  stampPath: string,
  deployPath: string,
  desiredIdentity: string,
): Promise<boolean> {
  if (!existsSync(targetTmux) || !existsSync(stampPath) || !existsSync(deployPath)) return false;
  if (!isMachO64(targetTmux)) return false;
  if ((await readFile(stampPath, "utf8")).trim() !== desiredIdentity) return false;
  if ((await readFile(deployPath, "utf8")).trim() !== MACOS_DEPLOYMENT_TARGET) return false;
  const newestInput = Math.max(
    statSync(new URL(import.meta.url).pathname).mtimeMs,
    statSync(new URL("./build-portable-tmux.ts", import.meta.url).pathname).mtimeMs,
    statSync(new URL("./macos-deployment.ts", import.meta.url).pathname).mtimeMs,
  );
  if (statSync(targetTmux).mtimeMs < newestInput) return false;
  for (const name of await readdir(VENDOR_DIR)) {
    if (name !== "tmux" && !name.endsWith(".dylib")) continue;
    const minos = await machOMinOS(path.join(VENDOR_DIR, name));
    if (!minos || !versionAtMost(minos, MACOS_DEPLOYMENT_TARGET)) return false;
  }
  return true;
}

async function main() {
  if (process.platform !== "darwin") {
    // electrobun's dev watcher fs.watch()es every `copy` source dir in
    // electrobun.config.ts unconditionally, including vendor/tmux/arm64 —
    // if it doesn't exist on disk, `bun run dev` crashes with ENOENT before
    // the app even launches. Create the (empty) dir so non-macOS dev works;
    // resolveTmuxBin() falls back to the system tmux on PATH regardless.
    await mkdir(VENDOR_DIR, { recursive: true });
    console.log(`[fetch-tmux] skipped on ${process.platform} (macOS-only step)`);
    return;
  }
  if (process.arch !== "arm64") {
    fail(`expected an arm64 build host (got ${process.arch}); ForgeOrbit only ships arm64`);
  }

  const targetTmux = path.join(VENDOR_DIR, "tmux");
  const stampPath = path.join(VENDOR_DIR, ".signed-by");
  const deployPath = path.join(VENDOR_DIR, ".deploy-target");
  const desiredIdentity = process.env.ELECTROBUN_DEVELOPER_ID || "adhoc";
  if (await vendoredIsCurrent(targetTmux, stampPath, deployPath, desiredIdentity)) {
    console.log(`[fetch-tmux] cached at ${path.relative(REPO_ROOT, VENDOR_DIR)}/ — skipping`);
    return;
  }

  const systemTmux = await which("tmux");
  let tmuxBin = systemTmux;
  if (!tmuxBin || !(await sourceWithinTarget(tmuxBin))) {
    const minos = tmuxBin ? await machOMinOS(tmuxBin) : null;
    console.log(
      tmuxBin
        ? `[fetch-tmux] system tmux minos ${minos ?? "unknown"} exceeds ${MACOS_DEPLOYMENT_TARGET} — building portable tmux`
        : `[fetch-tmux] no system tmux — building portable tmux`,
    );
    tmuxBin = await ensurePortableTmuxBinary();
  }

  console.log(`[fetch-tmux] vendoring ${tmuxBin} → ${path.relative(REPO_ROOT, VENDOR_DIR)}/`);
  await mkdir(VENDOR_DIR, { recursive: true });
  for (const name of await readdir(VENDOR_DIR)) {
    if (name === "tmux" || name.endsWith(".dylib") || name.startsWith(".")) {
      await rm(path.join(VENDOR_DIR, name), { force: true });
    }
  }

  // 1. Copy the tmux binary itself.
  await copyFile(tmuxBin, targetTmux);
  await chmod(targetTmux, 0o755);

  // 2. Walk the dylib graph from tmux, copy every brew-rooted .dylib.
  const deps = await resolveBundledDeps(tmuxBin);
  for (const src of deps) {
    const dst = path.join(VENDOR_DIR, path.basename(src));
    await copyFile(src, dst);
    await chmod(dst, 0o644);
  }
  console.log(`[fetch-tmux] copied ${deps.size} dylib(s)`);

  // 3. Patch load commands so everything resolves via @executable_path.
  await rewriteLoadCommands(targetTmux);
  const entries = await readdir(VENDOR_DIR);
  for (const f of entries) {
    if (f.endsWith(".dylib")) {
      await rewriteLoadCommands(path.join(VENDOR_DIR, f));
    }
  }

  // install_name_tool invalidates the codesign seal on the file it modifies.
  // macOS arm64 refuses to load unsigned binaries at all (the OS sends
  // SIGKILL — exit 137 — before even printing a message). Re-sign here so
  // (a) `tmux -V` works for the smoke test below and (b) the files going
  // into the .app are already signed correctly before Electrobun's outer
  // bundle sign + notarization runs (sign inside-out — Apple's recommended
  // pattern). When ELECTROBUN_DEVELOPER_ID is set (release builds), use it
  // with --options runtime + --timestamp so notarytool accepts the nested
  // binaries; otherwise ad-hoc, which is enough for local runs but won't
  // pass notarization.
  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  const signArgs = devId
    ? ["--force", "--options", "runtime", "--timestamp", "--sign", devId]
    : ["--force", "--sign", "-"];
  if (devId) {
    console.log(`[fetch-tmux] signing with ${devId}`);
  } else {
    console.log(`[fetch-tmux] signing ad-hoc (set ELECTROBUN_DEVELOPER_ID for release)`);
  }
  for (const f of [path.basename(targetTmux), ...entries.filter((e) => e.endsWith(".dylib"))]) {
    await run(["codesign", ...signArgs, path.join(VENDOR_DIR, f)]);
  }
  await writeFile(stampPath, `${desiredIdentity}\n`);
  await writeFile(deployPath, `${MACOS_DEPLOYMENT_TARGET}\n`);

  // 4. Verify: every load command on tmux should resolve to either a system
  //    path or @executable_path/. A leftover absolute prefix means
  //    rewriteLoadCommands missed something.
  const finalDeps = await loadCommands(targetTmux);
  const leaked = finalDeps.filter((d) => isBundledDepPath(d));
  if (leaked.length) {
    fail(`load commands still reference non-system paths after rewrite:\n  ${leaked.join("\n  ")}`);
  }
  for (const name of await readdir(VENDOR_DIR)) {
    if (name !== "tmux" && !name.endsWith(".dylib")) continue;
    const minos = await machOMinOS(path.join(VENDOR_DIR, name));
    if (!minos || !versionAtMost(minos, MACOS_DEPLOYMENT_TARGET)) {
      fail(`${name} minos ${minos ?? "unknown"} exceeds ${MACOS_DEPLOYMENT_TARGET}`);
    }
  }

  // 5. Sanity-run the vendored binary.
  const version = await run([targetTmux, "-V"]);
  console.log(`[fetch-tmux] ✓ ${version} (${entries.length} files in ${path.relative(REPO_ROOT, VENDOR_DIR)}/)`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[fetch-tmux] ${(e as Error).message}`);
    process.exit(1);
  });
}
