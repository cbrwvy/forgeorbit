import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo002-register-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4644";

let registerProject: typeof import("./project-register.ts").registerProject;
let projects: typeof import("./db.ts").projects;
let token = "";
let server: { stop: () => void };

beforeAll(async () => {
  ({ registerProject } = await import("./project-register.ts"));
  ({ projects } = await import("./db.ts"));
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
});

afterAll(() => {
  server?.stop?.();
});

test("import registers a folder and does not change its files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-import-"));
  const marker = path.join(dir, "docs");
  mkdirSync(marker);
  const idea = path.join(marker, "IDEA.md");
  writeFileSync(idea, "# Keep me\n");
  const result = registerProject({ path: dir, name: "Imported", rejectDuplicate: true });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.name).toBe("Imported");
  expect(readFileSync(idea, "utf8")).toBe("# Keep me\n");
});

test("a second registration of the same directory, including through a symlink, is refused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-dup-"));
  const first = registerProject({ path: dir, name: "Original", rejectDuplicate: true });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  projects.setBranchConfig(first.project.path, {
    includeSlug: false,
    rules: { task: { prefix: "features/" }, bug: { prefix: "hotfix/" }, spike: { prefix: "poc/" } },
  });
  const addedAt = projects.get(first.project.path)?.addedAt;
  const again = registerProject({ path: dir, name: "Renamed", rejectDuplicate: true });
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.status).toBe(409);
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  const viaLink = registerProject({ path: link, name: "Link", rejectDuplicate: true });
  expect(viaLink.ok).toBe(false);
  if (!viaLink.ok) expect(viaLink.error).toContain("Original");
  const stored = projects.get(first.project.path);
  expect(stored?.name).toBe("Original");
  expect(stored?.addedAt).toBe(addedAt);
  expect(stored?.branchConfig?.rules.task.prefix).toBe("features/");
});

test("creating a folder only mkdirs that leaf and leaves the parent untouched", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "fo002-create-"));
  writeFileSync(path.join(parent, "keep.txt"), "stay\n");
  const dest = path.join(parent, "orbit");
  const result = registerProject({
    path: dest,
    name: "Orbit",
    rejectDuplicate: true,
    createDirectory: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project.path).toBe(realpathSync(dest));
  expect(readFileSync(path.join(parent, "keep.txt"), "utf8")).toBe("stay\n");
  const occupied = path.join(parent, "taken");
  mkdirSync(occupied);
  writeFileSync(path.join(occupied, "README.md"), "here\n");
  const blocked = registerProject({
    path: occupied,
    name: "Taken",
    rejectDuplicate: true,
    createDirectory: true,
  });
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.status).toBe(409);
  expect(readFileSync(path.join(occupied, "README.md"), "utf8")).toBe("here\n");
});

test("a legacy add stays an idempotent upsert and does not create a missing directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-legacy-"));
  const first = registerProject({ path: dir, name: "First" });
  expect(first.ok).toBe(true);
  const second = registerProject({ path: dir, name: "Second" });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.project.name).toBe("First");
  const missing = path.join(dir, "nope");
  const created = registerProject({ path: missing, name: "Nope" });
  expect(created.ok).toBe(false);
  if (!created.ok) expect(created.status).toBe(404);
});

test("the discover and register routes are the ones the wizard calls", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo002-http-"));
  writeFileSync(path.join(dir, "Makefile"), "test:\n\techo hi\n");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const denied = await fetch("http://127.0.0.1:4644/projects/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  expect(denied.status).toBe(401);
  const discovered = await fetch("http://127.0.0.1:4644/projects/discover", {
    method: "POST",
    headers,
    body: JSON.stringify({ path: dir }),
  });
  expect(discovered.status).toBe(200);
  const report = await discovered.json() as { makefileTargets: string[]; duplicate: unknown };
  expect(report.makefileTargets).toEqual(["test"]);
  expect(report.duplicate).toBeNull();
  const created = await fetch("http://127.0.0.1:4644/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({ path: dir, name: "HTTP", rejectDuplicate: true }),
  });
  expect(created.status).toBe(200);
  const duplicate = await fetch("http://127.0.0.1:4644/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({ path: dir, name: "HTTP again", rejectDuplicate: true }),
  });
  expect(duplicate.status).toBe(409);
});
