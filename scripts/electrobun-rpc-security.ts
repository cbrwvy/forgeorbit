import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";
import socketPatch from "../patches/electrobun-1.18.1/socket.ts";
import browserPatch from "../patches/electrobun-1.18.1/browser.ts";

// Audited Electrobun 1.18.1 only. These build-time patches never edit node_modules.
// Re-review the transport and remove/rebase the patches when upgrading upstream.
// Do not resolve a bare SDK export while the native CLI imports its config.
// Its embedded Bun resolver differs from standalone Bun. Vite preserves the
// original per-module import.meta.dirname when bundling its configuration.
// Resolve lazily so SDK validation errors occur inside Bun.build's setup.
function sdkRoot() { return path.resolve(import.meta.dirname, "../node_modules/electrobun"); }
const files = {
  socket: ["bun/core/Socket.ts", "84f69b0645d0cfd331b650fed9889c1d00ad33d1d9ae5caaaeec2795f5ff4362"],
  browser: ["browser/index.ts", "07ec34e0a9f0abed36958d34228324242f87244af917c2ec370a8799d656c658"],
} as const;

export function patchElectrobunRpc(kind: keyof typeof files, source: string): string {
  if (createHash("sha256").update(source).digest("hex") !== files[kind][1]) {
    throw new Error(`NATIVE-003: unreviewed Electrobun ${kind}; rebase security patch`);
  }
  const patch = kind === "socket" ? socketPatch : browserPatch;
  for (const [before, after] of patch) {
    if (source.split(before).length !== 2) throw new Error("NATIVE-003: ambiguous SDK patch");
    source = source.replace(before, after);
  }
  return source;
}

function assertSdk() {
  const pkg = JSON.parse(readFileSync(path.join(sdkRoot(), "package.json"), "utf8"));
  if (pkg.version !== "1.18.1" || pkg.exports["./bun"] !== "./dist/api/bun/index.ts"
    || pkg.exports["./view"] !== "./dist/api/browser/index.ts") {
    throw new Error("NATIVE-003: unreviewed Electrobun version/exports");
  }
}

export function electrobunRpcSecurity(): BunPlugin {
  return { name: "forgeorbit-native003", setup(build) {
    // Validate during Bun.build: Electrobun catches config-load exceptions and
    // falls back to defaults. Throwing from this plugin must fail the build.
    assertSdk();
    const socket = path.join(sdkRoot(), "dist/api", files.socket[0]);
    patchElectrobunRpc("socket", readFileSync(socket, "utf8"));
    build.onLoad({ filter: /[/\\]electrobun[/\\]dist[/\\]api[/\\]bun[/\\]core[/\\]Socket\.ts$/ }, async args => {
      const contents = patchElectrobunRpc("socket", await Bun.file(args.path).text());
      console.log("[FO-NATIVE003] socket transform applied");
      return { contents, loader: "ts" };
    });
  } };
}

// ForgeOrbit currently uses its authenticated HTTP API, not Electroview. Keep
// SDK clients compatible if a view imports electrobun/view now or in the future.
export function electrobunViewSecurity() {
  assertSdk();
  patchElectrobunRpc("browser", readFileSync(path.join(sdkRoot(), "dist/api", files.browser[0]), "utf8"));
  return { name: "forgeorbit-native003-view", enforce: "pre" as const,
    transform(source: string, id: string) {
      if (/[/\\]electrobun[/\\]dist[/\\]api[/\\]browser[/\\]index\.ts$/.test(id)) {
        return { code: patchElectrobunRpc("browser", source), map: null };
      }
    },
  };
}
