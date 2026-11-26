import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeDeepSeekFixture } from "../../e2e/deepseek-fixture.ts";
import { discoverDeepSeekInstallation } from "./deepseek-installation.ts";
import { DEEPSEEK_POLICY, DEEPSEEK_POLICY_DIGEST } from "./deepseek-execution-policy.ts";

const root = mkdtempSync(path.join(tmpdir(), "fo-deepseek01-discovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const discover = (app: string) => discoverDeepSeekInstallation({ env: { FORGEORBIT_DEEPSEEK_APP_PATH: app } });

test("Desktop CLI identified without PATH, process launch or credential access; repeat discovery is stable", () => {
  const app = writeDeepSeekFixture(path.join(root, "installed"));
  const result = discover(app);
  expect(result).toMatchObject({ id: "deepseek-dsh", provider: "deepseek", version: "0.2.1-rc.5", status: "execution-unsupported",
    executionSupported: false, authentication: "unknown", quota: "unknown", models: [] });
  expect(result.path).toBe(path.join(app, "Contents/Resources/runtime/cli/bin/dsh"));
  expect(discover(app)).toEqual(result);
  expect(result.executionPolicy).toMatchObject({ status: "blocked", digest: DEEPSEEK_POLICY_DIGEST,
    blockers: ["filesystem-read-scope", "filesystem-write-scope", "hard-link-alias", "inherited-file-descriptor", "setsid-descendant", "component-boot"] });
  expect(DEEPSEEK_POLICY.requirements.configurationDigest).toBeNull();
  expect(DEEPSEEK_POLICY.requirements.providerRetries).toBe(0);
  expect(Object.isFrozen(DEEPSEEK_POLICY.requirements)).toBe(true);
  // A client can edit diagnostic copies, but cannot change admission policy.
  result.executionPolicy!.blockers.length = 0;
  expect(discover(app).executionPolicy!.blockers).toHaveLength(6);
  expect(existsSync(path.join(path.dirname(result.path!), "invocations"))).toBe(false);
});

test("absent, incomplete or unrelated installation cannot become a resource", () => {
  expect(discover(path.join(root, "missing")).status).toBe("missing");
  expect(discover("relative/app").status).toBe("missing");
  const app = writeDeepSeekFixture(path.join(root, "broken"));
  const cli = path.join(app, "Contents/Resources/runtime/cli/bin/dsh");
  rmSync(cli);
  expect(discover(app).status).toBe("unidentified");
  writeFileSync(cli, "#!/bin/sh\necho unrelated\n");
  expect(discover(app).status).toBe("unidentified");
});

test("assessed 0.2.2-rc.1 stays execution-blocked with the same admission policy", () => {
  const app = writeDeepSeekFixture(path.join(root, "rc2"), "0.2.2-rc.1");
  expect(discover(app)).toMatchObject({ status: "execution-unsupported", version: "0.2.2-rc.1", executionSupported: false });
  expect(discover(app).executionPolicy?.blockers).toContain("hard-link-alias");
});

test("unsupported version, non-executable launcher, malformed/oversized metadata fail closed", () => {
  const app = writeDeepSeekFixture(path.join(root, "future"), "99.0.0");
  expect(discover(app)).toMatchObject({ status: "unassessed-version", executionSupported: false, models: [] });
  expect(discover(app).executionPolicy).toBeUndefined();
  chmodSync(path.join(app, "Contents/Resources/runtime/cli/bin/dsh"), 0o644);
  expect(discover(app).status).toBe("unidentified");
  const plist = path.join(app, "Contents/Info.plist");
  writeFileSync(plist, "bplist00 malformed");
  expect(discover(app).version).toBeNull();
  writeFileSync(plist, " ".repeat(65537));
  expect(discover(app).status).toBe("unidentified");
});

test("fixture follows actual read-only help/version contract and refuses inference", async () => {
  const app = writeDeepSeekFixture(path.join(root, "contract"));
  const cli = path.join(app, "Contents/Resources/runtime/cli/bin/dsh");
  for (const args of [["--version"], ["--help"], ["--profile", "headless", "--help"]]) {
    const p = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBeTruthy();
  }
  // A fake argv contract check only; never reaches a model or real executable.
  const p = Bun.spawn([cli, "--profile", "headless", "--json", "synthetic"], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(64);
  expect(await new Response(p.stderr).text()).toContain("Execution unsupported");
  expect(readFileSync(path.join(path.dirname(cli), "invocations"), "utf8").trim().split("\n")).toHaveLength(4);
});
