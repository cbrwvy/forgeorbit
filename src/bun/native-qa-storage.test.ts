import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { patchQaBrowserView, QA_IDENTIFIER, QA_PARTITION, verifyQaStoragePackage } from "../../scripts/electrobun-qa-storage.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const source = readFileSync(path.join(repo, "node_modules/electrobun/dist/api/bun/core/BrowserView.ts"), "utf8");

test("QA build setup rejects version, FFI, native binary and view drift in an independent SDK capsule", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-native005-pins-"));
  const sdk = path.join(root, "node_modules/electrobun");
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(path.join(repo, "scripts/electrobun-qa-storage.ts"), path.join(root, "scripts/electrobun-qa-storage.ts"));
  const { electrobunQaStorage } = await import(path.join(root, "scripts/electrobun-qa-storage.ts"));
  const files = ["package.json", "dist/api/bun/proc/native.ts", "dist/api/bun/core/BrowserView.ts", "dist-macos-arm64/libNativeWrapper.dylib"];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(sdk, file)), { recursive: true });
    execFileSync("/bin/cp", ["-c", path.join(repo, "node_modules/electrobun", file), path.join(sdk, file)]);
  }
  let registered = false;
  const setup = () => electrobunQaStorage().setup({ onLoad() { registered = true; } } as any);
  setup(); expect(registered).toBe(true);
  for (const file of files) {
    registered = false;
    writeFileSync(path.join(sdk, file), file === "package.json" ? '{"version":"1.18.2"}' : "synthetic drift");
    expect(setup).toThrow("NATIVE-005");
    expect(registered).toBe(false);
    execFileSync("/bin/cp", ["-c", path.join(repo, "node_modules/electrobun", file), path.join(sdk, file)]);
  }
});

test("QA constructor passes a non-persist partition to its first native creation, including explicit persistent overrides", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo-native005-view-"));
  writeFileSync(path.join(dir, "view.ts"), patchQaBrowserView(source));
  writeFileSync(path.join(dir, "entry.ts"), `
    import { BrowserView } from './view.ts';
    BrowserView.prototype.createStreams = function() {};
    const calls:any[] = [];
    globalThis.__qaCalls = calls;
    for (const partition of [undefined, null, 'persist:default', 'persist:owner', 'another-ephemeral']) {
      const view = new BrowserView({partition});
      if(view.partition !== '${QA_PARTITION}' || view.renderer !== 'native') throw Error('wrong view');
    }
    try {new BrowserView({renderer:'cef'}); throw Error('CEF accepted');}
    catch(e) {if(!String(e).includes('QA requires native WebKit')) throw e;}
    if(calls.length !== 5 || calls.some(x => x.partition !== '${QA_PARTITION}' || x.renderer !== 'native')) throw Error('wrong FFI creation');
    console.log('five first-create calls verified; explicit CEF refused before FFI');
  `);
  const built = await Bun.build({ entrypoints: [path.join(dir, "entry.ts")], target: "bun", outdir: path.join(dir, "out"), plugins: [{
    name: "inert-native-dependencies", setup(build) {
      build.onResolve({ filter: /^\.\.\/|^\.\/(Updater|BuildConfig|Socket)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "ts", contents: `
        export const native = null, toCString = x => x;
        export const ffi = {request:{createWebview(x) {globalThis.__qaCalls.push(x);return null;}}};
        export default {};
        export const defineElectrobunRPC = () => {};
        export const Updater = {localInfo:{hash:async()=> 'synthetic'}};
        export const BuildConfig = {get:async()=>({defaultRenderer:'cef'})};
        export const rpcPort=50000, sendMessageToWebviewViaSocket=()=>{}, removeSocketForWebview=()=>{};
      ` }));
    },
  }] });
  expect(built.success, String(built.logs)).toBe(true);
  const run = spawnSync(process.execPath, [built.outputs[0]!.path], { env: { HOME: dir, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(() => patchQaBrowserView(source + "\n// drift")).toThrow("unreviewed");
});

test("QA packaging refuses production identity, registered schemes, missing transform and missing baked guard", () => {
  const contents = mkdtempSync(path.join(tmpdir(), "fo-native005-package-"));
  const resources = path.join(contents, "Resources");
  mkdirSync(path.join(resources, "app/bun"), { recursive: true });
  mkdirSync(path.join(contents, "MacOS"));
  execFileSync("/bin/cp", ["-c", path.join(repo, "node_modules/electrobun/dist-macos-arm64/libNativeWrapper.dylib"), path.join(contents, "MacOS/libNativeWrapper.dylib")]);
  const valid = `FO-NATIVE005-QA-EPHEMERAL-V1; this.partition = "${QA_PARTITION}"; ${JSON.stringify(realpathSync(contents))}; QA artifact refused launch without its isolated environment`;
  const plist = `<key>CFBundleIdentifier</key><string>${QA_IDENTIFIER}</string>`;
  const reset = () => {
    writeFileSync(path.join(contents, "Info.plist"), plist);
    writeFileSync(path.join(resources, "version.json"), JSON.stringify({ identifier: QA_IDENTIFIER }));
    writeFileSync(path.join(resources, "app/bun/index.js"), valid);
  };
  reset(); verifyQaStoragePackage(contents, contents);
  unlinkSync(path.join(resources, "version.json"));
  verifyQaStoragePackage(contents, contents, true);
  expect(() => verifyQaStoragePackage(contents, contents)).toThrow();
  for (const mutate of [
    () => writeFileSync(path.join(contents, "Info.plist"), plist.replace(".qa", "")),
    () => writeFileSync(path.join(contents, "Info.plist"), plist + "<key>CFBundleURLTypes</key>"),
    () => writeFileSync(path.join(resources, "version.json"), '{"identifier":"app.forgeorbit"}'),
    () => writeFileSync(path.join(resources, "app/bun/index.js"), valid.replace("FO-NATIVE005-QA-EPHEMERAL-V1", "")),
    () => writeFileSync(path.join(resources, "app/bun/index.js"), valid.replace("QA artifact refused launch without its isolated environment", "")),
    () => writeFileSync(path.join(resources, "app/bun/index.js"), valid + "this.partition = options.partition || null;"),
  ]) { reset(); mutate(); expect(() => verifyQaStoragePackage(contents, contents)).toThrow("NATIVE-005"); }
  reset(); writeFileSync(path.join(contents, "MacOS/libNativeWrapper.dylib"), "synthetic substituted binary");
  expect(() => verifyQaStoragePackage(contents, contents)).toThrow("packaged native renderer");
});

test("ordinary configuration preserves production identity, URL schemes and plugins", async () => {
  const { default: config } = await import("../../electrobun.config.ts");
  expect(config.app.name).toBe("ForgeOrbit");
  expect(config.app.identifier).toBe("app.forgeorbit");
  expect(config.app.urlSchemes).toEqual(["forgeorbit", "agetor"]);
  expect(config.build.bun.entrypoint).toBe("src/bun/native-bootstrap.ts");
  expect(config.build.bun.naming).toBe("index.[ext]");
  expect(config.build.bun.plugins.map(p => p.name)).toEqual(["forgeorbit-native003", "forgeorbit-native004"]);
  const root = mkdtempSync(path.join(tmpdir(), "fo-native005-config-"));
  const result = spawnSync(process.execPath, ["-e", `const {default:c}=await import(${JSON.stringify(path.join(repo, "electrobun.config.ts"))});console.log(JSON.stringify({app:c.app,entry:c.build.bun.entrypoint,plugins:c.build.bun.plugins.map(p=>p.name)}))`], {
    env: { HOME: root, PATH: "/usr/bin:/bin", FORGEORBIT_NATIVE_QA_ROOT: root }, encoding: "utf8", timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  const qa = JSON.parse(result.stdout);
  expect(qa.app.identifier).toBe(QA_IDENTIFIER);
  expect(qa.app.urlSchemes).toEqual([]);
  expect(qa.entry).toBe("src/bun/native-qa-bootstrap.ts");
  expect(qa.plugins).toEqual(["forgeorbit-native003", "forgeorbit-native004", "forgeorbit-native005-qa-storage"]);
});

test("live QA identity keeps the QA bundle id and the real bootstrap", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-gui02-live-id-"));
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["-e", `const {default:c}=await import(${JSON.stringify(path.join(repo, "electrobun.config.ts"))});console.log(JSON.stringify({app:c.app,entry:c.build.bun.entrypoint,plugins:c.build.bun.plugins.map(p=>p.name),define:c.build.bun.define??null}))`], {
    env, encoding: "utf8", timeout: 5000,
  });
  const live = run({ HOME: root, PATH: "/usr/bin:/bin", FORGEORBIT_QA_LIVE_IDENTITY: "1" });
  expect(live.status, live.stderr).toBe(0);
  const parsed = JSON.parse(live.stdout);
  expect(parsed.app.name).toBe("ForgeOrbitQA");
  expect(parsed.app.identifier).toBe(QA_IDENTIFIER);
  expect(parsed.app.urlSchemes).toEqual([]);
  expect(parsed.entry).toBe("src/bun/native-bootstrap.ts");
  expect(parsed.plugins).toEqual(["forgeorbit-native003", "forgeorbit-native004"]);
  expect(parsed.define).toBeNull();
  const both = run({ HOME: root, PATH: "/usr/bin:/bin", FORGEORBIT_QA_LIVE_IDENTITY: "1", FORGEORBIT_NATIVE_QA_ROOT: root });
  expect(both.status).not.toBe(0);
  expect(both.stderr).toContain("cannot be combined");
});
