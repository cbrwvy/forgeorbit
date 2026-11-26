import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDataDir } from "./data-dir.ts";
import { resolveDataDir as credsResolver } from "./core-creds.ts";
import { resolveDataDir as tokensResolver } from "./github-tokens.ts";

test("explicit ForgeOrbit and legacy overrides retain exact nullish precedence", () => {
  const env = { FORGEORBIT_DATA_DIR: "/Profiles/Forge Orbit", AGETOR_DATA_DIR: "/Profiles/Legacy" };
  for (const platform of ["darwin", "linux", "win32"] as const) {
    expect(resolveDataDir({ env, platform })).toBe(env.FORGEORBIT_DATA_DIR);
    expect(resolveDataDir({ env: { AGETOR_DATA_DIR: env.AGETOR_DATA_DIR }, platform })).toBe(env.AGETOR_DATA_DIR);
  }
  // Do not silently reinterpret existing explicit values (including relative
  // or empty values) as a request to discover a different profile.
  expect(resolveDataDir({ env: { FORGEORBIT_DATA_DIR: "", AGETOR_DATA_DIR: "/legacy" } })).toBe("");
  expect(resolveDataDir({ env: { AGETOR_DATA_DIR: "relative-profile" } })).toBe("relative-profile");
});

test("macOS fresh default ignores XDG and does not require existing directories", () => {
  const home = path.join(mkdtempSync(path.join(tmpdir(), "fo-profile-resolve-")), "Missing Home With Spaces");
  const result = resolveDataDir({ platform: "darwin", home, env: { XDG_DATA_HOME: "/xdg" } });
  expect(result).toBe(path.join(home, "Library", "Application Support", "ForgeOrbit"));
  expect(existsSync(home)).toBe(false); // Resolver performs no initialization/discovery IO.
});

test("Unix defaults honor absolute XDG_DATA_HOME with an independent fallback", () => {
  expect(resolveDataDir({ platform: "linux", home: "/home/a", env: {} })).toBe("/home/a/.local/share/forgeorbit");
  expect(resolveDataDir({ platform: "linux", home: "/home/a", env: { XDG_DATA_HOME: "/Volumes/Data With Spaces" } })).toBe("/Volumes/Data With Spaces/forgeorbit");
  expect(resolveDataDir({ platform: "linux", home: "/home/a", env: { XDG_DATA_HOME: "relative" } })).toBe("/home/a/.local/share/forgeorbit");
});

test("Windows defaults honor absolute LOCALAPPDATA without assuming POSIX separators", () => {
  expect(resolveDataDir({ platform: "win32", home: "C:\\Users\\QA", env: { LOCALAPPDATA: "D:\\Local Data" } })).toBe("D:\\Local Data\\ForgeOrbit");
  expect(resolveDataDir({ platform: "win32", home: "C:\\Users\\QA", env: {} })).toBe("C:\\Users\\QA\\AppData\\Local\\ForgeOrbit");
  expect(resolveDataDir({ platform: "win32", home: "C:\\Users\\QA", env: { LOCALAPPDATA: "relative" } })).toBe("C:\\Users\\QA\\AppData\\Local\\ForgeOrbit");
});

test("runtime credential and token stores share the same lazy DB-free resolver", () => {
  expect(credsResolver).toBe(resolveDataDir);
  expect(tokensResolver).toBe(resolveDataDir);
  const env = { FORGEORBIT_DATA_DIR: "/first" };
  expect(resolveDataDir({ env })).toBe("/first");
  env.FORGEORBIT_DATA_DIR = "/second";
  expect(resolveDataDir({ env })).toBe("/second");
});
