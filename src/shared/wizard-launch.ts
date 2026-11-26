/**
 * Launch-profile drafts for the project wizard (FO-004C).
 *
 * Built only from a Project Discovery report. Nothing here reads the
 * filesystem, starts Docker, runs a package script, or parses a Makefile
 * as code. The draft is still checked by `profileFromDraft`, the same
 * validator the Environment page uses, before it can be stored.
 */

import { defaultComposeProjectName, emptyDraft, profileFromDraft, type ProfileDraft } from "./environment/present.ts";
import { commandRejection } from "./environment/command.ts";
import type { LaunchProfile } from "./environment/types.ts";
import type { PackageManager, ProjectDiscovery } from "./project-discovery.ts";

/** Targets the wizard will offer. Other Makefile targets stay on the Git step as labels. */
export const MAKE_PROFILE_TARGETS = ["dev", "dev-up", "start"] as const;

export const PACKAGE_PROFILE_SCRIPTS = ["dev", "start", "serve"] as const;

/**
 * Make often starts other programs. The process host can signal the group
 * it created; it does not follow children that leave that group.
 */
export const MAKE_STOP_WARNING =
  "Make starts other programs. ForgeOrbit signals the process group it creates, and programs that leave that group are not tracked or stopped.";

export const COMPOSE_NAME_NOTE =
  "The Compose project name belongs to ForgeOrbit. This profile does not attach to a stack you already started, and Docker is not contacted while you set it up.";

export interface LaunchSuggestion {
  id: string;
  kind: ProfileDraft["kind"];
  title: string;
  detail: string;
  /** What the user is confirming. Compose is a file and a project name, not a shell line. */
  command: string;
  warning: string | null;
  draft: ProfileDraft;
}

const MANAGER_COMMAND: Record<PackageManager, { title: string; executable: string; args: (script: string) => string[] }> = {
  bun: { title: "Bun", executable: "bun", args: (script) => ["run", script] },
  npm: { title: "npm", executable: "npm", args: (script) => ["run", script] },
  pnpm: { title: "pnpm", executable: "pnpm", args: (script) => ["run", script] },
  yarn: { title: "Yarn", executable: "yarn", args: (script) => [script] },
};

export function createLaunchProfileId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `p${hex}`;
}

export function manualLaunchDraft(projectPath: string): ProfileDraft {
  return {
    ...emptyDraft(projectPath, "local-process"),
    id: "",
    name: "Local",
    executable: "",
    args: [],
  };
}

function processDraft(
  projectPath: string,
  name: string,
  executable: string,
  args: string[],
): ProfileDraft {
  return {
    ...emptyDraft(projectPath, "local-process"),
    id: "",
    name,
    cwd: projectPath,
    executable,
    args,
    signal: "SIGTERM",
    graceMs: 5_000,
    killAfterGrace: false,
    processGroup: true,
    httpUrl: "",
    tcpPort: "",
    websiteUrl: "",
    apiUrl: "",
    adminUrl: "",
    docsUrl: "",
    inherit: [],
  };
}

function argvLabel(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(" ");
}

/**
 * One suggestion per confirmed launch shape. Package scripts are offered
 * only when the script name exists. Makefile targets are offered only when
 * that target was parsed. go.mod, artisan, and Cargo.toml do not become a
 * command on their own.
 */
export function suggestLaunchProfiles(discovery: ProjectDiscovery): LaunchSuggestion[] {
  const projectPath = discovery.path;
  const suggestions: LaunchSuggestion[] = [];

  const composeFile = discovery.manifests.composePath;
  if (composeFile && !composeFile.includes("..") && !composeFile.startsWith("/")) {
    const projectName = defaultComposeProjectName(projectPath);
    const services = discovery.composeServices.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name));
    const draft: ProfileDraft = {
      ...emptyDraft(projectPath, "docker-compose"),
      id: "",
      name: "Docker Compose",
      cwd: projectPath,
      composeFile,
      projectName,
      services,
      httpUrl: "",
      tcpPort: "",
      websiteUrl: "",
      apiUrl: "",
      adminUrl: "",
      docsUrl: "",
      inherit: [],
    };
    const serviceLabel = services.length > 0 ? services.join(", ") : "services not detected";
    suggestions.push({
      id: `compose:${composeFile}`,
      kind: "docker-compose",
      title: "Docker Compose",
      detail: composeFile,
      command: `${composeFile} · ${projectName} · ${serviceLabel}`,
      warning: null,
      draft,
    });
  }

  const manager = discovery.manifests.packageManager;
  if (manager) {
    const spec = MANAGER_COMMAND[manager];
    for (const script of PACKAGE_PROFILE_SCRIPTS) {
      if (!discovery.packageScripts.includes(script)) continue;
      const args = spec.args(script);
      if (commandRejection(spec.executable, args)) continue;
      suggestions.push({
        id: `package:${script}`,
        kind: "local-process",
        title: spec.title,
        detail: argvLabel(spec.executable, args),
        command: argvLabel(spec.executable, args),
        warning: null,
        draft: processDraft(projectPath, spec.title, spec.executable, args),
      });
    }
  }

  for (const script of PACKAGE_PROFILE_SCRIPTS) {
    if (!discovery.composerScripts.includes(script)) continue;
    const args = ["run", script];
    if (commandRejection("composer", args)) continue;
    suggestions.push({
      id: `composer:${script}`,
      kind: "local-process",
      title: "Composer",
      detail: argvLabel("composer", args),
      command: argvLabel("composer", args),
      warning: null,
      draft: processDraft(projectPath, "Composer", "composer", args),
    });
  }

  if (discovery.manifests.makefilePath) {
    for (const target of MAKE_PROFILE_TARGETS) {
      if (!discovery.makefileTargets.includes(target)) continue;
      const args = [target];
      if (commandRejection("make", args)) continue;
      suggestions.push({
        id: `make:${target}`,
        kind: "local-process",
        title: "Make",
        detail: argvLabel("make", args),
        command: argvLabel("make", args),
        warning: MAKE_STOP_WARNING,
        draft: processDraft(projectPath, "Make", "make", args),
      });
    }
  }

  return suggestions;
}

export function launchSetupNote(discovery: ProjectDiscovery, suggestionCount: number): string {
  if (suggestionCount > 0) {
    return "Detected from project files. These are drafts, not commands, and nothing has been started.";
  }
  const unconfirmed = discovery.manifests.packageJson
    || discovery.manifests.composerJson
    || discovery.manifests.goMod
    || discovery.manifests.pyproject
    || discovery.manifests.dockerfile
    || discovery.manifests.makefilePath != null;
  if (unconfirmed) {
    return "No confirmed launch command. A manifest, or a Makefile without a dev, dev-up, or start target, is not enough to guess one. Configure a command yourself, or skip this step.";
  }
  return "No launch configuration detected. You can configure a command yourself, or skip this step.";
}

export function isMakeDraft(draft: ProfileDraft): boolean {
  if (draft.kind !== "local-process") return false;
  const base = draft.executable.trim().split("/").pop();
  return base === "make";
}

/** The review line. Arguments stay separate tokens; a space is not a shell join. */
export function formatLaunchSummary(draft: ProfileDraft): string {
  const name = draft.name.trim() || (draft.kind === "docker-compose" ? "Docker Compose" : "Local process");
  if (draft.kind === "docker-compose") {
    const services = draft.services.length > 0 ? draft.services.join(", ") : "services not listed";
    return `${name} · ${draft.composeFile.trim()} · ${draft.projectName.trim()} · ${services}`;
  }
  const args = draft.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
  const command = [draft.executable.trim(), args].filter((part) => part.length > 0).join(" ");
  return `${name} · ${command}`;
}

export type LaunchGate =
  | { state: "skip"; summary: null; profile: null }
  | { state: "ready"; summary: string; profile: LaunchProfile }
  | { state: "invalid"; summary: null; profile: null; error: string };

/** `skip` saves nothing. Anything else must already pass launch-profile validation. */
export function evaluateLaunch(projectPath: string, choice: string, draft: ProfileDraft | null): LaunchGate {
  if (choice === "skip") return { state: "skip", summary: null, profile: null };
  if (!draft) {
    return { state: "invalid", summary: null, profile: null, error: "Choose a launch profile or skip this step." };
  }
  const validated = profileFromDraft(projectPath, draft);
  if (!validated.ok) {
    return {
      state: "invalid",
      summary: null,
      profile: null,
      error: validated.errors.map((issue) => issue.message).join(" "),
    };
  }
  return { state: "ready", summary: formatLaunchSummary(draft), profile: validated.profile };
}

/** The create call stored the row and the response was lost. Retry must keep this id. */
export function profileCreateIsDuplicate(message: string): boolean {
  return message.includes("already exists");
}

export function profileSaveFailureMessage(detail: string): string {
  return `The project was added, but the launch profile was not saved: ${detail} The project and any documents already saved were kept. Nothing was started. Try again to save the same profile, or close and configure it later.`;
}
