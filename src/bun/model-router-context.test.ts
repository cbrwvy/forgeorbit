import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore } from "./account-core.ts";
import { TrustedQuotaRefresh } from "./trusted-quota.ts";
import { buildModelRouterResourceContext as buildPure } from "../shared/model-router/resource-context.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  migrate(db, migrations);
});
afterEach(() => db.close());

test("resource context builder matches fail-closed automatic routing", () => {
  const core = new AccountCore(db, () => 1_000);
  const trusted = new TrustedQuotaRefresh(core);
  const accounts = core.listAccounts();
  const ctx = buildPure({
    capturedAt: 1_000,
    harnesses: [{ id: "codex", label: "Codex", enabled: true }],
    accounts,
    quotasByAccount: new Map(accounts.map((a) => [a.id, core.currentQuotas(a.id)])),
    trustedSourcesByAccount: new Map(accounts.map((a) => [a.id, trusted.availability(a.id)])),
    now: 1_000,
  });
  expect(ctx.automaticRouting.available).toBe(false);
  expect(ctx.harnesses[0]?.automaticSelection).toBe("blocked-unverified");
});
