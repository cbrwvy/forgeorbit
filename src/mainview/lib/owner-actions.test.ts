import { expect, test } from "bun:test";
import { localeStore } from "../i18n/core";
import { ownerActions, ownerActionsText } from "./owner-actions";
import type { OwnerActionsPayload } from "../../shared/owner-actions.ts";

const rows = (over: Partial<OwnerActionsPayload> = {}): OwnerActionsPayload => ({ proposals: [], delegations: [], batchHolds: [], ...over });
const row = (projectPath: string, id = "x") => ({ projectPath, id, title: id });

const task = (over: Record<string, unknown>) => ({ id: "t", title: "T", column: "backlog", updatedAt: 1, archivedAt: null, workdir: "/p", ...over }) as never;

test("the orb's facts start from the same collector as the Needs you page", () => {
  const tasks = [task({ id: "a", column: "blocked" }), task({ id: "b", column: "review" }), task({ id: "c", column: "ready" })];
  const a = ownerActions(tasks, {});
  expect(a.tasks.total).toBe(2);
  expect(a.approvals).toBe(0);
  expect(a.total).toBe(2);
});

test("approvals are added on top, and never counted as tasks", () => {
  const a = ownerActions([task({ id: "a", column: "blocked" })], { rows: rows({ proposals: [row("/p", "a"), row("/p", "b")] }) });
  expect(a.tasks.total).toBe(1);
  expect(a.approvals).toBe(2);
  expect(a.total).toBe(3);
});

test("a project context counts only that project's tasks", () => {
  const tasks = [task({ id: "a", column: "blocked", workdir: "/p1" }), task({ id: "b", column: "blocked", workdir: "/p2" })];
  expect(ownerActions(tasks, { projectPath: "/p1" }).tasks.total).toBe(1);
  expect(ownerActions(tasks, {}).tasks.total).toBe(2);
});

test("wording keeps a blocked task apart from an approval (en)", async () => {
  await localeStore.choose("en", async () => {});
  expect(ownerActionsText(ownerActions([], {}))).toBe("Nothing is waiting for you.");
  expect(ownerActionsText(ownerActions([task({ column: "blocked" })], {}))).toBe("1 task needs you");
  expect(ownerActionsText(ownerActions([task({ id: "a", column: "blocked" }), task({ id: "b", column: "review" })], { rows: rows({ delegations: [row("/p")] }) }))).toBe("2 tasks need you · 1 approval waiting");
});

test("Russian plural forms", async () => {
  await localeStore.choose("ru", async () => {});
  expect(ownerActionsText(ownerActions([], { rows: rows({ proposals: [row("/p", "a"), row("/p", "b")] }) }))).toBe("2 одобрения ждут");
  expect(ownerActionsText(ownerActions([], { rows: rows({ proposals: ["a","b","c","d","e"].map((i) => row("/p", i)) }) }))).toBe("5 одобрений ждут");
  expect(ownerActionsText(ownerActions([task({ column: "blocked" })], {}))).toBe("1 задача ждёт вас");
  await localeStore.choose("en", async () => {});
});

test("batches on hold are counted and worded apart from approvals; a project context scopes all three", async () => {
  await localeStore.choose("en", async () => {});
  const all = rows({ proposals: [row("/p1", "a")], batchHolds: [{ ...row("/p1", "b1"), status: "paused" }, { ...row("/p2", "b2"), status: "stopped" }] });
  const both = ownerActions([], { rows: all });
  expect(both.holds).toBe(2);
  expect(ownerActionsText(both)).toBe("1 approval waiting · 2 batches on hold");
  const one = ownerActions([], { projectPath: "/p1", rows: all });
  expect(one.approvals).toBe(1);
  expect(one.holds).toBe(1);
  expect(ownerActionsText(one)).toBe("1 approval waiting · 1 batch on hold");
});
