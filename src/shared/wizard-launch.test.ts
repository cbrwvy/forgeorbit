import { expect, test } from "bun:test";
import { analyzeProject, type ScanFacts } from "./project-discovery.ts";
import { defaultComposeProjectName } from "./environment/present.ts";
import { validateLaunchProfile } from "./environment/profile.ts";
import {
  MAKE_STOP_WARNING,
  createLaunchProfileId,
  evaluateLaunch,
  formatLaunchSummary,
  launchSetupNote,
  manualLaunchDraft,
  profileCreateIsDuplicate,
  profileSaveFailureMessage,
  suggestLaunchProfiles,
} from "./wizard-launch.ts";

const ROOT = "/work/app";

function facts(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    projectPath: ROOT,
    willCreateDirectory: false,
    empty: false,
    files: new Set<string>(),
    inodes: new Map<string, string>(),
    rootEntries: [],
    texts: {},
    git: { present: true, branch: "main", toplevel: ROOT },
    secretsNoted: [],
    warnings: [],
    ...overrides,
  };
}

function report(files: string[], texts: Record<string, string> = {}) {
  return analyzeProject(facts({ files: new Set(files), texts }));
}

test("docker compose is a draft with ForgeOrbit's project name, not an external stack name", () => {
  const discovery = report(
    ["compose.yaml"],
    { "compose.yaml": "name: external-stack\nservices:\n  web:\n    image: nginx\n  worker:\n" },
  );
  const suggestions = suggestLaunchProfiles(discovery);
  expect(suggestions.map((item) => item.id)).toEqual(["compose:compose.yaml"]);
  const draft = suggestions[0]!.draft;
  expect(draft.kind).toBe("docker-compose");
  expect(draft.composeFile).toBe("compose.yaml");
  expect(draft.projectName).toBe(defaultComposeProjectName(ROOT));
  expect(draft.projectName).not.toBe("external-stack");
  expect(draft.services).toEqual(["web", "worker"]);
  expect(draft.cwd).toBe(ROOT);
  expect(draft.httpUrl).toBe("");
  expect(draft.websiteUrl).toBe("");
  expect(draft.inherit).toEqual([]);
  const gate = evaluateLaunch(ROOT, suggestions[0]!.id, { ...draft, id: "p0123456789abcdef" });
  expect(gate.state).toBe("ready");
  if (gate.state !== "ready") return;
  expect(gate.profile.launch.kind).toBe("docker-compose");
  expect(gate.profile.stop).toEqual({ kind: "compose-stop" });
  expect(gate.profile.healthChecks).toEqual([]);
  expect(gate.profile.urls).toEqual([]);
  expect(validateLaunchProfile(gate.profile).ok).toBe(true);
  expect(JSON.stringify(suggestions)).not.toContain("external-stack");
});

test("compose file priority follows the discovery allowlist", () => {
  const discovery = report(["docker-compose.yml", "compose.yaml"], {
    "compose.yaml": "services:\n  app:\n",
    "docker-compose.yml": "services:\n  other:\n",
  });
  const suggestions = suggestLaunchProfiles(discovery);
  expect(suggestions[0]?.draft.composeFile).toBe("compose.yaml");
  expect(suggestions[0]?.draft.services).toEqual(["app"]);
});

test("package scripts become argv for bun, npm, pnpm, and yarn, and a missing script is not invented", () => {
  const bun = suggestLaunchProfiles(report(["package.json", "bun.lock"], {
    "package.json": JSON.stringify({ scripts: { dev: "echo SECRET_BUN", start: "echo SECRET_START" }, packageManager: "npm@10.0.0" }),
  }));
  expect(bun.map((item) => item.command)).toEqual(["bun run dev", "bun run start"]);
  expect(bun[0]?.draft.executable).toBe("bun");
  expect(bun[0]?.draft.args).toEqual(["run", "dev"]);
  expect(JSON.stringify(bun)).not.toContain("SECRET_BUN");

  const npm = suggestLaunchProfiles(report(["package.json", "package-lock.json"], {
    "package.json": JSON.stringify({ scripts: { dev: "next dev" }, packageManager: "bun@1.1.0" }),
  }));
  expect(npm.map((item) => item.command)).toEqual(["npm run dev"]);

  const pnpm = suggestLaunchProfiles(report(["package.json", "pnpm-lock.yaml"], {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  }));
  expect(pnpm[0]?.draft.executable).toBe("pnpm");
  expect(pnpm[0]?.draft.args).toEqual(["run", "dev"]);

  const yarn = suggestLaunchProfiles(report(["package.json", "yarn.lock"], {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  }));
  expect(yarn[0]?.draft.executable).toBe("yarn");
  expect(yarn[0]?.draft.args).toEqual(["dev"]);

  const declared = suggestLaunchProfiles(report(["package.json"], {
    "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { serve: "vite preview" } }),
  }));
  expect(declared.map((item) => item.command)).toEqual(["pnpm run serve"]);

  const noScript = suggestLaunchProfiles(report(["package.json"], {
    "package.json": JSON.stringify({ name: "empty" }),
  }));
  expect(noScript).toEqual([]);
  expect(launchSetupNote(report(["package.json"], { "package.json": "{}" }), 0)).toMatch(/not enough/);
});

test("make offers only dev, dev-up, and start, and warns that the process group is not the whole tree", () => {
  const withTargets = suggestLaunchProfiles(report(["Makefile"], {
    Makefile: "dev:\n\techo SECRET_RECIPE\ndev-up:\n\ttrue\nstart:\n\ttrue\ntest:\n\ttrue\nbuild:\n\ttrue\n",
  }));
  expect(withTargets.map((item) => item.command)).toEqual(["make dev", "make dev-up", "make start"]);
  expect(withTargets.every((item) => item.warning === MAKE_STOP_WARNING)).toBe(true);
  expect(MAKE_STOP_WARNING).toMatch(/leave that group/);
  expect(MAKE_STOP_WARNING).not.toMatch(/will stop every/i);
  expect(JSON.stringify(withTargets)).not.toContain("SECRET_RECIPE");
  const draft = { ...withTargets[0]!.draft, id: "p0123456789abcdef" };
  const gate = evaluateLaunch(ROOT, "make:dev", draft);
  expect(gate.state).toBe("ready");
  if (gate.state !== "ready") return;
  expect(gate.profile.launch).toEqual({ kind: "local-process", command: { executable: "make", args: ["dev"] } });
  expect(gate.profile.stop).toMatchObject({ kind: "signal", processGroup: true, killAfterGrace: false });

  const without = report(["Makefile"], { Makefile: "test:\n\ttrue\nbuild:\n\ttrue\n" });
  expect(suggestLaunchProfiles(without)).toEqual([]);
  expect(launchSetupNote(without, 0)).toMatch(/Makefile/);
});

test("go, cargo, artisan, and a composer manifest without a launch script stay manual", () => {
  const discovery = report(["go.mod", "Cargo.toml", "artisan", "composer.json", "pyproject.toml"], {
    "go.mod": "module example.com/app\n",
    "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }),
    "pyproject.toml": "[project]\nname = 'app'\n",
  });
  expect(discovery.launch.map((hint) => hint.command)).toContain("go run .");
  expect(discovery.launch.map((hint) => hint.command)).toContain("php artisan serve");
  expect(suggestLaunchProfiles(discovery)).toEqual([]);
  expect(launchSetupNote(discovery, 0)).toMatch(/not enough/);
});

test("a declared composer script is argv, and its body is not copied", () => {
  const suggestions = suggestLaunchProfiles(report(["composer.json"], {
    "composer.json": JSON.stringify({ scripts: { dev: "echo SECRET_COMPOSER", test: "phpunit" } }),
  }));
  expect(suggestions.map((item) => item.command)).toEqual(["composer run dev"]);
  expect(suggestions[0]?.draft.args).toEqual(["run", "dev"]);
  expect(JSON.stringify(suggestions)).not.toContain("SECRET_COMPOSER");
});

test("an empty folder can be skipped, and a manual draft is not a shell command", () => {
  const discovery = report([]);
  expect(suggestLaunchProfiles(discovery)).toEqual([]);
  expect(launchSetupNote(discovery, 0)).toMatch(/No launch configuration/);
  const skipped = evaluateLaunch(ROOT, "skip", manualLaunchDraft(ROOT));
  expect(skipped).toEqual({ state: "skip", summary: null, profile: null });
  const manual = evaluateLaunch(ROOT, "manual", { ...manualLaunchDraft(ROOT), id: "p0123456789abcdef", executable: "bun", args: ["run", "dev"] });
  expect(manual.state).toBe("ready");
  const shell = evaluateLaunch(ROOT, "manual", {
    ...manualLaunchDraft(ROOT),
    id: "p0123456789abcdef",
    executable: "bash",
    args: ["-c", "echo hi"],
  });
  expect(shell.state).toBe("invalid");
});

test("editing a suggestion keeps its id, and traversal or an external URL is rejected", () => {
  const suggestion = suggestLaunchProfiles(report(["package.json"], {
    "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
  }))[0]!;
  const id = createLaunchProfileId();
  expect(id).toMatch(/^p[0-9a-f]{16}$/);
  const edited = { ...suggestion.draft, id, name: "App dev", args: ["run", "dev"] };
  const first = evaluateLaunch(ROOT, suggestion.id, edited);
  const second = evaluateLaunch(ROOT, suggestion.id, edited);
  expect(first.state).toBe("ready");
  expect(second.state).toBe("ready");
  if (first.state !== "ready" || second.state !== "ready") return;
  expect(first.profile.id).toBe(id);
  expect(second.profile.id).toBe(id);
  expect(formatLaunchSummary(edited)).toContain("npm run dev");

  const escaped = evaluateLaunch(ROOT, "manual", { ...edited, cwd: "/work/app/../../etc" });
  expect(escaped.state).toBe("invalid");
  if (escaped.state === "invalid") expect(escaped.error).toMatch(/\.\./);

  const outside = evaluateLaunch(ROOT, "manual", { ...edited, cwd: "/etc" });
  expect(outside.state).toBe("invalid");

  const remote = evaluateLaunch(ROOT, "manual", { ...edited, websiteUrl: "https://example.com/" });
  expect(remote.state).toBe("invalid");

  const composeEscape = evaluateLaunch(ROOT, "manual", {
    ...edited,
    kind: "docker-compose",
    composeFile: "../compose.yaml",
    projectName: defaultComposeProjectName(ROOT),
  });
  expect(composeEscape.state).toBe("invalid");
});

test("a lost create that already stored the profile is not a second profile", () => {
  expect(profileCreateIsDuplicate("profile p0123456789abcdef already exists")).toBe(true);
  expect(profileCreateIsDuplicate("compose file does not exist")).toBe(false);
  expect(profileSaveFailureMessage("cwd escapes the project directory")).toContain("were kept");
  expect(profileSaveFailureMessage("cwd escapes the project directory")).toContain("Nothing was started");
  expect(profileSaveFailureMessage("x")).not.toMatch(/^Start/m);
});
