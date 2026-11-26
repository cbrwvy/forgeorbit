import { expect, test } from "bun:test";
import { describeNoQualifier, summarizeNoQualifier } from "./no-qualifier.ts";

const row = (reasons: string[], refused = false) => ({
  eliminationReasons: reasons,
  providerRefusal: refused ? ({ id: "r" } as never) : null,
});

test("a known capacity shortfall, Unknown capacity and a provider refusal are three different things", () => {
  const summary = summarizeNoQualifier([
    row(["quota-exhausted: Verified quota is completely exhausted."]),
    row(["shared-pool-exhausted: The shared quota pool has no remaining verified capacity."]),
    row(["quota-unknown-strict: Strict quota policy rejects candidates whose quota cannot be verified."]),
    row(["quota-unverified-strict: Strict quota policy rejects stale capacity."]),
    row(["account-unauthenticated: Account credentials or login missing."]),
    row(["cursor-internal-sandbox-unavailable: x"]),
    row(["concurrency-limit-reached: Concurrency limit (1) fully occupied."]),
    row(["owner-account-disallowed: Account not in Owner allowed list."]),
    row(["something-new: surprise"]),
    // refused AND capacity-unknown: the refusal is counted apart and does not change the capacity count.
    row(["quota-unknown-strict: Strict quota policy rejects candidates whose quota cannot be verified."], true),
  ]);
  expect(summary.total).toBe(10);
  expect(summary.byCategory["known-shortfall"]).toBe(2);
  expect(summary.byCategory["unknown-capacity"]).toBe(3);
  expect(summary.byCategory["not-signed-in"]).toBe(1);
  expect(summary.byCategory["blocked-provider"]).toBe(1);
  expect(summary.byCategory["concurrency"]).toBe(1);
  expect(summary.byCategory["owner-policy"]).toBe(1);
  expect(summary.byCategory["other"]).toBe(1);
  expect(summary.refused).toBe(1);
});

test("a refusal alone never reads as a shortfall or as Unknown capacity", () => {
  const summary = summarizeNoQualifier([row(["owner-harness-disallowed: x"], true)]);
  expect(summary.byCategory["known-shortfall"]).toBe(0);
  expect(summary.byCategory["unknown-capacity"]).toBe(0);
  expect(summary.refused).toBe(1);
});

test("the English sentence names each non-empty category and the refusal count, never a recommendation", () => {
  const text = describeNoQualifier(summarizeNoQualifier([
    row(["quota-exhausted: x"]),
    row(["quota-unknown-strict: x"], true),
  ]));
  expect(text).toContain("known capacity shortfall");
  expect(text).toContain("Unknown capacity");
  expect(text).toContain("provider refusal");
  expect(text).not.toContain("0 ");
  expect(describeNoQualifier(summarizeNoQualifier([]))).toBe("");
});
