import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMachO64 } from "../../scripts/fetch-tmux.ts";

test("vendored tmux cache rejects a shell stub and accepts Mach-O 64 magic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo-fetch-tmux-"));
  const stub = path.join(dir, "tmux");
  writeFileSync(stub, "#!/bin/sh\necho 99.0.0-fake\n");
  expect(isMachO64(stub)).toBe(false);
  const macho = path.join(dir, "real");
  writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  expect(isMachO64(macho)).toBe(true);
  expect(isMachO64(path.join(dir, "missing"))).toBe(false);
});
