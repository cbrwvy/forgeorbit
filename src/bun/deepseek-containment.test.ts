import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { deepseekRealExecutionBlock } from "../shared/provider-readiness.ts";
import { DEEPSEEK_POLICY } from "./deepseek-execution-policy.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a path Seatbelt allows a project hard link to read an outside inode", () => {
  const root = mkdtempSync("/private/tmp/fo-ds-hl-");
  roots.push(root);
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  const secret = path.join(outside, "secret.txt");
  const alias = path.join(project, "alias.txt");
  writeFileSync(secret, "OUTSIDE-SECRET\n", { mode: 0o600 });
  linkSync(secret, alias);
  const script = path.join(root, "read.js");
  writeFileSync(script, `const fs = require("node:fs");
try { process.stdout.write(fs.readFileSync(${JSON.stringify(alias)}, "utf8")); }
catch (e) { process.stdout.write("DENY " + (e.code || "error")); }
`);
  const profile = path.join(root, "policy.sb");
  writeFileSync(profile, `(version 1)
(allow default)
(deny file-read-data (subpath ${JSON.stringify(outside)}))
(allow file-read-data (subpath ${JSON.stringify(project)}) (literal ${JSON.stringify(script)}))
(deny file-write*)
`);
  const run = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, script], { encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("OUTSIDE-SECRET\n");
  expect(DEEPSEEK_POLICY.blockers).toContain("hard-link-alias");
  expect(DEEPSEEK_POLICY.status).toBe("blocked");
  expect(deepseekRealExecutionBlock()).toContain("hard link");
});

test("a setsid child survives its parent's process-group signal", async () => {
  const root = mkdtempSync("/private/tmp/fo-ds-pg-");
  roots.push(root);
  const marker = path.join(root, "child-pid");
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));
    child.unref();
    setTimeout(() => process.exit(0), 200);
  `], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    parent.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`parent ${code}`)));
    parent.once("error", reject);
  });
  const pid = Number(readFileSync(marker, "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  try {
    process.kill(-parent.pid!, "SIGKILL");
  } catch {
    /* the parent group is already gone */
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(true);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
});
