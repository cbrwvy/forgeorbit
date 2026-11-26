import { describe, expect, test } from "bun:test";
import { classifyLaunchTarget, type LaunchTargetInput } from "./provider-launch-target.ts";
import { d9En } from "../mainview/i18n/d9.ts";

const base: LaunchTargetInput = {
  kind: "codex",
  contractBlocked: false,
  registration: "not-applicable",
  executable: { bin: "codex", path: "/opt/codex", source: "path-lookup" },
  version: { raw: "codex-cli 0.159.2", state: "read" },
  floor: { model: "gpt-6.1-sol", min: "0.159.0" },
  fixtureDriver: false,
  inertStub: false,
  mode: { id: "auto", supported: true },
};
const run = (over: Partial<LaunchTargetInput>) => classifyLaunchTarget({ ...base, ...over });

describe("classifyLaunchTarget", () => {
  test("compatible only states what the check can establish", () => {
    expect(run({})).toMatchObject({ verdict: "compatible", code: "compatible", minimumEnforced: true, version: { parsed: "0.159.2" } });
  });
  test("precedence: contract, registration, missing executable, mode, then version", () => {
    const all = { contractBlocked: true, registration: "stale" as const, executable: { bin: "x", path: null, source: "default-name" as const }, mode: { id: "m", supported: false }, version: { raw: "codex-cli 0.1.0", state: "read" as const } };
    expect(run(all).code).toBe("contract-blocked");
    expect(run({ ...all, contractBlocked: false }).code).toBe("registration-stale");
    expect(run({ ...all, contractBlocked: false, registration: "ok" }).code).toBe("executable-missing");
    expect(run({ ...all, contractBlocked: false, registration: "ok", executable: base.executable }).code).toBe("mode-unsupported");
    expect(run({ ...all, contractBlocked: false, registration: "ok", executable: base.executable, mode: base.mode }).code).toBe("version-below-minimum");
  });
  test("unreadable and unchecked versions are never a pass when a floor applies", () => {
    expect(run({ version: { raw: null, state: "unreadable" } })).toMatchObject({ verdict: "blocked", code: "version-unreadable" });
    expect(run({ version: { raw: "hello", state: "unreadable" } })).toMatchObject({ verdict: "blocked", code: "version-unreadable" });
    expect(run({ version: { raw: null, state: "not-checked" } })).toMatchObject({ verdict: "unverified", code: "version-not-checked" });
  });
  test("the recorded fixture driver shows an unreadable version without blocking; the inert QA stub skips the floor", () => {
    expect(run({ version: { raw: null, state: "unreadable" }, fixtureDriver: true })).toMatchObject({ verdict: "unverified", code: "version-unreadable" });
    expect(run({ version: { raw: "codex-cli 0.0.0-qa", state: "read" }, fixtureDriver: true, inertStub: true })).toMatchObject({ verdict: "compatible" });
    expect(run({ version: { raw: "codex-cli 0.150.0", state: "read" }, fixtureDriver: true })).toMatchObject({ verdict: "blocked", code: "version-below-minimum" });
  });
  test("a pre-release exactly at the floor is shown as unverified and never blocks", () => {
    expect(run({ version: { raw: "codex-cli 0.159.0-alpha.3", state: "read" } })).toMatchObject({ verdict: "unverified", code: "version-prerelease-at-minimum" });
  });
  test("no floor is invented: without one, any version state is compatible", () => {
    for (const kind of ["claude-code", "antigravity", "gemini", "fx"]) {
      for (const version of [{ raw: null, state: "unreadable" as const }, { raw: null, state: "not-checked" as const }, { raw: "0.0.1", state: "read" as const }]) {
        expect(run({ kind, floor: null, version })).toMatchObject({ verdict: "compatible", minimumEnforced: false });
      }
    }
  });
  test("a stale registration, a contract block and a missing executable never read as an upgrade", () => {
    for (const code of ["compatible", "contract-blocked", "registration-stale", "executable-missing", "mode-unsupported"] as const) {
      const next = (d9En as Record<string, string>)[`d9.target.next.${code}`]!;
      const state = (d9En as Record<string, string>)[`d9.target.state.${code}`]!;
      expect(`${state} ${next}`).not.toMatch(/\bupgrade\b|\bupdate\b|\bnewer\b/i);
    }
    // The compatible text says what it does not prove.
    expect(d9En["d9.target.next.compatible"]).toMatch(/does not show/i);
  });
});
