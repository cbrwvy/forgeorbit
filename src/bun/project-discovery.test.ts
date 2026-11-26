import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverProject } from "./project-discovery.ts";

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`);
}

test("discovery reads docs, compose, and make without running them or opening secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-scan-"));
  mkdirSync(path.join(dir, "docs"));
  writeFileSync(path.join(dir, "docs", "IDEA.md"), "# Idea title\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    dependencies: { react: "19.0.0" },
    scripts: { dev: "echo SECRET_SCRIPT_BODY", test: "vitest" },
  }));
  writeFileSync(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: nginx\n");
  writeFileSync(path.join(dir, "Makefile"), "dev:\n\ttouch fo002-should-not-run\n");
  writeFileSync(path.join(dir, ".env"), "SUPER_SECRET_TOKEN=nope\n");
  await git(["init", "-b", "orbit"], dir);
  await git(["add", "docs", "package.json", "compose.yaml", "Makefile"], dir);
  await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], dir);

  const result = await discoverProject({ path: dir });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.report.git.present).toBe(true);
  expect(result.report.git.branch).toBe("orbit");
  expect(result.report.documentation.state).toBe("idea-only");
  expect(result.report.documentation.idea?.path).toBe("docs/IDEA.md");
  expect(result.report.documentation.prd).toBeNull();
  expect(result.report.stacks).toContain("react");
  expect(result.report.manifests.composePath).toBe("compose.yaml");
  expect(result.report.composeServices).toEqual(["web"]);
  expect(result.report.makefileTargets).toEqual(["dev"]);
  expect(result.report.secretsNoted).toContain(".env");
  const encoded = JSON.stringify(result.report);
  expect(encoded).not.toContain("SECRET_SCRIPT_BODY");
  expect(encoded).not.toContain("SUPER_SECRET_TOKEN");
  expect(await Bun.file(path.join(dir, "fo002-should-not-run")).exists()).toBe(false);
});

test("a directory with neither doc and no git is reported honestly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-empty-"));
  const result = await discoverProject({ path: dir });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.report.git.present).toBe(false);
  expect(result.report.documentation.state).toBe("none");
  expect(result.report.empty).toBe(true);
  expect(result.report.willCreateDirectory).toBe(false);
});

test("alternate doc paths are offered and a link outside the project is not read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-alt-"));
  const outside = mkdtempSync(path.join(tmpdir(), "fo002-out-"));
  writeFileSync(path.join(outside, "secret.md"), "SUPER_SECRET_TOKEN outside\n");
  mkdirSync(path.join(dir, "docs"));
  mkdirSync(path.join(dir, "documentation"));
  symlinkSync(path.join(outside, "secret.md"), path.join(dir, "docs", "IDEA.md"));
  writeFileSync(path.join(dir, "IDEA.md"), "# Real idea\n");
  writeFileSync(path.join(dir, "documentation", "PRD.md"), "# Real prd\n");

  const result = await discoverProject({ path: dir });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.report.documentation.idea).toBeNull();
  expect(result.report.documentation.alternatives.map((hit) => hit.path)).toContain("IDEA.md");
  expect(result.report.documentation.alternatives.map((hit) => hit.path)).toContain("documentation/PRD.md");
  expect(result.report.warnings.some((warning) => warning.includes("docs/IDEA.md"))).toBe(true);
  expect(JSON.stringify(result.report)).not.toContain("SUPER_SECRET_TOKEN");
});

test("planning a new folder does not create it and still notices the parent git repo", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "fo002-parent-"));
  await git(["init", "-b", "main"], parent);
  const planned = path.join(realpathSync(parent), "fresh");
  const result = await discoverProject({ path: parent, folderName: "fresh" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.report.willCreateDirectory).toBe(true);
  expect(result.report.path).toBe(planned);
  expect(result.report.git.present).toBe(true);
  expect(await Bun.file(planned).exists()).toBe(false);
});

test("discovery rejects a relative path and a missing directory", async () => {
  expect((await discoverProject({ path: "relative" })).ok).toBe(false);
  const missing = await discoverProject({ path: path.join(tmpdir(), "fo002-missing-nope") });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.status).toBe(404);
});
