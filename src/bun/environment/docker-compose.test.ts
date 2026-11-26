import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FO_LABEL_PROFILE, FO_LABEL_TOKEN } from "../../shared/environment/compose-ownership.ts";
import type { CommandRunner } from "./command-runner.ts";
import {
  assertSafeDockerArgv,
  composeBaseArgv,
  createDockerComposeHost,
  renderLabelOverride,
} from "./docker-compose.ts";

const id = "a".repeat(64);

function runner(script: (argv: readonly string[], env: Record<string, string> | undefined) => { code: number; stdout?: string; stderr?: string; spawnError?: string }): {
  runner: CommandRunner;
  calls: string[][];
  envs: (Record<string, string> | undefined)[];
} {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  return {
    calls,
    envs,
    runner: {
      async run(argv, options) {
        calls.push([...argv]);
        envs.push(options.env);
        const result = script(argv, options.env);
        return {
          code: result.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          timedOut: false,
          spawnError: result.spawnError ?? null,
          pid: 7,
        };
      },
    },
  };
}

function inspectBody(labels: Record<string, string>, status = "running"): string {
  return JSON.stringify([
    {
      Id: id,
      State: { Status: status },
      Config: { Labels: labels },
    },
  ]);
}

const labels = {
  "com.docker.compose.project": "fo-example-project",
  "com.docker.compose.project.working_dir": "/work/example-project",
  "com.docker.compose.project.config_files": "/work/example-project/compose.yaml,/tmp/labels.yml",
  "com.docker.compose.service": "web",
  [FO_LABEL_PROFILE]: "example-project",
  [FO_LABEL_TOKEN]: "ab".repeat(16),
  "forgeorbit.managed": "1",
};

test("compose argv always names the project and rejects down, volumes, and prune", () => {
  const argv = [...composeBaseArgv("docker", {
    projectName: "fo-example-project",
    composeFile: "/work/example-project/compose.yaml",
    cwd: "/work/example-project",
  }), "up", "-d", "web"];
  expect(() => assertSafeDockerArgv(argv)).not.toThrow();
  expect(argv).toContain("--project-name");
  expect(argv).toContain("fo-example-project");
  expect(argv).not.toContain("down");
  expect(() => assertSafeDockerArgv(["docker", "compose", "--project-name", "fo-example-project", "down", "-v"])).toThrow(/down|-v|unsafe|refusing/);
  expect(() => assertSafeDockerArgv(["docker", "system", "prune"])).toThrow(/refusing/);
  expect(() => assertSafeDockerArgv(["docker", "volume", "prune"])).toThrow(/refusing/);
  expect(renderLabelOverride(["web"], { "forgeorbit.token": "ab".repeat(16), "forgeorbit.profile": "example-project" })).not.toContain("volumes");
});

test("a missing docker binary is reported and up is not run", async () => {
  const fake = runner(() => ({ code: null as unknown as number, spawnError: "ENOENT: docker" }));
  const host = createDockerComposeHost({
    runner: fake.runner,
    markerDir: mkdtempSync(path.join(tmpdir(), "fo-docker-")),
  });
  const result = await host.availability();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.detail).toContain("ENOENT");
  expect(fake.calls.some((argv) => argv.includes("up"))).toBe(false);
});

test("stop of a foreign compose project does not issue compose stop", async () => {
  const fake = runner((argv) => {
    if (argv.includes("ps")) return { code: 0, stdout: `${id}\n` };
    if (argv[1] === "inspect") {
      return {
        code: 0,
        stdout: inspectBody({
          ...labels,
          "com.docker.compose.project": "fo-example-portal",
          "com.docker.compose.project.working_dir": "/work/example-portal",
          "com.docker.compose.project.config_files": "/work/example-portal/compose.yaml",
        }),
      };
    }
    return { code: 0, stdout: "" };
  });
  const dir = mkdtempSync(path.join(tmpdir(), "fo-docker-"));
  const host = createDockerComposeHost({ runner: fake.runner, markerDir: dir });
  const stopped = await host.stop(
    {
      projectName: "fo-example-project",
      workingDir: "/work/example-project",
      composeFile: "/work/example-project/compose.yaml",
      profileId: "example-project",
      token: "ab".repeat(16),
      recordedIds: [id],
      tokenApplied: true,
    },
    ["web"],
  );
  expect(stopped.ok).toBe(false);
  if (!stopped.ok) expect(stopped.refused).toBe(true);
  expect(fake.calls.some((argv) => argv.includes("stop") || argv.includes("down"))).toBe(false);
});

test("managed stop uses compose stop for that project only and checks the result", async () => {
  let running = true;
  const fake = runner((argv) => {
    if (argv.includes("ps")) return { code: 0, stdout: running ? `${id}\n` : "" };
    if (argv[1] === "inspect") return { code: 0, stdout: inspectBody(labels, running ? "running" : "exited") };
    if (argv.includes("stop")) {
      running = false;
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: "" };
  });
  const dir = mkdtempSync(path.join(tmpdir(), "fo-docker-"));
  const host = createDockerComposeHost({
    runner: fake.runner,
    markerDir: dir,
    parentEnv: { PATH: "/usr/bin", COMPOSE_PROJECT_NAME: "someone-else", HOME: "/Users/me" },
  });
  const expected = {
    projectName: "fo-example-project",
    workingDir: "/work/example-project",
    composeFile: "/work/example-project/compose.yaml",
    profileId: "example-project",
    token: "ab".repeat(16),
    recordedIds: [id],
    tokenApplied: true,
  };
  const stopped = await host.stop(expected, ["web"]);
  expect(stopped.ok).toBe(true);
  const stopArgv = fake.calls.find((argv) => argv.includes("stop"));
  expect(stopArgv).toBeDefined();
  expect(stopArgv).toContain("--project-name");
  expect(stopArgv).toContain("fo-example-project");
  expect(stopArgv).not.toContain("fo-example-portal");
  expect(stopArgv).not.toContain("down");
  expect(stopArgv).not.toContain("-v");
  expect(fake.envs.some((env) => env && "COMPOSE_PROJECT_NAME" in env)).toBe(false);

  writeFileSync(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: example\n");
  const up = await host.up({ ...expected, recordedIds: [], tokenApplied: false }, ["web"]);
  // The script treats every ps as empty once `running` is false, so up's pre-check is absent.
  expect(up.ok).toBe(true);
  const upArgv = fake.calls.find((argv) => argv.includes("up"));
  expect(upArgv).toContain("-d");
  expect(upArgv).toContain("web");
  expect(upArgv?.join(" ")).not.toContain(" down");
});
