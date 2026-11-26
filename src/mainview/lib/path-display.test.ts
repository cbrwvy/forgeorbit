import { expect, test } from "bun:test";
import { shortenPath } from "./path-display";

test("short paths and the home folder are kept", () => {
  expect(shortenPath("/Users/me", "/Users/me")).toBe("~");
  expect(shortenPath("/Users/me/code/app", "/Users/me")).toBe("~/code/app");
  expect(shortenPath("/srv/app", "")).toBe("/srv/app");
});

test("deep paths keep the last three segments behind an ellipsis", () => {
  expect(shortenPath("/var/folders/03/abc/T/fopm01-x/projects/Orbit Notes", "/Users/me")).toBe("…/fopm01-x/projects/Orbit Notes");
  expect(shortenPath("/Users/me/a/b/c/d/project", "/Users/me")).toBe("…/c/d/project");
});

test("a custom depth is honoured", () => {
  expect(shortenPath("/a/b/c/d", "", 2)).toBe("…/c/d");
});
