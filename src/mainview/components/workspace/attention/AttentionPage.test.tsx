import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../../../i18n/react";
import type { Project, Task } from "../../../../shared/types.ts";
import { AttentionPage } from "./AttentionPage";

const task = (over: Partial<Task> & { id: string }): Task => ({
  title: over.id, prompt: "", agent: "claude-code", workdir: "/p/a", column: "backlog", updatedAt: 1, createdAt: 1, archivedAt: null, pendingInteractionCount: 0,
  ...over,
} as unknown as Task);
const projects = [{ path: "/p/a", name: "Alpha" }] as unknown as Project[];
const render = (tasks: Task[]) => renderToStaticMarkup(<LocaleProvider><AttentionPage tasks={tasks} projects={projects} homeDir="/Users/x" onOpenTask={() => {}} /></LocaleProvider>);

test("empty board: the empty state, no rows", () => {
  const html = render([task({ id: "t1" })]);
  expect(html).toContain('data-testid="attention-empty"');
  expect(html).not.toContain('data-testid="attention-row"');
  expect(html).toContain("0 waiting");
});

test("rows are ordered by urgency and carry the project name, kind and an Open button", () => {
  const html = render([task({ id: "rev", title: "Review me", column: "review" }), task({ id: "ask", title: "Question", pendingInteractionCount: 3, column: "running" })]);
  expect(html.indexOf('data-task-id="ask"')).toBeLessThan(html.indexOf('data-task-id="rev"'));
  expect(html).toContain('data-kind="answer"');
  expect(html).toContain("Answer (3)");
  expect(html).toContain('data-kind="review"');
  expect(html).toContain("Alpha");
  expect((html.match(/data-testid="attention-open"/g) ?? []).length).toBe(2);
  expect(html).toContain("2 waiting");
});

test("the page says where non-task items live instead of pretending to list them", () => {
  const html = render([]);
  expect(html).toContain("The full resource, estimate and recommendation view is on the Portfolio page");
});
