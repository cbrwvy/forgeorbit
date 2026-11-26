import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";

export const QA_IDENTIFIER = "app.forgeorbit.qa";
export const QA_PARTITION = "fo-native005-qa-ephemeral";
const marker = "FO-NATIVE005-QA-EPHEMERAL-V1";
const viewHash = "c63f9d7185f67716382b79d1363f0e6e5f9619e3b0dd2aa826e323b365598c4f";
const pins = {
  "dist/api/bun/proc/native.ts": "eff5c9c871a2bde2ec06d5c3a65a9e97957101a66dd9e659c4b38029ce64c6e1",
  "dist-macos-arm64/libNativeWrapper.dylib": "25c117cd210e2d13a77e0f811337a0ba855d4d233a35a299c632ab9d69470af7",
};
const sdk = () => path.resolve(import.meta.dirname, "../node_modules/electrobun");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** QA only: cover the first window view AND any subsequently created views.
 * A non-persist partition selects nonPersistentDataStore in the pinned native
 * renderer, before WKWebView construction. No SDK files are modified.
 */
export function patchQaBrowserView(source: string): string {
  if (hash(source) !== viewHash) throw new Error("NATIVE-005: unreviewed BrowserView source");
  const before = "this.partition = options.partition || null;";
  if (source.split(before).length !== 2) throw new Error("NATIVE-005: ambiguous partition patch");
  source = source.replace(before, `// ${marker}
        if (options.renderer === "cef") throw new Error("NATIVE-005: QA requires native WebKit");
        this.partition = "${QA_PARTITION}";
        console.log("${marker}: non-persist partition selected before native view creation");`);
  return source.replace('this.renderer = options.renderer ?? defaultOptions.renderer ?? "native";', 'this.renderer = "native";');
}

export function electrobunQaStorage(): BunPlugin {
  return { name: "forgeorbit-native005-qa-storage", setup(build) {
    if (process.platform !== "darwin" || process.arch !== "arm64"
      || JSON.parse(readFileSync(path.join(sdk(), "package.json"), "utf8")).version !== "1.18.1") {
      throw new Error("NATIVE-005: QA storage requires reviewed Electrobun 1.18.1 macOS arm64");
    }
    for (const [file, digest] of Object.entries(pins)) {
      if (hash(readFileSync(path.join(sdk(), file))) !== digest) throw new Error(`NATIVE-005: unreviewed SDK ${file}`);
    }
    patchQaBrowserView(readFileSync(path.join(sdk(), "dist/api/bun/core/BrowserView.ts"), "utf8"));
    build.onLoad({ filter: /[/\\]electrobun[/\\]dist[/\\]api[/\\]bun[/\\]core[/\\]BrowserView\.ts$/ }, async args => {
      const contents = patchQaBrowserView(await Bun.file(args.path).text());
      console.log("[FO-NATIVE005] QA storage transform applied");
      return { contents, loader: "ts" };
    });
  } };
}

/** Inspect the actual copied macOS artifact, independently of config loading.
 * Electrobun logs some config/build errors instead of reliably failing closed.
 */
export function verifyQaStoragePackage(contents: string, root: string, metadataPending = false): void {
  const plist = readFileSync(path.join(contents, "Info.plist"), "utf8");
  // SDK writes version.json AFTER postBuild. The secure wrapper must call the
  // default, complete verification after the CLI returns (and before launch).
  const version = metadataPending ? null : JSON.parse(readFileSync(path.join(contents, "Resources/version.json"), "utf8"));
  const code = readFileSync(path.join(contents, "Resources/app/bun/index.js"), "utf8");
  if (hash(readFileSync(path.join(contents, "MacOS/libNativeWrapper.dylib"))) !== pins["dist-macos-arm64/libNativeWrapper.dylib"]) {
    throw new Error("NATIVE-005: packaged native renderer differs from reviewed binary");
  }
  const qaId = QA_IDENTIFIER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`<key>CFBundleIdentifier<\\/key>\\s*<string>${qaId}<\\/string>`).test(plist)
    || (!metadataPending && version.identifier !== QA_IDENTIFIER) || /<key>CFBundleURLTypes<\/key>/.test(plist)) {
    throw new Error("NATIVE-005: QA identity or URL scheme isolation missing");
  }
  if (!code.includes(marker) || !code.includes(`this.partition = "${QA_PARTITION}"`)
    || code.includes("this.partition = options.partition || null;")
    || !code.includes(JSON.stringify(realpathSync(root)))
    || !code.includes("QA artifact refused launch without its isolated environment")) {
    throw new Error("NATIVE-005: QA storage transform or baked bootstrap missing");
  }
}

/** Production-identity bundle built with the isolated WebKit store: same trust identity, non-persistent partition baked in. */
export function verifyIsolatedStoragePackage(contents: string): void {
  const plist = readFileSync(path.join(contents, "Info.plist"), "utf8");
  const code = readFileSync(path.join(contents, "Resources/app/bun/index.js"), "utf8");
  if (hash(readFileSync(path.join(contents, "MacOS/libNativeWrapper.dylib"))) !== pins["dist-macos-arm64/libNativeWrapper.dylib"]) {
    throw new Error("NATIVE-ISOLATED: packaged native renderer differs from reviewed binary");
  }
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>app\.forgeorbit<\/string>/.test(plist)) {
    throw new Error("NATIVE-ISOLATED: the bundle must keep the production identifier");
  }
  if (!code.includes(marker) || !code.includes(`this.partition = "${QA_PARTITION}"`) || code.includes("this.partition = options.partition || null;")) {
    throw new Error("NATIVE-ISOLATED: the non-persistent WebKit partition transform is missing");
  }
  if (code.includes("__FORGEORBIT_NATIVE_QA_ROOT__") || code.includes("QA artifact refused launch without its isolated environment")) {
    throw new Error("NATIVE-ISOLATED: a QA bootstrap must not be present in a production-identity bundle");
  }
}
