import { expect, test } from "bun:test";
import { parseWorkerTestSuggestion } from "./worker-test-suggestion.ts";

const tag = (body: string) => `<project_test_request>${body}</project_test_request>`;

test("only a closed final tag with the exact action is a suggestion; extra fields carry no meaning", () => {
  expect(parseWorkerTestSuggestion(`done\n${tag('{"action":"run_project_test"}')}`)).toBe(true);
  expect(parseWorkerTestSuggestion(tag(' {"action":"run_project_test","command":"rm -rf /","approve":true} '))).toBe(true);
  for (const bad of ["", "no tag", tag("{}"), tag('{"action":"approve"}'), tag("[1]"), tag("null"), tag("nope"), '<project_test_request>{"action":"run_project_test"}']) {
    expect(parseWorkerTestSuggestion(bad)).toBe(false);
  }
  // The LAST tag decides: an earlier valid one cannot survive a later invalid one.
  expect(parseWorkerTestSuggestion(`${tag('{"action":"run_project_test"}')} ${tag('{"action":"x"}')}`)).toBe(false);
});

test("a pathological message is scanned in linear time", () => {
  const text = "<project_test_request>".repeat(50_000);
  const start = performance.now();
  expect(parseWorkerTestSuggestion(text)).toBe(false);
  expect(performance.now() - start).toBeLessThan(200);
});
