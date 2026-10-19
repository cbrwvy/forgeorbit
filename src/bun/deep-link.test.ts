import { test, expect, describe } from "bun:test";
import { APP_URL_SCHEME, LEGACY_APP_URL_SCHEME, buildTaskDeepLink, parseTaskDeepLink } from "./deep-link.ts";

describe("constants", () => {
  test("APP_URL_SCHEME is forgeorbit and LEGACY_APP_URL_SCHEME is agetor", () => {
    expect(APP_URL_SCHEME).toBe("forgeorbit");
    expect(LEGACY_APP_URL_SCHEME).toBe("agetor");
  });
});

describe("buildTaskDeepLink", () => {
  test("builds the expected literal string for a plain id", () => {
    expect(buildTaskDeepLink("abc")).toBe("forgeorbit://task/abc");
  });
});

describe("round-trip through buildTaskDeepLink -> parseTaskDeepLink", () => {
  const cases: Array<[string, string]> = [
    ["plain id", "abc123"],
    ["id with slash", "a/b"],
    ["id with question mark", "a?b"],
    ["id with hash", "a#b"],
    ["id with space", "a b"],
    ["id with unicode", "táșk-é-🚀"],
  ];

  for (const [label, id] of cases) {
    test(`round-trips ${label}`, () => {
      const link = buildTaskDeepLink(id);
      expect(parseTaskDeepLink(link)).toBe(id);
    });
  }
});

describe("parseTaskDeepLink valid input", () => {
  test("returns the decoded id for a valid single-segment forgeorbit:// link", () => {
    expect(parseTaskDeepLink("forgeorbit://task/abc%20def")).toBe("abc def");
  });

  test("accepts legacy agetor:// links for backward compatibility", () => {
    expect(parseTaskDeepLink("agetor://task/abc%20def")).toBe("abc def");
  });
});

describe("parseTaskDeepLink rejects malformed input", () => {
  const invalid: Array<[string, string]> = [
    ["wrong scheme (http)", "http://task/x"],
    ["wrong scheme (foo)", "foo://task/x"],
    ["wrong host (other)", "forgeorbit://other/x"],
    ["wrong host (task2)", "forgeorbit://task2/x"],
    ["missing id", "forgeorbit://task"],
    ["empty id", "forgeorbit://task/"],
    ["extra segments", "forgeorbit://task/a/b"],
    ["doubled slash", "forgeorbit://task//a"],
    ["query string", "forgeorbit://task/a?x=1"],
    ["fragment", "forgeorbit://task/a#y"],
    ["non-URL garbage", "not a url"],
    ["empty string", ""],
  ];

  for (const [label, input] of invalid) {
    test(`returns null for ${label}`, () => {
      expect(parseTaskDeepLink(input)).toBeNull();
    });
  }
});
