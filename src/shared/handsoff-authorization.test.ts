import { describe, expect, test } from "bun:test";
import { DEFAULT_HANDSOFF_POLICY, parseHandsoffPolicy, type HandsoffPolicy } from "./handsoff.ts";
import { envelopeFrom, launchClaimKey, policyWithinEnvelope } from "./handsoff-authorization.ts";
import { envelopeDigest, projectIdentityOf } from "./handsoff-authorization-digest.ts";
import { OWNER_TRUST_SCHEMA, expectedScope, parseOwnerOperation, sha256Hex } from "./owner-trust/protocol.ts";

const pol = (body: Record<string, unknown>, base: HandsoffPolicy = DEFAULT_HANDSOFF_POLICY): HandsoffPolicy => {
  const parsed = parseHandsoffPolicy(body, base);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.policy;
};
const policy: HandsoffPolicy = pol({ enabled: true, autoApply: true, harnessIds: ["codex-p"], accountIds: ["acct-1"], maxFixRounds: 2 });
const envelope = envelopeFrom({ policy, projectPath: "/p", projectIdentity: projectIdentityOf("/p", 1), developerModels: ["m2", "m1", "m1"], reviewerModels: ["m1"], launchBudget: 12 });

describe("the envelope names what is signed", () => {
  test("sorted, de-duplicated, one digest, a different project is a different identity", () => {
    expect(envelope.developerModels).toEqual(["m1", "m2"]);
    expect(envelopeDigest(envelope)).toBe(envelopeDigest({ ...envelope }));
    expect(envelopeDigest({ ...envelope, launchBudget: 13 })).not.toBe(envelopeDigest(envelope));
    expect(projectIdentityOf("/p", 1)).not.toBe(projectIdentityOf("/p", 2));
  });
  test("a launch claim key is unique per run, role, round and intent", () => {
    const base = { handsoffRunId: "r", role: "developer" as const, round: 0, intentAt: 1 };
    expect(launchClaimKey(base)).toBe(launchClaimKey({ ...base }));
    for (const other of [{ ...base, role: "reviewer" as const }, { ...base, round: 1 }, { ...base, intentAt: 2 }, { ...base, handsoffRunId: "s" }]) {
      expect(launchClaimKey(other)).not.toBe(launchClaimKey(base));
    }
  });
});

describe("narrowing and cosmetic edits stay inside; anything wider does not", () => {
  test("cosmetic and narrower", () => {
    expect(policyWithinEnvelope(policy, envelope)).toEqual({ ok: true });
    expect(policyWithinEnvelope({ ...policy, autoAssign: false, requireTest: true, maxParallel: 1 }, envelope)).toEqual({ ok: true });
    expect(policyWithinEnvelope(pol({ autoApply: false, autoDone: false, maxFixRounds: 0, runOfflineTests: false, accountIds: [] }, policy), envelope)).toEqual({ ok: true });
  });
  test("wider", () => {
    const narrow = envelopeFrom({ policy: { ...policy, autoApply: false, runOfflineTests: false, autoDone: false, acknowledgeUsageNotice: false, maxFixRounds: 1 }, projectPath: "/p", projectIdentity: "x", developerModels: ["m"], reviewerModels: ["m"], launchBudget: 1 });
    const wide = pol({ harnessIds: ["codex-p", "other"], accountIds: ["acct-1", "acct-2"], autoApply: true, autoDone: true, runOfflineTests: true, acknowledgeUsageNotice: true, maxFixRounds: 3 }, policy);
    const result = policyWithinEnvelope(wide, narrow);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasons.sort()).toEqual(["accounts", "apply", "billing", "done", "fix-rounds", "harnesses", "resources", "tests"].sort());
    expect(policyWithinEnvelope({ ...policy, enabled: false }, envelope)).toEqual({ ok: false, reasons: ["off"] });
  });
});

describe("the envelope covers exact role + harness + account pairs", () => {
  const sub = { harnessId: "codex-sub", accountKey: "acct-1" };
  const onlySub = pol({ enabled: true, resources: [{ role: "developer", ...sub }, { role: "reviewer", ...sub }] });
  const env = envelopeFrom({ policy: onlySub, projectPath: "/p", projectIdentity: "x", developerModels: ["m"], reviewerModels: ["m"], launchBudget: 2 });
  test("only the chosen pairs are in the signed envelope", () => {
    expect(env.resources).toEqual([{ role: "developer", ...sub }, { role: "reviewer", ...sub }]);
    expect(env.harnessIds).toEqual(["codex-sub"]);
  });
  test("a pair for another role or another profile is wider, even when its harness and account appear elsewhere", () => {
    const both = pol({ resources: [{ role: "developer", ...sub }, { role: "reviewer", harnessId: "codex", accountKey: "default" }] });
    expect(policyWithinEnvelope(both, env)).toMatchObject({ ok: false });
    // The two plain lists cover the cross product; the envelope built from pairs does not contain it.
    const crossed = pol({ harnessIds: ["codex-sub", "codex"], accountIds: ["acct-1", "default"] });
    const res = policyWithinEnvelope(crossed, env);
    expect(!res.ok && res.reasons).toContain("resources");
    // The same pair for the Developer only is narrower and stays inside.
    expect(policyWithinEnvelope(pol({ enabled: true, resources: [{ role: "developer", ...sub }] }), env)).toEqual({ ok: true });
  });
});

describe("the project-envelope operation is a distinct, narrow kind", () => {
  const now = 1_000_000;
  const raw = (patch: Record<string, unknown> = {}) => {
    const missionId = "handsoff:abc";
    return {
      schema: OWNER_TRUST_SCHEMA, requestId: "r1", kind: "project-envelope", projectPath: "/p", taskId: "policy-envelope", missionId, missionRevision: "d".repeat(64),
      role: "policy-envelope", providerId: "policy-envelope", harnessId: "codex-p", modelId: "policy-envelope", accountId: "acct-1", mode: "m", workspace: "/p",
      filesystem: "policy-envelope", terminalAllowed: false, browserAllowed: false, computerUseAllowed: false, gitRead: false, gitPublish: false, deploymentAllowed: false,
      envelopeId: "handsoff-project", envelopeDigest: sha256Hex("e"), policyRevision: "3",
      scope: expectedScope({ kind: "project-envelope", role: "policy-envelope", providerId: "policy-envelope", accountId: "acct-1", modelId: "policy-envelope", missionId, policyRevision: "3" }),
      runId: "policy-envelope", attemptId: "none", knownCost: "unknown", costCoverage: "unknown-subscription", expiresAt: now + 3_600_000, cancellationAvailable: true,
      externalProcess: true, taskStateDigest: "s", missionStateDigest: "s", ...patch,
    };
  };
  test("parses when it names exactly one project and nothing privileged", () => {
    expect(parseOwnerOperation(raw(), now).ok).toBe(true);
  });
  test("refuses a named launch, another scope, a missing project, git read or privileged flags", () => {
    for (const patch of [{ role: "developer" }, { providerId: "codex" }, { filesystem: "workspace-write" }, { taskId: "t1" }, { projectPath: "policy-envelope" }, { missionId: "mission-1" }, { gitRead: true }, { gitPublish: true }, { browserAllowed: true }, { scope: "single:x" }]) {
      expect([JSON.stringify(patch), parseOwnerOperation(raw(patch), now).ok]).toEqual([JSON.stringify(patch), false]);
    }
  });
  test("valid for at most the bounded-grant ceiling", () => {
    expect(parseOwnerOperation(raw({ expiresAt: now + 25 * 3_600_000 }), now).ok).toBe(false);
    expect(parseOwnerOperation(raw({ expiresAt: now - 1 }), now).ok).toBe(false);
  });
});

describe("modules the webview imports stay free of node and crypto", () => {
  test("no runtime import of node:* or the Owner-trust protocol", async () => {
    for (const file of ["handsoff.ts", "handsoff-authorization.ts"]) {
      const text = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
      const imports = text.split("\n").filter((line) => /^import\s/.test(line) && !/^import type/.test(line) && /node:|owner-trust|bun:/.test(line));
      expect([file, imports]).toEqual([file, []]);
    }
  });
});
