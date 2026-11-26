import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createOfflineMacosBoundary, offlineBoundaryRequest } from "./macos-offline-boundary.ts";

const root = mkdtempSync("/private/tmp/fo-deepseek03-policy-");
const project = root + "/project", scratch = root + "/scratch", runtime = root + "/runtime";
for (const p of [project, scratch, runtime]) mkdirSync(p, { mode: 0o700 });
const bin = runtime + "/probe";
writeFileSync(bin, "synthetic runtime"); chmodSync(bin, 0o700);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const make = (role: "developer" | "reviewer" = "developer") => createOfflineMacosBoundary({ project, scratch, executable: bin, role });

test("deny-default policy freezes exact runtime, role, scratch, and dyld bootstrap", () => {
  const b = make();
  expect(b.profile).toContain("(deny default)");
  expect(b.profile).not.toContain('(import "system.sb")');
  expect(b.profile).toContain(`(allow process-exec (literal "${bin}"))`);
  expect(b.profile).toContain(`(allow file-write* (subpath "${scratch}") (subpath "${project}"))`);
  expect(b.profile).not.toContain("(allow network");
  expect(b.profile).not.toContain("(allow mach-lookup");
  expect(Object.isFrozen(b.snapshot.runtime)).toBe(true);
  expect(make().digest).toBe(b.digest);
  expect(make("reviewer").digest).not.toBe(b.digest);
  expect(make("reviewer").profile).toContain(`(allow file-write* (subpath "${scratch}"))`);
});
test("canonical roots bind symlink aliases and reject overlaps/broad roots/runtime writes", () => {
  symlinkSync(project, root + "/alias");
  expect(createOfflineMacosBoundary({ project: root + "/alias", scratch, executable: bin, role: "developer" }).digest).toBe(make().digest);
  for (const patch of [{ scratch: project }, { project: "/private/tmp" }, { executable: scratch }, { project: "relative" }, { project: project + "\n" }]) {
    expect(() => createOfflineMacosBoundary({ project, scratch, executable: bin, role: "developer", ...patch })).toThrow();
  }
  chmodSync(scratch, 0o755); expect(make).toThrow("private"); chmodSync(scratch, 0o700);
});
test("runtime/policy/path identity changes invalidate the frozen offline request", () => {
  const b = make();
  const r = offlineBoundaryRequest(b, ["read", "$literal"], "ab".repeat(16), () => {});
  expect(r.executable).toBe("/usr/bin/sandbox-exec");
  expect(r.args.slice(-2)).toEqual(["read", "$literal"]);
  expect(r.processGroup).toBe(true);
  expect(() => offlineBoundaryRequest({ ...b, profile: b.profile + "(allow default)" }, [], "ab".repeat(16), () => {})).toThrow("identity changed");
  expect(() => offlineBoundaryRequest({ ...b, snapshot: { ...b.snapshot, role: "reviewer" } }, [], "ab".repeat(16), () => {})).toThrow("identity changed");
  expect(r.env.HOME).toBe(scratch); expect(r.env.TMPDIR).toBe(scratch);
  expect(Object.keys(r.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
  writeFileSync(bin, "changed runtime");
  expect(() => offlineBoundaryRequest(b, [], "ab".repeat(16), () => {})).toThrow("identity changed");
  writeFileSync(bin, "synthetic runtime");
  expect(make().digest).toBe(b.digest);
  const other = root + "/other"; mkdirSync(other, { mode: 0o700 });
  expect(createOfflineMacosBoundary({ project: other, scratch, executable: bin, role: "developer" }).digest).not.toBe(b.digest);
  const original = readFileSync(bin); expect(original.toString()).toBe("synthetic runtime");
});
test("replacement of an approved directory is detected before making a launch request", () => {
  const dir = root + "/replace-project"; mkdirSync(dir, { mode: 0o700 });
  const b = createOfflineMacosBoundary({ project: dir, scratch, executable: bin, role: "developer" });
  renameSync(dir, dir + "-original"); mkdirSync(dir, { mode: 0o700 });
  expect(() => offlineBoundaryRequest(b, [], "ab".repeat(16), () => {})).toThrow("identity changed");
});
