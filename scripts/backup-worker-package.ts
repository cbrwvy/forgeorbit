import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export async function installBackupWorker(resources: string): Promise<void> {
  const workerSource = path.resolve(import.meta.dirname, "../src/bun/backup-worker.ts");
  const workerTarget = path.join(resources, "app/bun/backup-worker.js");
  const build = await Bun.build({
    entrypoints: [workerSource],
    target: "bun",
  });
  if (!build.success || build.outputs.length === 0) {
    throw new Error("FO-BACKUP-RUNNER: Failed to build backup-worker bundle");
  }
  const code = await build.outputs[0]!.text();
  writeFileSync(workerTarget, code);
  const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex");
  writeFileSync(path.join(resources, "app/bun/backup-worker.sha256"), hash + "\n");
  console.log("[FO-BACKUP-RUNNER] package verified");
}

export function verifyBackupWorkerPackage(appCode: string): void {
  const workerTarget = path.join(appCode, "bun/backup-worker.js");
  if (!existsSync(workerTarget) || readFileSync(workerTarget).length === 0) {
    throw new Error("FO-BACKUP-RUNNER: packaged backup-worker bundle missing or empty");
  }
  const hashTarget = path.join(appCode, "bun/backup-worker.sha256");
  if (!existsSync(hashTarget)) {
    throw new Error("FO-BACKUP-RUNNER: packaged backup-worker integrity sidecar missing");
  }
  const expected = readFileSync(hashTarget, "utf8").trim();
  const actual = new Bun.CryptoHasher("sha256").update(readFileSync(workerTarget)).digest("hex");
  if (expected !== actual) {
    throw new Error(`FO-BACKUP-RUNNER: backup-worker bundle integrity mismatch (expected ${expected}, got ${actual})`);
  }
}
