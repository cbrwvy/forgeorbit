import { expect, test } from "bun:test";
import type { CandidateEvaluation } from "../../shared/router-v2/types.ts";
import { candidateAvailability, candidateSignedIn, capacityReading, otherEligibleOption } from "./router-candidate-state.ts";
import { refusalClearedBy } from "../../shared/provider-refusal.ts";

const refusal = { id: "r", kind: "usage-limit" as const, provider: "codex", harnessId: "h", accountId: "a", modelId: "m", observedAt: 1, surface: "developer-run", proof: "codex-cli-usage-limit" as const, retryHint: null, supersededAt: null, diagnostics: "" };
const candidate = (over: Partial<CandidateEvaluation> = {}): CandidateEvaluation => ({
  candidateId: "c", harnessId: "h", harnessLabel: "H", kind: "codex", accountId: "a", accountLabel: "A", modelId: "m", modelLabel: "M", mode: "auto", modeLabel: "Auto",
  role: "developer", eligible: true, readiness: "verified-ready", eliminationReasons: [], selectionReasons: [], warnings: [],
  scores: { quality: { score: 1, evidence: "configured", detail: "" }, cost: { score: 1, evidence: "unknown", detail: "" }, latency: { score: 1, evidence: "unknown", detail: "" }, quota: { score: 1, evidence: "unknown", detail: "", capacityClass: "unknown" }, history: { score: 1, evidence: "unknown", detail: "", runCount: 0 }, preferenceBonus: 0, totalScore: 1 },
  ...over,
} as CandidateEvaluation);

test("four states stay apart: refused, ineligible for another reason, unverified, verified", () => {
  expect(candidateAvailability(candidate())).toBe("unverified");
  expect(candidateAvailability(candidate({ providerRefusal: refusal }))).toBe("refused");
  expect(candidateAvailability(candidate({ eligible: false, eliminationReasons: ["active-block: x"] }))).toBe("ineligible");
  // A refusal on an ineligible candidate does not hide the separate reason.
  expect(candidateAvailability(candidate({ eligible: false, providerRefusal: refusal }))).toBe("ineligible");
  const verified = candidate();
  verified.scores.quota.capacityClass = "verified-sufficient";
  expect(candidateAvailability(verified)).toBe("verified");
});

test("signed in is read from readiness, separately from capacity", () => {
  expect(candidateSignedIn(candidate({ readiness: "installed" }))).toBe(false);
  expect(candidateSignedIn(candidate({ readiness: "verified-ready" }))).toBe(true);
});

test("another option is only named beside a refused selection: a different account, not refused, eligible", () => {
  const refused = candidate({ candidateId: "1", providerRefusal: refusal });
  const sameAccount = candidate({ candidateId: "2", modelId: "m2" });
  const other = candidate({ candidateId: "3", accountId: "b", accountLabel: "B" });
  const alsoRefused = candidate({ candidateId: "4", accountId: "c", providerRefusal: { ...refusal, accountId: "c" } });
  expect(otherEligibleOption(refused, [refused, sameAccount, alsoRefused, other])?.candidateId).toBe("3");
  expect(otherEligibleOption(refused, [refused, sameAccount, alsoRefused])).toBeNull();
  expect(otherEligibleOption(other, [refused, other])).toBeNull();
  expect(otherEligibleOption(null, [other])).toBeNull();
});

test("only an answer on the same harness, account and model clears a refusal; unidentified stays unidentified", () => {
  const answer = { harnessId: "h", accountId: "a", modelId: "m" };
  expect(refusalClearedBy(refusal, answer)).toBe(true);
  expect(refusalClearedBy(refusal, { ...answer, accountId: "b" })).toBe(false);
  expect(refusalClearedBy(refusal, { ...answer, accountId: null })).toBe(false);
  expect(refusalClearedBy(refusal, { ...answer, modelId: "m2" })).toBe(false);
  expect(refusalClearedBy(refusal, { ...answer, harnessId: "h2" })).toBe(false);
  expect(refusalClearedBy({ ...refusal, modelId: null }, answer)).toBe(false);
  expect(refusalClearedBy({ ...refusal, accountId: null }, { ...answer, accountId: null })).toBe(true);
  expect(refusalClearedBy({ ...refusal, supersededAt: 5 }, answer)).toBe(false);
});

test("capacity is its own reading: a refusal never hides it and never creates it", () => {
  const withClass = (capacityClass: NonNullable<CandidateEvaluation["scores"]["quota"]["capacityClass"]>, over: Partial<CandidateEvaluation> = {}) => {
    const c = candidate(over);
    c.scores.quota.capacityClass = capacityClass;
    return c;
  };
  expect(capacityReading(withClass("verified-insufficient"))).toBe("shortfall");
  expect(capacityReading(withClass("verified-sufficient"))).toBe("verified");
  expect(capacityReading(withClass("unknown"))).toBe("unknown");
  for (const unverified of ["owner-reported", "stale", "configured-unverified"] as const) expect(capacityReading(withClass(unverified))).toBe("unverified");
  // Refused + Unknown capacity: the availability state reads refused, the capacity still reads Unknown.
  const refusedUnknown = withClass("unknown", { providerRefusal: refusal });
  expect(candidateAvailability(refusedUnknown)).toBe("refused");
  expect(capacityReading(refusedUnknown)).toBe("unknown");
  // Refused + verified capacity: the refusal does not remove verified capacity either.
  expect(capacityReading(withClass("verified-sufficient", { providerRefusal: refusal }))).toBe("verified");
  // No capacity class at all is Unknown, never verified.
  const none = candidate();
  delete (none.scores.quota as { capacityClass?: unknown }).capacityClass;
  expect(capacityReading(none)).toBe("unknown");
});
