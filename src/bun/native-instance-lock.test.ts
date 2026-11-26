import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireNativeInstanceLock } from "./native-instance-lock.ts";

const modulePath = path.join(import.meta.dir, "native-instance-lock.ts");
const script = (dataDir: string) => `const {acquireNativeInstanceLock}=await import(${JSON.stringify(modulePath)}); const release=acquireNativeInstanceLock(${JSON.stringify(dataDir)});`;
const probe = (dataDir: string) => spawnSync(process.execPath, ["-e", script(dataDir) + "release();"], { encoding: "utf8", timeout: 10_000 });

test("a second process is refused; another data directory and explicit release work", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fo013a-native-lock-"));
  const other = mkdtempSync(path.join(tmpdir(), "fo013a-native-other-"));
  const release = acquireNativeInstanceLock(dataDir);
  try {
    const refused = probe(dataDir);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Another ForgeOrbit desktop instance");
    expect(probe(other).status).toBe(0);
  } finally {
    release();
    release();
  }
  expect(probe(dataDir).status).toBe(0);
});

test("the kernel releases an interrupted owner's lock without deleting a stale file", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fo013a-native-crash-"));
  const owner = Bun.spawn([process.execPath, "-e", script(dataDir) + "console.log('LOCKED'); await Bun.sleep(60000);"], { stdout: "pipe", stderr: "pipe" });
  try {
    const first = await owner.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("LOCKED");
    expect(probe(dataDir).status).not.toBe(0);
    owner.kill("SIGKILL");
    await owner.exited;
    expect(probe(dataDir).status).toBe(0);
  } finally {
    if (owner.exitCode === null) owner.kill();
    await owner.exited;
  }
});

test("concurrent launch has exactly one kernel owner and restart succeeds", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fo013a1-concurrent-"));
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", `
    try { ${script(dataDir)} console.log('OWNER'); await Bun.sleep(60000); }
    catch { console.log('REFUSED'); process.exit(10); }
  `], { stdout: "pipe", stderr: "pipe" }));
  try {
    const results = await Promise.all(children.map(async child => {
      const first = await child.stdout.getReader().read();
      return new TextDecoder().decode(first.value);
    }));
    expect(results.filter(value => value.includes("OWNER"))).toHaveLength(1);
    expect(results.filter(value => value.includes("REFUSED"))).toHaveLength(3);
    expect(probe(dataDir).status).not.toBe(0);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exited));
  }
  expect(probe(dataDir).status).toBe(0);
});
