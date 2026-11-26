/** Electrobun postBuild hook: inspect copied output before signing/wrapping. */
import path from "node:path";
import { readFileSync } from "node:fs";
import { CATALOG_RESOURCE_PATH } from "../src/bun/catalog/catalog-resources.ts";
import { catalogInventory, verifyCatalogPackage } from "../src/bun/catalog/catalog-package.ts";
import { verifyNativeRpcPackage } from "./native-rpc-build-acceptance.ts";
import { installLauncherLifecycle, verifyNativeLifecyclePackage } from "./electrobun-lifecycle.ts";
import { installBackupWorker, verifyBackupWorkerPackage } from "./backup-worker-package.ts";
import { installBundledBrowser, verifyBundledBrowserPackage } from "./bundled-browser-package.ts";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
if (!buildDir || !appName) throw new Error("Electrobun build directory and app name are required.");
const mac = process.env.ELECTROBUN_OS === "macos";
// 1.18.1's hook APP_NAME is the channel-suffixed name without the .app extension.
const root = path.join(buildDir, mac ? `${appName}.app` : appName, ...(mac ? ["Contents"] : []), "Resources/app", CATALOG_RESOURCE_PATH);
const source = path.resolve(import.meta.dir, "..", CATALOG_RESOURCE_PATH);
const result = verifyCatalogPackage(root);
for (const file of catalogInventory(source)) {
  if (!readFileSync(path.join(source, file)).equals(readFileSync(path.join(root, file)))) {
    throw new Error(`Catalog copy differs from source: ${file}`);
  }
}
console.log("[FO-PKG01] Built artifact catalog verified:", JSON.stringify(result));
console.log("[FO-NATIVE003] package verified", JSON.stringify(verifyNativeRpcPackage(path.resolve(root, "../../.."))));
const resources = path.resolve(root, "../../../..");
await installLauncherLifecycle(resources);
verifyNativeLifecyclePackage(path.join(resources, "app"));
console.log("[FO-NATIVE004] package verified");
await installBackupWorker(resources);
verifyBackupWorkerPackage(path.join(resources, "app"));
installBundledBrowser(path.join(resources, "app"));
verifyBundledBrowserPackage(path.join(resources, "app"));
console.log("[FO-BROWSER04] package verified");
if (process.env.FORGEORBIT_NATIVE_QA_ROOT) {
  const { verifyQaStoragePackage } = await import("./electrobun-qa-storage.ts");
  verifyQaStoragePackage(path.dirname(resources), process.env.FORGEORBIT_NATIVE_QA_ROOT, true);
  console.log("[FO-NATIVE005] QA storage package verified");
}
