import { expect, test } from "bun:test";
import path from "node:path";

async function runIsolatedSuite(file: string): Promise<void> {
  const proc = Bun.spawn(["bun", "test", path.join(import.meta.dir, file)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${file} failed (exit ${code}):\n${stdout}\n${stderr}`);
  }
}

test("FO-KANBAN-RECURRING01 isolated lifecycle, smart queue, recovery, and backup/restore suite", async () => {
  await runIsolatedSuite("recurring-lifecycle.suite.ts");
}, 120_000);

test("FO-KANBAN-RECURRING01 isolated Owner authorization (expiry, budget, HTTP auth) suite", async () => {
  await runIsolatedSuite("recurring-auth.suite.ts");
}, 90_000);
