/**
 * Read-only project discovery (FO-002).
 *
 * Pure: no filesystem, no git, no child processes. The Bun side
 * (`src/bun/project-discovery.ts`) stats an allowlist of paths, refuses to
 * read secrets, and hands the facts here. Nothing in this module is a
 * command to run — `command` strings are labels for the review screen.
 */

export const PROJECT_NAME_MAX = 120;
export const PROJECT_DESCRIPTION_MAX = 500;
export const FOLDER_NAME_MAX = 255;
export const DISCOVERY_TEXT_CAP = 256 * 1024;

export const IDEA_STANDARD = "docs/IDEA.md";
export const PRD_STANDARD = "docs/PRD.md";

/** Checked in order. The first hit that is not the same inode as an earlier
 *  hit wins. Only `docs/IDEA.md` counts as the standard location. */
export const IDEA_CANDIDATES = [
  IDEA_STANDARD,
  "IDEA.md",
  "docs/idea.md",
  "idea.md",
  "documentation/IDEA.md",
  "doc/IDEA.md",
] as const;

export const PRD_CANDIDATES = [
  PRD_STANDARD,
  "PRD.md",
  "docs/prd.md",
  "prd.md",
  "documentation/PRD.md",
  "doc/PRD.md",
  "docs/product-requirements.md",
] as const;

export const README_CANDIDATES = ["README.md", "readme.md", "README.markdown"] as const;
export const COMPOSE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const;
export const MAKEFILE_CANDIDATES = ["Makefile", "makefile", "GNUmakefile"] as const;

/** Manifests and markers the scanner may stat. Text is read only for the
 *  subset in `READABLE_REL_PATHS`. */
export const DISCOVERY_REL_PATHS: readonly string[] = [
  ...README_CANDIDATES,
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "composer.json",
  "go.mod",
  "pyproject.toml",
  "Dockerfile",
  "dockerfile",
  ...COMPOSE_CANDIDATES,
  ...MAKEFILE_CANDIDATES,
  "artisan",
  "Package.swift",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "phpunit.xml",
  "phpunit.xml.dist",
  "pest.php",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "electrobun.config.ts",
  "electrobun.config.js",
  ...IDEA_CANDIDATES,
  ...PRD_CANDIDATES,
];

/** Files whose contents are parsed. Everything else on the allowlist is
 *  presence-only (lockfiles, requirement lists, and agent docs can be huge
 *  or can carry credentials). */
export const READABLE_REL_PATHS: ReadonlySet<string> = new Set([
  "package.json",
  "composer.json",
  "go.mod",
  "pyproject.toml",
  "Package.swift",
  ...MAKEFILE_CANDIDATES,
  ...COMPOSE_CANDIDATES,
  "Dockerfile",
  "dockerfile",
  ...README_CANDIDATES,
  ...IDEA_CANDIDATES,
  ...PRD_CANDIDATES,
]);

/** Basenames at the project root. The scanner records that they exist and
 *  does not open them. */
export const SECRET_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "credentials.json",
  "secrets.json",
  ".npmrc",
  ".netrc",
  "id_rsa",
] as const;

const LAUNCH_SCRIPT_KEYS = ["dev", "start", "serve"] as const;
const TEST_SCRIPT_KEYS = ["test", "lint", "check"] as const;
const LAUNCH_MAKE_TARGETS = new Set(["dev", "start", "run", "serve", "up", "app", "develop"]);
const TEST_MAKE_TARGETS = new Set(["test", "check", "lint", "fmt", "ci"]);

export type StackId =
  | "laravel"
  | "php"
  | "go"
  | "node"
  | "react"
  | "python"
  | "rust"
  | "macos"
  | "docker-compose"
  | "docker";

export type DocKind = "idea" | "prd";
export type DocState = "both" | "idea-only" | "prd-only" | "alternatives" | "none";
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface DocHit {
  kind: DocKind;
  /** Project-relative, posix separators. */
  path: string;
  standard: boolean;
}

export interface LaunchHint {
  label: string;
  /** Display only. Discovery never executes this. */
  command: string;
  source: string;
}

export interface GitFacts {
  present: boolean;
  branch: string | null;
  /** Absolute git toplevel when `present`. */
  toplevel: string | null;
  nested: boolean;
}

export interface ProjectDiscovery {
  /** Directory that will be registered. */
  path: string;
  willCreateDirectory: boolean;
  nameSuggestion: string;
  empty: boolean;
  git: GitFacts;
  readmePath: string | null;
  agentsPath: string | null;
  claudePath: string | null;
  documentation: {
    idea: DocHit | null;
    prd: DocHit | null;
    alternatives: DocHit[];
    state: DocState;
  };
  stacks: StackId[];
  /** Short reasons, safe to show. Never file bodies. */
  signals: string[];
  manifests: {
    packageJson: boolean;
    composerJson: boolean;
    goMod: boolean;
    pyproject: boolean;
    dockerfile: boolean;
    composePath: string | null;
    makefilePath: string | null;
    packageManager: PackageManager | null;
  };
  /**
   * `dev` / `start` / `serve` names that exist in package.json. The script
   * bodies are not copied — a launch profile must not inherit them.
   */
  packageScripts: string[];
  /** Same allowlist for composer.json scripts. Bodies are not copied. */
  composerScripts: string[];
  launch: LaunchHint[];
  testTools: LaunchHint[];
  makefileTargets: string[];
  composeServices: string[];
  /** Basenames only. Contents were not read. */
  secretsNoted: string[];
  warnings: string[];
  /** First markdown heading for docs and the README, keyed by relative path. */
  titles: Record<string, string>;
  duplicate: { path: string; name: string } | null;
}

export interface ScanFacts {
  projectPath: string;
  willCreateDirectory: boolean;
  empty: boolean;
  /** Relative paths that exist, are files, and stay inside the project. */
  files: ReadonlySet<string>;
  /** dev:ino identity so case-insensitive volumes don't double-count. */
  inodes: ReadonlyMap<string, string>;
  rootEntries: readonly string[];
  texts: Readonly<Record<string, string>>;
  git: { present: boolean; branch: string | null; toplevel: string | null };
  secretsNoted: readonly string[];
  warnings: readonly string[];
}

export function pathBasename(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Single path segment safe to create as a new project folder. */
export function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required.";
  if (trimmed.length > FOLDER_NAME_MAX) return "Folder name is too long.";
  if (trimmed === "." || trimmed === ".." || trimmed === ".git") return "That folder name is not allowed.";
  if (/[/\\\0]/.test(trimmed)) return "Folder name cannot contain a slash.";
  return null;
}

/** Relative path that cannot escape the project. Posix only — this app is macOS. */
export function isSafeProjectRelPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return false;
  if (rel.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return true;
}

export function joinProjectPath(parent: string, folderName: string): string {
  const base = parent.trim().replace(/\/+$/, "");
  return `${base}/${folderName.trim()}`;
}

export function expandHomePath(input: string, home: string): string {
  const trimmed = input.trim();
  const root = home.trim().replace(/\/+$/, "");
  if (!root) return trimmed;
  if (trimmed === "~") return root;
  if (trimmed.startsWith("~/")) return `${root}${trimmed.slice(1)}`;
  return trimmed;
}

export function firstMarkdownHeading(text: string): string | null {
  const lines = text.split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    const match = /^#{1,3}\s+(\S.*?)\s*$/.exec(line);
    if (match?.[1]) return match[1].slice(0, 120);
  }
  return null;
}

export function makefileTargets(text: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith("#") || raw.startsWith("\t") || raw.startsWith(" ")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(raw);
    if (!match?.[1] || seen.has(match[1])) continue;
    seen.add(match[1]);
    targets.push(match[1]);
    if (targets.length >= 40) break;
  }
  return targets;
}

export function composeServiceNames(text: string): string[] {
  const names: string[] = [];
  let inServices = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith("#")) break;
    const match = /^(?: {2}|\t)([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:\s*(?:#.*)?$/.exec(line);
    if (!match?.[1]) continue;
    names.push(match[1]);
    if (names.length >= 30) break;
  }
  return names;
}

function firstPresent(candidates: readonly string[], files: ReadonlySet<string>): string | null {
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function docHits(
  kind: DocKind,
  candidates: readonly string[],
  standard: string,
  files: ReadonlySet<string>,
  inodes: ReadonlyMap<string, string>,
): DocHit[] {
  const hits: DocHit[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!files.has(candidate)) continue;
    const inode = inodes.get(candidate) ?? candidate;
    if (seen.has(inode)) continue;
    seen.add(inode);
    hits.push({ kind, path: candidate, standard: candidate === standard });
  }
  return hits;
}

function documentationFrom(files: ReadonlySet<string>, inodes: ReadonlyMap<string, string>): ProjectDiscovery["documentation"] {
  const ideaHits = docHits("idea", IDEA_CANDIDATES, IDEA_STANDARD, files, inodes);
  const prdHits = docHits("prd", PRD_CANDIDATES, PRD_STANDARD, files, inodes);
  const idea = ideaHits.find((hit) => hit.standard) ?? null;
  const prd = prdHits.find((hit) => hit.standard) ?? null;
  const alternatives = [
    ...ideaHits.filter((hit) => !hit.standard),
    ...prdHits.filter((hit) => !hit.standard),
  ];
  let state: DocState;
  if (idea && prd) state = "both";
  else if (idea) state = "idea-only";
  else if (prd) state = "prd-only";
  else if (alternatives.length > 0) state = "alternatives";
  else state = "none";
  return { idea, prd, alternatives, state };
}

/** `packageManager` is `name@version`. Only the name is a manager signal. */
function managerFromPackageManagerField(field: string | null): PackageManager | null {
  if (!field) return null;
  const name = field.trim().toLowerCase().split("@")[0];
  if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
  return null;
}

/**
 * Lockfiles win when one is present: that is the manager that last installed.
 * The `packageManager` field is used only when no lockfile names a manager,
 * so a declared pnpm project without a lockfile is not reported as npm.
 */
function packageManagerOf(files: ReadonlySet<string>, packageManagerField: string | null = null): PackageManager | null {
  if (!files.has("package.json")) return null;
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("package-lock.json")) return "npm";
  return managerFromPackageManagerField(packageManagerField) ?? "npm";
}

function scriptCommand(manager: PackageManager, script: string): string {
  if (manager === "bun") return `bun run ${script}`;
  if (manager === "pnpm") return `pnpm run ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  return `npm run ${script}`;
}

function recordStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function dependencyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value);
}

function titlesFrom(texts: Readonly<Record<string, string>>, paths: readonly string[]): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const rel of paths) {
    const text = texts[rel];
    if (!text) continue;
    const heading = firstMarkdownHeading(text);
    if (heading) titles[rel] = heading;
  }
  return titles;
}

function pushHint(list: LaunchHint[], hint: LaunchHint) {
  if (list.length >= 12) return;
  if (list.some((item) => item.command === hint.command && item.source === hint.source)) return;
  list.push(hint);
}

/**
 * Turn a scanner snapshot into the report the wizard shows. File bodies are
 * used only to classify; they are not copied onto the result.
 */
export function analyzeProject(facts: ScanFacts): ProjectDiscovery {
  const files = facts.files;
  const texts = facts.texts;
  const warnings = [...facts.warnings];
  const signals: string[] = [];
  const stacks: StackId[] = [];
  const launch: LaunchHint[] = [];
  const testTools: LaunchHint[] = [];

  const packageText = texts["package.json"];
  let packageDeps: string[] = [];
  let packageScripts: Record<string, string> = {};
  let declaredManager: string | null = null;
  if (files.has("package.json")) {
    if (packageText) {
      try {
        const parsed = JSON.parse(packageText) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          packageDeps = [
            ...dependencyNames(record.dependencies),
            ...dependencyNames(record.devDependencies),
            ...dependencyNames(record.peerDependencies),
          ];
          packageScripts = recordStrings(record.scripts);
          if (typeof record.packageManager === "string") declaredManager = record.packageManager;
        }
      } catch {
        warnings.push("package.json could not be parsed.");
      }
    }
    stacks.push("node");
    signals.push("package.json");
  }

  const manager = packageManagerOf(files, declaredManager);
  const packageScriptNames = LAUNCH_SCRIPT_KEYS.filter((key) => key in packageScripts);
  if (packageDeps.includes("react")) {
    stacks.push("react");
    signals.push("package.json depends on react");
  }
  if (packageDeps.includes("electrobun") || files.has("electrobun.config.ts") || files.has("electrobun.config.js")) {
    stacks.push("macos");
    signals.push("Electrobun project");
  }
  if (manager) {
    for (const key of LAUNCH_SCRIPT_KEYS) {
      if (key in packageScripts) {
        pushHint(launch, { label: key, command: scriptCommand(manager, key), source: "package.json" });
      }
    }
    for (const key of TEST_SCRIPT_KEYS) {
      if (key in packageScripts) {
        pushHint(testTools, { label: key, command: scriptCommand(manager, key), source: "package.json" });
      }
    }
  }

  let laravel = false;
  const composerScriptNames: string[] = [];
  if (files.has("composer.json")) {
    signals.push("composer.json");
    const composerText = texts["composer.json"];
    if (composerText) {
      try {
        const parsed = JSON.parse(composerText) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const requireNames = [
            ...dependencyNames(record.require),
            ...dependencyNames(record["require-dev"]),
          ];
          laravel = requireNames.includes("laravel/framework");
          const scripts = recordStrings(record.scripts);
          for (const key of LAUNCH_SCRIPT_KEYS) {
            if (key in scripts) {
              composerScriptNames.push(key);
              pushHint(launch, { label: key, command: `composer run ${key}`, source: "composer.json" });
            }
          }
          if ("test" in scripts) pushHint(testTools, { label: "test", command: "composer run test", source: "composer.json" });
        }
      } catch {
        warnings.push("composer.json could not be parsed.");
      }
    }
  }
  if (files.has("artisan")) {
    laravel = true;
    signals.push("artisan");
    pushHint(launch, { label: "Laravel dev server", command: "php artisan serve", source: "artisan" });
  }
  if (laravel) stacks.push("laravel");
  else if (files.has("composer.json")) stacks.push("php");
  if (files.has("phpunit.xml") || files.has("phpunit.xml.dist")) {
    pushHint(testTools, { label: "PHPUnit", command: "vendor/bin/phpunit", source: "phpunit.xml" });
  }
  if (files.has("pest.php")) {
    pushHint(testTools, { label: "Pest", command: "vendor/bin/pest", source: "pest.php" });
  }

  if (files.has("go.mod")) {
    stacks.push("go");
    const moduleLine = texts["go.mod"] ? /^module\s+(\S+)/m.exec(texts["go.mod"]) : null;
    signals.push(moduleLine?.[1] ? `go.mod (${moduleLine[1]})` : "go.mod");
    pushHint(launch, { label: "Go", command: "go run .", source: "go.mod" });
    pushHint(testTools, { label: "Go test", command: "go test ./...", source: "go.mod" });
  }

  if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("Pipfile")) {
    stacks.push("python");
    signals.push(files.has("pyproject.toml") ? "pyproject.toml" : files.has("requirements.txt") ? "requirements.txt" : "Pipfile");
    const pyproject = texts["pyproject.toml"] ?? "";
    if (pyproject.includes("[tool.pytest") || /^\s*pytest\b/m.test(pyproject)) {
      pushHint(testTools, { label: "pytest", command: "pytest", source: "pyproject.toml" });
    }
    const scriptsBlock = pyproject.split("[project.scripts]")[1]?.split(/\n\[/)[0] ?? "";
    for (const line of scriptsBlock.split(/\n/)) {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/.exec(line);
      if (match?.[1]) pushHint(launch, { label: match[1], command: match[1], source: "pyproject.toml" });
    }
  }

  if (files.has("Cargo.toml")) {
    stacks.push("rust");
    signals.push("Cargo.toml");
    pushHint(launch, { label: "Cargo", command: "cargo run", source: "Cargo.toml" });
    pushHint(testTools, { label: "Cargo test", command: "cargo test", source: "Cargo.toml" });
  }

  const swift = texts["Package.swift"] ?? "";
  const xcode = facts.rootEntries.some((entry) => entry.endsWith(".xcodeproj") || entry.endsWith(".xcworkspace"));
  if (xcode || swift.includes(".macOS")) {
    if (!stacks.includes("macos")) stacks.push("macos");
    signals.push(xcode ? "Xcode project" : "Package.swift targets macOS");
  }

  const dockerfile = files.has("Dockerfile") ? "Dockerfile" : files.has("dockerfile") ? "dockerfile" : null;
  if (dockerfile) {
    stacks.push("docker");
    signals.push(dockerfile);
  }

  const composePath = firstPresent(COMPOSE_CANDIDATES, files);
  let composeServices: string[] = [];
  if (composePath) {
    stacks.push("docker-compose");
    signals.push(composePath);
    composeServices = composeServiceNames(texts[composePath] ?? "");
    pushHint(launch, {
      label: "Docker Compose",
      command: "docker compose up",
      source: composePath,
    });
  }

  const makefilePath = firstPresent(MAKEFILE_CANDIDATES, files);
  const targets = makefilePath ? makefileTargets(texts[makefilePath] ?? "") : [];
  if (makefilePath) signals.push(makefilePath);
  for (const target of targets) {
    if (LAUNCH_MAKE_TARGETS.has(target)) {
      pushHint(launch, { label: `make ${target}`, command: `make ${target}`, source: makefilePath ?? "Makefile" });
    }
    if (TEST_MAKE_TARGETS.has(target)) {
      pushHint(testTools, { label: `make ${target}`, command: `make ${target}`, source: makefilePath ?? "Makefile" });
    }
  }

  const readmePath = firstPresent(README_CANDIDATES, files);
  const documentation = documentationFrom(files, facts.inodes);
  const titlePaths = [
    ...(readmePath ? [readmePath] : []),
    ...(documentation.idea ? [documentation.idea.path] : []),
    ...(documentation.prd ? [documentation.prd.path] : []),
    ...documentation.alternatives.map((hit) => hit.path),
  ];

  const toplevel = facts.git.toplevel;
  const nested = Boolean(facts.git.present && toplevel && normalizeSlash(toplevel) !== normalizeSlash(facts.projectPath));
  if (!facts.git.present) warnings.push("This folder is not a git repository.");
  else if (nested && toplevel) warnings.push(`This folder sits inside the git repository at ${toplevel}.`);
  if (facts.secretsNoted.length > 0) {
    warnings.push(`Secrets files are present (${facts.secretsNoted.join(", ")}). Their contents were not read.`);
  }
  if (facts.willCreateDirectory) {
    warnings.push("This folder does not exist yet. It will be created only after you confirm.");
  }

  const nameSuggestion = pathBasename(facts.projectPath) || facts.projectPath;

  return {
    path: facts.projectPath,
    willCreateDirectory: facts.willCreateDirectory,
    nameSuggestion: nameSuggestion.slice(0, PROJECT_NAME_MAX),
    empty: facts.empty,
    git: {
      present: facts.git.present,
      branch: facts.git.branch,
      toplevel: facts.git.toplevel,
      nested,
    },
    readmePath,
    agentsPath: files.has("AGENTS.md") ? "AGENTS.md" : null,
    claudePath: files.has("CLAUDE.md") ? "CLAUDE.md" : null,
    documentation,
    stacks,
    signals,
    manifests: {
      packageJson: files.has("package.json"),
      composerJson: files.has("composer.json"),
      goMod: files.has("go.mod"),
      pyproject: files.has("pyproject.toml"),
      dockerfile: dockerfile != null,
      composePath,
      makefilePath,
      packageManager: manager,
    },
    packageScripts: packageScriptNames,
    composerScripts: composerScriptNames,
    launch,
    testTools,
    makefileTargets: targets,
    composeServices,
    secretsNoted: [...facts.secretsNoted],
    warnings,
    titles: titlesFrom(texts, titlePaths),
    duplicate: null,
  };
}

function normalizeSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function formatStacks(ids: readonly StackId[]): string {
  const set = new Set(ids);
  const parts: string[] = [];
  if (set.has("laravel")) parts.push("Laravel / PHP");
  else if (set.has("php")) parts.push("PHP");
  if (set.has("react")) parts.push("Node / React");
  else if (set.has("node")) parts.push("Node");
  if (set.has("go")) parts.push("Go");
  if (set.has("python")) parts.push("Python");
  if (set.has("rust")) parts.push("Rust");
  if (set.has("macos")) parts.push("macOS application");
  if (set.has("docker-compose")) parts.push("Docker Compose");
  else if (set.has("docker")) parts.push("Docker");
  return parts.length > 0 ? parts.join(", ") : "No stack detected";
}

export function formatGit(git: GitFacts): string {
  if (!git.present) return "Not a git repository";
  const branch = git.branch && git.branch !== "HEAD" ? git.branch : "detached HEAD";
  if (git.nested && git.toplevel) return `Branch ${branch} · git root ${git.toplevel}`;
  return `Branch ${branch}`;
}

export function defaultDocPaths(docs: ProjectDiscovery["documentation"]): { ideaPath: string | null; prdPath: string | null } {
  const ideaAlts = docs.alternatives.filter((hit) => hit.kind === "idea");
  const prdAlts = docs.alternatives.filter((hit) => hit.kind === "prd");
  return {
    ideaPath: docs.idea?.path ?? (ideaAlts.length === 1 ? ideaAlts[0]!.path : null),
    prdPath: docs.prd?.path ?? (prdAlts.length === 1 ? prdAlts[0]!.path : null),
  };
}

export function formatDocumentation(
  docs: ProjectDiscovery["documentation"],
  selected: { ideaPath: string | null; prdPath: string | null },
  drafted: { ideaPath: string | null; prdPath: string | null } = { ideaPath: null, prdPath: null },
  skipped: { idea: boolean; prd: boolean } = { idea: false, prd: false },
): string {
  const idea = docs.idea?.path ?? selected.ideaPath;
  const prd = docs.prd?.path ?? selected.prdPath;
  const label = (existing: string | null, draft: string | null, skip: boolean) =>
    existing ?? (draft ? `${draft} (new draft)` : skip ? "skipped" : "missing");
  return `IDEA: ${label(idea, drafted.ideaPath, skipped.idea)} · PRD: ${label(prd, drafted.prdPath, skipped.prd)}`;
}
