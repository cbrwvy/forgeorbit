import { expect, test } from "bun:test";

import {
  classifyComposeProject,
  composeStartDecision,
  composeStopPermitted,
  FO_LABEL_PROFILE,
  FO_LABEL_TOKEN,
  type ComposeContainerSnapshot,
  type ComposeExpectation,
} from "./compose-ownership.ts";

const expected: ComposeExpectation = {
  projectName: "fo-example-project",
  workingDir: "/work/example-project",
  composeFile: "/work/example-project/compose.yaml",
  profileId: "example-project",
  token: "cd".repeat(16),
  recordedIds: ["aaaaaaaaaaaa"],
  tokenApplied: true,
};

function container(overrides: Partial<ComposeContainerSnapshot> = {}): ComposeContainerSnapshot {
  return {
    id: "aaaaaaaaaaaa",
    service: "web",
    state: "running",
    project: expected.projectName,
    workingDir: expected.workingDir,
    configFiles: [expected.composeFile, "/tmp/labels.yml"],
    labels: {
      [FO_LABEL_PROFILE]: expected.profileId,
      [FO_LABEL_TOKEN]: expected.token ?? "",
    },
    ...overrides,
  };
}

test("a labeled container for this project is managed and may be stopped", () => {
  const view = classifyComposeProject([container()], expected);
  expect(view.kind).toBe("managed");
  expect(composeStartDecision(view)).toBe("already");
  expect(composeStopPermitted(view)).toBe(true);
});

test("another project's containers are foreign even if the project name was reused", () => {
  const foreign = classifyComposeProject(
    [container({ project: "fo-example-portal", workingDir: "/work/example-portal", configFiles: ["/work/example-portal/compose.yaml"] })],
    expected,
  );
  expect(foreign.kind).toBe("foreign");
  expect(composeStopPermitted(foreign)).toBe(false);
  expect(composeStartDecision(foreign)).toBe("refuse");
});

test("the same compose identity without our token is external and must not be stopped", () => {
  const external = classifyComposeProject([container({ labels: {} })], { ...expected, tokenApplied: true });
  expect(external.kind).toBe("external");
  expect(composeStopPermitted(external)).toBe(false);
  expect(composeStartDecision(external)).toBe("refuse");
});

test("an empty project is absent, and exact container ids prove ownership when labels were not applied", () => {
  expect(classifyComposeProject([], expected).kind).toBe("absent");
  const byId = classifyComposeProject([container({ labels: {} })], {
    ...expected,
    tokenApplied: false,
    recordedIds: ["aaaaaaaaaaaa"],
  });
  expect(byId.kind).toBe("managed");
  const drifted = classifyComposeProject([container({ id: "bbbbbbbbbbbb", labels: {} })], {
    ...expected,
    tokenApplied: false,
    recordedIds: ["aaaaaaaaaaaa"],
  });
  expect(drifted.kind).toBe("drift");
  expect(composeStopPermitted(drifted)).toBe(false);
});
