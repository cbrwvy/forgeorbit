/**
 * Verifies a ForgeOrbit bundle against the local Owner anchor.
 * A passing verification is not Owner enrollment and does not start a provider.
 */
import path from "node:path";
import { evaluateLocalSignature } from "../src/bun/owner-trust/local-signature.ts";

const appArg = process.argv.find((arg) => arg.startsWith("--app="))?.slice("--app=".length);
const anchorArg = process.argv.find((arg) => arg.startsWith("--anchor="))?.slice("--anchor=".length);
const allowTest = process.argv.includes("--allow-test-identity");
if (!appArg) {
  console.error("Usage: bun scripts/verify-local-owner.ts --app=<path> [--anchor=<sha256> --allow-test-identity]");
  process.exit(2);
}
const report = evaluateLocalSignature(path.resolve(appArg), {
  anchor: anchorArg,
  requireOwnerCn: !allowTest,
});
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
