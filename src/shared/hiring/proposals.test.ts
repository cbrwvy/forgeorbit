import { describe, expect, it } from "bun:test";
import {
  hiringProposalStatusLabel,
  hiringProposalStatusTone,
  parseHiringDrafts,
} from "./proposals.ts";

describe("parseHiringDrafts", () => {
  it("returns empty drafts when no tag is present", () => {
    const res = parseHiringDrafts("Here is a general recommendation for your project.");
    expect(res.drafts).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it("parses valid hiring proposal inside <hiring_proposals>", () => {
    const text = `
I recommend hiring a frontend specialist:
<hiring_proposals>
{
  "proposals": [
    {
      "name": "Alex",
      "role_slug": "engineering-frontend-developer",
      "title": "Senior Frontend Developer",
      "justification": "Needs to build responsive React UI components.",
      "competencies": ["React", "TypeScript", "Tailwind CSS"],
      "related_tasks": ["#1a2b3c4d"],
      "adapted_prompt": "# Custom Frontend Instructions\\nFocus on accessible design."
    }
  ]
}
</hiring_proposals>
    `;
    const res = parseHiringDrafts(text);
    expect(res.errors).toEqual([]);
    expect(res.drafts.length).toBe(1);
    expect(res.drafts[0]).toEqual({
      name: "Alex",
      roleSlug: "engineering-frontend-developer",
      title: "Senior Frontend Developer",
      justification: "Needs to build responsive React UI components.",
      competencies: ["React", "TypeScript", "Tailwind CSS"],
      relatedTasks: ["1a2b3c4d"],
      adaptedPrompt: "# Custom Frontend Instructions\nFocus on accessible design.",
    });
  });

  it("parses multiple catalog roles and handles code fences", () => {
    const text = `
<team_hiring_proposals>
\`\`\`json
{
  "proposals": [
    {
      "name": "Jane",
      "role_slug": "engineering-frontend-developer",
      "justification": "Frontend developer for SPA.",
      "competencies": ["React"]
    },
    {
      "name": "Bob",
      "role_slug": "engineering-backend-architect",
      "title": "Backend Architect",
      "justification": "System architecture and Bun/SQLite design.",
      "competencies": ["Bun", "SQLite"]
    },
    {
      "name": "Charlie",
      "role_slug": "testing-reality-checker",
      "justification": "E2E and Playwright verification.",
      "competencies": ["Playwright"]
    }
  ]
}
\`\`\`
</team_hiring_proposals>
    `;
    const res = parseHiringDrafts(text);
    expect(res.errors).toEqual([]);
    expect(res.drafts.length).toBe(3);
    expect(res.drafts.map((d) => d.roleSlug)).toEqual([
      "engineering-frontend-developer",
      "engineering-backend-architect",
      "testing-reality-checker",
    ]);
  });

  it("handles malformed manager output and invalid JSON", () => {
    const badJson = `
<hiring_proposals>
{ proposals: [ not valid json ] }
</hiring_proposals>
    `;
    const res = parseHiringDrafts(badJson);
    expect(res.drafts).toEqual([]);
    expect(res.errors).toContain("The team hiring suggestion was not valid JSON, so none was recorded.");
  });

  it("handles cut off / truncated tag body", () => {
    const truncated = `<hiring_proposals>{"proposals": [`;
    const res = parseHiringDrafts(truncated);
    expect(res.drafts).toEqual([]);
    expect(res.errors).toContain("The team hiring suggestion was cut off, so none was recorded.");
  });

  it("drops entries with missing slug, missing justification, or non-object", () => {
    const text = `
<hiring_proposals>
{
  "proposals": [
    "not an object",
    { "role_slug": "INVALID SLUG WITH SPACES", "justification": "Reason" },
    { "role_slug": "engineering-frontend-developer" },
    { "justification": "Only reason without slug" },
    {
      "role_slug": "engineering-frontend-developer",
      "justification": "Valid proposal"
    }
  ]
}
</hiring_proposals>
    `;
    const res = parseHiringDrafts(text);
    expect(res.drafts.length).toBe(1);
    expect(res.drafts[0]!.roleSlug).toBe("engineering-frontend-developer");
    expect(res.errors.length).toBe(4);
  });

  it("deduplicates identical role slugs within one proposal draft", () => {
    const text = `
<hiring_proposals>
{
  "proposals": [
    { "role_slug": "engineering-frontend-developer", "justification": "First dev" },
    { "role_slug": "engineering-frontend-developer", "justification": "Duplicate dev" }
  ]
}
</hiring_proposals>
    `;
    const res = parseHiringDrafts(text);
    expect(res.drafts.length).toBe(1);
    expect(res.drafts[0]!.justification).toBe("First dev");
    expect(res.errors).toContain('Suggestion 2 repeated role slug "engineering-frontend-developer".');
  });

  it("enforces maximum limit per reply", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      role_slug: `engineering-role-${i}`,
      justification: `Reason for role ${i}`,
    }));
    const text = `<hiring_proposals>${JSON.stringify({ proposals: items })}</hiring_proposals>`;
    const res = parseHiringDrafts(text);
    expect(res.drafts.length).toBe(10);
    expect(res.errors).toContain("Only the first 10 suggestions were kept.");
  });

  it("sanitizes text, caps limits, and removes control characters", () => {
    const dirtyJustification = "Needs to build \u0000\u001fUI with secret sk-ant-api03-abcdef1234567890abcdef1234567890.";
    const text = `
<hiring_proposals>
{
  "proposals": [
    {
      "role_slug": "engineering-frontend-developer",
      "justification": "${dirtyJustification}"
    }
  ]
}
</hiring_proposals>
    `;
    const res = parseHiringDrafts(text);
    expect(res.drafts.length).toBe(1);
    expect(res.drafts[0]!.justification).not.toContain("sk-ant-api03-");
    expect(res.drafts[0]!.justification).not.toContain("\u0000");
  });

  it("returns appropriate status labels and tones", () => {
    expect(hiringProposalStatusLabel("pending")).toBe("Pending Review");
    expect(hiringProposalStatusLabel("approved")).toBe("Approved");
    expect(hiringProposalStatusLabel("rejected")).toBe("Rejected");

    expect(hiringProposalStatusTone("pending")).toBe("warning");
    expect(hiringProposalStatusTone("approved")).toBe("success");
    expect(hiringProposalStatusTone("rejected")).toBe("danger");
  });
});
