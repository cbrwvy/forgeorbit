import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureBuild } from "./release-metadata.ts";
import { assertUpdaterContract } from "./updater-sdk-contract.ts";

// Preserve local SDK dev/watch while supplying the same metadata contract.
// Distributable artifacts must use build-native-secure's independent acceptance.
const project = process.cwd();
assertUpdaterContract(project);
const { default: config } = await import(path.join(project, "electrobun.config.ts"));
const metadata = captureBuild(project, "dev", config.app.identifier);
const cli = path.join(project, "node_modules/electrobun/bin", process.platform === "win32" ? "electrobun.exe" : "electrobun");
const result = spawnSync(cli, ["dev", ...process.argv.slice(2)], { cwd: project, stdio: "inherit",
  env: { ...process.env, FORGEORBIT_DEV_WATCH: "1", FORGEORBIT_BUILD_METADATA: JSON.stringify(metadata) } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
