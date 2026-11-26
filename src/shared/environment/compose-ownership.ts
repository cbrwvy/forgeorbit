/**
 * Decide whether a set of containers is the compose project this profile
 * owns. Stop and start both go through here so a project-name collision
 * cannot reach `docker compose stop` or `up`.
 *
 * Identity is Docker's own labels (project, working directory, config files)
 * plus, when we managed to set it, the ForgeOrbit token label. Container ids
 * are the fallback when the token label is not on the container: an id is
 * immutable for the life of that container, so a recorded id cannot silently
 * start referring to someone else's container.
 */

export const FO_LABEL_PROFILE = "forgeorbit.profile";
export const FO_LABEL_TOKEN = "forgeorbit.token";
export const FO_LABEL_MANAGED = "forgeorbit.managed";

export const COMPOSE_LABEL_PROJECT = "com.docker.compose.project";
export const COMPOSE_LABEL_WORKDIR = "com.docker.compose.project.working_dir";
export const COMPOSE_LABEL_CONFIG = "com.docker.compose.project.config_files";
export const COMPOSE_LABEL_SERVICE = "com.docker.compose.service";

export interface ComposeContainerSnapshot {
  id: string;
  service: string;
  /** Docker status word: running, exited, restarting, paused, dead, created, … */
  state: string;
  project: string;
  workingDir: string;
  configFiles: string[];
  labels: Record<string, string>;
}

export interface ComposeExpectation {
  projectName: string;
  workingDir: string;
  composeFile: string;
  profileId: string;
  /** Null when this start has not claimed the project yet. */
  token: string | null;
  /** Ids captured the last time we successfully started the project. */
  recordedIds: readonly string[];
  /** When false, the token was never observed on the containers; ids are the claim. */
  tokenApplied: boolean;
}

export type ComposeClassification =
  | { kind: "absent" }
  | { kind: "managed"; running: boolean; containers: ComposeContainerSnapshot[] }
  | { kind: "external"; detail: string; containers: ComposeContainerSnapshot[] }
  | { kind: "foreign"; detail: string; containers: ComposeContainerSnapshot[] }
  | { kind: "drift"; detail: string; containers: ComposeContainerSnapshot[] };

const RUNNING_STATES = new Set(["running", "restarting", "paused"]);

export function classifyComposeProject(
  containers: readonly ComposeContainerSnapshot[],
  expected: ComposeExpectation,
): ComposeClassification {
  if (containers.length === 0) return { kind: "absent" };

  const workdir = stripTrailingSlash(expected.workingDir);
  const composeFile = stripTrailingSlash(expected.composeFile);

  for (const container of containers) {
    if (container.project !== expected.projectName) {
      return {
        kind: "foreign",
        detail: `container ${container.id} belongs to compose project ${container.project || "(none)"}, not ${expected.projectName}`,
        containers: [...containers],
      };
    }
    if (stripTrailingSlash(container.workingDir) !== workdir) {
      return {
        kind: "foreign",
        detail: `container ${container.id} has working directory ${container.workingDir || "(none)"}, not ${expected.workingDir}`,
        containers: [...containers],
      };
    }
    const configs = container.configFiles.map(stripTrailingSlash);
    if (!configs.includes(composeFile)) {
      return {
        kind: "foreign",
        detail: `container ${container.id} was not created from ${expected.composeFile}`,
        containers: [...containers],
      };
    }
  }

  const claim = claimMatches(containers, expected);
  if (claim === "managed") {
    return {
      kind: "managed",
      running: containers.some((container) => RUNNING_STATES.has(container.state)),
      containers: [...containers],
    };
  }
  if (claim === "drift") {
    return {
      kind: "drift",
      detail: "compose project mixes ForgeOrbit-owned containers with containers this profile did not start",
      containers: [...containers],
    };
  }
  return {
    kind: "external",
    detail: `compose project ${expected.projectName} is running but was not started by this ForgeOrbit profile`,
    containers: [...containers],
  };
}

function claimMatches(
  containers: readonly ComposeContainerSnapshot[],
  expected: ComposeExpectation,
): "managed" | "external" | "drift" {
  const haveClaim = expected.tokenApplied && expected.token !== null;
  if (haveClaim && expected.token !== null) {
    const token = expected.token;
    const matches = containers.map(
      (container) =>
        container.labels[FO_LABEL_TOKEN] === token && container.labels[FO_LABEL_PROFILE] === expected.profileId,
    );
    if (matches.every(Boolean)) return "managed";
    if (matches.some(Boolean)) return "drift";
    return "external";
  }

  if (expected.recordedIds.length === 0) return "external";
  const recorded = new Set(expected.recordedIds);
  if (containers.every((container) => recorded.has(container.id))) return "managed";
  return "drift";
}

export type ComposeStartDecision = "up" | "already" | "refuse";

export function composeStartDecision(classification: ComposeClassification): ComposeStartDecision {
  if (classification.kind === "absent") return "up";
  if (classification.kind === "managed" && classification.running) return "already";
  if (classification.kind === "managed") return "up";
  return "refuse";
}

export function composeStopPermitted(classification: ComposeClassification): boolean {
  return classification.kind === "absent" || classification.kind === "managed";
}

export function containersStopped(containers: readonly ComposeContainerSnapshot[]): boolean {
  return containers.every((container) => !RUNNING_STATES.has(container.state));
}

export function stripTrailingSlash(value: string): string {
  if (value.length > 1 && value.endsWith("/")) return value.replace(/\/+$/, "");
  return value;
}

export function splitConfigFiles(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
