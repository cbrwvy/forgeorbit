import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HANDSOFF_POLICY,
  effectiveHandsoffPolicy,
  fixDecision,
  handsoffPolicyWidens,
  hasResource,
  normalizeFindings,
  parseHandsoffPolicy,
  textFingerprint,
  type HandsoffPolicy,
} from "./handsoff.ts";

const pol = (body: Record<string, unknown>, base: HandsoffPolicy = DEFAULT_HANDSOFF_POLICY): HandsoffPolicy => {
  const parsed = parseHandsoffPolicy(body, base);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.policy;
};
const on: HandsoffPolicy = pol({ enabled: true, autoApply: true, harnessIds: ["codex"], accountIds: ["default", "acct-1"] });

describe("policy parsing is strict", () => {
  test("off by default and nothing covered", () => {
    expect(DEFAULT_HANDSOFF_POLICY).toMatchObject({ enabled: false, autoApply: false, harnessIds: [], accountIds: [] });
  });
  test("unknown fields, wrong types and out-of-range numbers are refused, not clamped or ignored", () => {
    for (const bad of [{ surprise: true }, { enabled: "yes" }, { maxFixRounds: 4 }, { maxFixRounds: -1 }, { maxParallel: 0 }, { maxParallel: 1.5 }, { harnessIds: "codex" }, { accountIds: [""] }, { harnessIds: ["a\u0000b"] }, [], null, "x"]) {
      expect(parseHandsoffPolicy(bad).ok).toBe(false);
    }
  });
  test("lists are de-duplicated and sorted; a partial body keeps the base", () => {
    const parsed = parseHandsoffPolicy({ harnessIds: ["b", "a", "b"] }, on);
    expect(parsed.ok && parsed.policy).toMatchObject({ harnessIds: ["a", "b"], enabled: true, autoApply: true });
  });
});

describe("a step is held to the narrower of the frozen and the live policy", () => {
  test("turning it off, or removing coverage, takes effect; adding coverage never widens earlier work", () => {
    expect(effectiveHandsoffPolicy(on, { ...on, enabled: false }).enabled).toBe(false);
    expect(effectiveHandsoffPolicy(on, null).enabled).toBe(false);
    const narrower = effectiveHandsoffPolicy(on, pol({ autoApply: false, accountIds: ["default"], maxFixRounds: 0, maxParallel: 1 }, on));
    expect(narrower).toMatchObject({ autoApply: false, accountIds: ["default"], maxFixRounds: 0, maxParallel: 1, enabled: true });
    const wider = effectiveHandsoffPolicy(pol({ autoApply: false, accountIds: ["default"] }, on), pol({ autoApply: true, accountIds: ["default", "acct-1", "acct-2"] }, on));
    expect(wider.autoApply).toBe(false);
    expect(wider.accountIds).toEqual(["default"]);
  });
  test("an expansion is reported by name", () => {
    expect(handsoffPolicyWidens(on, { ...on, autoDone: false, maxFixRounds: 1 })).toEqual([]);
    expect(handsoffPolicyWidens({ ...on, autoApply: false }, pol({ accountIds: [...on.accountIds, "acct-9"] }, on))).toEqual(expect.arrayContaining(["autoApply", "resources"]));
  });
});

describe("a correction is bounded, and a loop is not progress", () => {
  const base = { round: 0, maxFixRounds: 2, qcRoundsUsed: 1, qcMaxRounds: 5, findingsHash: "a", previousFindingsHash: null, sourceFingerprint: "s1", previousFingerprint: null };
  test("starts a correction while rounds remain", () => expect(fixDecision(base)).toEqual({ kind: "fix" }));
  test("stops at the policy limit and at the review round limit", () => {
    expect(fixDecision({ ...base, round: 2 })).toMatchObject({ kind: "stop", code: "review-limit" });
    expect(fixDecision({ ...base, qcRoundsUsed: 5 })).toMatchObject({ kind: "stop", code: "review-limit" });
    expect(fixDecision({ ...base, maxFixRounds: 0 })).toMatchObject({ kind: "stop", code: "review-limit" });
  });
  test("the same findings again stops, whether or not the source changed after a correction round", () => {
    expect(fixDecision({ ...base, round: 1, previousFindingsHash: "a", previousFingerprint: "s1" })).toMatchObject({ kind: "stop", code: "no-progress" });
    expect(fixDecision({ ...base, round: 1, previousFindingsHash: "a", previousFingerprint: "s0" })).toMatchObject({ kind: "stop", code: "no-progress" });
    expect(fixDecision({ ...base, round: 1, previousFindingsHash: "b", previousFingerprint: "s0" })).toEqual({ kind: "fix" });
  });
});

describe("findings compare by their words", () => {
  test("timings, digests and absolute paths do not make a repeated finding look new", () => {
    const a = "Exit code 1.\nerror: expected throw [2.31ms] at /private/var/x/data/task-workspaces/aaa/src/p.test.ts:4\nEvidence 0123456789ab";
    const b = "Exit code 1.\nerror: expected throw [3.02ms] at /private/var/y/data/task-workspaces/bbb/src/p.test.ts:4\nEvidence ba9876543210";
    expect(normalizeFindings(a)).toBe(normalizeFindings(b));
    expect(textFingerprint(normalizeFindings(a))).toBe(textFingerprint(normalizeFindings(b)));
    expect(textFingerprint("one")).not.toBe(textFingerprint("two"));
  });
});

describe("covered resources are exact role + harness + account pairs", () => {
  const sub = { harnessId: "codex-sub", accountKey: "acct-1" };
  const def = { harnessId: "codex", accountKey: "default" };
  const twoRoles = pol({ enabled: true, resources: [{ role: "developer", ...def }, { role: "reviewer", ...def }, { role: "developer", ...sub }, { role: "reviewer", ...sub }] });
  test("clearing one row removes only that pair: the other role's row for the same login, and the other profile, stay as they were", () => {
    const next = pol({ resources: twoRoles.resources.filter((r) => !(r.role === "developer" && r.harnessId === "codex")) }, twoRoles);
    expect(hasResource(next.resources, "developer", "codex", "default")).toBe(false);
    expect(hasResource(next.resources, "reviewer", "codex", "default")).toBe(true);
    expect(hasResource(next.resources, "developer", "codex-sub", "acct-1")).toBe(true);
  });
  test("only the subscription pair covers nothing else, and the plain lists derived from it say so", () => {
    const only = pol({ enabled: true, resources: [{ role: "developer", ...sub }, { role: "reviewer", ...sub }] });
    expect(only.harnessIds).toEqual(["codex-sub"]);
    expect(only.accountIds).toEqual(["acct-1"]);
    expect(hasResource(only.resources, "developer", "codex", "default")).toBe(false);
    expect(hasResource(only.resources, "developer", "codex", "acct-1")).toBe(false);
    expect(hasResource(only.resources, "reviewer", "codex-sub", "default")).toBe(false);
  });
  test("two plain lists keep their old meaning (every pair, both roles); pairs and a contradicting plain list in one body are refused", () => {
    const legacy = pol({ harnessIds: ["a", "b"], accountIds: ["x"] });
    expect(legacy.resources).toHaveLength(4);
    expect(parseHandsoffPolicy({ resources: [], harnessIds: ["a"] }).ok).toBe(false);
    const both = pol({ resources: [{ role: "developer", harnessId: "a", accountKey: "x" }] });
    expect(parseHandsoffPolicy({ ...both }).ok).toBe(true);
    expect(parseHandsoffPolicy({ ...both, harnessIds: ["a", "b"] }).ok).toBe(false);
    expect(parseHandsoffPolicy({ resources: [{ role: "admin", harnessId: "a", accountKey: "b" }] }).ok).toBe(false);
    expect(parseHandsoffPolicy({ resources: [{ role: "developer", harnessId: "a", accountKey: "b", extra: 1 }] }).ok).toBe(false);
  });
  test("a step is held to the intersection of the frozen and the live pairs; a pair added later never widens earlier work", () => {
    const frozen = pol({ enabled: true, resources: [{ role: "developer", ...sub }] });
    const live = pol({ enabled: true, resources: [{ role: "developer", ...sub }, { role: "reviewer", ...sub }, { role: "developer", ...def }] });
    expect(effectiveHandsoffPolicy(frozen, live).resources).toEqual([{ role: "developer", ...sub }]);
    expect(effectiveHandsoffPolicy(live, frozen).resources).toEqual([{ role: "developer", ...sub }]);
    expect(handsoffPolicyWidens(frozen, live)).toContain("resources");
  });
});
