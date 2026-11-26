import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDataDir } from "./data-dir.ts";
import { acquireNativeInstanceLock } from "./native-instance-lock.ts";

test("duplicate bootstrap exits before SQLite, migrations and SDK imports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo013a1-preimport-"));
  const release = acquireNativeInstanceLock(dir);
  try {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "native-bootstrap.ts")], {
      env: { HOME: dir, PATH: "/usr/bin:/bin", AGETOR_DATA_DIR: dir, FORGEORBIT_DATA_DIR: dir },
      encoding: "utf8", timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("desktop startup refused");
    expect(existsSync(path.join(dir, "agetor.sqlite"))).toBe(false);
    expect(existsSync(path.join(dir, "agetor.pid"))).toBe(false);
  } finally { release(); }
});

test("normal and QA configs use the pre-import bootstrap", async () => {
  const { default: config } = await import("../../electrobun.config.ts");
  expect(config.build.bun.entrypoint).toBe("src/bun/native-bootstrap.ts");
  const bootstrap = readFileSync(path.join(import.meta.dir, "native-qa-bootstrap.ts"), "utf8");
  expect(bootstrap.indexOf("nativeQaRuntimeEnv(__FORGEORBIT")).toBeLessThan(bootstrap.indexOf('await import("./native-bootstrap.ts")'));
});

test("ordinary HOME resolution and the temporary test fallback precede imports", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo013a1-bootstrap-env-"));
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "native-bootstrap.ts")],
    target: "bun", outdir: path.join(dir, "compiled"),
    // bun test otherwise folds NODE_ENV to "test" at bundle time.
    define: { "process.env.NODE_ENV": "globalThis.process.env.NODE_ENV" },
    plugins: [{ name: "inert-app-import", setup(build) {
      build.onResolve({ filter: /^\.\/index\.ts$/ }, () => ({ path: "inert-app", namespace: "test" }));
      build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "ts", contents: `import {resolveDataDir} from ${JSON.stringify(path.join(import.meta.dir, "data-dir.ts"))}; console.log(JSON.stringify({data: resolveDataDir()}));` }));
    } }] });
  expect(built.success).toBe(true);
  for (const nodeEnv of ["production", "test"]) {
    const result = spawnSync(process.execPath, [built.outputs[0]!.path], { env: {
      HOME: dir, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin", NODE_ENV: nodeEnv,
    }, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data as string;
    if (nodeEnv === "test") expect(data.startsWith(path.join(tmpdir(), "forgeorbit-native-test-"))).toBe(true);
    else expect(data).toBe(resolveDataDir({ env: {}, home: dir }));
    expect(existsSync(path.join(data, "agetor.sqlite"))).toBe(false);
    expect(existsSync(path.join(data, "desktop-instance.lock"))).toBe(true);
  }
});
