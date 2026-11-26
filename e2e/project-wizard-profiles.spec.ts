import { mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-004C. The wizard can save a launch profile through the environment API.
 * Fixtures are temp directories. Nothing here starts Docker, a dev server,
 * or a real agent CLI.
 */

test.describe.configure({ mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function tempDir(name: string): Promise<string> {
  // macOS tmpdir is under /var, a symlink to /private/var. Registration stores
  // the real path, and the sidebar's data-path uses that.
  return realpath(await mkdtemp(path.join(tmpdir(), `fo004c-${name}-`)));
}

async function openWizard(page: Page): Promise<void> {
  await page.getByTestId("workspace-add-project").click();
  await expect(page.getByTestId("project-wizard")).toBeVisible();
}

async function fillProject(
  page: Page,
  fields: { name: string; directory: string; mode?: "import" | "create"; folderName?: string },
): Promise<void> {
  if (fields.mode === "create") await page.getByTestId("wizard-mode-create").click();
  await page.getByTestId("wizard-name").fill(fields.name);
  await page.getByTestId("wizard-directory").fill(fields.directory);
  if (fields.folderName) {
    await page.getByTestId("wizard-placement-new-folder").click();
    await page.getByTestId("wizard-folder-name").fill(fields.folderName);
  }
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
}

async function toLaunch(page: Page): Promise<void> {
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "docs");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "environment");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "launch");
}

function option(page: Page, id: string) {
  return page.locator(`[data-testid="wizard-launch-option"][data-id="${id}"] input`);
}

async function profiles(request: APIRequestContext, backend: E2EBackend, dir: string) {
  const res = await request.get(`${backend.apiBase}/projects/environment?path=${encodeURIComponent(dir)}`, {
    headers: auth(backend),
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as {
    profiles: { profile: { id: string; name: string; launch: { kind: string } }; status: { recordedPhase: string; pid: number | null } }[];
  };
}

async function projectsAt(request: APIRequestContext, backend: E2EBackend, dir: string) {
  const res = await request.get(`${backend.apiBase}/projects`, { headers: auth(backend) });
  expect(res.ok(), await res.text()).toBeTruthy();
  const rows = (await res.json()) as { path: string; name: string }[];
  return rows.filter((row) => row.path === dir);
}

test("suggests compose, package managers, and make targets without running them", async ({ page, freshBackend: backend }) => {
  const compose = await tempDir("compose");
  await writeFile(path.join(compose, "compose.yaml"), "name: external-stack\nservices:\n  web:\n    image: nginx\n");
  await writeFile(path.join(compose, "package.json"), JSON.stringify({ scripts: { dev: "echo SECRET_SHOULD_NOT_RUN" } }));
  await writeFile(path.join(compose, "Makefile"), "dev:\n\ttouch fo004c-should-not-run\n");

  const bunDir = await tempDir("bun");
  await writeFile(path.join(bunDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  await writeFile(path.join(bunDir, "bun.lock"), "");

  const pnpmDir = await tempDir("pnpm");
  await writeFile(path.join(pnpmDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  await writeFile(path.join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const yarnDir = await tempDir("yarn");
  await writeFile(path.join(yarnDir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  await writeFile(path.join(yarnDir, "yarn.lock"), "# yarn\n");

  const npmDir = await tempDir("npm");
  await writeFile(path.join(npmDir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
  await writeFile(path.join(npmDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

  const makeOnly = await tempDir("make-no");
  await writeFile(path.join(makeOnly, "Makefile"), "test:\n\ttouch fo004c-should-not-test\n");

  const empty = await tempDir("empty");
  const goOnly = await tempDir("go");
  await writeFile(path.join(goOnly, "go.mod"), "module example.com/app\n\ngo 1.22\n");

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillProject(page, { name: "Compose Orbit", directory: compose });
  await expect(page.getByTestId("project-wizard")).not.toContainText("SECRET_SHOULD_NOT_RUN");
  await toLaunch(page);
  await expect(page.getByTestId("wizard-launch-note")).toContainText("nothing has been started");
  await expect(option(page, "compose:compose.yaml")).toBeVisible();
  await expect(option(page, "package:dev")).toBeVisible();
  await expect(option(page, "make:dev")).toBeVisible();
  await expect(page.getByTestId("wizard-launch")).not.toContainText("external-stack");
  await page.getByRole("radio", { name: /Skip for now/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "compose:compose.yaml")).toBeChecked();
  await expect(page.getByTestId("wizard-launch-project-name")).toHaveValue(/^fo-[0-9a-f]{8}$/);
  await expect(page.getByTestId("wizard-launch-services")).toHaveValue("web");
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "Bun Orbit", directory: bunDir });
  await toLaunch(page);
  await expect(page.locator('[data-testid="wizard-launch-option"][data-id="package:dev"]')).toContainText("bun run dev");
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "pnpm Orbit", directory: pnpmDir });
  await toLaunch(page);
  await expect(page.locator('[data-testid="wizard-launch-option"][data-id="package:dev"]')).toContainText("pnpm run dev");
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "Yarn Orbit", directory: yarnDir });
  await toLaunch(page);
  await expect(page.locator('[data-testid="wizard-launch-option"][data-id="package:dev"]')).toContainText("yarn dev");
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "npm Orbit", directory: npmDir });
  await toLaunch(page);
  await expect(page.locator('[data-testid="wizard-launch-option"][data-id="package:start"]')).toContainText("npm run start");
  await expect(page.locator('[data-testid="wizard-launch-option"][data-id="package:dev"]')).toHaveCount(0);
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "Make Orbit", directory: makeOnly });
  await toLaunch(page);
  await expect(page.getByTestId("wizard-launch-option")).toHaveCount(0);
  await expect(page.getByTestId("wizard-launch-note")).toContainText("Makefile");
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "Empty Orbit", directory: empty });
  await toLaunch(page);
  await expect(page.getByTestId("wizard-launch-note")).toContainText("No launch configuration");
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillProject(page, { name: "Go Orbit", directory: goOnly });
  await toLaunch(page);
  await expect(page.getByTestId("wizard-launch")).not.toContainText("go run");
  await expect(page.getByTestId("wizard-launch-note")).toContainText("not enough");
  await page.getByTestId("wizard-cancel").click();

  expect(await readFile(path.join(compose, "package.json"), "utf8")).toContain("SECRET_SHOULD_NOT_RUN");
});

test("saves an edited profile for an imported project and does not start it", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("save-bun");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "echo NO_RUN" } }));
  await writeFile(path.join(dir, "bun.lock"), "");
  const starts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/projects/environment/") && req.url().includes("/start")) {
      starts.push(req.url());
    }
  });

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillProject(page, { name: "Saved Bun", directory: dir });
  await toLaunch(page);
  await option(page, "package:dev").check();
  await page.getByTestId("wizard-launch-name").fill("App dev");
  await page.getByTestId("wizard-launch-executable").fill("/usr/bin/true");
  await page.getByTestId("wizard-launch-args").fill("ready");
  await expect(page.getByTestId("wizard-launch-argv-executable")).toHaveText("/usr/bin/true");
  await expect(page.getByTestId("wizard-launch-argv-arg")).toHaveText("ready");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-review-section-environment")).toBeVisible();
  await expect(page.getByTestId("wizard-review-environment")).toContainText("/usr/bin/true");
  await expect(page.getByTestId("wizard-review-environment")).toContainText("ready");
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Save the launch profile" })).toBeVisible();
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Do not start the project" })).toBeVisible();
  await expect(page.getByTestId("wizard-change").filter({ hasText: /^Start/ })).toHaveCount(0);
  await page.getByTestId("wizard-submit").click();

  await expect(page.getByTestId("project-header-name")).toHaveText("Saved Bun");
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-phase")).toHaveText("Stopped");
  await expect(page.getByTestId("environment-page")).toContainText("App dev");
  await expect(page.getByTestId("environment-services")).toContainText("true");
  await expect(page.getByTestId("environment-start")).toBeVisible();
  await expect(page.getByTestId("environment-stop")).toHaveCount(0);
  expect(starts).toEqual([]);

  const saved = await profiles(request, backend, dir);
  expect(saved.profiles).toHaveLength(1);
  expect(saved.profiles[0]?.status.recordedPhase).toBe("stopped");
  expect(saved.profiles[0]?.status.pid).toBeNull();
  expect(saved.profiles[0]?.profile.name).toBe("App dev");
  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-phase")).toHaveText("Stopped");
  await expect(page.getByTestId("environment-page")).toContainText("App dev");
  expect(starts).toEqual([]);
});

test("creates a new folder and a manual profile without starting it", async ({ page, request, freshBackend: backend }) => {
  const parent = await tempDir("create");
  const folder = "fresh-orbit";
  const dir = path.join(parent, folder);

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillProject(page, { mode: "create", name: "Fresh Orbit", directory: parent, folderName: folder });
  await toLaunch(page);
  await expect(page.getByTestId("wizard-launch-note")).toContainText("No launch configuration");
  await page.getByTestId("wizard-launch-manual").locator("input").check();
  await page.getByTestId("wizard-launch-name").fill("Manual");
  await page.getByTestId("wizard-launch-executable").fill("/usr/bin/true");
  await page.getByTestId("wizard-launch-args").fill("ready");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Create the folder" })).toBeVisible();
  await expect(page.getByTestId("wizard-review-environment")).toContainText("Manual");
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Fresh Orbit");
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-phase")).toHaveText("Stopped");
  const saved = await profiles(request, backend, dir);
  expect(saved.profiles).toHaveLength(1);
  expect(saved.profiles[0]?.status.recordedPhase).toBe("stopped");
});

test("skipping the environment step leaves the project without a profile", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("skip");
  await writeFile(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: nginx\n");
  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillProject(page, { name: "Skipped Orbit", directory: dir });
  await toLaunch(page);
  await expect(page.getByRole("radio", { name: /Skip for now/ })).toBeChecked();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-review-environment")).toHaveText("Not configured");
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Skipped Orbit");
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-phase")).toHaveText("Not configured");
  expect((await profiles(request, backend, dir)).profiles).toHaveLength(0);
});

test("a failed profile save keeps the project and a retry does not duplicate it", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("retry");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  await writeFile(path.join(dir, "bun.lock"), "");
  const ids: string[] = [];
  let dropped = false;
  await page.route("**/projects/environment**", async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (req.method() === "POST" && pathname === "/projects/environment" && !dropped) {
      dropped = true;
      const body = req.postDataJSON() as { profile: { id: string } };
      ids.push(body.profile.id);
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "response lost" }),
      });
      return;
    }
    if (req.method() === "POST" && pathname === "/projects/environment") {
      const body = req.postDataJSON() as { profile: { id: string } };
      ids.push(body.profile.id);
    }
    await route.continue();
  });

  try {
    await gotoApp(page, backend.bootBase);
    await openWizard(page);
    await fillProject(page, { name: "Retry Orbit", directory: dir });
    await toLaunch(page);
    await option(page, "package:dev").check();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByTestId("wizard-error")).toContainText("response lost");
    await expect(page.getByTestId("wizard-error")).toContainText("Nothing was started");
    await expect(page.getByTestId("wizard-cancel")).toHaveText("Finish without the launch profile");
    expect(await projectsAt(request, backend, dir)).toHaveLength(1);
    expect((await profiles(request, backend, dir)).profiles).toHaveLength(1);

    await page.getByTestId("wizard-submit").click();
    await expect(page.getByTestId("project-header-name")).toHaveText("Retry Orbit");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect((await profiles(request, backend, dir)).profiles).toHaveLength(1);
    expect((await profiles(request, backend, dir)).profiles[0]?.profile.id).toBe(ids[0]);
    await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
    await expect(page.getByTestId("environment-phase")).toHaveText("Stopped");
  } finally {
    await page.unroute("**/projects/environment**");
  }
});

test("a path with .. cannot leave the launch step", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("dotdot");
  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillProject(page, { name: "Dotdot Orbit", directory: dir });
  await toLaunch(page);
  await page.getByTestId("wizard-launch-manual").locator("input").check();
  await page.getByTestId("wizard-launch-executable").fill("/usr/bin/true");
  await page.getByTestId("wizard-launch-cwd").fill(`${dir}/../outside`);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "launch");
  await expect(page.getByTestId("wizard-error")).toContainText("..");
  expect(await projectsAt(request, backend, dir)).toHaveLength(0);
});

test("a symlink cwd is rejected after registration and the project stays", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("symlink");
  const outside = await tempDir("outside");
  await symlink(outside, path.join(dir, "escape-link"));
  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillProject(page, { name: "Symlink Orbit", directory: dir });
  await toLaunch(page);
  await page.getByTestId("wizard-launch-manual").locator("input").check();
  await page.getByTestId("wizard-launch-executable").fill("/usr/bin/true");
  await page.getByTestId("wizard-launch-cwd").fill(path.join(dir, "escape-link"));
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("wizard-error")).toContainText("escapes");
  await expect(page.getByTestId("wizard-error")).toContainText("Nothing was started");
  expect(await projectsAt(request, backend, dir)).toHaveLength(1);
  expect((await profiles(request, backend, dir)).profiles).toHaveLength(0);
  await page.getByTestId("wizard-cancel").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Symlink Orbit");
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
  await expect(page.getByTestId("environment-phase")).toHaveText("Not configured");
  expect(await projectsAt(request, backend, dir)).toHaveLength(1);
});

test.describe("documents plus a launch profile", () => {
  test.use({
    backendEnv: {
      AGETOR_CODEX_DRIVER: "fake",
      AGETOR_CODEX_BIN: "/bin/echo",
      AGETOR_FAKE_INTERVIEW_DELAY_MS: "300",
    },
  });

  test("keeps documents when the profile save fails, then retries without rewriting them", async ({ page, request, freshBackend: backend }) => {
    const enable = await request.patch(`${backend.apiBase}/harnesses/codex`, {
      headers: auth(backend),
      data: { enabled: true },
    });
    expect(enable.ok(), await enable.text()).toBeTruthy();
    const dir = await tempDir("docs-profile");
    await writeFile(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: nginx\n");
    const hidden = path.join(dir, "compose.yaml.hidden");

    await gotoApp(page, backend.bootBase);
    await openWizard(page);
    await fillProject(page, { name: "Docs Orbit", directory: dir });
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-open-interview").click();
    await page.getByTestId("interview-harness").selectOption("codex");
    await page.getByTestId("interview-consent").check();
    await page.getByTestId("interview-start").click();
    await expect(page.getByTestId("interview-message").last()).toContainText("What do you want to build");
    await page.getByTestId("interview-finish").click();
    await expect(page.getByTestId("interview-preview-idea")).toBeVisible();
    await page.getByTestId("interview-accept-toggle").click();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "environment");
    await page.getByTestId("wizard-next").click();
    await option(page, "compose:compose.yaml").check();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-change").filter({ hasText: "Create docs/IDEA.md" })).toBeVisible();
    await expect(page.getByTestId("wizard-change").filter({ hasText: "Save the launch profile" })).toBeVisible();

    await rename(path.join(dir, "compose.yaml"), hidden);
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByTestId("wizard-doc-result").filter({ hasText: "Created docs/IDEA.md" })).toBeVisible();
    await expect(page.getByTestId("wizard-error")).toContainText("compose file does not exist");
    await expect(page.getByTestId("wizard-error")).toContainText("Nothing was started");
    const idea = path.join(dir, "docs", "IDEA.md");
    const before = await stat(idea);
    const ideaText = await readFile(idea, "utf8");
    expect(await projectsAt(request, backend, dir)).toHaveLength(1);
    expect((await profiles(request, backend, dir)).profiles).toHaveLength(0);

    await rename(hidden, path.join(dir, "compose.yaml"));
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByTestId("project-header-name")).toHaveText("Docs Orbit");
    const after = await stat(idea);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(idea, "utf8")).toBe(ideaText);
    expect(await readFile(path.join(dir, "docs", "PRD.md"), "utf8")).toContain("PRD");
    const saved = await profiles(request, backend, dir);
    expect(saved.profiles).toHaveLength(1);
    expect(saved.profiles[0]?.profile.launch.kind).toBe("docker-compose");
    expect(saved.profiles[0]?.status.recordedPhase).toBe("stopped");
    await page.getByTestId("project-more").click(); await page.getByTestId("project-page-environment").click();
    await expect(page.getByTestId("environment-phase")).toHaveText("Stopped");
    await expect(page.getByTestId("environment-services")).toContainText("web");
  });
});

test("the environment step fits a narrow window in light and dark", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("narrow");
  await writeFile(path.join(dir, "Makefile"), "dev:\n\ttrue\n");
  await gotoApp(page, backend.bootBase);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  try {
    for (const theme of ["Light", "Dark"] as const) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog");
      await settings.getByRole("button", { name: theme, exact: true }).click();
      await settings.getByRole("button", { name: "Close", exact: true }).click();
      await page.setViewportSize({ width: 420, height: 680 });
      await openWizard(page);
      await fillProject(page, { name: `Narrow ${theme}`, directory: dir });
      await toLaunch(page);
      await option(page, "make:dev").check();
      await expect(page.getByTestId("wizard-launch-warning")).toBeVisible();
      await expect(page.getByTestId("wizard-next")).toBeVisible();
      const overflow = await page.getByTestId("wizard-body").evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const filter = await page.getByTestId("project-wizard").evaluate((el) => {
        const panel = el.closest(".glass-elevated");
        return panel ? getComputedStyle(panel).backdropFilter : "missing";
      });
      expect(filter === "none" || filter === "").toBe(true);
      const tone = await page.getByTestId("project-wizard").evaluate((el) => {
        const match = getComputedStyle(el).color.match(/rgba?\((\d+)/);
        return match ? Number(match[1]) : -1;
      });
      if (theme === "Light") expect(tone).toBeLessThan(80);
      else expect(tone).toBeGreaterThan(180);
      await page.getByTestId("wizard-cancel").click();
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  } finally {
    await request.put(`${backend.apiBase}/preferences/theme`, {
      headers: auth(backend),
      data: { value: "auto" },
    });
  }
});
