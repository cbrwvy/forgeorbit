import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = mkdtempSync(path.join(tmpdir(), "fo014b-catalog-api-"));
process.env.AGETOR_DATA_DIR = isolated;
process.env.AGETOR_API_PORT = "47116";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo014b-cli";
}

let server: ReturnType<typeof import("../server.ts")["startApiServer"]>;
let token: string;
let db: typeof import("../db.ts");
let spawn: ReturnType<typeof spyOn>;
let spawnSync: ReturnType<typeof spyOn>;
let fetchGuard: ReturnType<typeof spyOn>;
let externalCalls = 0;
let cliCalls = 0;
const base = "http://127.0.0.1:47116";
const root = mkdtempSync(path.join(tmpdir(), "fo014b-projects-"));
const projectA = path.join(root, "alpha");

let workerId = "";
let legacyWorkerId = "";

beforeAll(async () => {
  spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    cliCalls += 1;
    throw new Error("Unexpected process spawn");
  });
  spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    cliCalls += 1;
    throw new Error("Unexpected process spawnSync");
  });

  const fetchOriginal = globalThis.fetch;
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/`)) {
      externalCalls += 1;
      throw new Error(`Unexpected external request: ${url}`);
    }
    return fetchOriginal(input, init);
  }) as typeof fetch);

  mkdirSync(projectA, { recursive: true });
  db = await import("../db.ts");
  const backend = await import("../server.ts");
  token = backend.API_TOKEN;
  server = backend.startApiServer();

  // Create an employee to work with
  const createRes = await call("POST", "/employees", {
    name: "Ada Lovelace",
    jobTitle: "Senior Architect",
    roleCategory: "engineering",
  });
  workerId = (createRes.body as any).id;

  const legacyRes = await call("POST", "/employees", {
    name: "Legacy Worker",
    jobTitle: "Junior Dev",
    roleCategory: "engineering",
  });
  legacyWorkerId = (legacyRes.body as any).id;
});

afterAll(() => {
  server?.stop(true);
  spawn?.mockRestore();
  spawnSync?.mockRestore();
  fetchGuard?.mockRestore();
  rmSync(root, { recursive: true, force: true });
  rmSync(isolated, { recursive: true, force: true });
});

async function call(
  method: string,
  route: string,
  value?: unknown,
  authorization: string | null = `Bearer ${token}`,
) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(value !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: value !== undefined ? JSON.stringify(value) : undefined,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

test("rejects unauthenticated requests with 401 Unauthorized", async () => {
  const noAuth = await call("GET", "/catalog/roles", undefined, null);
  expect(noAuth.status).toBe(401);

  const wrongAuth = await call("GET", "/catalog/roles", undefined, "Bearer wrong-token");
  expect(wrongAuth.status).toBe(401);

  const empNoAuth = await call("GET", `/employees/${workerId}/professional-profile`, undefined, null);
  expect(empNoAuth.status).toBe(401);
});

test("GET /catalog/roles returns complete 283 role library with divisions", async () => {
  const res = await call("GET", "/catalog/roles");
  expect(res.status).toBe(200);
  const data = res.body as any;
  expect(data.roles.length).toBe(283);
  expect(data.allTotal).toBe(283);
  expect(data.divisions.length).toBe(18);
});

test("GET /catalog/roles?division=engineering filters to exactly 66 engineering roles", async () => {
  const res = await call("GET", "/catalog/roles?division=engineering");
  expect(res.status).toBe(200);
  const data = res.body as any;
  expect(data.roles.length).toBe(66);
  expect(data.roles.every((r: any) => r.division === "engineering")).toBe(true);
});

test("GET /catalog/roles?search=architect finds architect roles", async () => {
  const res = await call("GET", "/catalog/roles?search=architect");
  expect(res.status).toBe(200);
  const data = res.body as any;
  expect(data.roles.length).toBeGreaterThan(0);
  expect(data.roles.some((r: any) => r.slug === "engineering-backend-architect")).toBe(true);
});

test("GET /catalog/roles/:slug returns full role template and markdown", async () => {
  const res = await call("GET", "/catalog/roles/engineering-backend-architect");
  expect(res.status).toBe(200);
  const data = res.body as any;
  expect(data.role.slug).toBe("engineering-backend-architect");
  expect(data.role.name).toBe("Backend Architect");
  expect(data.role.originalMarkdown).toContain("Backend Architect");
  expect(data.role.sha256).toBe("45d94306c8f0f4c51efb76066008297fa4e87ce5b69f509cfede224084b74dfb");
});

test("GET /catalog/roles/:slug handles nested game-development roles", async () => {
  const res = await call("GET", "/catalog/roles/unreal-multiplayer-architect");
  expect(res.status).toBe(200);
  const data = res.body as any;
  expect(data.role.division).toBe("game-development");
  expect(data.role.sourcePath).toBe("game-development/unreal-engine/unreal-multiplayer-architect.md");
});

test("GET /catalog/roles/:slug rejects invalid slugs and path traversal", async () => {
  const traversal = await call("GET", "/catalog/roles/..%2f..%2fsecret");
  expect(traversal.status).toBe(400);

  const nonExistent = await call("GET", "/catalog/roles/nonexistent-role-xyz");
  expect(nonExistent.status).toBe(404);
});

test("GET /catalog/divisions and /catalog/manifest return metadata", async () => {
  const divRes = await call("GET", "/catalog/divisions");
  expect(divRes.status).toBe(200);
  expect((divRes.body as any).divisions.length).toBe(18);

  const manRes = await call("GET", "/catalog/manifest");
  expect(manRes.status).toBe(200);
  expect((manRes.body as any).manifest.license).toBe("MIT");
  expect((manRes.body as any).manifest.totalProfiles).toBe(283);
});

test("GET /employees/:id/professional-profile returns null for legacy employee without profile", async () => {
  const res = await call("GET", `/employees/${legacyWorkerId}/professional-profile`);
  expect(res.status).toBe(200);
  expect((res.body as any).profile).toBeNull();
});

test("POST /employees/:id/professional-profile assigns a role and creates revision 1", async () => {
  const res = await call("POST", `/employees/${workerId}/professional-profile`, {
    catalogRoleSlug: "engineering-backend-architect",
  });
  expect(res.status).toBe(200);
  const profile = (res.body as any).profile;
  expect(profile.catalogRoleSlug).toBe("engineering-backend-architect");
  expect(profile.currentRevision).toBe(1);
  expect(profile.activePrompt.revision).toBe(1);
  expect(profile.activePrompt.ownerProvenance).toBe("owner");
});

test("PUT /employees/:id/professional-profile updates prompt and increments revision", async () => {
  const res = await call("PUT", `/employees/${workerId}/professional-profile`, {
    promptMarkdown: "# Customized Instructions\nAlways write tests first.",
    expectedRevision: 1,
    changeNote: "Add TDD requirement",
  });
  expect(res.status).toBe(200);
  const profile = (res.body as any).profile;
  expect(profile.currentRevision).toBe(2);
  expect(profile.activePrompt.revision).toBe(2);
  expect(profile.activePrompt.promptMarkdown).toBe("# Customized Instructions\nAlways write tests first.");
});

test("PUT /employees/:id/professional-profile rejects stale revision with 409", async () => {
  const staleRes = await call("PUT", `/employees/${workerId}/professional-profile`, {
    promptMarkdown: "Stale edit",
    expectedRevision: 1, // Current is 2
  });
  expect(staleRes.status).toBe(409);
});

test("POST /employees/:id/professional-profile/reset restores original template as revision 3", async () => {
  const res = await call("POST", `/employees/${workerId}/professional-profile/reset`, {
    expectedRevision: 2,
  });
  expect(res.status).toBe(200);
  const profile = (res.body as any).profile;
  expect(profile.currentRevision).toBe(3);
  expect(profile.activePrompt.changeNote).toBe("Restored from original catalog template");
  expect(profile.activePrompt.promptMarkdown).toContain("Backend Architect");
});

test("GET /employees/:id/professional-profile/revisions returns full revision history", async () => {
  const res = await call("GET", `/employees/${workerId}/professional-profile/revisions`);
  expect(res.status).toBe(200);
  const revs = (res.body as any).revisions;
  expect(revs.length).toBe(3);
  expect(revs.map((r: any) => r.revision)).toEqual([3, 2, 1]);

  const rev2Res = await call("GET", `/employees/${workerId}/professional-profile/revisions/2`);
  expect(rev2Res.status).toBe(200);
  expect((rev2Res.body as any).revision.promptMarkdown).toBe("# Customized Instructions\nAlways write tests first.");
});

test("safety guards: no external network and no CLI process spawns", () => {
  expect(externalCalls).toBe(0);
  expect(cliCalls).toBe(0);
});
