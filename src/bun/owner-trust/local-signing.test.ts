import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { HELPER_BUNDLE_RELATIVE_PATH, LOCAL_OWNER_CERT_CN, PRODUCTION_HELPER_ID, TEST_SIGNING_CERT_CN } from "../../shared/owner-trust/signing-policy.ts";
import { createDisposableCodeSigningIdentity, loginKeychainPath, certificatePins, findCodesigningIdentity } from "../../../scripts/local-owner-identity.ts";
import { developmentHelperPath } from "./helper-integrity.ts";
import { identityFromCodesign, readLocalOwnerAnchor, realUserHome } from "./identity.ts";
import { evaluateLocalSignature } from "./local-signature.ts";
import { signApplication } from "../../../scripts/sign-macos-app.ts";

function run(command: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// These tests must never change the user's keychain search list or default
// keychain. codesign --keychain <path> finds the disposable identity without
// either, so a stray test keychain can never make the Owner's signing prompt
// for a different keychain.
describe("local owner signing", () => {
  // The helper performs a first-launch code-signature evaluation, which can
  // take several seconds for a freshly built binary. Allow for it explicitly.
  test("a disposable certificate is not the Owner anchor, and a replaced helper is rejected", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-local-owner-"));
    const keychain = path.join(root, "test.keychain-db");
    const password = "fixture-password";
    const app = path.join(root, "ForgeOrbit.app");
    const helper = path.join(app, "Contents/Resources/app/bin/forgeorbit-owner-trust");
    const launcher = path.join(app, "Contents/MacOS/launcher");
    let created = false;
    try {
      const made = run(["security", "create-keychain", "-p", password, keychain]);
      expect(made.status).toBe(0);
      created = true;
      run(["security", "set-keychain-settings", "-t", "600", keychain]);
      run(["security", "unlock-keychain", "-p", password, keychain]);
      const fingerprint = createDisposableCodeSigningIdentity({
        commonName: TEST_SIGNING_CERT_CN,
        keychain,
        password,
      });
      expect(fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(() => createDisposableCodeSigningIdentity({
        commonName: LOCAL_OWNER_CERT_CN,
        keychain,
        password,
      })).toThrow(/Owner signing identity/);
      expect(() => createDisposableCodeSigningIdentity({
        commonName: TEST_SIGNING_CERT_CN,
        keychain: loginKeychainPath(),
        password,
      })).toThrow(/login keychain/);

      mkdirSync(path.dirname(helper), { recursive: true });
      mkdirSync(path.dirname(launcher), { recursive: true });
      writeFileSync(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.forgeorbit</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundleName</key><string>ForgeOrbit</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
      const source = path.join(root, "launcher.c");
      writeFileSync(source, `#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  pid_t pid = fork();
  if (pid < 0) return 127;
  if (pid == 0) { execv(argv[1], argv + 1); return 127; }
  int status = 0;
  if (waitpid(pid, &status, 0) < 0) return 127;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
}
`);
      expect(run(["cc", "-o", launcher, source]).status).toBe(0);
      chmodSync(launcher, 0o755);
      copyFileSync(developmentHelperPath(), helper);
      chmodSync(helper, 0o755);
      // The untrusted personal certificate must still be discoverable by the
      // identity lookup and the public-fingerprint helper. `find-identity -v`
      // (valid only) would hide it.
      expect(findCodesigningIdentity(TEST_SIGNING_CERT_CN, keychain)).not.toBeNull();
      expect(certificatePins(TEST_SIGNING_CERT_CN, keychain).map((pin) => pin.sha256)).toContain(fingerprint.sha256);
      // A personal self-signed certificate is not in the system trust store,
      // so codesign has to be pointed at the exact keychain. This is the same
      // mechanism scripts/sign-macos-app.ts uses for the real Owner identity.
      const sign = (args: string[]) => {
        const result = run(["codesign", "--force", "--sign", TEST_SIGNING_CERT_CN, "--keychain", keychain, ...args]);
        expect(result.status, result.stderr || result.stdout).toBe(0);
      };
      sign(["--identifier", "app.forgeorbit.owner-trust", helper]);
      sign([launcher]);
      sign(["--identifier", "app.forgeorbit", app]);

      const ownerRefused = evaluateLocalSignature(app, { requireOwnerCn: true });
      expect(ownerRefused.ok).toBe(false);
      expect(ownerRefused.authoritative).toBe(false);
      expect(ownerRefused.adhoc).toBe(false);
      expect(ownerRefused.teamId).toBeNull();

      const matched = evaluateLocalSignature(app, { anchor: fingerprint.sha256, requireOwnerCn: false });
      expect(matched.ok).toBe(true);
      expect(matched.authoritative).toBe(false);
      expect(matched.code).toBe("signature-verified-not-authoritative");
      expect(matched.helperId).toBe("app.forgeorbit.owner-trust");
      expect(matched.appCertSha256).toBe(fingerprint.sha256);
      expect(matched.helperCertSha256).toBe(fingerprint.sha256);

      const text = run(["codesign", "-dv", "--verbose=4", app]);
      const parsed = identityFromCodesign(`${text.stdout}\n${text.stderr}`, "app.forgeorbit", app, {
        certSha256: fingerprint.sha256,
        anchorSha256: fingerprint.sha256,
      });
      expect(parsed.adhoc).toBe(false);
      expect(parsed.teamId).toBeNull();
      expect(parsed.trustClass).toBe("production");
      expect(identityFromCodesign(`${text.stdout}\n${text.stderr}`, "app.forgeorbit", app).trustClass).toBe("unestablished");

      // The helper reads the real login-keychain anchor when its parent is a
      // bundle. With a real Owner anchor present, an untrusted disposable
      // helper can make macOS ask for that keychain item, which is exactly the
      // kind of prompt this test must not trigger. The genuine signed-app path
      // is covered by the Owner acceptance, not by this disposable test.
      if (!readLocalOwnerAnchor()) {
        const checked = run([launcher, helper, "check-caller"]);
        expect(checked.status).toBe(4);
        expect(checked.stdout).toContain("application-identity-unestablished");
      }
      // A shell parent is rejected before any anchor access.
      const shell = run([helper, "check-caller"]);
      expect(shell.status).toBe(3);
      expect(shell.stdout).toContain("caller-identity-rejected");

      copyFileSync(launcher, helper);
      chmodSync(helper, 0o755);
      const replaced = evaluateLocalSignature(app, { anchor: fingerprint.sha256, requireOwnerCn: false });
      expect(replaced.ok).toBe(false);
      expect(["helper-identity-mismatch", "signature-invalid", "unsigned-or-adhoc", "requirement-mismatch"]).toContain(replaced.code);

      const adhocApp = path.join(root, "Adhoc.app");
      mkdirSync(path.join(adhocApp, "Contents/MacOS"), { recursive: true });
      writeFileSync(path.join(adhocApp, "Contents/Info.plist"), readFileSync(path.join(app, "Contents/Info.plist")));
      copyFileSync(launcher, path.join(adhocApp, "Contents/MacOS/launcher"));
      mkdirSync(path.join(adhocApp, "Contents/Resources/app/bin"), { recursive: true });
      copyFileSync(launcher, path.join(adhocApp, "Contents/Resources/app/bin/forgeorbit-owner-trust"));
      expect(run(["codesign", "--force", "--sign", "-", "--identifier", "app.forgeorbit.owner-trust", path.join(adhocApp, "Contents/Resources/app/bin/forgeorbit-owner-trust")]).status).toBe(0);
      expect(run(["codesign", "--force", "--sign", "-", "--identifier", "app.forgeorbit", adhocApp]).status).toBe(0);
      const adhoc = evaluateLocalSignature(adhocApp, { anchor: fingerprint.sha256, requireOwnerCn: false });
      expect(adhoc.ok).toBe(false);
      expect(adhoc.code).toBe("unsigned-or-adhoc");

      const refusedIdentity = run(["bun", "scripts/sign-macos-app.ts", `--app=${app}`, "--channel=local-owner", "--identity=-"]);
      expect(refusedIdentity.status).not.toBe(0);
      expect(refusedIdentity.stderr).toContain(LOCAL_OWNER_CERT_CN);
      const developerId = run(["bun", "scripts/sign-macos-app.ts", `--app=${app}`, "--channel=local-owner", "--identity=Developer ID Application: Example"]);
      expect(developerId.status).not.toBe(0);
    } finally {
      if (created) run(["security", "delete-keychain", keychain]);
      rmSync(root, { recursive: true, force: true });
    }
    const identities = run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout;
    expect(identities).not.toContain(LOCAL_OWNER_CERT_CN);
    expect(identities).not.toContain(TEST_SIGNING_CERT_CN);
  }, 90_000);

  test("an agent session cannot create the Owner identity", async () => {
    const child = Bun.spawn(["bun", "scripts/local-owner-identity.ts", "--create", "--confirm-owner-action"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(2);
    expect(stderr).toContain("non-interactive");
    const identities = run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout;
    expect(identities).not.toContain(LOCAL_OWNER_CERT_CN);
  });
  test("the inside-out signer preserves entitlements and rejects a modified or substituted bundle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-sign-core-"));
    const keychain = path.join(root, "test.keychain-db");
    const password = "fixture-password";
    let created = false;
    const plist = (bundleId: string, executable: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;
    try {
      const made = run(["security", "create-keychain", "-p", password, keychain]);
      expect(made.status).toBe(0);
      created = true;
      run(["security", "set-keychain-settings", "-t", "600", keychain]);
      run(["security", "unlock-keychain", "-p", password, keychain]);
      const fingerprint = createDisposableCodeSigningIdentity({ commonName: TEST_SIGNING_CERT_CN, keychain, password });

      const app = path.join(root, "Fixture.app");
      const launcher = path.join(app, "Contents/MacOS/launcher");
      const helper = path.join(app, HELPER_BUNDLE_RELATIVE_PATH);
      const dylib = path.join(app, "Contents/Resources/libfixture.dylib");
      const tool = path.join(app, "Contents/Resources/app/bin/tool");
      const nestedApp = path.join(app, "Contents/Resources/Nested.app");
      const nestedBinary = path.join(nestedApp, "Contents/MacOS/nested");
      mkdirSync(path.dirname(launcher), { recursive: true });
      mkdirSync(path.dirname(helper), { recursive: true });
      mkdirSync(path.dirname(nestedBinary), { recursive: true });
      mkdirSync(path.dirname(tool), { recursive: true });
      writeFileSync(path.join(app, "Contents/Info.plist"), plist("app.forgeorbit", "launcher"));
      writeFileSync(path.join(nestedApp, "Contents/Info.plist"), plist("app.forgeorbit.nested", "nested"));
      const source = path.join(root, "fixture.c");
      writeFileSync(source, "int main(void){return 0;}\n");
      expect(run(["cc", "-o", launcher, source]).status).toBe(0);
      expect(run(["cc", "-o", nestedBinary, source]).status).toBe(0);
      expect(run(["cc", "-dynamiclib", "-o", dylib, source]).status).toBe(0);
      expect(run(["cc", "-o", tool, source]).status).toBe(0);
      copyFileSync(developmentHelperPath(), helper);
      chmodSync(helper, 0o755);

      const entitlements = path.join(root, "entitlements.plist");
      writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
`);
      const signFixture = (args: string[]) => run(["codesign", "--force", "--sign", TEST_SIGNING_CERT_CN, "--keychain", keychain, ...args]);
      // Entitlements live on a main executable, not a dylib. Pre-sign a bare
      // Mach-O with them; the app signer must preserve them (a plain re-sign
      // strips them).
      expect(signFixture(["--entitlements", entitlements, tool]).status).toBe(0);
      expect(`${run(["codesign", "-d", "--entitlements", "-", tool]).stdout}`).toContain("com.apple.security.cs.allow-jit");

      const targets = signApplication({ app, identity: fingerprint.sha1, keychain, helperId: PRODUCTION_HELPER_ID });
      // Only the helper and the application use the Owner identity; every other
      // Mach-O is re-signed ad-hoc so macOS asks for the private key twice, not
      // once per file.
      expect(targets.ownerKeyOperations).toBe(2);
      expect(targets.processes).toBe(3);
      expect(targets.bundles).toContain(nestedApp);

      const report = evaluateLocalSignature(app, { anchor: fingerprint.sha256, requireOwnerCn: false });
      expect(report.ok).toBe(true);
      expect(report.authoritative).toBe(false);
      expect(report.helperId).toBe(PRODUCTION_HELPER_ID);
      expect(report.appCertSha256).toBe(fingerprint.sha256);
      expect(report.helperCertSha256).toBe(fingerprint.sha256);
      expect(run(["codesign", "--verify", "--strict", "--verbose=2", app]).status).toBe(0);
      const detail = (target: string) => {
        const text = run(["codesign", "-dv", "--verbose=4", target]);
        return `${text.stdout}\n${text.stderr}`;
      };
      // Only the application and its helper carry the Owner identity. Nested
      // third-party code is re-signed ad-hoc: it is sealed by the application
      // but cannot present Owner authority.
      for (const target of [app, helper]) {
        expect(detail(target)).toContain(`Authority=${TEST_SIGNING_CERT_CN}`);
      }
      for (const target of [dylib, nestedBinary, nestedApp, tool]) {
        expect(detail(target)).toContain("Signature=adhoc");
        expect(detail(target)).not.toContain("Authority=");
      }
      expect(detail(app)).toContain(`Identifier=app.forgeorbit`);
      expect(detail(helper)).toContain(`Identifier=${PRODUCTION_HELPER_ID}`);
      expect(detail(nestedApp)).toContain(`Identifier=app.forgeorbit.nested`);
      const toolText = run(["codesign", "-d", "--entitlements", "-", tool]);
      expect(`${toolText.stdout}\n${toolText.stderr}`).toContain("com.apple.security.cs.allow-jit");

      // A modified nested binary no longer satisfies its signature.
      const original = readFileSync(dylib);
      const mutated = Buffer.from(original);
      const middle = Math.floor(mutated.length / 2);
      mutated[middle] = (mutated[middle] ?? 0) ^ 0xff;
      writeFileSync(dylib, mutated);
      expect(run(["codesign", "--verify", "--strict", dylib]).status).not.toBe(0);
      writeFileSync(dylib, original);
      expect(run(["codesign", "--verify", "--strict", dylib]).status).toBe(0);

      // A substituted helper is not accepted as the Owner helper.
      copyFileSync(launcher, helper);
      chmodSync(helper, 0o755);
      const replaced = evaluateLocalSignature(app, { anchor: fingerprint.sha256, requireOwnerCn: false });
      expect(replaced.ok).toBe(false);

      // A tampered resource inside a signed bundle fails strict bundle seal verification.
      const reSigned = signApplication({ app, identity: fingerprint.sha1, keychain, helperId: PRODUCTION_HELPER_ID });
      expect(reSigned.ownerKeyOperations).toBe(2);
      const resourceFile = path.join(app, "Contents/Resources/app/marker.txt");
      mkdirSync(path.dirname(resourceFile), { recursive: true });
      writeFileSync(resourceFile, "tampered");
      expect(run(["codesign", "--verify", "--strict", app]).status).not.toBe(0);
    } finally {
      if (created) run(["security", "delete-keychain", keychain]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("realUserHome keeps the OS account home directory when HOME is redirected and USER is absent", () => {
    const previousHome = process.env.HOME;
    const previousUser = process.env.USER;
    const previousLogname = process.env.LOGNAME;
    const fakeHome = mkdtempSync(path.join(tmpdir(), "fo-isolated-home-"));
    try {
      process.env.HOME = fakeHome;
      delete process.env.USER;
      delete process.env.LOGNAME;
      const resolved = realUserHome();
      expect(resolved).toBeTruthy();
      expect(resolved).not.toBe(fakeHome);
      expect(resolved).not.toBe("/var/empty");
      if (previousHome && previousHome.startsWith("/Users/")) {
        expect(resolved).toBe(previousHome);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUser === undefined) delete process.env.USER;
      else process.env.USER = previousUser;
      if (previousLogname === undefined) delete process.env.LOGNAME;
      else process.env.LOGNAME = previousLogname;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

});
