import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { InfrastructureCore } from "./infrastructure-core.ts";
import { infrastructureHttp } from "./infrastructure-http.ts";

function server() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/alpha', 'Alpha', 1)`);
  db.run(
    `INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES ('00000000-0000-4000-8000-00000000000a', 'One', '', 1, 1)`,
  );
  const core = new InfrastructureCore(db, { now: () => 5 });
  const call = (pathname: string, init?: RequestInit, authorized = true) =>
    infrastructureHttp(new Request(`http://127.0.0.1${pathname}`, init), authorized, { core });
  return { db, call };
}

test("missing bearer is unauthorized before the body is read", async () => {
  const { db, call } = server();
  const response = await call("/infrastructure/resources", { method: "POST", body: "{" }, false);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
  expect(db.query(`SELECT COUNT(*) AS count FROM infrastructure_resources`).get()).toEqual({ count: 0 });
});

test("create, edit, archive, and relations stay on the bearer API", async () => {
  const { db, call } = server();
  const created = await call("/infrastructure/resources", {
    method: "POST",
    body: JSON.stringify({ name: "Edge", resourceType: "cloud", status: "not-verified", costAmount: "3", currency: "EUR" }),
  });
  expect(created.status).toBe(201);
  const resource = await created.json() as { id: string; verification: string; status: string };
  expect(resource.verification).toBe("absent");
  expect(resource.status).toBe("not-verified");

  const online = await call("/infrastructure/resources", {
    method: "POST",
    body: JSON.stringify({ name: "Nope", resourceType: "vps", status: "online" }),
  });
  expect(online.status).toBe(400);

  const secret = await call("/infrastructure/resources", {
    method: "POST",
    body: JSON.stringify({ name: "Nope", resourceType: "vps", token: "abc" }),
  });
  expect(secret.status).toBe(400);

  const edited = await call(`/infrastructure/resources/${resource.id}`, {
    method: "PATCH",
    body: JSON.stringify({ hostname: "edge.fixture.invalid" }),
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ hostname: "edge.fixture.invalid", ipAddress: null });

  const linked = await call(`/infrastructure/resources/${resource.id}/clusters`, {
    method: "POST",
    body: JSON.stringify({ clusterId: "00000000-0000-4000-8000-00000000000a" }),
  });
  expect(linked.status).toBe(201);
  const project = await call(`/infrastructure/resources/${resource.id}/projects`, {
    method: "POST",
    body: JSON.stringify({ projectPath: "/registry/alpha" }),
  });
  expect(project.status).toBe(201);
  const missing = await call(`/infrastructure/resources/${resource.id}/projects`, {
    method: "POST",
    body: JSON.stringify({ projectPath: "/registry/missing" }),
  });
  expect(missing.status).toBe(404);
  const environment = await call("/infrastructure/project-environments", {
    method: "POST",
    body: JSON.stringify({ projectPath: "/registry/alpha", environment: "staging" }),
  });
  expect(environment.status).toBe(201);
  const bound = await call(`/infrastructure/resources/${resource.id}/environment-links`, {
    method: "POST",
    body: JSON.stringify({ projectPath: "/registry/alpha", environment: "staging" }),
  });
  expect(bound.status).toBe(201);

  const removed = await call(
    `/infrastructure/resources/${resource.id}/clusters/00000000-0000-4000-8000-00000000000a`,
    { method: "DELETE" },
  );
  expect(removed.status).toBe(200);
  expect((await removed.json()) as { clusters: unknown[] }).toMatchObject({ clusters: [] });
  const relinked = await call(`/infrastructure/resources/${resource.id}/clusters`, {
    method: "POST",
    body: JSON.stringify({ clusterId: "00000000-0000-4000-8000-00000000000a" }),
  });
  expect(relinked.status).toBe(201);

  const view = await call("/infrastructure/clusters/00000000-0000-4000-8000-00000000000a");
  expect(view.status).toBe(200);
  const body = await view.json() as { resources: { id: string }[]; statusNote: string };
  expect(body.resources.map((item) => item.id)).toEqual([resource.id]);
  expect(body.statusNote).toContain("Not verified");

  const archived = await call(`/infrastructure/resources/${resource.id}/archive`, { method: "POST" });
  expect(archived.status).toBe(200);
  const active = await call("/infrastructure/resources");
  expect(await active.json()).toMatchObject({ resources: [] });
  expect(db.query(`SELECT COUNT(*) AS count FROM environment_profiles`).get()).toEqual({ count: 0 });
  expect((await call("/infrastructure/resources/not-a-uuid")).status).toBe(400);
  expect((await call("/infrastructure/ssh")).status).toBe(404);
});
