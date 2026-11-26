/**
 * Process supervision that does not launch DSH or Cursor.
 * A path Seatbelt still allows a pre-existing hard link. Callers must refuse
 * a workspace that contains one. setsid descendants stay reachable only while
 * their ancestor pid is known, so the supervisor records descendants before
 * the parent exits and kills that set.
 */
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export function escapingHardLinks(root: string): string[] {
  const counts = new Map<string, { nlink: number; paths: string[] }>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const key = `${stat.dev}:${stat.ino}`;
      const row = counts.get(key) ?? { nlink: stat.nlink, paths: [] };
      row.nlink = stat.nlink;
      row.paths.push(full);
      counts.set(key, row);
    }
  };
  walk(root);
  const escaping: string[] = [];
  for (const row of counts.values()) if (row.nlink > row.paths.length) escaping.push(...row.paths);
  return escaping;
}

export function descendantPids(rootPid: number): number[] {
  const listed = spawnSync("/bin/ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of (listed.stdout ?? "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid <= 0) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid) || pid === rootPid) continue;
    seen.add(pid);
    found.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return found;
}

/** Kills recorded descendants. Does not signal any pid that was not observed under rootPid. */
export function killOwnedTree(rootPid: number): number[] {
  const pids = descendantPids(rootPid);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  try { process.kill(rootPid, "SIGKILL"); } catch { /* already gone */ }
  return pids;
}

/** A clean tree is not DSH admission. Component boot and unconfined reads stay blocked. */
export function workspaceHardLinkPreflight(root: string): { ok: true } | { ok: false; reason: string; paths: string[] } {
  const paths = escapingHardLinks(root);
  if (paths.length === 0) return { ok: true };
  return {
    ok: false,
    paths,
    reason: "A hard link inside the project names an inode that also exists outside it. Path Seatbelt rules do not stop that read. Execution stays blocked.",
  };
}

export function containedStdio(): ["pipe", "pipe", "pipe"] {
  return ["pipe", "pipe", "pipe"];
}

export function spawnContained(argv: string[]): ReturnType<typeof spawn> {
  return spawn(argv[0]!, argv.slice(1), { stdio: containedStdio() });
}
