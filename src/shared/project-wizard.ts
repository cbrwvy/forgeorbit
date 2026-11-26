/**
 * Project-creation wizard rules (FO-002). Pure, shared by the dialog and
 * the tests. Creating the directory and registering the row stay on the
 * server; this module only decides whether a step is ready and what the
 * review screen should promise.
 */

import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  defaultDocPaths,
  expandHomePath,
  formatDocumentation,
  formatGit,
  formatStacks,
  isSafeProjectRelPath,
  joinProjectPath,
  validateFolderName,
  type ProjectDiscovery,
} from "./project-discovery.ts";

/** Project-relative path for an absolute file the user picked, or null when
 *  it isn't inside `root`. */
export function relativeInside(root: string, absolute: string): string | null {
  const normRoot = root.trim().replace(/\/+$/, "");
  const normAbs = absolute.trim().replace(/\/+$/, "");
  if (!normRoot.startsWith("/") || !normAbs.startsWith(`${normRoot}/`)) return null;
  const rel = normAbs.slice(normRoot.length + 1);
  return isSafeProjectRelPath(rel) ? rel : null;
}

export const WIZARD_STEPS = [
  { id: "project", label: "Project" },
  { id: "discovery", label: "Discovery" },
  { id: "docs", label: "Docs" },
  { id: "environment", label: "Git" },
  { id: "launch", label: "Environment" },
  { id: "review", label: "Review" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];
export type WizardMode = "create" | "import";
export type CreatePlacement = "existing" | "new-folder";

export interface WizardDraft {
  mode: WizardMode;
  placement: CreatePlacement;
  name: string;
  description: string;
  /** What the user typed or what the folder picker returned. May start with `~`. */
  directory: string;
  folderName: string;
  ideaPath: string | null;
  prdPath: string | null;
  /** The person skipped this document on the Docs step (FO-002.1). Held only
   *  while the wizard is open: a document that doesn't exist is simply
   *  "not created", and the workspace offers to create it later. */
  ideaSkipped: boolean;
  prdSkipped: boolean;
}

export const EMPTY_WIZARD_DRAFT: WizardDraft = {
  mode: "import",
  placement: "existing",
  name: "",
  description: "",
  directory: "",
  folderName: "",
  ideaPath: null,
  prdPath: null,
  ideaSkipped: false,
  prdSkipped: false,
};

export interface ProjectMeta {
  description?: string;
  idea?: string | null;
  prd?: string | null;
}

/** Preferences are one URL segment, so the path is encoded into the key. */
export function projectMetaKey(projectPath: string): string {
  return `projectMeta.${encodeURIComponent(projectPath)}`;
}

export function serializeProjectMeta(meta: ProjectMeta): string | null {
  const description = meta.description?.trim() ?? "";
  const idea = meta.idea && isSafeProjectRelPath(meta.idea) ? meta.idea : null;
  const prd = meta.prd && isSafeProjectRelPath(meta.prd) ? meta.prd : null;
  if (!description && !idea && !prd) return null;
  return JSON.stringify({
    ...(description ? { description: description.slice(0, PROJECT_DESCRIPTION_MAX) } : {}),
    ...(idea ? { idea } : {}),
    ...(prd ? { prd } : {}),
  });
}

export function parseProjectMeta(raw: string | null | undefined): ProjectMeta {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const description = typeof record.description === "string"
      ? record.description.trim().slice(0, PROJECT_DESCRIPTION_MAX)
      : undefined;
    const idea = typeof record.idea === "string" && isSafeProjectRelPath(record.idea) ? record.idea : null;
    const prd = typeof record.prd === "string" && isSafeProjectRelPath(record.prd) ? record.prd : null;
    return {
      ...(description ? { description } : {}),
      idea,
      prd,
    };
  } catch {
    return {};
  }
}

export function resolvedDirectory(draft: WizardDraft, home: string): string {
  return expandHomePath(draft.directory, home).trim();
}

/** Absolute path the wizard will register, or "" when it isn't known yet. */
export function projectTarget(draft: WizardDraft, home: string): string {
  const directory = resolvedDirectory(draft, home);
  if (!directory.startsWith("/")) return "";
  if (draft.mode === "create" && draft.placement === "new-folder") {
    if (validateFolderName(draft.folderName)) return "";
    return joinProjectPath(directory, draft.folderName);
  }
  return directory.replace(/\/+$/, "");
}

export function validateProjectStep(draft: WizardDraft, home: string): string | null {
  const name = draft.name.trim();
  if (!name) return "Project name is required.";
  if (name.length > PROJECT_NAME_MAX) return "Project name is too long.";
  if (draft.description.trim().length > PROJECT_DESCRIPTION_MAX) return "Description is too long.";
  const directory = resolvedDirectory(draft, home);
  if (!directory) return "Choose a folder.";
  if (directory.startsWith("~")) return "Home directory isn't known yet. Paste a full path.";
  if (!directory.startsWith("/")) return "Use a full path, starting with /.";
  if (draft.mode === "create" && draft.placement === "new-folder") {
    return validateFolderName(draft.folderName);
  }
  return null;
}

/** A skip only means something for a document that doesn't exist. */
export function effectiveSkips(
  draft: Pick<WizardDraft, "ideaSkipped" | "prdSkipped" | "ideaPath" | "prdPath">,
  discovery: ProjectDiscovery,
): { idea: boolean; prd: boolean } {
  return {
    idea: draft.ideaSkipped && !draft.ideaPath && !discovery.documentation.idea,
    prd: draft.prdSkipped && !draft.prdPath && !discovery.documentation.prd,
  };
}

/** Where a document stands (FO-002.1). `skipped` and `missing` are both
 *  "not created"; the difference is only what the wizard says about it. */
export type DocLifecycle = "exists" | "planned" | "failed" | "skipped" | "missing";

export function docLifecycle(input: {
  existing: string | null;
  planned: boolean;
  failed: boolean;
  skipped: boolean;
}): DocLifecycle {
  if (input.existing) return "exists";
  if (input.failed) return "failed";
  if (input.planned) return "planned";
  return input.skipped ? "skipped" : "missing";
}

/**
 * Which documents a registered project has. Discovery decides first (the
 * filesystem is the truth); a path stored in the project meta counts only
 * when the caller confirmed the file is really there.
 */
export function existingDocPaths(
  documentation: ProjectDiscovery["documentation"],
  meta: ProjectMeta,
  metaFileExists: { idea: boolean; prd: boolean },
): { idea: string | null; prd: string | null } {
  const found = defaultDocPaths(documentation);
  return {
    idea: found.ideaPath ?? (meta.idea && metaFileExists.idea ? meta.idea : null),
    prd: found.prdPath ?? (meta.prd && metaFileExists.prd ? meta.prd : null),
  };
}

/** Project meta with one document path set, everything else kept. */
export function withDocPath(meta: ProjectMeta, kind: "idea" | "prd", docPath: string): ProjectMeta {
  return { ...meta, [kind]: docPath };
}

export function validateDocSelection(draft: WizardDraft): string | null {
  if (draft.ideaPath && !isSafeProjectRelPath(draft.ideaPath)) return "IDEA path must stay inside the project.";
  if (draft.prdPath && !isSafeProjectRelPath(draft.prdPath)) return "PRD path must stay inside the project.";
  return null;
}

/** A reviewed interview draft that confirm will create (FO-003). */
export interface PlannedDocWrite {
  kind: "idea" | "prd";
  path: string;
}

/**
 * How the review step describes the optional launch profile.
 * `skip` saves nothing. `ready` names the profile that confirm will store.
 * `invalid` blocks confirm. None of these start the project.
 */
export interface ReviewEnvironment {
  state: "skip" | "ready" | "invalid";
  summary: string | null;
}

export const SKIPPED_ENVIRONMENT: ReviewEnvironment = { state: "skip", summary: null };

/** What confirm will do. Every line is a promise the server keeps. */
export function reviewChanges(
  draft: WizardDraft,
  discovery: ProjectDiscovery,
  docWrites: readonly PlannedDocWrite[] = [],
  environment: ReviewEnvironment = SKIPPED_ENVIRONMENT,
): string[] {
  const lines: string[] = [];
  if (discovery.willCreateDirectory) lines.push(`Create the folder ${discovery.path}.`);
  lines.push("Register the folder as a ForgeOrbit project.");
  lines.push("Leave every file already in the folder untouched.");
  const skips = effectiveSkips(draft, discovery);
  if (docWrites.length === 0) {
    lines.push("Do not create or overwrite IDEA.md or PRD.md.");
  } else {
    for (const write of docWrites) {
      lines.push(`Create ${write.path} from the draft you reviewed. Stop if that file already exists.`);
    }
    lines.push("Do not overwrite any existing document.");
  }
  if (skips.idea || skips.prd) {
    const names = skips.idea && skips.prd ? "IDEA and PRD are" : `${skips.idea ? "IDEA" : "PRD"} is`;
    lines.push(`${names} skipped. You can create ${skips.idea && skips.prd ? "them" : "it"} later from the project workspace.`);
  }
  lines.push("Do not run install, test, git, Docker, or Makefile commands.");
  if (environment.state === "ready" && environment.summary) {
    lines.push(`Save the launch profile: ${environment.summary}.`);
  } else if (environment.state === "invalid") {
    lines.push("The launch profile is not valid yet. Fix it or skip the environment step before adding the project.");
  } else {
    lines.push("Do not save a launch profile.");
  }
  lines.push("Do not start the project.");
  if (draft.description.trim() || draft.ideaPath || draft.prdPath) {
    lines.push("Save the description and document choices in ForgeOrbit, outside the project folder.");
  }
  return lines;
}

/** Confirm only repeats work that has not succeeded yet. */
export function wizardSaveSteps(input: {
  registered: boolean;
  documentsPending: boolean;
  profilePending: boolean;
}): Array<"register" | "documents" | "profile"> {
  const steps: Array<"register" | "documents" | "profile"> = [];
  if (!input.registered) steps.push("register");
  if (input.documentsPending) steps.push("documents");
  if (input.profilePending) steps.push("profile");
  return steps;
}

export function reviewRows(
  draft: WizardDraft,
  discovery: ProjectDiscovery,
  docWrites: readonly PlannedDocWrite[] = [],
  environment: ReviewEnvironment = SKIPPED_ENVIRONMENT,
): { label: string; value: string }[] {
  const planned = (kind: "idea" | "prd") => docWrites.find((write) => write.kind === kind)?.path ?? null;
  const environmentValue = environment.state === "ready" && environment.summary
    ? environment.summary
    : environment.state === "invalid"
      ? "Needs attention"
      : "Not configured";
  return [
    { label: "Name", value: draft.name.trim() },
    { label: "Folder", value: discovery.path },
    ...(draft.description.trim() ? [{ label: "Description", value: draft.description.trim() }] : []),
    { label: "Stack", value: formatStacks(discovery.stacks) },
    { label: "Git", value: formatGit(discovery.git) },
    {
      label: "Documentation",
      value: formatDocumentation(
        discovery.documentation,
        { ideaPath: draft.ideaPath, prdPath: draft.prdPath },
        { ideaPath: planned("idea"), prdPath: planned("prd") },
        effectiveSkips(draft, discovery),
      ),
    },
    { label: "Environment", value: environmentValue },
  ];
}
