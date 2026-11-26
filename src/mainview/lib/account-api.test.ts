import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AccountCore } from "../../bun/account-core.ts";
import { accountHttp } from "../../bun/account-http.ts";
import { accountPortfolioView } from "../../bun/account-portfolio.ts";
import { LegacyUsageBridge } from "../../bun/account-usage-bridge.ts";
import { migrate } from "../../bun/migrate.ts";
import { migrations } from "../../bun/migrations/index.ts";
import { createAccountApi } from "./account-api.ts";

let db: Database, core: AccountCore;
let calls: { path: string; method: string; retry?: boolean }[];
let guards: { mockRestore: () => void }[];
let authorized: boolean, portfolioStatus: number;
const now = 1_000_000;
beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  core = new AccountCore(db, () => now);
  calls = [];
  authorized = true;
  portfolioStatus = 200;
  const blockedFetch = Object.assign(
    () => {
      throw new Error("Network forbidden");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  guards = [
    spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Process forbidden");
    }),
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("Process forbidden");
    }),
    spyOn(globalThis, "fetch").mockImplementation(blockedFetch),
  ];
});
afterEach(() => {
  for (const g of guards) g.mockRestore();
  db.close();
});
const client = createAccountApi(
  async <T>(
    path: string,
    init?: RequestInit,
    opts?: { retry?: boolean },
  ): Promise<T> => {
    calls.push({ path, method: init?.method ?? "GET", retry: opts?.retry });
    if (path === "/portfolio/analysis") {
      if (portfolioStatus !== 200)
        throw Object.assign(new Error("Portfolio rejected"), {
          status: portfolioStatus,
        });
      return { accountResources: accountPortfolioView(core) } as T;
    }
    const response = await accountHttp(
      new Request(`http://local.test${path}`, init),
      core,
      new LegacyUsageBridge(db, () => now),
      authorized,
    );
    const body = (await response.json()) as any;
    if (!response.ok)
      throw Object.assign(new Error(body.error), { status: response.status });
    return body;
  },
);
const create = () =>
  client.createAccount({
    provider: "openai",
    displayName: "Duplicate",
    externalIdentity: null,
    provenance: "user-provided",
    availability: "unknown",
  });

test("dashboard client creates distinct same-name accounts and explicit many-to-many harness bindings", async () => {
  const a = await create(),
    b = await create();
  expect(a.id).not.toBe(b.id);
  await client.bindHarness(a.id, "codex");
  await client.bindHarness(b.id, "codex");
  await client.bindHarness(a.id, "cursor");
  const data = await client.resources();
  expect(data.accounts).toHaveLength(2);
  expect(
    data.accounts.find((r) => r.account.id === a.id)?.bindings,
  ).toHaveLength(2);
  await client.updateAccount(a.id, {
    displayName: "Renamed",
    externalIdentity: null,
    provenance: "unknown",
    availability: "unavailable",
  });
  await client.unbindHarness(a.id, "cursor");
  expect(core.bindings(a.id)).toHaveLength(1);
  expect(
    calls.filter((c) => c.method !== "GET").every((c) => c.retry === false),
  ).toBe(true);
});
test("profile associations require an explicit harness, preserve profile configuration and show drift", async () => {
  const a = await create();
  db.run(
    "INSERT INTO agent_profiles(id,name,name_key,harness_id,model,created_at,updated_at) VALUES ('p','Profile','profile','codex','fake-model',0,0)",
  );
  await expect(client.bindProfile(a.id, "p")).rejects.toThrow(
    "Bind the profile's harness",
  );
  await client.bindHarness(a.id, "codex");
  await client.bindProfile(a.id, "p");
  expect((await client.identity("codex", "p")).accountId).toBe(a.id);
  db.run("UPDATE agent_profiles SET harness_id='cursor' WHERE id='p'");
  expect((await client.identity("codex", "p")).accountId).toBeNull();
  await client.unbindProfile(a.id, "p");
  expect(core.associations(a.id)).toHaveLength(0);
});
test("shared subscriptions, independent identity, currency separation and historical membership guard", async () => {
  const a = await create(),
    b = await create();
  const input = {
    provider: "openai",
    planLabel: "Same Plan",
    currency: "USD",
    recurringCostMinor: 29,
    billingPeriod: "month" as const,
    renewsAt: null,
    resetsAt: null,
  };
  const s = await client.createSubscription(input),
    independent = await client.createSubscription({
      ...input,
      currency: "EUR",
    });
  const unknown = await client.createSubscription({
    ...input,
    recurringCostMinor: null,
  });
  await client.linkSubscription(a.id, s.id);
  await client.linkSubscription(b.id, s.id);
  await client.linkSubscription(b.id, independent.id);
  expect((await client.resources()).commitments.totals).toHaveLength(2);
  expect((await client.resources()).commitments.unknownIds).toContain(
    unknown.id,
  );
  const q = await client.createDefinition({
    accountId: a.id,
    subscriptionId: s.id,
    scope: "account",
    unit: { kind: "money", currency: "USD" },
    window: "month",
  });
  await expect(client.unlinkSubscription(a.id, s.id)).rejects.toThrow(
    "Historical quota",
  );
  const { provider: _provider, ...patch } = input;
  expect(
    (await client.updateSubscription(s.id, { ...patch, recurringCostMinor: 0 }))
      .recurringCostMinor,
  ).toBe(0);
  await client.archiveDefinition(q.id);
  expect((await client.definitions(a.id))[0]?.archivedAt).toBe(now);
  await client.archiveSubscription(s.id);
  expect(
    (await client.resources()).subscriptions.some((item) => item.id === s.id),
  ).toBe(false);
});
test("manual observations are append-only, paginate with server cursor and survive account archive", async () => {
  const a = await create();
  const q = await client.createDefinition({
    accountId: a.id,
    subscriptionId: null,
    scope: "account",
    unit: { kind: "tokens" },
    window: "unknown",
  });
  for (let i = 0; i < 201; i++)
    await client.recordObservation(q.id, {
      observedAt: now,
      expiresAt: now + 100,
      resetAt: null,
      remaining: i === 0 ? 0 : null,
      limit: null,
      used: null,
      indicator: null,
      confidence: "unknown",
    });
  const first = await client.history(q.id);
  expect(first.observations).toHaveLength(200);
  expect(first.nextCursor).not.toBeNull();
  const second = await client.history(q.id, first.nextCursor);
  expect(second.observations).toHaveLength(1);
  expect(second.observations[0]?.remaining).toBe(0);
  expect(
    new Set([...first.observations, ...second.observations].map((o) => o.id))
      .size,
  ).toBe(201);
  await client.archiveAccount(a.id);
  expect(await client.accounts()).toHaveLength(0);
  expect(await client.accounts(true)).toHaveLength(1);
  expect((await client.history(q.id)).observations).toHaveLength(200);
});
test("client legacy reads stay unassigned and never use refresh/discovery endpoints", async () => {
  expect((await client.legacyUsage()).observations).toEqual([]);
  expect((await client.legacyTokens()).observations).toEqual([]);
  await client.resources();
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  expect(
    calls.some((c) => /refresh|models\/discover|agent-models/.test(c.path)),
  ).toBe(false);
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
});
test("unauthorized API reads and writes fail without retry or alternate authorization", async () => {
  authorized = false;
  await expect(create()).rejects.toThrow("unauthorized");
  await expect(client.accounts()).rejects.toThrow("unauthorized");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.retry).toBe(false);
});
test("account resources remain manageable when unrelated Portfolio analysis is rejected", async () => {
  const a = await create();
  await client.bindHarness(a.id, "codex");
  portfolioStatus = 422;
  const result = await client.resources();
  expect(result.accounts[0]?.account.id).toBe(a.id);
  expect(result.accounts[0]?.bindings).toHaveLength(1);
  expect(
    calls.filter(
      (c) =>
        c.method === "GET" &&
        c.path.startsWith(`/account-core/accounts/${a.id}/`),
    ),
  ).toHaveLength(6);
  expect(calls.some(call => call.path === `/account-core/accounts/${a.id}/provider-refusals`)).toBe(true);
});

test("source capability reads are local and refresh is a single explicit non-retried mutation", async () => {
  const a = await create(); calls = [];
  const sources = await client.sources();
  const available = await client.quotaSources(a.id);
  expect(sources.find(s => s.id === "codex-app-server")?.documentation).toBe("documented");
  expect(available.every(s => !s.refreshAvailable)).toBe(true);
  expect(calls.every(c => c.method === "GET")).toBe(true);
  await expect(client.refreshQuota(a.id,"codex-app-server")).rejects.toMatchObject({status:409});
  expect(calls.at(-1)).toEqual({path:`/account-core/accounts/${a.id}/quota-refresh`,method:"POST",retry:false});
  expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
});

test("provider evidence: the read is a plain GET and Refresh is one explicit, consented, non-retried POST", async () => {
  const a = await create(); calls = [];
  // The harness mounts no collector, so both routes answer 501 instead of starting anything.
  await expect(client.providerEvidence(a.id)).rejects.toMatchObject({ status: 501 });
  expect(calls.at(-1)).toEqual({ path: `/account-core/accounts/${a.id}/provider-evidence`, method: "GET", retry: undefined });
  await expect(client.refreshProviderEvidence(a.id)).rejects.toMatchObject({ status: 501 });
  expect(calls.at(-1)).toEqual({ path: `/account-core/accounts/${a.id}/provider-evidence`, method: "POST", retry: false });
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
});
