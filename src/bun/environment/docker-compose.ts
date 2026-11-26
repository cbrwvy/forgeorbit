/**
 * Docker Compose adapter.
 *
 * Every compose invocation passes `--project-name`, `--file`, and
 * `--project-directory`. Stop and up both re-read container labels and refuse
 * to continue unless {@link classifyComposeProject} says the containers are
 * this profile's. `down`, `-v`, prune, and kill are not in the allowlist, and
 * {@link assertSafeDockerArgv} runs again immediately before spawn.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  classifyComposeProject,
  COMPOSE_LABEL_CONFIG,
  COMPOSE_LABEL_PROJECT,
  COMPOSE_LABEL_SERVICE,
  COMPOSE_LABEL_WORKDIR,
  composeStopPermitted,
  containersStopped,
  FO_LABEL_MANAGED,
  FO_LABEL_PROFILE,
  FO_LABEL_TOKEN,
  splitConfigFiles,
  type ComposeClassification,
  type ComposeContainerSnapshot,
  type ComposeExpectation,
} from "../../shared/environment/compose-ownership.ts";
import { COMPOSE_PROJECT_PATTERN, SERVICE_NAME_PATTERN } from "../../shared/environment/profile.ts";
import type { CommandRunner } from "./command-runner.ts";
import { buildDockerEnv } from "./env.ts";

const ALLOWED_COMPOSE = new Set(["version", "ps", "up", "stop", "logs"]);
const VALUE_FLAGS = new Set([
  "--project-name",
  "--project-directory",
  "--file",
  "-f",
  "-p",
  "--format",
  "--tail",
]);
const UNSAFE_ARGS = new Set(["-v", "--volumes", "--remove-orphans", "--rmi"]);

export interface ComposeTarget {
  projectName: string;
  composeFile: string;
  cwd: string;
}

export type ComposeInspectResult = ComposeClassification | { kind: "docker-error"; detail: string };

export interface ComposeHost {
  availability(): Promise<{ ok: true } | { ok: false; detail: string }>;
  inspect(expected: ComposeExpectation): Promise<ComposeInspectResult>;
  up(
    expected: ComposeExpectation,
    services: readonly string[],
  ): Promise<{ ok: true; containers: ComposeContainerSnapshot[] } | { ok: false; detail: string }>;
  stop(
    expected: ComposeExpectation,
    services: readonly string[],
  ): Promise<
    | { ok: true; containers: ComposeContainerSnapshot[] }
    | { ok: false; detail: string; refused: boolean }
  >;
  logs(
    expected: ComposeExpectation,
    tail: number,
  ): Promise<{ ok: true; text: string } | { ok: false; detail: string }>;
}

export function assertSafeDockerArgv(argv: readonly string[]): void {
  for (const arg of argv) {
    if (UNSAFE_ARGS.has(arg)) throw new Error(`refusing unsafe docker argument: ${arg}`);
  }
  const top = argv[1];
  if (top === "info" || top === "inspect") return;
  if (top !== "compose") throw new Error(`refusing docker command ${top ?? ""}`);
  const sub = composeSubcommand(argv);
  if (sub === null || !ALLOWED_COMPOSE.has(sub)) {
    throw new Error(`refusing compose subcommand ${sub ?? "(missing)"}`);
  }
  if (sub !== "version" && !argv.includes("--project-name")) {
    throw new Error("compose command is missing --project-name");
  }
}

export function composeBaseArgv(bin: string, target: ComposeTarget, extraFiles: readonly string[] = []): string[] {
  const argv = [
    bin,
    "compose",
    "--project-name",
    target.projectName,
    "--project-directory",
    target.cwd,
    "--file",
    target.composeFile,
  ];
  for (const file of extraFiles) argv.push("--file", file);
  return argv;
}

export function renderLabelOverride(services: readonly string[], labels: Readonly<Record<string, string>>): string {
  const lines = ["services:"];
  for (const service of services) {
    if (!SERVICE_NAME_PATTERN.test(service)) {
      throw new Error(`refusing to write a label override for service ${service}`);
    }
    lines.push(`  ${service}:`, "    labels:");
    for (const [key, value] of Object.entries(labels)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key) || !/^[A-Za-z0-9_-]*$/.test(value)) {
        throw new Error("refusing to write an unsafe compose label");
      }
      lines.push(`      ${key}: "${value}"`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const CONTAINER_ID = /^[a-f0-9]{12,64}$/;

export function createDockerComposeHost(options: {
  runner: CommandRunner;
  dockerBin?: string;
  markerDir: string;
  parentEnv?: Record<string, string | undefined>;
  timeouts?: { probeMs?: number; upMs?: number; stopMs?: number };
}): ComposeHost {
  const bin = options.dockerBin ?? "docker";
  const probeMs = options.timeouts?.probeMs ?? 8_000;
  const upMs = options.timeouts?.upMs ?? 120_000;
  const stopMs = options.timeouts?.stopMs ?? 30_000;
  const env = buildDockerEnv(options.parentEnv ?? process.env);

  async function docker(argv: string[], timeoutMs: number, cwd: string): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; detail: string }> {
    assertSafeDockerArgv(argv);
    const result = await options.runner.run(argv, { cwd, env, timeoutMs });
    if (result.spawnError && result.spawnError !== "cancelled") {
      return { ok: false, detail: result.spawnError };
    }
    if (result.timedOut) return { ok: false, detail: "docker command timed out" };
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `docker exited ${result.code}`;
      return { ok: false, detail };
    }
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }

  function targetOf(expected: ComposeExpectation): ComposeTarget {
    if (!COMPOSE_PROJECT_PATTERN.test(expected.projectName)) {
      throw new Error(`refusing compose project name ${expected.projectName}`);
    }
    return { projectName: expected.projectName, composeFile: expected.composeFile, cwd: expected.workingDir };
  }

  async function readContainers(expected: ComposeExpectation): Promise<
    { ok: true; containers: ComposeContainerSnapshot[] } | { ok: false; detail: string }
  > {
    const target = targetOf(expected);
    const ps = await docker(
      [...composeBaseArgv(bin, target), "ps", "-a", "-q"],
      probeMs,
      expected.workingDir,
    );
    if (!ps.ok) return ps;
    const ids = ps.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (ids.length === 0) return { ok: true, containers: [] };
    for (const id of ids) {
      if (!CONTAINER_ID.test(id)) return { ok: false, detail: `refusing to inspect unexpected container id ${id}` };
    }
    const inspected = await docker([bin, "inspect", ...ids], probeMs, expected.workingDir);
    if (!inspected.ok) return inspected;
    try {
      return { ok: true, containers: parseInspect(inspected.stdout) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async function classify(expected: ComposeExpectation): Promise<ComposeInspectResult> {
    const read = await readContainers(expected);
    if (!read.ok) return { kind: "docker-error", detail: read.detail };
    return classifyComposeProject(read.containers, expected);
  }

  return {
    async availability() {
      const version = await docker([bin, "compose", "version"], probeMs, options.markerDir);
      if (!version.ok) return { ok: false, detail: version.detail };
      const info = await docker([bin, "info", "--format", "{{.ServerVersion}}"], probeMs, options.markerDir);
      if (!info.ok) return { ok: false, detail: info.detail };
      return { ok: true };
    },

    inspect: classify,

    async up(expected, services) {
      if (services.length === 0) return { ok: false, detail: "refusing to start compose without service names" };
      const before = await classify(expected);
      if (before.kind === "docker-error") return { ok: false, detail: before.detail };
      if (before.kind === "foreign" || before.kind === "external" || before.kind === "drift") {
        return { ok: false, detail: before.detail };
      }
      const labels = ownershipLabels(expected);
      const overridePath = path.join(options.markerDir, expected.profileId, "labels.yml");
      mkdirSync(path.dirname(overridePath), { recursive: true });
      writeFileSync(overridePath, renderLabelOverride(services, labels), "utf8");
      const target = targetOf(expected);
      const argv = [...composeBaseArgv(bin, target, [overridePath]), "up", "-d", ...services];
      const started = await docker(argv, upMs, expected.workingDir);
      if (!started.ok) return started;
      const after = await readContainers(expected);
      if (!after.ok) return after;
      return { ok: true, containers: after.containers };
    },

    async stop(expected, services) {
      const before = await classify(expected);
      if (before.kind === "docker-error") return { ok: false, detail: before.detail, refused: true };
      if (!composeStopPermitted(before)) {
        const detail =
          before.kind === "external" || before.kind === "foreign" || before.kind === "drift"
            ? before.detail
            : "refusing to stop this compose project";
        return { ok: false, detail, refused: true };
      }
      if (before.kind === "absent" || (before.kind === "managed" && containersStopped(before.containers))) {
        return { ok: true, containers: before.kind === "managed" ? before.containers : [] };
      }
      const target = targetOf(expected);
      const argv = [...composeBaseArgv(bin, target), "stop", ...services];
      const stopped = await docker(argv, stopMs, expected.workingDir);
      if (!stopped.ok) return { ok: false, detail: stopped.detail, refused: false };
      const after = await readContainers(expected);
      if (!after.ok) return { ok: false, detail: after.detail, refused: false };
      return { ok: true, containers: after.containers };
    },

    async logs(expected, tail) {
      const view = await classify(expected);
      if (view.kind !== "managed") {
        return { ok: false, detail: view.kind === "docker-error" ? view.detail : "logs are only read for a project this profile owns" };
      }
      const safeTail = Number.isInteger(tail) && tail > 0 && tail <= 500 ? tail : 200;
      const target = targetOf(expected);
      const result = await docker(
        [...composeBaseArgv(bin, target), "logs", "--no-color", "--tail", String(safeTail)],
        probeMs,
        expected.workingDir,
      );
      if (!result.ok) return result;
      return { ok: true, text: result.stdout + result.stderr };
    },
  };
}

export function ownershipLabels(expected: ComposeExpectation): Record<string, string> {
  if (!expected.token || !/^[a-f0-9]{32}$/.test(expected.token)) {
    throw new Error("refusing to label a compose project without an ownership token");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(expected.profileId)) {
    throw new Error("refusing to label a compose project with an unsafe profile id");
  }
  return {
    [FO_LABEL_MANAGED]: "1",
    [FO_LABEL_PROFILE]: expected.profileId,
    [FO_LABEL_TOKEN]: expected.token,
  };
}

interface InspectContainer {
  Id?: string;
  State?: { Status?: string; Health?: { Status?: string } };
  Config?: { Labels?: Record<string, string> };
}

export function parseInspect(stdout: string): ComposeContainerSnapshot[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("docker inspect did not return a list");
  return parsed.map((entry) => {
    const container = entry as InspectContainer;
    const id = container.Id ?? "";
    if (!CONTAINER_ID.test(id) && !CONTAINER_ID.test(id.slice(0, 64))) {
      // inspect returns the full 64-char id.
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("docker inspect returned an unexpected id");
    }
    const labels = container.Config?.Labels ?? {};
    return {
      id: id.slice(0, 64),
      service: labels[COMPOSE_LABEL_SERVICE] ?? "",
      state: container.State?.Status ?? "",
      project: labels[COMPOSE_LABEL_PROJECT] ?? "",
      workingDir: labels[COMPOSE_LABEL_WORKDIR] ?? "",
      configFiles: splitConfigFiles(labels[COMPOSE_LABEL_CONFIG] ?? ""),
      labels,
    };
  });
}

function composeSubcommand(argv: readonly string[]): string | null {
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}
