import { verifyProvenance } from "./release-metadata.ts";
const [app, receiptDir] = process.argv.slice(2);
if (!app || !receiptDir) throw new Error("Usage: bun scripts/verify-provenance.ts /path/App.app /path/receipt-directory");
const receipt = verifyProvenance(app, receiptDir);
console.log("ForgeOrbit provenance PASS", receipt.artifactManifestSHA256);
