import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  blockingReason,
  defaultComposeProjectName,
  displayPhase,
  emptyDraft,
  environmentActions,
  literalEnvRejection,
  profileFromDraft,
  redactEnvironmentText,
  splitArgLines,
  toPublicProfile,
} from "./present.ts";
import type { LaunchProfile } from "./types.ts";

function projectDir(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "fo-present-")));
}

test("display phases and actions follow ownership", () => {
  expect(displayPhase({ configured: false, recordedPhase: "running", ownership: "session" })).toBe("not-configured");
  expect(displayPhase({ configured: true, recordedPhase: "running", ownership: "external" })).toBe("external");
  expect(displayPhase({ configured: true, recordedPhase: "degraded", ownership: "session" })).toBe("degraded");
  expect(environmentActions("stopped", "none")).toEqual({ start: true, stop: false, restart: false });
  expect(environmentActions("running", "session")).toEqual({ start: false, stop: true, restart: true });
  expect(environmentActions("running", "prior-forgeorbit")).toEqual({ start: false, stop: true, restart: true });
  expect(environmentActions("starting", "session")).toEqual({ start: false, stop: false, restart: false });
  expect(environmentActions("stopping", "session")).toEqual({ start: false, stop: false, restart: false });
  expect(environmentActions("external", "external")).toEqual({ start: false, stop: false, restart: false });
  expect(environmentActions("unknown", "unverified")).toEqual({ start: false, stop: false, restart: false });
  expect(environmentActions("error", "none").stop).toBe(false);
  expect(environmentActions("error", "session").stop).toBe(true);
  expect(blockingReason("external", "external")).toContain("will not stop");
  expect(blockingReason("unknown", "unverified")).toContain("will not signal");
  expect(blockingReason("running", "session")).toBeNull();
});

test("compose project names are stable and do not use the directory basename", () => {
  const name = defaultComposeProjectName("/tmp/mediatest");
  expect(name).toBe(defaultComposeProjectName("/tmp/mediatest"));
  expect(name).toMatch(/^fo-[a-f0-9]{8}$/);
  expect(name).not.toContain("mediatest");
});

test("argv stays separate and a shell command is rejected", () => {
  const dir = projectDir();
  expect(splitArgLines("run\ndev\n")).toEqual(["run", "dev"]);
  const draft = emptyDraft(dir);
  draft.name = "App";
  draft.executable = "/bin/echo";
  draft.args = ["$HOME", "a; rm"];
  draft.cwd = dir;
  const ok = profileFromDraft(dir, draft);
  expect(ok.ok).toBe(true);
  if (ok.ok && ok.profile.launch.kind === "local-process") {
    expect(ok.profile.launch.command.args).toEqual(["$HOME", "a; rm"]);
  }
  draft.executable = "bash";
  draft.args = ["-c", "echo hi"];
  const rejected = profileFromDraft(dir, draft);
  expect(rejected.ok).toBe(false);
});

test("local URLs must be loopback and literals are not public", () => {
  const dir = projectDir();
  const draft = emptyDraft(dir, "local-process");
  draft.name = "App";
  draft.executable = "bun";
  draft.args = ["run", "dev"];
  draft.cwd = dir;
  draft.websiteUrl = "https://example.com";
  expect(profileFromDraft(dir, draft).ok).toBe(false);
  draft.websiteUrl = "http://127.0.0.1:3000/";
  draft.httpUrl = "";
  const ok = profileFromDraft(dir, draft);
  expect(ok.ok).toBe(true);
  expect(literalEnvRejection([{ name: "TOKEN", from: "literal", value: "secret" }])).toContain("inherit");
  expect(literalEnvRejection([{ name: "PORT", from: "inherit" }])).toBeNull();
  if (!ok.ok) return;
  const stored: LaunchProfile = {
    ...ok.profile,
    env: [{ name: "TOKEN", from: "literal", value: "super-secret" }],
  };
  const pub = toPublicProfile(stored);
  expect(JSON.stringify(pub)).not.toContain("super-secret");
  expect(pub.env[0]).toEqual({ name: "TOKEN", from: "literal", redacted: true });
});

test("redaction removes tokens without eating short words", () => {
  const token = "ab".repeat(16);
  expect(redactEnvironmentText(`token=${token} ok`, [token])).toBe("token=[redacted] ok");
  expect(redactEnvironmentText("FORGEORBIT_ENV_TOKEN=abcdef1234567890 trailing", [])).toContain("[redacted]");
  expect(redactEnvironmentText("dev server", ["dev"])).toBe("dev server");
});
