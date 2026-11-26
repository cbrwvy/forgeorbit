#!/usr/bin/env bun
// Local build and verification only. Version allocation/commit precedes this
// command. Tags, push and publication are separate manual Owner actions.
if (process.argv.length !== 2) throw new Error("Allocate version first with bun run version:next; release takes no arguments");
for (const command of [["bun", "run", "build:stable"], ["bun", "scripts/verify-release.ts"]]) {
  const p = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  if (await p.exited !== 0) throw new Error("Local release build/verification failed");
}
console.log("Local release artifacts verified. No tags, push or publication performed.");
