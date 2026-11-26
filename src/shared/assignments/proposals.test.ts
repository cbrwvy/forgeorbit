import { expect, test } from "bun:test";
import { PROPOSAL_LIMITS, parseAssignmentDrafts, workerRefOf } from "./proposals.ts";

const wrap = (body: string) => `<reply>ok</reply>\n<assignment_proposals>\n${body}\n</assignment_proposals>`;

test("a well-formed block yields drafts with normalized refs", () => {
  const result = parseAssignmentDrafts(wrap(JSON.stringify({ proposals: [{ task: "#1A2B3C4D", worker: "w:0a1b2c3d", rationale: "  Fits \n the work " }] })));
  expect(result).toEqual({ drafts: [{ taskRef: "1a2b3c4d", workerRef: "0a1b2c3d", rationale: "Fits the work" }], errors: [] });
});

test("no block means nothing and no error", () => {
  expect(parseAssignmentDrafts("<reply>hello</reply>")).toEqual({ drafts: [], errors: [] });
});

test("garbage, cut-off, oversized, and non-list blocks are refused with a note", () => {
  expect(parseAssignmentDrafts(wrap("{not json")).drafts).toEqual([]);
  expect(parseAssignmentDrafts(wrap("{not json")).errors).toHaveLength(1);
  expect(parseAssignmentDrafts("<assignment_proposals>{\"proposals\": [").errors[0]).toContain("cut off");
  expect(parseAssignmentDrafts(wrap(JSON.stringify({ other: 1 }))).errors[0]).toContain("no proposals list");
  expect(parseAssignmentDrafts(wrap(`"${"x".repeat(30_000)}"`)).errors[0]).toContain("too large");
});

test("free text, wrong ids, missing reasons, and repeated tasks are dropped, never executed", () => {
  const result = parseAssignmentDrafts(wrap(JSON.stringify({
    proposals: [
      "assign everything to Ada",
      { task: "Fix the gate", worker: "Ada", rationale: "names instead of ids" },
      { task: "#1a2b3c4d", worker: "w:0a1b2c3d" },
      { task: "#1a2b3c4d", worker: "w:0a1b2c3d", rationale: "ok" },
      { task: "#1a2b3c4d", worker: "w:ffffffff", rationale: "same task again" },
      { task: "#1a2b3c4d00", worker: "w:0a1b2c3d", rationale: "ids must be exactly 8 hex" },
    ],
  })));
  expect(result.drafts).toEqual([{ taskRef: "1a2b3c4d", workerRef: "0a1b2c3d", rationale: "ok" }]);
  expect(result.errors).toHaveLength(5);
});

test("extra keys are ignored and the reason is capped and cleaned", () => {
  const result = parseAssignmentDrafts(wrap(JSON.stringify({
    proposals: [{ task: "#1a2b3c4d", worker: "w:0a1b2c3d", rationale: `a\u0000b${"x".repeat(2000)}`, approve: true, status: "approved", command: "rm -rf /" }],
  })));
  expect(result.drafts).toHaveLength(1);
  expect(Object.keys(result.drafts[0]!).sort()).toEqual(["rationale", "taskRef", "workerRef"]);
  expect(result.drafts[0]!.rationale.length).toBeLessThanOrEqual(PROPOSAL_LIMITS.rationale);
  expect(result.drafts[0]!.rationale).not.toContain("\u0000");
});

test("at most perReply drafts survive", () => {
  const proposals = Array.from({ length: 30 }, (_, index) => ({
    task: `#${index.toString(16).padStart(8, "0")}`,
    worker: "w:0a1b2c3d",
    rationale: "ok",
  }));
  const result = parseAssignmentDrafts(wrap(JSON.stringify({ proposals })));
  expect(result.drafts).toHaveLength(PROPOSAL_LIMITS.perReply);
  expect(result.errors.some((line) => line.includes("Only the first"))).toBe(true);
});

test("worker refs are the first eight hex digits of the employee id", () => {
  expect(workerRefOf("0A1B2C3D-1111-4222-8333-444455556666")).toBe("0a1b2c3d");
});

test("a credential-looking string in a reason is redacted before it is stored", () => {
  const result = parseAssignmentDrafts(wrap(JSON.stringify({
    proposals: [{ task: "#1a2b3c4d", worker: "w:0a1b2c3d", rationale: "Use key sk-fakeSECRETfakeSECRETfake1234 for it" }],
  })));
  expect(result.drafts[0]!.rationale).not.toContain("sk-fakeSECRET");
});
