// Headless entrypoint only. Compile separately; never import the native app entrypoint.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getRoleCatalogService } from "../role-catalog.ts";
import { verifyCatalogPackage } from "../catalog-package.ts";
import { catalogHttp } from "../catalog-http.ts";

const deny = () => { throw new Error("FO-PKG01 forbids process spawning and network in the headless probe"); };
Bun.spawn = deny as typeof Bun.spawn;
Bun.spawnSync = deny as typeof Bun.spawnSync;
globalThis.fetch = Object.assign(deny, { preconnect: deny }) as typeof fetch;
assert.equal(process.env.FORGEORBIT_CATALOG_PATH, undefined);
assert.equal(process.env.FORGEORBIT_CATALOG_DIR, undefined);

// Exercise legacy HTTP before ANY catalog access. Default profile-core construction
// must remain safe even with a missing/corrupt optional catalog (fresh singleton).
const { employeeHttp } = await import("../../employee-http.ts");
async function employee(method: string, route: string, body?: unknown) {
  return employeeHttp(new Request(`http://localhost/employees${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), true);
}
const created = await employee("POST", "", { name: "Offline Worker", jobTitle: "Engineer", roleCategory: "engineering" });
assert.equal(created.status, 201);
const worker = await created.json() as { id: string };
for (const route of ["", "/organization", `/${worker.id}`, `/${worker.id}/history`, `/${worker.id}/professional-profile`]) {
  assert.equal((await employee("GET", route)).status, 200, route);
}
assert.equal((await employee("PATCH", `/${worker.id}`, { jobTitle: "Offline Engineer" })).status, 200);
assert.equal((await employee("DELETE", `/${worker.id}`)).status, 200);

const service = getRoleCatalogService();
const root = service.getCatalogDir();
assert.equal(root, fileURLToPath(new URL("../resources/agent-catalog/agency-agents", import.meta.url)));
const response = await catalogHttp(new Request("http://localhost/catalog/roles"), true);
const runbookResponse = await catalogHttp(new Request("http://localhost/catalog/runbooks"), true);
if (process.argv[2] === "degraded") {
  assert.equal(response.status, 500);
  assert.equal(runbookResponse.status, 500);
  const { error } = await response.json() as { error: string };
  assert.match(error, /Offline catalog unavailable or corrupt/);
  assert.ok(error.includes(root));
  console.log(JSON.stringify({ root, legacyEmployeeHttp: "PASS", catalogStatus: 500, error }));
} else {
  assert.equal(response.status, 200);
  assert.equal(runbookResponse.status, 200);
  const result = verifyCatalogPackage(root);
  console.log(JSON.stringify({ root, legacyEmployeeHttp: "PASS", ...result }));
}
