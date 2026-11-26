import { resolveDataDir } from "./core-creds.ts";
import { ensurePrivateDataDir } from "./private-storage.ts";
import { acquireNativeInstanceLock } from "./native-instance-lock.ts";
import { nativeQaRoot } from "./native-qa-state.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Imports above are DB/SDK-free. Duplicate owners must be refused before
// SQLite, migrations, SDK listeners, recovery or credential writes.
// Route rejections through the fatal cleanup/code path, including after the
// SDK overrides process.exit. The launcher supervisor also catches Worker exit.
process.on("unhandledRejection", (reason) => {
  console.error("[forgeorbit] fatal unhandled backend rejection:", reason);
  process.exit(1);
});
let releaseInstanceLock: (() => void) | undefined;
try {
  // Preserve db.ts's test fallback even though ownership now precedes it.
  if (process.env.NODE_ENV === "test" && !process.env.FORGEORBIT_DATA_DIR && !process.env.AGETOR_DATA_DIR) {
    process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "forgeorbit-native-test-"));
  }
  const dir = resolveDataDir();
  ensurePrivateDataDir(dir);
  if (process.platform === "darwin") releaseInstanceLock = acquireNativeInstanceLock(dir);
} catch {
  console.error("[forgeorbit] desktop startup refused: data directory already owned or unavailable");
  process.exit(1);
}
if (nativeQaRoot()) {
  try {
    const { db } = await import("./db.ts");
    const { prepareNativeQaData } = await import("./native-qa-data.ts");
    prepareNativeQaData(db, nativeQaRoot()!, process.env.HOME!);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "SCHEMA_AHEAD") {
      console.error(`[forgeorbit] ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    console.error("[forgeorbit] QA artifact refused unsafe stored paths or overrides");
    process.exit(1);
  }
}
await import("./index.ts");
// Register after application cleanup hooks: ports/credentials must be retired
// before a new backend can acquire ownership. Failed imports and forced exits
// retain the lock until the kernel releases the process's descriptors.
if (releaseInstanceLock) process.once("exit", releaseInstanceLock);
