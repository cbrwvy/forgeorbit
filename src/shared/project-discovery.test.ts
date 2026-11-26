import { expect, test } from "bun:test";
import {
  analyzeProject,
  composeServiceNames,
  defaultDocPaths,
  formatDocumentation,
  formatGit,
  formatStacks,
  makefileTargets,
  type ScanFacts,
} from "./project-discovery.ts";

function facts(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    projectPath: "/work/app",
    willCreateDirectory: false,
    empty: false,
    files: new Set<string>(),
    inodes: new Map<string, string>(),
    rootEntries: [],
    texts: {},
    git: { present: false, branch: null, toplevel: null },
    secretsNoted: [],
    warnings: [],
    ...overrides,
  };
}

test("makefile targets ignore assignments, comments, and dot targets", () => {
  const targets = makefileTargets([
    "# comment: nope",
    "FOO := bar",
    "BAR ?= baz",
    ".PHONY: test",
    "dev: build",
    "\techo secret-recipe",
    "test:",
    "build:",
  ].join("\n"));
  expect(targets).toEqual(["dev", "test", "build"]);
  expect(targets.join(" ")).not.toContain("secret-recipe");
});

test("compose service names stay inside the services block", () => {
  const names = composeServiceNames([
    "name: demo",
    "services:",
    "  web:",
    "    image: nginx",
    "  worker:",
    "volumes:",
    "  data:",
  ].join("\n"));
  expect(names).toEqual(["web", "worker"]);
});

test("both standard docs are recognized and alternatives of the same file are collapsed", () => {
  const report = analyzeProject(facts({
    files: new Set(["docs/IDEA.md", "docs/idea.md", "docs/PRD.md"]),
    inodes: new Map([
      ["docs/IDEA.md", "1:1"],
      ["docs/idea.md", "1:1"],
      ["docs/PRD.md", "1:2"],
    ]),
    texts: {
      "docs/IDEA.md": "# Orbit idea\n",
      "docs/PRD.md": "# Orbit prd\n",
    },
  }));
  expect(report.documentation.state).toBe("both");
  expect(report.documentation.idea?.standard).toBe(true);
  expect(report.documentation.prd?.path).toBe("docs/PRD.md");
  expect(report.documentation.alternatives).toEqual([]);
  expect(report.titles["docs/IDEA.md"]).toBe("Orbit idea");
  expect(defaultDocPaths(report.documentation)).toEqual({
    ideaPath: "docs/IDEA.md",
    prdPath: "docs/PRD.md",
  });
});

test("a missing document and an alternate path are reported separately", () => {
  const ideaOnly = analyzeProject(facts({ files: new Set(["docs/IDEA.md"]) }));
  expect(ideaOnly.documentation.state).toBe("idea-only");
  expect(ideaOnly.documentation.prd).toBeNull();

  const prdOnly = analyzeProject(facts({ files: new Set(["docs/PRD.md"]) }));
  expect(prdOnly.documentation.state).toBe("prd-only");

  const alternate = analyzeProject(facts({ files: new Set(["IDEA.md", "documentation/PRD.md"]) }));
  expect(alternate.documentation.state).toBe("alternatives");
  expect(alternate.documentation.idea).toBeNull();
  expect(alternate.documentation.alternatives.map((hit) => hit.path)).toEqual(["IDEA.md", "documentation/PRD.md"]);
  expect(defaultDocPaths(alternate.documentation)).toEqual({ ideaPath: "IDEA.md", prdPath: "documentation/PRD.md" });

  const none = analyzeProject(facts());
  expect(none.documentation.state).toBe("none");
  expect(formatDocumentation(none.documentation, { ideaPath: null, prdPath: null })).toBe("IDEA: missing · PRD: missing");
});

test("stack signals come from manifests, not from running them", () => {
  const report = analyzeProject(facts({
    files: new Set([
      "package.json",
      "composer.json",
      "artisan",
      "go.mod",
      "pyproject.toml",
      "Dockerfile",
      "compose.yaml",
      "Makefile",
      "Cargo.toml",
      "App.xcodeproj",
    ]),
    rootEntries: ["App.xcodeproj"],
    texts: {
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0" },
        scripts: { dev: "echo SECRET_SCRIPT_BODY", test: "vitest" },
      }),
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "pyproject.toml": "[tool.pytest.ini_options]\n",
      "compose.yaml": "services:\n  web:\n",
      Makefile: "dev:\n\ttouch should-not-exist\n",
    },
  }));
  expect(formatStacks(report.stacks)).toBe("Laravel / PHP, Node / React, Go, Python, Rust, macOS application, Docker Compose");
  expect(report.launch.map((hint) => hint.command)).toContain("npm run dev");
  expect(report.launch.map((hint) => hint.command)).toContain("docker compose up");
  expect(report.launch.map((hint) => hint.command)).toContain("make dev");
  expect(report.testTools.map((hint) => hint.command)).toContain("npm run test");
  expect(report.makefileTargets).toEqual(["dev"]);
  expect(report.composeServices).toEqual(["web"]);
  expect(report.packageScripts).toEqual(["dev"]);
  expect(report.packageScripts.join(" ")).not.toContain("SECRET_SCRIPT_BODY");
  const encoded = JSON.stringify(report);
  expect(encoded).not.toContain("SECRET_SCRIPT_BODY");
  expect(encoded).not.toContain("should-not-exist");
});

test("secrets are named and never copied, and a missing git repo is a warning", () => {
  const report = analyzeProject(facts({
    secretsNoted: [".env"],
    warnings: [],
  }));
  expect(report.secretsNoted).toEqual([".env"]);
  expect(report.warnings.some((warning) => warning.includes(".env"))).toBe(true);
  expect(report.git.present).toBe(false);
  expect(formatGit(report.git)).toBe("Not a git repository");
  expect(JSON.stringify(report)).not.toContain("SUPER_SECRET_TOKEN");
});

test("git branch and a nested toplevel are described", () => {
  const report = analyzeProject(facts({
    projectPath: "/work/app/web",
    git: { present: true, branch: "main", toplevel: "/work/app" },
  }));
  expect(report.git.nested).toBe(true);
  expect(formatGit(report.git)).toContain("Branch main");
  expect(formatGit(report.git)).toContain("/work/app");
});
