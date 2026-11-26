import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCoreCreds, writeCoreCreds } from "./core-creds.ts";
import { ownNativeCredentials } from "./native-runtime-cleanup.ts";

for (const replacement of [false, true]) {
  test(`native cleanup is idempotent and ${replacement ? "preserves replacement" : "removes owned"} credentials`, () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "fo-native004-credentials-"));
    let stops = 0;
    const cleanup = ownNativeCredentials(dataDir, "synthetic-owner", () => { stops++; });
    writeCoreCreds({ port: 1, token: replacement ? "synthetic-successor" : "synthetic-owner", pid: process.pid,
      kind: "app", version: "fixture", startedAt: Date.now() }, dataDir);
    cleanup(); cleanup();
    expect(stops).toBe(1);
    expect(readCoreCreds(dataDir)?.token ?? null).toBe(replacement ? "synthetic-successor" : null);
    process.removeListener("exit", cleanup);
  });
}
