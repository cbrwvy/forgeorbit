// Builds a relocatable tmux when the Homebrew bottle was compiled for this
// host's SDK (minos 27 on the current machine). Sources and flags follow the
// Homebrew formulas for the versions already vendored (tmux 3.8, libevent
// 2.1.13, ncurses 6.6, utf8proc 2.12.0, jemalloc 5.4.0). OpenSSL is disabled
// in libevent: the core dylib the bottle actually links does not need it, and
// a detected Homebrew OpenSSL would bake a non-portable path.
//
// The deployment target is applied as a compiler -target, so a newer Apple
// API without an availability guard fails the build instead of being stamped
// down after the fact. Output is an install prefix; scripts/fetch-tmux.ts
// copies the binary and rewrites load commands to @executable_path.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MACOS_DEPLOYMENT_TARGET, machOMinOS, versionAtMost } from "./macos-deployment.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ROOT = path.join(REPO_ROOT, "vendor", "tmux", ".portable");
const PREFIX = path.join(ROOT, "prefix");
const SRC_ROOT = path.join(ROOT, "src");
const STAMP = path.join(ROOT, "stamp");

const PARTS = [
  {
    name: "libevent",
    file: "libevent-2.1.13-stable.tar.gz",
    url: "https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz",
    sha256: "f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c",
    dir: "libevent-2.1.13-stable",
  },
  {
    name: "ncurses",
    file: "ncurses-6.6.tar.gz",
    url: "https://invisible-mirror.net/archives/ncurses/ncurses-6.6.tar.gz",
    sha256: "355b4cbbed880b0381a04c46617b7656e362585d52e9cf84a67e2009b749ff11",
    dir: "ncurses-6.6",
  },
  {
    name: "utf8proc",
    file: "utf8proc-2.12.0.tar.gz",
    url: "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v2.12.0.tar.gz",
    sha256: "f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111",
    dir: "utf8proc-2.12.0",
  },
  {
    name: "jemalloc",
    file: "jemalloc-5.4.0.tar.bz2",
    url: "https://github.com/jemalloc/jemalloc/releases/download/5.4.0/jemalloc-5.4.0.tar.bz2",
    sha256: "200776fac271093e7c2f21edd6d62657ecd2be578d9328633f2a86bfa6ef4f1d",
    dir: "jemalloc-5.4.0",
  },
  {
    name: "tmux",
    file: "tmux-3.8.tar.gz",
    url: "https://github.com/tmux/tmux/releases/download/3.8/tmux-3.8.tar.gz",
    sha256: "e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e",
    dir: "tmux-3.8",
  },
] as const;

const STAMP_VALUE = `${MACOS_DEPLOYMENT_TARGET} ${PARTS.map((part) => part.file).join(" ")}`;

function fail(msg: string): never {
  throw new Error(`[portable-tmux] ${msg}`);
}

async function run(cmd: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<void> {
  console.log(`[portable-tmux] ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...buildEnv(), ...extraEnv },
  });
  const code = await proc.exited;
  if (code !== 0) fail(`command failed (${code}): ${cmd.join(" ")}`);
}

function jobs(): string {
  const count = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4;
  return String(count || 4);
}

function buildEnv(): Record<string, string> {
  const target = `arm64-apple-macos${MACOS_DEPLOYMENT_TARGET}`;
  const flags = `-O2 -target ${target} -Werror=unguarded-availability`;
  return {
    MACOSX_DEPLOYMENT_TARGET: MACOS_DEPLOYMENT_TARGET,
    CC: "clang",
    CXX: "clang++",
    CFLAGS: flags,
    CXXFLAGS: flags,
    LDFLAGS: `-target ${target}`,
    // Bun's own directory stays on PATH so the pkg-config shim's shebang resolves.
    // Homebrew is omitted so configure cannot pick up bottles we are replacing.
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin:${path.join(ROOT, "bin")}`,
    FO_TMUX_PREFIX: PREFIX,
  };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function download(part: (typeof PARTS)[number]): Promise<string> {
  const dest = path.join(SRC_ROOT, part.file);
  if (!existsSync(dest) || (await sha256(dest)) !== part.sha256) {
    console.log(`[portable-tmux] downloading ${part.name}`);
    const res = await fetch(part.url);
    if (!res.ok) fail(`download ${part.url} → ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    if ((await sha256(dest)) !== part.sha256) fail(`checksum mismatch for ${part.file}`);
  }
  const dir = path.join(SRC_ROOT, part.dir);
  if (!existsSync(dir)) {
    await run(["tar", "-xf", dest, "-C", SRC_ROOT], SRC_ROOT);
  }
  return dir;
}

async function writePkgConfig(): Promise<void> {
  const bin = path.join(ROOT, "bin");
  await mkdir(bin, { recursive: true });
  const file = path.join(bin, "pkg-config");
  await writeFile(
    file,
    `#!/usr/bin/env bun
const prefix = process.env.FO_TMUX_PREFIX;
if (!prefix) process.exit(1);
const pcdir = prefix + "/lib/pkgconfig";
let mode = "";
let mod = "";
for (const arg of process.argv.slice(2)) {
  if (arg === "--exists" || arg === "--cflags" || arg === "--libs" || arg === "--modversion") mode = arg.slice(2);
  else if (!arg.startsWith("-")) mod = arg.split(/\\s/)[0].split(">=")[0].trim();
}
if (!mode || !mod) process.exit(1);
const pcPath = pcdir + "/" + mod + ".pc";
const text = await Bun.file(pcPath).text().catch(() => "");
if (!text) process.exit(1);
const vars = new Map([["prefix", prefix]]);
const lines = text.split("\\n");
for (const line of lines) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  let value = match[2];
  value = value.replace(/\\$\\{([^}]+)\\}/g, (_, name) => vars.get(name) ?? "");
  vars.set(match[1], value);
}
const field = (name) => {
  const raw = lines.find((line) => line.startsWith(name + ":"));
  if (!raw) return "";
  return raw.slice(name.length + 1).trim().replace(/\\$\\{([^}]+)\\}/g, (_, key) => vars.get(key) ?? "");
};
if (mode === "exists") process.exit(0);
if (mode === "modversion") { console.log(field("Version") || "0"); process.exit(0); }
if (mode === "cflags") { console.log(field("Cflags")); process.exit(0); }
if (mode === "libs") { console.log(field("Libs")); process.exit(0); }
process.exit(1);
`,
  );
  await chmod(file, 0o755);
}

async function assertPrefixMinOS(): Promise<void> {
  const lib = path.join(PREFIX, "lib");
  const files = [path.join(PREFIX, "bin", "tmux")];
  for (const name of await readdir(lib).catch(() => [])) {
    if (name.endsWith(".dylib") && !name.includes(".dylib.")) files.push(path.join(lib, name));
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    const minos = await machOMinOS(file);
    if (!minos || !versionAtMost(minos, MACOS_DEPLOYMENT_TARGET)) {
      fail(`${path.relative(PREFIX, file)} minos ${minos ?? "unknown"} exceeds ${MACOS_DEPLOYMENT_TARGET}`);
    }
  }
}

async function buildAll(): Promise<void> {
  await mkdir(SRC_ROOT, { recursive: true });
  await writePkgConfig();
  const libevent = await download(PARTS[0]);
  const ncurses = await download(PARTS[1]);
  const utf8proc = await download(PARTS[2]);
  const jemalloc = await download(PARTS[3]);
  const tmux = await download(PARTS[4]);

  // The macOS 27 SDK declares pipe2, which libevent would call with no
  // availability check. The deployment target is 14.0, so leave it out and
  // use the pipe() + fcntl fallback already in evutil.c. That keeps the
  // dylib free of a symbol that does not exist before 27.
  await run(
    [
      "./configure",
      `--prefix=${PREFIX}`,
      "--disable-debug-mode",
      "--disable-openssl",
      "--disable-static",
      "--enable-shared",
      "ac_cv_func_pipe2=no",
    ],
    libevent,
  );
  await run(["make", "-j", jobs()], libevent);
  await run(["make", "install"], libevent);

  await run(["./configure", `--prefix=${PREFIX}`, "--disable-debug", "--with-jemalloc-prefix="], jemalloc);
  await run(["make", "-j", jobs()], jemalloc);
  await run(["make", "install"], jemalloc);

  await run(["make", `prefix=${PREFIX}`, "-j", jobs()], utf8proc);
  await run(["make", `prefix=${PREFIX}`, "install"], utf8proc);

  await run(
    [
      "./configure",
      `--prefix=${PREFIX}`,
      "--enable-pc-files",
      `--with-pkg-config-libdir=${path.join(PREFIX, "lib", "pkgconfig")}`,
      "--enable-sigwinch",
      "--enable-symlinks",
      "--enable-widec",
      "--with-shared",
      "--with-cxx-shared",
      "--with-gpm=no",
      "--without-ada",
      // Do not compile the build prefix into the dylib, and do not try to
      // write the database into /usr. The system terminfo is the runtime source.
      "--disable-db-install",
      "--with-default-terminfo-dir=/usr/share/terminfo",
      "--with-terminfo-dirs=/usr/share/terminfo",
    ],
    ncurses,
  );
  await run(["make", "-j", jobs()], ncurses);
  await run(["make", "install"], ncurses);

  const cflags = `-I${path.join(PREFIX, "include")} -I${path.join(PREFIX, "include", "ncursesw")}`;
  const libs = `-L${path.join(PREFIX, "lib")}`;
  await run(
    ["./configure", `--prefix=${PREFIX}`, "--enable-sixel", "--enable-utf8proc", "--enable-jemalloc"],
    tmux,
    {
      PKG_CONFIG: path.join(ROOT, "bin", "pkg-config"),
      LIBEVENT_CORE_CFLAGS: cflags,
      LIBEVENT_CORE_LIBS: `${libs} -levent_core`,
      LIBEVENT_CFLAGS: cflags,
      LIBEVENT_LIBS: `${libs} -levent_core`,
      LIBNCURSESW_CFLAGS: cflags,
      LIBNCURSESW_LIBS: `${libs} -lncursesw`,
      LIBUTF8PROC_CFLAGS: cflags,
      LIBUTF8PROC_LIBS: `${libs} -lutf8proc`,
      JEMALLOC_CFLAGS: cflags,
      JEMALLOC_LIBS: `${libs} -ljemalloc`,
    },
  );
  await run(["make", "-j", jobs()], tmux);
  await run(["make", "install"], tmux);
  await assertPrefixMinOS();
  await writeFile(STAMP, `${STAMP_VALUE}\n`);
}

export async function ensurePortableTmuxBinary(): Promise<string> {
  const tmux = path.join(PREFIX, "bin", "tmux");
  if (existsSync(STAMP) && existsSync(tmux)) {
    const stamp = (await readFile(STAMP, "utf8")).trim();
    const minos = await machOMinOS(tmux);
    if (stamp === STAMP_VALUE && minos && versionAtMost(minos, MACOS_DEPLOYMENT_TARGET)) {
      console.log(`[portable-tmux] cached ${tmux}`);
      return tmux;
    }
  }
  await mkdir(ROOT, { recursive: true });
  await buildAll();
  if (!existsSync(tmux)) fail("build finished without bin/tmux");
  console.log(`[portable-tmux] built ${tmux}`);
  return tmux;
}

if (import.meta.main) {
  ensurePortableTmuxBinary().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
