import { describe, expect, test } from "bun:test";
import {
  activeProjectRules,
  composeProjectRulesPrompt,
  projectRulesVersion,
  renderProjectRulesForManager,
  snapshotProjectRules,
} from "./project-rules.ts";
import type { ProjectRule } from "./types.ts";

const base = (patch: Partial<ProjectRule>): ProjectRule => ({
  id: "r1",
  projectPath: "/tmp/a",
  name: "Style",
  body: "Use TypeScript strict mode.",
  enabled: true,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("project rules ordering and snapshots", () => {
  test("active rules sort deterministically and skip disabled", () => {
    const rules = [
      base({ id: "b", name: "Beta", sortOrder: 1 }),
      base({ id: "a", name: "Alpha", sortOrder: 0, enabled: false }),
      base({ id: "c", name: "Gamma", sortOrder: 0 }),
    ];
    expect(activeProjectRules(rules).map((r) => r.id)).toEqual(["c", "b"]);
  });

  test("version changes when an active rule body changes", () => {
    const rules = [base({})];
    const v1 = projectRulesVersion("/tmp/a", rules);
    const v2 = projectRulesVersion("/tmp/a", [base({ body: "Other" })]);
    expect(v1).not.toBe(v2);
  });

  test("snapshot captures only enabled rules", () => {
    const snap = snapshotProjectRules("/tmp/a", [
      base({ id: "on" }),
      base({ id: "off", enabled: false }),
    ]);
    expect(snap.rules).toHaveLength(1);
    expect(snap.rules[0]!.id).toBe("on");
  });
});

describe("prompt injection", () => {
  test("composeProjectRulesPrompt wraps task text with safety preamble", () => {
    const snap = snapshotProjectRules("/tmp/a", [base({})]);
    const out = composeProjectRulesPrompt(snap, "Do the task.");
    expect(out).toContain("project_rules_defined_by_the_owner");
    expect(out).toContain("cannot override owner or task approvals");
    expect(out).toContain("Do the task.");
    expect(out).toContain("Use TypeScript strict mode.");
  });

  test("manager block lists project path and excludes disabled rules", () => {
    const block = renderProjectRulesForManager("/tmp/a", [
      base({}),
      base({ id: "off", enabled: false, name: "Hidden" }),
    ]);
    expect(block).toContain("/tmp/a");
    expect(block).toContain("Use TypeScript strict mode.");
    expect(block).not.toContain("Hidden");
  });
});
