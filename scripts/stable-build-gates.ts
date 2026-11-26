import { validateBuildMetadata, type BuildMetadata } from "../src/shared/release-version.ts";

/** Offline preflight only. Passing this never claims signing acceptance. */
export function stableBuildGates(metadata: BuildMetadata, mac: { codesign?: boolean; notarize?: boolean }, env: NodeJS.ProcessEnv) {
  validateBuildMetadata(metadata);
  if (metadata.channel !== "stable" || metadata.platform !== "macos" || metadata.arch !== "arm64") throw new Error("Stable release acceptance currently targets macOS arm64");
  if (env.FORGEORBIT_NATIVE_QA_ROOT || env.FORGEORBIT_QA_LIVE_IDENTITY || env.FORGEORBIT_DEV_WATCH || !mac.codesign || !mac.notarize) throw new Error("Stable requires production signing/notarization gates");
  for (const key of ["ELECTROBUN_DEVELOPER_ID", "ELECTROBUN_APPLEAPIKEY", "ELECTROBUN_APPLEAPIISSUER", "ELECTROBUN_APPLEAPIKEYPATH"]) {
    if (!env[key]) throw new Error("Stable signing/notarization credentials missing");
  }
}
