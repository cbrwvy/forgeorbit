import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { containedStdio, descendantPids, killOwnedTree, workspaceHardLinkPreflight } from "./containment.ts";
import { DEEPSEEK_POLICY } from "../deepseek-execution-policy.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync("/private/tmp/fo-runtime-");
  roots.push(root);
  return root;
}

test("a hard link that escapes the project fails preflight and does not admit DSH", () => {
  const root = scratch();
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  const secret = path.join(outside, "secret.txt");
  const alias = path.join(project, "alias.txt");
  writeFileSync(secret, "OUTSIDE-SECRET\n");
  linkSync(secret, alias);
  const preflight = workspaceHardLinkPreflight(project);
  expect(preflight.ok).toBe(false);
  if (!preflight.ok) expect(preflight.paths).toContain(alias);
  expect(DEEPSEEK_POLICY.status).toBe("blocked");
  rmSync(alias);
  writeFileSync(path.join(project, "ordinary.txt"), "inside\n");
  expect(workspaceHardLinkPreflight(project).ok).toBe(true);
});

test("the owned-process supervisor kills a setsid descendant of a live parent", async () => {
  const root = scratch();
  const marker = path.join(root, "child-pid");
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));
    setInterval(() => {}, 1000);
  `], { stdio: "ignore" });
  const deadline = Date.now() + 3_000;
  let pid = 0;
  while (Date.now() < deadline && pid === 0) {
    try { pid = Number(readFileSync(marker, "utf8")); } catch { await Bun.sleep(20); }
  }
  expect(pid).toBeGreaterThan(0);
  let seen = false;
  const seenUntil = Date.now() + 2_000;
  while (Date.now() < seenUntil) {
    if (descendantPids(parent.pid!).includes(pid)) { seen = true; break; }
    await Bun.sleep(20);
  }
  expect(seen).toBe(true);
  const killed = killOwnedTree(parent.pid!);
  expect(killed).toContain(pid);
  await Bun.sleep(100);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

test("contained stdio does not inherit an extra file descriptor", async () => {
  const root = scratch();
  const file = path.join(root, "secret.txt");
  writeFileSync(file, "SECRET");
  const fd = openSync(file, "r");
  const child = spawn(process.execPath, ["-e", "try { require('node:fs').readFileSync('/dev/fd/3'); process.exit(0); } catch { process.exit(2); }"], { stdio: containedStdio() });
  const code = await new Promise<number | null>((resolve) => child.once("exit", (status) => resolve(status)));
  closeSync(fd);
  expect(code).toBe(2);
});
