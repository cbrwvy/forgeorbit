import { expect, test } from "bun:test";
import { describeEstimateBasis, type EstimateBasisSource } from "./estimate-basis.ts";

const base: EstimateBasisSource = {
  roles: ["developer", "reviewer"], technology: "JavaScript/TypeScript", category: "task", complexity: "low",
  workerId: null, dependsOn: [], plannedResource: { harnessId: "codex", modelId: "m", accountId: null, mode: "auto" },
  developer: { basis: "heuristic", samples: 0 }, reviewer: { basis: "heuristic", samples: 0 }, plannedUsage: { totals: [] },
};

test("no comparable history reads as a cold-start heuristic and names what is unknown", () => {
  const basis = describeEstimateBasis(base);
  expect(basis.kind).toBe("heuristic");
  expect(basis.required).toBe(3);
  expect(basis.stages).toEqual([{ role: "developer", basis: "heuristic", samples: 0 }, { role: "reviewer", basis: "heuristic", samples: 0 }]);
  expect(basis.inputs).toEqual(["scope", "resource"]);
  expect(basis.unknowns).toEqual(["subscription", "cost", "account", "human-wait"]);
});

test("two outcomes stay a heuristic and keep the count they were short by", () => {
  const basis = describeEstimateBasis({ ...base, developer: { basis: "heuristic", samples: 2 } });
  expect(basis.kind).toBe("heuristic");
  expect(basis.stages[0]).toEqual({ role: "developer", basis: "heuristic", samples: 2 });
});

test("one calibrated stage is partial and two are historical", () => {
  expect(describeEstimateBasis({ ...base, developer: { basis: "historical", samples: 3 } }).kind).toBe("partial");
  expect(describeEstimateBasis({ ...base, developer: { basis: "historical", samples: 4 }, reviewer: { basis: "historical", samples: 3 } }).kind).toBe("historical");
  // A Developer-only estimate is judged on the stages it has.
  expect(describeEstimateBasis({ ...base, roles: ["developer"], developer: { basis: "historical", samples: 3 } }).kind).toBe("historical");
});

test("worker, dependencies, a priced account and an unknown stack change what is named", () => {
  const basis = describeEstimateBasis({
    ...base, workerId: "w", dependsOn: ["a"], technology: "unknown",
    plannedResource: { harnessId: "codex", modelId: "m", accountId: "acct", mode: "auto" },
    plannedUsage: { totals: [{}] },
  });
  expect(basis.inputs).toEqual(["scope", "resource", "worker", "dependencies"]);
  expect(basis.unknowns).toEqual(["subscription", "technology", "human-wait"]);
});

test("a missing stage option is none, never historical", () => {
  const basis = describeEstimateBasis({ ...base, developer: null, reviewer: null });
  expect(basis.kind).toBe("heuristic");
  expect(basis.stages.map(stage => stage.basis)).toEqual(["none", "none"]);
});
