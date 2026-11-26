import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { OwnerTrustPanel, operationMatchesContext } from "./OwnerTrustPanel";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

/** Text a person reads: everything outside the collapsed technical-details block. */
function everydayText(html: string): string {
  return html.replace(/<details[\s\S]*?<\/details>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

test("Russian Owner authorization shows plain words; raw states and English fallbacks stay in technical details", async () => {
  await choose("ru");
  const html = renderToStaticMarkup(<LocaleProvider><OwnerTrustPanel /></LocaleProvider>);
  const visible = everydayText(html);
  expect(visible).toContain("Авторизация владельца");
  expect(visible).toContain("Состояние");
  expect(visible).toContain("Это сборка для разработки");
  expect(visible).toContain("Заблокирован до подтверждения");
  for (const raw of ["unestablished", "not pinned", "application-identity", "development-or-qa", "Secure Enclave", "true", "false"]) {
    expect(visible).not.toContain(raw);
  }
  // Nothing was dropped: the diagnostic rows still exist, collapsed, with their existing test ids.
  expect(html).toContain('data-testid="owner-trust-details"');
  for (const id of ["owner-trust-bundle", "owner-trust-expected", "owner-trust-team", "owner-trust-helper", "owner-trust-enclave", "owner-trust-code", "owner-trust-reason"]) {
    expect(html).toContain(`data-testid="${id}"`);
  }
  // The safety statement and the review button stay visible.
  expect(html).toContain('data-testid="owner-trust-no-process"');
  expect(html).toContain('data-testid="owner-trust-review"');
});

test("English Owner authorization keeps the same structure", async () => {
  await choose("en");
  const html = renderToStaticMarkup(<LocaleProvider><OwnerTrustPanel /></LocaleProvider>);
  const visible = everydayText(html);
  expect(visible).toContain("Owner authorization");
  expect(visible).toContain("Blocked until confirmed");
  expect(visible).toContain("No external AI process will start from this page.");
  expect(visible).not.toContain("application-identity-unestablished");
});

test("the everyday view is status, permission, next step and the safety line; the explanation is behind a disclosure", async () => {
  await choose("en");
  const html = renderToStaticMarkup(<LocaleProvider><OwnerTrustPanel /></LocaleProvider>);
  const visible = everydayText(html);
  for (const label of ["Status", "Running with AI", "What to do"]) expect(visible).toContain(label);
  // The protocol explanation is no longer everyday text, but it is still in the DOM.
  expect(visible).not.toContain("macOS authentication in the trusted helper signs one exact operation");
  expect(html).toContain('data-testid="owner-trust-how"');
  expect(html).toContain('data-testid="owner-trust-intro"');
  expect(html).toContain("macOS authentication in the trusted helper signs one exact operation");
  // No certificate or protocol row leaks into the everyday view.
  for (const raw of ["SHA-256", "Bundle", "Secure Enclave", "owner-proof-invalid"]) expect(visible).not.toContain(raw);
  // Every existing test id is still present.
  for (const id of ["owner-trust-panel", "owner-trust-state", "owner-trust-execution", "owner-trust-action", "owner-trust-operation", "owner-trust-no-process", "owner-trust-review", "owner-trust-details", "owner-trust-state-detail", "owner-trust-enrollment", "owner-trust-authentication", "owner-trust-execution-detail", "owner-trust-action-detail"]) {
    expect(html).toContain(`data-testid="${id}"`);
  }
});

// FO-UX-SIMPLIFY02-M4: opening the review from a mission carries that mission and task, never another operation.
test("a mission context only matches the operation that belongs to that mission and task", () => {
  const operation = { missionId: "m1", taskId: "t1" };
  expect(operationMatchesContext(operation, null)).toBe(true);
  expect(operationMatchesContext(null, null)).toBe(true);
  expect(operationMatchesContext(operation, { missionId: "m1" })).toBe(true);
  expect(operationMatchesContext(operation, { missionId: "m1", taskId: "t1" })).toBe(true);
  expect(operationMatchesContext(operation, { missionId: "m2" })).toBe(false);
  expect(operationMatchesContext(operation, { missionId: "m1", taskId: "t2" })).toBe(false);
  expect(operationMatchesContext(null, { missionId: "m1" })).toBe(false);
  expect(operationMatchesContext(undefined, { missionId: "m1", taskId: "t1" })).toBe(false);
});

test("with a mission context and no matching operation the panel says so and the review button is disabled", async () => {
  await choose("en");
  const html = renderToStaticMarkup(<LocaleProvider><OwnerTrustPanel context={{ missionId: "m1", missionTitle: "Ship it", taskId: "t1", taskTitle: "Write tests" }} /></LocaleProvider>);
  const visible = everydayText(html);
  expect(visible).toContain("Opened from mission “Ship it”.");
  expect(visible).toContain("Task: Write tests");
  expect(visible).toContain("No operation is waiting for Owner review for this mission. Nothing was selected for you.");
  expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*data-testid="owner-trust-review"/);
  expect(html).toContain('data-testid="owner-trust-context-mismatch"');
});

test("without a mission context the review button stays enabled", async () => {
  await choose("en");
  const html = renderToStaticMarkup(<LocaleProvider><OwnerTrustPanel /></LocaleProvider>);
  expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*data-testid="owner-trust-review"/);
  expect(html).not.toContain('data-testid="owner-trust-context"');
});

test("the mission context copy exists in Russian too", async () => {
  await choose("ru");
  const html = renderToStaticMarkup(<LocaleProvider><OwnerTrustPanel context={{ missionId: "m1", missionTitle: "Релиз" }} /></LocaleProvider>);
  expect(everydayText(html)).toContain("Открыто из миссии «Релиз».");
  expect(everydayText(html)).toContain("Ничего не выбрано за вас.");
});
