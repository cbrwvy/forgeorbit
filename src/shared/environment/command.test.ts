import { expect, test } from "bun:test";

import {
  argvUsesShellCommandFlag,
  commandProvesToken,
  commandRejection,
  processGroupArgv,
  PROCESS_GROUP_HELPER,
} from "./command.ts";
import { buildProcessEnv } from "../../bun/environment/env.ts";

const token = "ab".repeat(16);

test("a structured command is argv, and a shell string or sh -c is rejected", () => {
  expect(commandRejection("bun", ["run", "dev"])).toBeNull();
  expect(commandRejection("/bin/echo", ["$HOME", "a; rm -rf /"])).toBeNull();
  expect(commandRejection("bun run dev", [])).toContain("shell command");
  expect(commandRejection("/bin/sh", ["-c", "echo hi"])).toContain("shell");
  expect(commandRejection("/bin/bash", ["-lc", "echo hi"])).toContain("shell");

  const argv = processGroupArgv(token, "bun", ["run", "dev"]);
  expect(argv[0]).toBe("/usr/bin/perl");
  expect(argv).toContain(token);
  expect(argv.slice(-4)).toEqual([token, "bun", "run", "dev"]);
  expect(PROCESS_GROUP_HELPER.script.includes(token)).toBe(false);
  expect(argvUsesShellCommandFlag(argv)).toBe(false);
  expect(argvUsesShellCommandFlag(["/bin/sh", "-c", "bun run dev"])).toBe(true);
  expect(commandProvesToken(`perl -e script ${token} bun run dev`, token, "bun")).toBe(true);
  expect(commandProvesToken("/bin/sleep 30", token, "bun")).toBe(false);
});

test("process environment is an allowlist plus explicit bindings, not the parent environment", () => {
  const env = buildProcessEnv({
    parent: {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      SECRET_TOKEN: "nope",
      COMPOSE_PROJECT_NAME: "someone-else",
      PORT: "4000",
    },
    bindings: [
      { name: "PORT", from: "inherit" },
      { name: "APP_ENV", from: "literal", value: "local" },
    ],
    profileId: "app",
    token,
  });
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/Users/me");
  expect(env.PORT).toBe("4000");
  expect(env.APP_ENV).toBe("local");
  expect(env.FORGEORBIT_ENV_TOKEN).toBe(token);
  expect(env.SECRET_TOKEN).toBeUndefined();
  expect(env.COMPOSE_PROJECT_NAME).toBeUndefined();
});
