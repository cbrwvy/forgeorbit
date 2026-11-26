// Electrobun postBuild: stamp Info.plist, then run the existing catalog and
// native-security receipts. The plist edit has to land before codesign.
import { patchHookBundles } from "./macos-bundle-metadata.ts";

await patchHookBundles();
await import("./verify-catalog-package.ts");
