import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import type { HeadBoardProposal } from "../../../shared/head-pm-scope.ts";
import { HeadBoardProposalCard } from "./HeadBoardProposalCard";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

const baseContext = {
  scope: { kind: "project" as const, path: "/tmp/fo-head-preview" },
  label: "FO-D31QA Head (disposable)",
  projectPath: "/tmp/fo-head-preview",
  projectAddedAt: 1,
  clusterId: null,
};

const noop = () => {};
const noopTask = () => true;

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("title-only edit card shows affected task, old → new title, and explicit unchanged description in EN and RU", async () => {
  const proposal: HeadBoardProposal = {
    messageId: "msg-rename-only",
    context: baseContext,
    action: {
      kind: "edit",
      taskId: "64fa2a83-f6c0-401d-b11e-9ada2d8e4da2",
      title: "Add subtract helper function",
    },
    status: "pending",
    taskId: null,
    error: null,
    affectedProjects: [{ path: "/tmp/fo-head-preview", name: "FO-D31QA Head (disposable)" }],
    editPreview: {
      taskId: "64fa2a83-f6c0-401d-b11e-9ada2d8e4da2",
      currentTitle: "Add subtract helper",
      nextTitle: "Add subtract helper function",
      titleChanged: true,
      currentDescription: "Add subtract to src/index.ts.",
      nextDescription: null,
      descriptionStatus: "unchanged",
    },
    permissions: "None (task metadata modification)",
    policy: "Supervised edit policy",
    sideEffects: "Updates task title only. Description stays unchanged.",
  };

  await choose("en");
  const enHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const enText = plainText(enHtml);
  expect(enHtml).toContain('data-testid="head-pm-edit-preview"');
  expect(enHtml).toContain('data-description-status="unchanged"');
  expect(enText).toContain("Task: Add subtract helper");
  expect(enText).toContain("Title: Add subtract helper → Add subtract helper function");
  expect(enText).toContain("Description: Unchanged");
  expect(enText).toContain("Updates task title only. Description stays unchanged.");
  expect(enText).not.toContain("Updates task title and prompt.");
  expect(enHtml).toMatch(/data-testid="head-pm-board-approve"/);
  expect(enHtml).not.toMatch(/disabled=""[^>]*data-testid="head-pm-board-approve"/);

  await choose("ru");
  const ruHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const ruText = plainText(ruHtml);
  expect(ruText).toContain("Задача: Add subtract helper");
  expect(ruText).toContain("Название: Add subtract helper → Add subtract helper function");
  expect(ruText).toContain("Описание: Без изменений");
  expect(ruText).toContain("Обновляет только название задачи. Описание остаётся без изменений.");
});

test("description edit card renders current and proposed description from validated stored action", async () => {
  const proposal: HeadBoardProposal = {
    messageId: "msg-desc-edit",
    context: baseContext,
    action: {
      kind: "edit",
      taskId: "64fa2a83-f6c0-401d-b11e-9ada2d8e4da2",
      title: "Add subtract helper",
      description: "Handle negative and floating-point operands cleanly.",
    },
    status: "pending",
    taskId: null,
    error: null,
    affectedProjects: [{ path: "/tmp/fo-head-preview", name: "FO-D31QA Head (disposable)" }],
    editPreview: {
      taskId: "64fa2a83-f6c0-401d-b11e-9ada2d8e4da2",
      currentTitle: "Add subtract helper",
      nextTitle: "Add subtract helper",
      titleChanged: false,
      currentDescription: "Add subtract to src/index.ts.",
      nextDescription: "Handle negative and floating-point operands cleanly.",
      descriptionStatus: "updated",
    },
    sideEffects: "Updates task description only. Title stays unchanged.",
  };

  await choose("en");
  const enHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const enText = plainText(enHtml);
  expect(enHtml).toContain('data-description-status="updated"');
  expect(enHtml).toContain('data-testid="head-pm-edit-description-current"');
  expect(enHtml).toContain('data-testid="head-pm-edit-description-next"');
  expect(enText).toContain("Title: Unchanged");
  expect(enText).toContain("Current: Add subtract to src/index.ts.");
  expect(enText).toContain("Proposed: Handle negative and floating-point operands cleanly.");
  expect(enText).toContain("Updates task description only. Title stays unchanged.");

  await choose("ru");
  const ruHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const ruText = plainText(ruHtml);
  expect(ruText).toContain("Название: Без изменений");
  expect(ruText).toContain("Текущее: Add subtract to src/index.ts.");
  expect(ruText).toContain("Новое: Handle negative and floating-point operands cleanly.");
  expect(ruText).toContain("Обновляет только описание задачи. Название остаётся без изменений.");
});

test("legacy unsafe blank-description proposal shows alert, disables Approve, and keeps Reject enabled", async () => {
  const proposal: HeadBoardProposal = {
    messageId: "msg-legacy-unsafe",
    context: baseContext,
    action: {
      kind: "edit",
      taskId: "64fa2a83-f6c0-401d-b11e-9ada2d8e4da2",
      title: "Add subtract helper function",
      description: "",
    },
    status: "pending",
    taskId: null,
    error: null,
    affectedProjects: [{ path: "/tmp/fo-head-preview", name: "FO-D31QA Head (disposable)" }],
    editPreview: {
      taskId: "64fa2a83-f6c0-401d-b11e-9ada2d8e4da2",
      currentTitle: "Add subtract helper",
      nextTitle: "Add subtract helper function",
      titleChanged: true,
      currentDescription: "Add subtract to src/index.ts.",
      nextDescription: null,
      descriptionStatus: "unsafe-blank",
    },
    sideEffects: "Blocked: stored edit proposal contains a blank description that would erase the task prompt.",
  };

  await choose("en");
  const enHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const enText = plainText(enHtml);
  expect(enHtml).toContain('data-description-status="unsafe-blank"');
  expect(enHtml).toContain('data-testid="head-pm-edit-unsafe-blank"');
  expect(enText).toContain("Approval blocked: this stored proposal contains an empty description that would erase the task prompt.");
  // Approve is disabled while Reject remains enabled.
  expect(enHtml).toMatch(/<button[^>]*disabled=""[^>]*data-testid="head-pm-board-approve"/);
  expect(enHtml).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="head-pm-board-reject"/);

  await choose("ru");
  const ruHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const ruText = plainText(ruHtml);
  expect(ruText).toContain("Подтверждение заблокировано: сохранённое предложение содержит пустое описание");
  expect(ruText).toContain("Заблокировано: сохранённое предложение содержит пустое описание и стёрло бы текст задачи.");
});

test("create_batch proposal renders numbered task list and Create all button in EN and RU", async () => {
  const batchAction = {
    kind: "create_batch" as const,
    title: "3 tasks",
    projectPath: "/tmp/fo-head-preview",
    tasks: [
      { title: "Add dark mode", description: "Support system and manual theme toggle.", projectPath: "/tmp/fo-head-preview" },
      { title: "Fix login redirect", description: "Preserve return URL after sign in.", projectPath: "/tmp/fo-head-preview" },
      { title: "Update README", description: "Update README", projectPath: "/tmp/fo-head-preview" },
    ],
  };
  const proposal: HeadBoardProposal = {
    messageId: "msg-batch-create",
    context: baseContext,
    action: batchAction,
    status: "pending",
    taskId: null,
    error: null,
    affectedProjects: [{ path: "/tmp/fo-head-preview", name: "DemoApp" }],
    permissions: "None (draft creation in Backlog)",
    policy: "Supervised backlog policy",
    sideEffects: "Creates 3 draft tasks in Backlog. No specialist runs.",
  };

  await choose("en");
  const enHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const enText = plainText(enHtml);
  expect(enHtml).toContain('data-kind="create_batch"');
  expect(enHtml).toContain('data-testid="head-pm-batch-list"');
  expect(enText).toContain("Add tasks to Backlog");
  expect(enText).toContain("Add dark mode");
  expect(enText).toContain("Support system and manual theme toggle.");
  expect(enText).toContain("Fix login redirect");
  expect(enText).toContain("Update README");
  expect(enText).toContain("Create all (3)");
  expect(enText).toContain("Creates 3 draft tasks in Backlog. No specialist runs.");

  await choose("ru");
  const ruHtml = renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={proposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  );
  const ruText = plainText(ruHtml);
  expect(ruText).toContain("Добавить задачи в бэклог");
  expect(ruText).toContain("Создать все (3)");
  expect(ruText).toContain("Создаёт черновики задач (3) в Бэклоге. Специалисты не запускаются.");

  const appliedProposal: HeadBoardProposal = {
    ...proposal,
    status: "applied",
    taskId: "t-1",
    action: {
      ...batchAction,
      createdTaskIds: ["t-1", "t-2", "t-3"],
    },
  };
  const collapsedRu = plainText(renderToStaticMarkup(
    <LocaleProvider>
      <HeadBoardProposalCard proposal={appliedProposal} onChange={noop} onOpenProject={noop} onOpenTask={noopTask} />
    </LocaleProvider>,
  ));
  expect(collapsedRu).toContain("Добавить задачи в бэклог");
  expect(collapsedRu).toContain("Задач: 3");
  expect(collapsedRu).toContain("Применено");
});
