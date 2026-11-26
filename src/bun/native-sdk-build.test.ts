import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptNativeRpcBuild } from "../../scripts/native-rpc-build-acceptance.ts";

// Real embedded Electrobun CLI loading/configuration/packaging; never runs the
// produced app, SDK listener, FFI or a real agent. Keep all evidence in tmpdir.
test("embedded native CLI loads security helper; import fallback, drift and missing transform cannot pass acceptance", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native CLI regression requires macOS arm64");
  const repo = path.resolve(import.meta.dir, "../..");
  const fixture = mkdtempSync(path.join(tmpdir(), "fo-native003-cli-"));
  for (const dir of ["node_modules", "scripts", "patches/electrobun-1.18.1", "home", "tmp", "src/bun", "evidence"]) {
    mkdirSync(path.join(fixture, dir), { recursive: true });
  }
  // APFS independent clones, not installed-SDK edits or hardlinks to its cache.
  execFileSync("/bin/cp", ["-cR", path.join(repo, "node_modules/electrobun"), path.join(fixture, "node_modules/electrobun")]);
  for (const file of ["scripts/electrobun-rpc-security.ts", "scripts/native-rpc-build-acceptance.ts", "scripts/electrobun-lifecycle.ts",
    "patches/electrobun-1.18.1/socket.ts", "patches/electrobun-1.18.1/browser.ts", "patches/electrobun-1.18.1/lifecycle-supervisor.ts"]) {
    copyFileSync(path.join(repo, file), path.join(fixture, file));
  }
  const sdk = path.join(fixture, "node_modules/electrobun");
  const pkgFile = path.join(sdk, "package.json");
  const socketFile = path.join(sdk, "dist/api/bun/core/Socket.ts");
  const originalPkg = readFileSync(pkgFile, "utf8");
  const originalSocket = readFileSync(socketFile, "utf8");
  const utilsFile = path.join(sdk, "dist/api/bun/core/Utils.ts");
  const launcherFile = path.join(sdk, "dist/main.js");
  const originalUtils = readFileSync(utilsFile, "utf8");
  const originalLauncher = readFileSync(launcherFile, "utf8");
  writeFileSync(path.join(fixture, "package.json"), '{"name":"fo-native003-cli-fixture","type":"module"}');
  writeFileSync(path.join(fixture, "entry.ts"), 'export { rpcPort } from "./node_modules/electrobun/dist/api/bun/core/Socket.ts"; export { quit } from "./node_modules/electrobun/dist/api/bun/core/Utils.ts";');
  writeFileSync(path.join(fixture, "src/bun/index.ts"), 'console.log("inert default-config fixture; never executed");');
  writeFileSync(path.join(fixture, "view.js"), 'console.log("inert view; never executed");');
  writeFileSync(path.join(fixture, "scripts/check-package.ts"), `
    import path from 'node:path';
    import { verifyNativeRpcPackage } from './native-rpc-build-acceptance.ts';
    import { installLauncherLifecycle, verifyNativeLifecyclePackage } from './electrobun-lifecycle.ts';
    const appCode = path.join(process.env.ELECTROBUN_BUILD_DIR!,process.env.ELECTROBUN_APP_NAME!+'.app','Contents/Resources/app');
    console.log('[FO-NATIVE003] package verified', JSON.stringify(verifyNativeRpcPackage(appCode)));
    await installLauncherLifecycle(path.dirname(appCode));
    verifyNativeLifecyclePackage(appCode);
    console.log('[FO-NATIVE004] package verified');
  `);
  const env = { HOME: path.join(fixture, "home"), TMPDIR: path.join(fixture, "tmp"),
    PATH: `${path.join(sdk, "dist-macos-arm64") }:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/sh", LANG: "en_US.UTF-8" };
  for (const mode of ["valid", "old-resolver", "version-drift", "source-drift", "missing-transform", "utils-drift", "launcher-drift", "missing-lifecycle"]) {
    writeFileSync(pkgFile, originalPkg); writeFileSync(socketFile, originalSocket);
    writeFileSync(utilsFile, originalUtils); writeFileSync(launcherFile, originalLauncher);
    if (mode === "version-drift") writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(originalPkg), version: "1.18.2" }));
    if (mode === "source-drift") writeFileSync(socketFile, originalSocket + "\n// synthetic drift\n");
    if (mode === "utils-drift") writeFileSync(utilsFile, originalUtils + "\n// synthetic drift\n");
    if (mode === "launcher-drift") writeFileSync(launcherFile, originalLauncher + "\n// synthetic drift\n");
    const oldResolver = mode === "old-resolver" ? `import {createRequire} from 'node:module'; createRequire(import.meta.url).resolve('electrobun/bun');` : "";
    writeFileSync(path.join(fixture, "electrobun.config.ts"), `
      import {electrobunRpcSecurity} from './scripts/electrobun-rpc-security.ts';
      import {electrobunLifecycle} from './scripts/electrobun-lifecycle.ts';
      ${oldResolver}
      const synthetic = {name:'inert-view',setup(b) {
        b.onResolve({filter:/BrowserView(?:\\.ts)?$/},()=>({path:'view',namespace:'synthetic'}));
        b.onLoad({filter:/.*/,namespace:'synthetic'},()=>({loader:'ts',contents:'export class BrowserView { static getById() {} }'}));
        b.onResolve({filter:/proc\\/native$/},()=>({path:'native',namespace:'native'}));
        b.onLoad({filter:/.*/,namespace:'native'},()=>({loader:'ts',contents:'export const ffi = {}; export const native = null;'}));
      }};
      export default {
        app:{name:'ForgeOrbitRPCBuildTest',identifier:'qa.forgeorbit.rpcbuild',version:'0.0.0'},
        build:{buildFolder:'build-${mode}',useAsar:false,
          bun:{entrypoint:'entry.ts',naming:'index.[ext]',plugins:[${mode === "missing-transform" ? "" : "electrobunRpcSecurity(),"}${mode === "missing-lifecycle" ? "" : "electrobunLifecycle(),"}synthetic]},
          copy:{'view.js':'views/mainview/view.js'},
          mac:{bundleCEF:false,icons:'',codesign:false,notarize:false}},
        scripts:{postBuild:'scripts/check-package.ts'},release:{generatePatch:false}
      };
    `);
    // Exercise the real SDK independently of product release metadata. The
    // fixture is deliberately inert and has no product Git/version identity.
    const result = spawnSync(path.join(sdk, "bin/electrobun"), ["build", "--env=dev"], {
      cwd: fixture, env, encoding: "utf8", timeout: 30000,
    });
    expect(result.error).toBeUndefined();
    const log = result.stdout + result.stderr;
    writeFileSync(path.join(fixture, "evidence", `${mode}.log`), log);
    expect(log).not.toMatch(/Downloading|downloading\.\.\./);
    const appCode = path.join(fixture, `build-${mode}/dev-macos-arm64/ForgeOrbitRPCBuildTest-dev.app/Contents/Resources/app`);
    if (mode === "valid") {
      expect(result.status, log).toBe(0);
      const proof = acceptNativeRpcBuild(log, appCode);
      expect(proof.backend.file).toBe("bun/index.js");
      expect(() => acceptNativeRpcBuild(log, appCode, true)).toThrow("view transform missing");
      expect(() => acceptNativeRpcBuild("using default config instead\n" + log, appCode)).toThrow("fallback");
      expect(() => acceptNativeRpcBuild(log.replace("[FO-NATIVE003] socket transform applied", ""), appCode)).toThrow("receipts missing");
    } else {
      if (!["utils-drift", "launcher-drift", "missing-lifecycle"].includes(mode)) expect(() => acceptNativeRpcBuild(log, appCode)).toThrow("NATIVE-003");
      if (mode === "old-resolver") {
        expect(log).toContain("Failed to load config");
        expect(log).toContain("using default config");
      } else {
        expect(result.status, log).not.toBe(0);
        expect(log).not.toContain("using default config");
        expect(log).toContain(mode === "missing-transform" ? "packaged RPC transform missing" : mode === "missing-lifecycle" ? "backend lifecycle transform missing" : "unreviewed Electrobun");
      }
    }
  }
  console.log("NATIVE003 real CLI regression evidence:", path.join(fixture, "evidence"));
}, 120000);
