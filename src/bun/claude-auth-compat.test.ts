import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertBoundedClaudeAuthentication, copyClaudeStorageCompatibility, CLAUDE_SECURE_STORAGE_SELECTOR } from "./claude-auth-compat.ts";
const root = mkdtempSync(path.join(tmpdir(), "fo-auth-compat-"));
afterAll(() => rmSync(root, {recursive:true,force:true}));
test("compatibility selector is explicit only, preserving tested empty value", () => {
  const env: Record<string,string> = {};
  copyClaudeStorageCompatibility({}, env); expect(env).toEqual({});
  copyClaudeStorageCompatibility({[CLAUDE_SECURE_STORAGE_SELECTOR]:""}, env); expect(env[CLAUDE_SECURE_STORAGE_SELECTOR]).toBe("");
});
test("documented auth-status probe has no prompt, discloses no secrets and fails closed", async () => {
  for (const [name, out, ok] of [["good", '{"loggedIn":true,"token":"SECRET"}',true],["loggedout",'{"loggedIn":false}',false],["invalid",'secret token',false]] as const) {
    const bin = path.join(root,name);
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = auth ] && [ "$2" = status ] || exit 19\nprintf '%s' '${out}'\n`, {mode:0o700});
    if (ok) await assertBoundedClaudeAuthentication(bin,{PATH:"/usr/bin:/bin", HOME:root});
    else await expect(assertBoundedClaudeAuthentication(bin,{PATH:"/usr/bin:/bin",HOME:root})).rejects.toThrow("authentication could not be established");
  }
});
