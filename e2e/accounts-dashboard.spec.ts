import { Database } from "bun:sqlite";
import path from "node:path";
import {
  test,
  expect,
  type APIRequestContext,
  type E2EBackend,
  type Page,
} from "./fixtures";
import { gotoApp } from "./helpers";
import { dateInput } from "../src/mainview/lib/accounts";
import { journalLegacyUsage } from "../src/bun/account-usage-bridge";
import { AccountCore } from "../src/bun/account-core";

// Each test owns a backend, temporary SQLite and HOME; all drivers are fake and usage is offline.
const headers = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });
async function post(
  request: APIRequestContext,
  b: E2EBackend,
  route: string,
  data: unknown,
) {
  const response = await request.post(`${b.apiBase}${route}`, {
    headers: headers(b),
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const account = (
  request: APIRequestContext,
  b: E2EBackend,
  displayName = "Owner",
  provider = "openai",
) => post(request, b, "/account-core/accounts", { provider, displayName });
const quota = (
  request: APIRequestContext,
  b: E2EBackend,
  accountId: string,
  window = "rolling",
  unit = { kind: "tokens" },
) =>
  post(request, b, "/account-core/quotas", {
    accountId,
    scope: "account",
    window,
    unit,
  });
const observe = (
  request: APIRequestContext,
  b: E2EBackend,
  quotaId: string,
  values: object,
) =>
  post(request, b, `/account-core/quotas/${quotaId}/observations`, {
    observedAt: Date.now() - 1000,
    expiresAt: Date.now() + 3_600_000,
    ...values,
  });
const dashboard = (page: Page) => page.getByTestId("accounts-dashboard");
async function open(page: Page, b: E2EBackend) {
  await gotoApp(page, b.bootBase);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "AI providers and accounts", exact: true })
    .click();
  await expect(
    dashboard(page).getByRole("button", {
      name: "Create Account",
      exact: true,
    }),
  ).toBeEnabled();
}
async function save(page: Page, title: string) {
  const form = page.getByRole("dialog", { name: title, exact: true });
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function viewAccount(page: Page, name: string) {
  await dashboard(page)
    .getByTestId("account-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .first()
    .getByRole("button", { name: "View Account Details" })
    .click();
  await expect(page.getByTestId("account-details")).toBeVisible();
}
async function choose(page: Page, title: string, label: string, id: string) {
  const form = page.getByRole("dialog", { name: title, exact: true });
  await form.getByLabel(label, { exact: true }).selectOption(id);
  await save(page, title);
}
async function confirm(page: Page, title: string) {
  await page
    .getByRole("dialog", { name: title, exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
}

test("empty global dashboard, loading, read-only navigation, settings and Portfolio round trip", async ({
  page,
  freshBackend: b,
}) => {
  await open(page, b);
  const root = dashboard(page);
  await expect(root).toContainText("No registered accounts");
  await expect(
    root.getByTestId("account-metric-accounts-registered"),
  ).toContainText("0");
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /account-core|usage\/refresh|agent-models|\/tasks/.test(request.url())
    )
      writes.push(request.url());
  });
  for (const name of [
    "Subscriptions",
    "Quotas",
    "Resource Availability",
    "Unassigned Usage",
    "Accounts",
  ])
    await root.getByRole("button", { name, exact: true }).click();
  await expect(root).toContainText("No registered accounts");
  expect(writes).toEqual([]);
  await root
    .getByRole("button", { name: "Open Portfolio", exact: true })
    .click();
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  await page
    .getByTestId("portfolio-dashboard")
    .getByRole("button", { name: "Accounts & Resources", exact: true })
    .click();
  await expect(root).toBeVisible();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "General", exact: true })
    .click();
  await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Library", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add agent", exact: true }),
  ).toBeVisible();
});

test("account forms, duplicate names, multiple bindings, edit, unbind and archival", async ({
  page,
  request,
  freshBackend: b,
}) => {
  await open(page, b);
  for (let i = 0; i < 2; i++) {
    await dashboard(page)
      .getByRole("button", { name: "Create Account", exact: true })
      .click();
    const form = page.getByRole("dialog", {
      name: "Create Account",
      exact: true,
    });
    await form.getByLabel("Provider", { exact: true }).fill("openai");
    await form.getByLabel("Display Name", { exact: true }).fill("Same name");
    await save(page, "Create Account");
  }
  await expect(dashboard(page).getByTestId("account-card")).toHaveCount(2);
  const response = await request.get(`${b.apiBase}/account-core/accounts`, {
    headers: headers(b),
  });
  const accounts = await response.json();
  expect(accounts[0].id).not.toBe(accounts[1].id);
  await viewAccount(page, "Same name");
  await expect(page.getByTestId("account-details")).toContainText("unverified");
  for (const h of ["codex", "cursor"]) {
    await page
      .getByRole("button", { name: "Bind Harness", exact: true })
      .click();
    await choose(page, "Bind Harness", "Harness", h);
  }
  await expect(
    page
      .getByRole("region", { name: "Harness Bindings", exact: true })
      .getByRole("button", { name: "Unbind Harness" }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Edit Metadata", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Edit Metadata", exact: true })
    .getByLabel("Display Name", { exact: true })
    .fill("Renamed owner");
  await save(page, "Edit Metadata");
  await expect(
    page
      .getByTestId("account-details")
      .getByRole("heading", { name: "Renamed owner", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to Accounts", exact: true })
    .click();
  await viewAccount(page, "Same name");
  await page.getByRole("button", { name: "Bind Harness", exact: true }).click();
  await choose(page, "Bind Harness", "Harness", "codex");
  await dashboard(page)
    .getByRole("button", { name: "Resource Availability", exact: true })
    .click();
  const codex = page
    .getByTestId("availability-card")
    .filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
  await expect(codex).toContainText("Renamed owner");
  await expect(codex).toContainText("Same name");
  await dashboard(page)
    .getByRole("button", { name: "Accounts", exact: true })
    .click();
  await viewAccount(page, "Renamed owner");
  await page
    .getByRole("button", { name: "Unbind Harness", exact: true })
    .last()
    .click();
  await confirm(page, "Unbind harness?");
  await expect(
    page.getByRole("button", { name: "Unbind Harness", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Archive Account", exact: true })
    .click();
  await confirm(page, "Archive account?");
  await expect(dashboard(page).getByTestId("account-card")).toHaveCount(1);
  await dashboard(page)
    .getByRole("button", { name: "Archived Accounts", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Archived Accounts", exact: true }),
  ).toContainText("Renamed owner");
});

test("profile association errors, harness drift, removal and unchanged profile metadata", async ({
  page,
  request,
  freshBackend: b,
}) => {
  const a = await account(request, b);
  const profile = await post(request, b, "/agent-profiles", {
    name: "Planning profile",
    harness: "codex",
    model: "fake-model",
  });
  await open(page, b);
  await viewAccount(page, "Owner");
  await page
    .getByRole("button", { name: "Associate Agent Profile", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Associate Agent Profile",
    exact: true,
  });
  await expect(form).toContainText(
    "This association does not switch the CLI account.",
  );
  await form
    .getByLabel("Agent Profile", { exact: true })
    .selectOption(profile.id);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText(
    "Bind the profile's current harness",
  );
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Discard unsaved changes?", exact: true })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await page.getByRole("button", { name: "Bind Harness", exact: true }).click();
  await choose(page, "Bind Harness", "Harness", "codex");
  await page
    .getByRole("button", { name: "Associate Agent Profile", exact: true })
    .click();
  await choose(page, "Associate Agent Profile", "Agent Profile", profile.id);
  const before = await (
    await request.get(`${b.apiBase}/agent-profiles/${profile.id}`, {
      headers: headers(b),
    })
  ).json();
  expect(before.harness).toBe("codex");
  expect(before.model).toBe("fake-model");
  const patched = await request.patch(
    `${b.apiBase}/agent-profiles/${profile.id}`,
    { headers: headers(b), data: { harness: "cursor" } },
  );
  expect(patched.ok()).toBe(true);
  await dashboard(page)
    .getByRole("button", { name: "Refresh accounts", exact: true })
    .click();
  await expect(page.getByTestId("account-details")).toContainText(
    "Unreliable association",
  );
  await expect(
    dashboard(page).getByTestId("account-metric-resource-conflicts"),
  ).toContainText("1");
  await page
    .getByRole("button", { name: "Remove Profile Association", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Remove Profile Association",
      exact: true,
    }),
  ).toHaveCount(0);
  const identity = await request.get(
    `${b.apiBase}/account-core/identity?harnessId=codex&profileId=${profile.id}`,
    { headers: headers(b) },
  );
  expect((await identity.json()).accountId).toBeNull();
  expect(a.id).toBeTruthy();
});

test("subscription forms preserve exact money, shared identity, independent plans and currencies", async ({
  page,
  request,
  freshBackend: b,
}) => {
  const a = await account(request, b, "Owner A"),
    other = await account(request, b, "Owner B");
  await open(page, b);
  await dashboard(page)
    .getByRole("button", { name: "Subscriptions", exact: true })
    .click();
  await dashboard(page)
    .getByRole("button", { name: "Create Subscription", exact: true })
    .click();
  let form = page.getByRole("dialog", {
    name: "Create Subscription",
    exact: true,
  });
  await form.getByLabel("Provider", { exact: true }).fill("openai");
  await form.getByLabel("Plan Label", { exact: true }).fill("Shared plan");
  await form.getByLabel("Currency", { exact: true }).fill("USD");
  await form.getByLabel("Recurring Cost", { exact: true }).fill("0.291");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("at most 2 decimal");
  await form.getByLabel("Recurring Cost", { exact: true }).fill("0.29");
  await form
    .getByLabel("Billing Period", { exact: true })
    .selectOption("month");
  await save(page, "Create Subscription");
  const shared = dashboard(page)
    .getByTestId("subscription-card")
    .filter({ hasText: "Shared plan" });
  for (const id of [a.id, other.id]) {
    await shared
      .getByRole("button", { name: "Link Account", exact: true })
      .click();
    await choose(page, "Link Account to Subscription", "Account", id);
  }
  await expect(shared).toContainText("Owner A");
  await expect(shared).toContainText("Owner B");
  await expect(page.getByTestId("subscription-commitments")).toContainText(
    "USD 0.29 / month",
  );
  const subs = (
    await (
      await request.get(`${b.apiBase}/account-core/subscriptions`, {
        headers: headers(b),
      })
    ).json()
  ).subscriptions;
  expect(subs[0].recurringCostMinor).toBe(29);
  await post(request, b, `/account-core/accounts/${a.id}/harnesses`, {
    harnessId: "codex",
  });
  await dashboard(page)
    .getByRole("button", { name: "Open Portfolio", exact: true })
    .click();
  const resource = page
    .getByTestId("portfolio-resource")
    .filter({ hasText: a.id });
  await expect(resource).toContainText(subs[0].id);
  await expect(resource).toContainText("Identity provenance: user-provided");
  await page
    .getByTestId("portfolio-dashboard")
    .getByRole("button", { name: "Accounts & Resources", exact: true })
    .click();
  await dashboard(page)
    .getByRole("button", { name: "Subscriptions", exact: true })
    .click();
  for (const extra of [
    { currency: "EUR", recurringCostMinor: 500 },
    { currency: "USD", recurringCostMinor: 29 },
    { currency: null, recurringCostMinor: null },
  ])
    await post(request, b, "/account-core/subscriptions", {
      provider: "openai",
      planLabel: "Same plan",
      billingPeriod: "month",
      ...extra,
    });
  await dashboard(page)
    .getByRole("button", { name: "Refresh accounts", exact: true })
    .click();
  await expect(dashboard(page).getByTestId("subscription-card")).toHaveCount(4);
  await expect(page.getByTestId("subscription-commitments")).toContainText(
    "USD 0.58 / month",
  );
  await expect(page.getByTestId("subscription-commitments")).toContainText(
    "EUR 5.00 / month",
  );
  await expect(page.getByTestId("subscription-commitments")).toContainText(
    "Unknown commitments: 1",
  );
  await shared
    .getByRole("button", { name: "Edit Subscription", exact: true })
    .click();
  form = page.getByRole("dialog", { name: "Edit Subscription", exact: true });
  await form.getByLabel("Recurring Cost", { exact: true }).fill("0");
  await save(page, "Edit Subscription");
  await expect(shared).toContainText("USD 0.00");
  await shared
    .getByRole("button", { name: "Archive Subscription", exact: true })
    .click();
  await confirm(page, "Archive subscription?");
  await expect(dashboard(page).getByTestId("subscription-card")).toHaveCount(3);
});

test("manual definition and observation forms, unknown and zero, validation, immutable archived history", async ({
  page,
  request,
  freshBackend: b,
}) => {
  await account(request, b);
  await open(page, b);
  await viewAccount(page, "Owner");
  await page
    .getByRole("button", { name: "Create Quota Definition", exact: true })
    .click();
  const defForm = page.getByRole("dialog", {
    name: "Create Quota Definition",
    exact: true,
  });
  await defForm.getByLabel("Window", { exact: true }).fill("manual-hour");
  await save(page, "Create Quota Definition");
  let card = page.getByTestId("account-quota");
  await expect(card).toContainText("Current capacity: Unknown");
  await card
    .getByRole("button", { name: "Add Observation", exact: true })
    .click();
  let form = page.getByRole("dialog", { name: "Add Observation", exact: true });
  // Keep the later percentage sample newer even when both saves finish
  // within one second (datetime-local truncates subsecond precision).
  await form.getByLabel("Observed At", { exact: true }).fill(dateInput(Date.now() - 60_000));
  await form.getByLabel("Remaining", { exact: true }).fill("0");
  await form
    .getByLabel("Expires At (freshness)", { exact: true })
    .fill(dateInput(Date.now() + 3_600_000));
  await save(page, "Add Observation");
  await expect(card).toContainText("current");
  await expect(
    page.getByRole("region", { name: "Archived Quota History", exact: true }),
  ).toContainText("No archived definitions.");
  await expect(
    card.locator("dd").filter({ hasText: /^0$/ }).first(),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Add Observation", exact: true })
    .click();
  form = page.getByRole("dialog", { name: "Add Observation", exact: true });
  await form
    .getByLabel("Observed At", { exact: true })
    .fill(dateInput(Date.now() + 86_400_000));
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText(
    "cannot be in the future",
  );
  await form
    .getByLabel("Observed At", { exact: true })
    .fill(dateInput(Date.now() - 500));
  await form
    .getByLabel("Percentage Semantics", { exact: true })
    .selectOption("percent-remaining");
  await form.getByLabel("Percentage (0–100)", { exact: true }).fill("25");
  await form
    .getByLabel("Expires At (freshness)", { exact: true })
    .fill(dateInput(Date.now() + 3_600_000));
  await save(page, "Add Observation");
  await expect(card).toContainText("25% remaining");
  await expect(card).toContainText("Remaining");
  await card.getByRole("button", { name: "View History", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Usage History", exact: true })
      .getByTestId("evidence-row"),
  ).toHaveCount(2);
  await card
    .getByRole("button", { name: "Archive Definition", exact: true })
    .click();
  await confirm(page, "Archive quota definition?");
  await expect(card).toHaveCount(0);
  await page
    .getByRole("button", { name: "View Archived History", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Usage History", exact: true }),
  ).toContainText("Archived definition");
  await page
    .getByRole("button", { name: "Archive Account", exact: true })
    .click();
  await confirm(page, "Archive account?");
  await dashboard(page)
    .getByRole("button", { name: "Archived Accounts", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Browse Archived Account History",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "View Archived History", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Usage History", exact: true })
      .getByTestId("evidence-row"),
  ).toHaveCount(2);
});

test("quota evidence distinguishes percentages, expiry, stale, conflicts, unknown reset and known remaining", async ({
  page,
  request,
  freshBackend: b,
}) => {
  const a = await account(request, b);
  const now = Date.now();
  const variants = [
    { name: "unknown", values: null },
    { name: "zero", values: { remaining: 0 } },
    { name: "known", values: { limit: 100, used: 30, remaining: 70 } },
    {
      name: "used-percent",
      values: { indicator: { kind: "percent-used", value: 40 } },
    },
    {
      name: "remaining-percent",
      values: { indicator: { kind: "percent-remaining", value: 60 } },
    },
    { name: "stale", values: { remaining: 90, expiresAt: null } },
    {
      name: "expired",
      values: {
        remaining: 80,
        observedAt: now - 60_000,
        expiresAt: now - 10_000,
      },
    },
  ];
  for (const variant of variants) {
    const q = await quota(request, b, a.id, variant.name);
    if (variant.values) await observe(request, b, q.id, variant.values);
  }
  const conflict = await quota(request, b, a.id, "conflict");
  for (const remaining of [10, 0])
    await observe(request, b, conflict.id, {
      remaining,
      observedAt: now - 1000,
    });
  await open(page, b);
  await dashboard(page)
    .getByRole("button", { name: "Quotas", exact: true })
    .click();
  const cards = page.getByTestId("account-quota");
  await expect(cards).toHaveCount(8);
  const window = (name: string) =>
    cards.filter({
      has: page.locator("dd").filter({ hasText: new RegExp(`^${name}$`) }),
    });
  await expect(window("known")).toContainText("70");
  await expect(window("used-percent")).toContainText("40% used");
  await expect(window("remaining-percent")).toContainText("60% remaining");
  await expect(window("stale")).toContainText("freshness unknown");
  await expect(window("expired")).toContainText("Current capacity: Unknown");
  await window("expired")
    .getByText("Supporting latest observations", { exact: false })
    .click();
  await expect(window("expired")).toContainText("Expired");
  await expect(window("conflict")).toContainText("Conflict · capacity Unknown");
  await expect(window("zero")).toContainText("Unknown");
  await expect(
    dashboard(page).getByTestId("account-metric-resource-conflicts"),
  ).toContainText("1");
});

test("history pagination uses server cursors for equal timestamps", async ({
  page,
  request,
  freshBackend: b,
}) => {
  test.setTimeout(60_000);
  const a = await account(request, b),
    q = await quota(request, b, a.id);
  const observedAt = Date.now() - 1000;
  for (let i = 0; i < 201; i++)
    await observe(request, b, q.id, { observedAt, remaining: i });
  await open(page, b);
  await viewAccount(page, "Owner");
  await page.getByRole("button", { name: "View History", exact: true }).click();
  const history = page.getByRole("region", {
    name: "Usage History",
    exact: true,
  });
  await expect(history.getByTestId("evidence-row")).toHaveCount(200);
  await history
    .getByRole("button", { name: "Load older observations", exact: true })
    .click();
  await expect(history.getByTestId("evidence-row")).toHaveCount(201);
  await expect(
    history.getByRole("button", {
      name: "Load older observations",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("saved legacy usage stays unassigned, sanitized and separate from account quota", async ({
  page,
  request,
  freshBackend: b,
}) => {
  const a = await account(request, b);
  await post(request, b, `/account-core/accounts/${a.id}/harnesses`, {
    harnessId: "codex",
  });
  const db = new Database(path.join(b.dataDir, "agetor.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    journalLegacyUsage(db, {
      harnessId: "codex",
      kind: "codex",
      source: "cache",
      fetchedAtMs: Date.now(),
      status: "ok",
      planType: "PRIVATE_PLAN",
      reason: "PRIVATE_SECRET",
      meters: [
        {
          id: "session",
          label: "PRIVATE_PATH",
          usedPercent: 41,
          resetsAtMs: null,
        },
      ],
    });
    db.run(
      "INSERT INTO usage_daily(config_dir,day,model,input_tokens,output_tokens) VALUES (?, ?, ?, ?, ?)",
      ["/PRIVATE_HOME", "2026-10-24", "fixture-model", 123, 45],
    );
  } finally {
    db.close();
  }
  await open(page, b);
  await dashboard(page)
    .getByRole("button", { name: "Unassigned Usage", exact: true })
    .click();
  const legacy = page.getByRole("region", {
    name: "Unassigned Usage",
    exact: true,
  });
  await expect(legacy).toContainText("41% used");
  await expect(legacy).toContainText("fixture-model");
  await expect(legacy).toContainText("Unknown (daily aggregate)");
  await expect(legacy).toContainText("Unassigned");
  await expect(legacy).not.toContainText("PRIVATE_");
  await expect(legacy).not.toContainText(a.id);
  const unauthorized = await request.get(
    `${b.apiBase}/account-core/legacy-usage`,
  );
  expect(unauthorized.status()).toBe(401);
});

test("API errors are sanitized, loading retries work, and failed writes do not leak secrets", async ({
  page,
  request,
  freshBackend: b,
}) => {
  await open(page, b);
  await page.route("**/portfolio/analysis", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "SQLite PRIVATE_SECRET /real/home" }),
    }),
  );
  await dashboard(page)
    .getByRole("button", { name: "Refresh accounts", exact: true })
    .click();
  await expect(dashboard(page).getByRole("alert")).toContainText(
    "Authorization failed",
  );
  await expect(dashboard(page)).not.toContainText("PRIVATE_SECRET");
  await page.unroute("**/portfolio/analysis");
  await dashboard(page)
    .getByRole("button", { name: "Refresh accounts", exact: true })
    .click();
  await expect(dashboard(page).getByRole("alert")).toHaveCount(0);
  await dashboard(page)
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Create Account",
    exact: true,
  });
  await form.getByLabel("Provider", { exact: true }).fill("openai");
  await form
    .getByLabel("Display Name", { exact: true })
    .fill("Bearer PRIVATE_SECRET");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText(
    "credentials are not accepted",
  );
  await expect(form.getByRole("alert")).not.toContainText("PRIVATE_SECRET");
  const response = await request.post(`${b.apiBase}/account-core/accounts`, {
    headers: headers(b),
    data: {
      provider: "openai",
      displayName: "x",
      credentials: "PRIVATE_SECRET",
    },
  });
  expect(response.status()).toBe(400);
  expect(await response.text()).not.toContain("PRIVATE_SECRET");
});

test("large registry, long names, responsive themes, reduced preferences and keyboard focus", async ({
  page,
  request,
  freshBackend: b,
}, testInfo) => {
  test.setTimeout(60_000);
  for (let i = 0; i < 25; i++)
    await account(
      request,
      b,
      `${i.toString().padStart(2, "0")} ${"LongAccountName".repeat(9)}`,
      "VeryLongProviderName".repeat(7),
    );
  await open(page, b);
  const root = dashboard(page);
  await expect(root.getByTestId("account-card")).toHaveCount(12);
  await root
    .getByRole("button", { name: "Next accounts", exact: true })
    .click();
  await expect(root).toContainText("Page 2 of 3");
  await root
    .getByRole("button", { name: "Next accounts", exact: true })
    .click();
  await expect(root.getByTestId("account-card")).toHaveCount(1);
  await root
    .getByRole("textbox", { name: "Search accounts", exact: true })
    .fill("00 LongAccountName");
  await expect(root.getByTestId("account-card")).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
    ),
  ).toBe(true);
  for (const theme of ["light", "dark"]) {
    const res = await request.put(`${b.apiBase}/preferences/theme`, {
      headers: headers(b),
      data: { value: theme },
    });
    expect(res.ok()).toBe(true);
    // Theme is selected through the existing UI so this window applies it immediately.
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "General", exact: true })
      .click();
    await page
      .getByRole("button", { name: new RegExp(`^${theme}$`, "i") })
      .click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "AI providers and accounts", exact: true })
      .click();
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(root).toBeVisible();
      const overflow = await root.evaluate(
        (el) => el.scrollWidth <= el.clientWidth + 1,
      );
      expect(overflow).toBe(true);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`accounts-${theme}-${width}.png`),
      });
    }
  }
  const create = root.getByRole("button", {
    name: "Create Account",
    exact: true,
  });
  await create.focus();
  await page.keyboard.press("Enter");
  const form = page.getByRole("dialog", {
    name: "Create Account",
    exact: true,
  });
  await expect(
    form.getByRole("heading", { name: "Create Account", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByLabel("Provider", { exact: true })).toBeFocused();
  await form.getByLabel("Provider", { exact: true }).fill("openai");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Discard unsaved changes?", exact: true })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(create).toBeFocused();
});

test("local expiry invalidates quota capacity without a network poll and models stay read-only", async ({
  page,
  request,
  freshBackend: b,
}) => {
  const now = Date.now();
  const a = await account(request, b);
  await post(request, b, `/account-core/accounts/${a.id}/harnesses`, {
    harnessId: "codex",
  });
  const q = await quota(request, b, a.id);
  await observe(request, b, q.id, {
    remaining: 7,
    observedAt: now - 1000,
    expiresAt: now + 60_000,
  });
  const db = new Database(path.join(b.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    new AccountCore(db).setModelCapability(
      a.id,
      "codex",
      "LongModelDeclaration".repeat(7),
      { support: "supported", expiresAt: now + 60_000 },
    );
  } finally {
    db.close();
  }
  await page.clock.install({ time: now });
  await open(page, b);
  await viewAccount(page, "Owner");
  const models = page.getByRole("region", {
    name: "Model Capabilities",
    exact: true,
  });
  await expect(models).toContainText("read-only");
  await expect(models).toContainText("user-provided");
  await expect(models.getByRole("button")).toHaveCount(0);
  const card = page.getByTestId("account-quota");
  await expect(card).toContainText("current");
  await expect(
    page.getByRole("region", { name: "Archived Quota History", exact: true }),
  ).toContainText("No archived definitions.");
  const reads: string[] = [];
  page.on("request", (r) => {
    if (/account-core|portfolio\/analysis/.test(r.url())) reads.push(r.url());
  });
  await page.clock.fastForward(60_001);
  await expect(card).toContainText("Current capacity: Unknown");
  await expect(models).toContainText("Expired");
  expect(reads).toEqual([]);
  await card
    .getByRole("button", { name: "Add Observation", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Add Observation",
    exact: true,
  });
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await form
        .locator("form")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }
});

test("audited sources show unsupported reasons and never acquire quota on page load or local refresh", async ({ page, request, freshBackend: b }, testInfo) => {
  const a = await account(request,b,"Quota Owner");
  const q = await quota(request,b,a.id,"primary");
  await observe(request,b,q.id,{indicator:{kind:"percent-used",value:72}});
  const writes: string[] = [];
  page.on("request",r => { if (r.method() === "POST" && /quota-refresh|usage\/refresh/.test(r.url())) writes.push(r.url()); });
  await open(page,b);
  await dashboard(page).getByRole("button",{name:"Quota Sources",exact:true}).click();
  const sources = page.getByTestId("quota-sources");
  await expect(sources.getByTestId("quota-source-codex-app-server")).toContainText("documented");
  await expect(sources.getByTestId("quota-source-gemini-cli")).toContainText("unsupported");
  await expect(sources.getByTestId("quota-source-manual")).toContainText("user-provided-only");
  await expect(sources.getByTestId("quota-source-cursor-org-pool")).toContainText("Organization API key");
  for (const button of await sources.getByRole("button",{name:/^Refresh /}).all()) await expect(button).toBeDisabled();
  for (const width of [390, 1280]) {
    await page.setViewportSize({width,height:1000});
    expect(await sources.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await sources.getByTestId("quota-source-codex-app-server").screenshot({path:testInfo.outputPath(`quota-source-${width}.png`)});
  }
  await dashboard(page).getByRole("button",{name:"Accounts",exact:true}).click();
  await viewAccount(page,"Quota Owner");
  const codex = page.getByTestId("quota-source-codex-app-server");
  await expect(codex).toContainText("No documented stable provider subject");
  await expect(codex).toContainText("Last Verified Observation");
  for (const button of await codex.getByRole("button",{name:/^Refresh /}).all()) await expect(button).toBeDisabled(); // every Refresh control of the source, incl. "Refresh Evidence"
  await expect(page.getByTestId("account-quota")).toContainText("72% used");
  await expect(page.getByTestId("account-quota")).toContainText("Reading type");
  await dashboard(page).getByRole("button",{name:"Refresh accounts",exact:true}).click();
  for (const button of await codex.getByRole("button",{name:/^Refresh /}).all()) await expect(button).toBeDisabled(); // every Refresh control of the source, incl. "Refresh Evidence"
  expect(writes).toEqual([]);
  const rejected = await request.post(`${b.apiBase}/account-core/accounts/${a.id}/quota-refresh`,{headers:headers(b),data:{sourceId:"codex-app-server"}});
  expect(rejected.status()).toBe(409);
});

test("explicit quota refresh UI handles duplicate clicks, timeout and sanitized errors through a fake source", async ({ page, request, freshBackend: b }) => {
  const a = await account(request,b,"Refresh Fixture");
  const response = await request.get(`${b.apiBase}/account-core/accounts/${a.id}/quota-sources`,{headers:headers(b)});
  const sources = (await response.json()).map((s: any) => s.id === "codex-app-server" ? {...s,implemented:true,refreshAvailable:true,reason:"Ready for explicit manual refresh."} : s);
  await page.route(`**/account-core/accounts/${a.id}/quota-sources`,route => route.fulfill({json:sources}));
  let calls = 0, release!: () => void, status = 504;
  await page.route(`**/account-core/accounts/${a.id}/quota-refresh`,async route => {
    calls++; expect(route.request().postDataJSON()).toEqual({sourceId:"codex-app-server"});
    await new Promise<void>(resolve => {release=resolve;});
    await route.fulfill({status,json:{error:"Bearer SECRET /private/auth.json"}});
  });
  await open(page,b); await viewAccount(page,"Refresh Fixture");
  const panel = page.getByTestId("quota-sources"); const button = panel.getByRole("button",{name:"Refresh Codex app-server rate limits",exact:true});
  await expect(button).toBeEnabled(); expect(calls).toBe(0);
  await button.click(); await expect(button).toBeDisabled(); await expect.poll(() => calls).toBe(1); release();
  await expect(panel.getByRole("alert")).toHaveText("Quota refresh timed out. Previous observations were retained.");
  await expect(panel).not.toContainText("SECRET"); await expect(button).toBeEnabled();
  status = 502; await button.click(); await expect.poll(() => calls).toBe(2); release();
  await expect(panel.getByRole("alert")).toHaveText("Quota refresh failed. Previous observations were retained.");
  await expect(panel).not.toContainText("SECRET");
});
