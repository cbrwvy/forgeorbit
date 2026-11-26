import { productIdentity } from "./scripts/release-metadata.ts";
import type { ElectrobunConfig } from "electrobun";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { electrobunRpcSecurity } from "./scripts/electrobun-rpc-security.ts";
import { electrobunLifecycle } from "./scripts/electrobun-lifecycle.ts";
import { electrobunQaStorage, QA_IDENTIFIER } from "./scripts/electrobun-qa-storage.ts";

// Ephemeral NATIVE-005 QA (fake drivers, inert stubs, baked root) stays on
// FORGEORBIT_NATIVE_QA_ROOT. A packaged Owner acceptance build needs the same
// preliminary QA bundle id without that gate: real CLI spawn, and no rewrite
// of builtin harness homes into an empty CLAUDE_CONFIG_DIR. The two modes
// cannot be combined. Neither mode is the production identifier.
const product = productIdentity(import.meta.dir);
const qaRoot = Boolean(process.env.FORGEORBIT_NATIVE_QA_ROOT);
const qaLiveIdentity = process.env.FORGEORBIT_QA_LIVE_IDENTITY === "1";
if (qaRoot && qaLiveIdentity) {
  throw new Error("FORGEORBIT_QA_LIVE_IDENTITY cannot be combined with FORGEORBIT_NATIVE_QA_ROOT");
}
const qaIdentity = qaRoot || qaLiveIdentity;
const localBuild = process.env.FORGEORBIT_LOCAL_BUILD === "1";
// Native acceptance of an Owner-signed, production-identity bundle needs a WebKit store that is not the owner's
// (`~/Library/WebKit/app.forgeorbit`): a private HOME alone does not move it. This build-time option reuses the reviewed
// non-persistent partition transform (NATIVE-005) and changes nothing else: same bundle id, same trust class, same
// bootstrap. An artifact built with it is a QA artifact and is never what gets installed.
const isolatedStorage = process.env.FORGEORBIT_ISOLATED_NATIVE_STORAGE === "1";
if (isolatedStorage && (!localBuild || qaIdentity)) {
  throw new Error("FORGEORBIT_ISOLATED_NATIVE_STORAGE applies only to an ordinary personal local build");
}

/** Present only after scripts/prepare-brain-model.ts. Dev launches skip it. */
function stagedBrainCopies(root: string): Record<string, string> {
  const copies: Record<string, string> = {};
  if (existsSync(path.join(root, "vendor/brain-model"))) copies["vendor/brain-model"] = "models";
  const modules = path.join(root, "vendor/brain-runtime/node_modules");
  if (!existsSync(modules)) return copies;
  for (const name of readdirSync(modules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(path.join(modules, name))) {
        copies[`vendor/brain-runtime/node_modules/${name}/${scoped}`] = `node_modules/${name}/${scoped}`;
      }
    } else {
      copies[`vendor/brain-runtime/node_modules/${name}`] = `node_modules/${name}`;
    }
  }
  return copies;
}
if (localBuild && (qaIdentity || process.platform !== "darwin" || process.arch !== "arm64")) {
  throw new Error("Personal local builds require ordinary macOS arm64 production identity");
}

export default {
  app: {
    name: qaIdentity ? "ForgeOrbitQA" : "ForgeOrbit",
    // Preliminary local identifiers. Not a public-release assignment and not a
    // claim on the app.forgeorbit domain.
    identifier: qaIdentity ? QA_IDENTIFIER : "app.forgeorbit",
    version: product.version,
    // Registers forgeorbit:// (and legacy agetor:// for backward compatibility)
    // so a clicked notification's `-open forgeorbit://task/<id>` (see
    // src/bun/notifier.ts) routes back into this app as an "open-url" event,
    // which src/bun/deep-link.ts parses back into a task id. Hardcoded rather
    // than imported from src/bun/deep-link.ts (APP_URL_SCHEME) to keep this
    // build-config file free of app-source imports — keep the two in sync by hand.
    urlSchemes: qaIdentity ? [] : ["forgeorbit", "agetor"],
  },
  release: {
    // GitHub Releases' "latest" download URL for ForgeOrbit — always redirects
    // to the most recent non-prerelease tag on cbrwvy/forgeorbit.
    // `electrobun build` bakes this into Resources/version.json, and
    // Updater.checkForUpdate() fetches <baseUrl>/<channel>-macos-arm64-update.json
    // from there.
    baseUrl: "https://github.com/cbrwvy/forgeorbit/releases/latest/download",
    // Full local artifacts only. Delta generation would read a previous feed;
    // publication and production updater acceptance are separate Owner steps.
    generatePatch: false,
  },
  runtime: {
    // Don't quit the bun process when the user closes the window. ForgeOrbit
    // hosts long-running claude/codex sessions in tmux that should survive
    // a dismissed window — the user can bring the window back via the Dock
    // icon (handled by the `reopen` event in src/bun/index.ts). Cmd+Q is
    // the explicit quit path and goes through the `before-quit` confirm
    // dialog in quit-guard.ts.
    exitOnLastWindowClosed: false,
  },
  scripts: {
    // 1.18.1 merely logs missing copy sources. Fail the build if its actual
    // output lacks any catalog file, or if the pinned snapshot is damaged.
    // macos-post-build stamps Info.plist first: postBuild runs before codesign.
    postBuild: "scripts/macos-post-build.ts",
    // The self-extracting wrapper rewrites Info.plist from the SDK template
    // after the inner app is tarred. Patch that copy before its codesign.
    postWrap: "scripts/macos-bundle-metadata.ts",
  },
  build: {
    // The catalog uses node:fs, so keep assets as regular files (Electrobun 1.18.1).
    useAsar: false,
    // A QA artifact must fail closed if LaunchServices cold-starts it without
    // the isolated environment (including after an automation observation).
    // Only the ephemeral root selects the refusing bootstrap and the
    // non-persist partition plugin. Live QA identity keeps native-bootstrap
    // so a builtin harness with home null can reach the owner's Claude login.
    ...(process.env.FORGEORBIT_NATIVE_QA_ROOT ? {
      bun: {
        plugins: [electrobunRpcSecurity(), electrobunLifecycle(), electrobunQaStorage()],
        entrypoint: "src/bun/native-qa-bootstrap.ts",
        naming: "index.[ext]",
        external: ["playwright", "playwright-core", "@xenova/transformers", "onnxruntime-node", "onnxruntime-web"],
        define: { __FORGEORBIT_NATIVE_QA_ROOT__: JSON.stringify(realpathSync(process.env.FORGEORBIT_NATIVE_QA_ROOT)) },
      },
    } : {
      // The Electrobun launcher loads flat bundles only from bun/index.js.
      // Without this naming, the entry file name (native-bootstrap.js) is
      // emitted and the app cannot start.
      bun: {
        entrypoint: "src/bun/native-bootstrap.ts",
        naming: "index.[ext]",
        external: ["playwright", "playwright-core", "@xenova/transformers", "onnxruntime-node", "onnxruntime-web"],
        plugins: [electrobunRpcSecurity(), electrobunLifecycle(), ...(isolatedStorage ? [electrobunQaStorage()] : [])],
        ...(localBuild ? { define: { __FORGEORBIT_LOCAL_BUILD__: "true" } } : {}),
      },
    }),
    copy: {
      // Recursive copy preserves profiles (including nested game roles), strategy,
      // manifest, README, MIT license and provenance under Resources/app/.
      "resources/agent-catalog/agency-agents": "resources/agent-catalog/agency-agents",
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      // Boot splash logo. Source straight from src/mainview/public/ rather
      // than dist/ — Vite only writes the file to dist/ during `vite build`,
      // so when `bun run dev:hmr` runs the electrobun copy step before any
      // production build has happened, dist/splash-logo.png doesn't exist
      // and electrobun aborts. The source path always exists.
      "src/mainview/public/splash-logo.png": "views/mainview/splash-logo.png",
      // Bundled tmux for users without one on PATH — see scripts/fetch-tmux.ts.
      // Lands at Contents/Resources/app/bin/ inside the .app, which is what
      // src/bun/tmux-resolution.ts:bundledTmuxPath() points to at runtime.
      "vendor/tmux/arm64": "bin",
      // Our own native arm64 notifier helper (ForgeOrbitNotifier.app) — posts
      // deep-linkable notifications via UNUserNotificationCenter and opens
      // forgeorbit://task/<id> on click (built by scripts/build-notifier.ts from
      // native/notifier/). Lands at Contents/Resources/app/bin/
      // ForgeOrbitNotifier.app; src/bun/notifier.ts:resolveNotifier() points at its
      // inner executable. No third-party binary, no Rosetta.
      "vendor/notifier": "bin",
      // Our own native arm64 "disclaim" helper — execs a spawned command as
      // TCC-responsible for itself instead of inheriting ForgeOrbit's responsible
      // process identity (built by scripts/build-disclaim.ts from
      // native/disclaim/). Lands at Contents/Resources/app/bin/disclaim;
      // src/bun/disclaim.ts:bundledDisclaimPath() points at it.
      "vendor/disclaim": "bin",
      "vendor/owner-trust": "bin",
      "vendor/computer-use": "bin",
      // Playwright's library only. Chromium itself stays in the local Playwright
      // browser cache and is never copied from the Owner's Chrome profile.
      "node_modules/playwright": "node_modules/playwright",
      "node_modules/playwright-core": "node_modules/playwright-core",
      ...stagedBrainCopies(import.meta.dir),
    },
    watchIgnore: ["dist/**", ".agetor/**", "vendor/**"],
    mac: {
      bundleCEF: false,
      icons: "src/assets/forgeorbit.iconset",
      codesign: !localBuild,
      notarize: !localBuild,
    },
    linux: { bundleCEF: false, icon: "src/assets/forgeorbit-icon.png" },
    win: { bundleCEF: false, icon: "src/assets/forgeorbit-icon.ico" },
  },
} satisfies ElectrobunConfig;
