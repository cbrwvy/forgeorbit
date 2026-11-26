import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ACTIVITY_EVENT_TYPES, type ActivityEvent } from "../../shared/activity/types.ts";
import { EVENT_STATUS, activityDateRange, groupActivity, mergeActivity } from "./activity-journal";
import { activityConnection, publishActivitySignal, subscribeActivitySignal } from "./activity-events";
import { localeStore, translate } from "../i18n/core";
import { LocaleProvider } from "../i18n/react";
import { ActivityRow } from "../components/workspace/company/activity/ActivityJournal";
import { activityEn, activityRu } from "../i18n/activity";
const event = (sequenceId: number, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({ sequenceId, id: `e${sequenceId}`, eventType: "turn.submitted", schemaVersion: 1, projectPath: "/fixture/p", actorType: "employee", actorId: "ada", targetType: "task", targetId: "task1", taskId: "task1", runId: null, executionId: null, turnId: null, employeeId: "ada", idempotencyKey: `k${sequenceId}`, sourceEventId: null, payload: {}, createdAt: 1000, ...patch });

test("all 18 canonical events have distinct, complete EN/RU presentation and precise statuses", () => {
  expect(Object.keys(EVENT_STATUS).sort()).toEqual([...ACTIVITY_EVENT_TYPES].sort());
  expect(Object.keys(activityEn).sort()).toEqual(Object.keys(activityRu).sort());
  for (const type of ACTIVITY_EVENT_TYPES) {
    for (const locale of ["en", "ru"] as const) {
      expect(translate(locale, `activity.event.${type}`)).not.toContain("activity.");
      expect(translate(locale, `activity.status.${EVENT_STATUS[type]}`)).not.toContain("activity.");
    }
  }
  expect(EVENT_STATUS["turn.submitted"]).toBe("submitted");
  expect(EVENT_STATUS["delivery.indeterminate"]).toBe("indeterminate");
  expect(EVENT_STATUS["execution.started"]).toBe("started");
  expect(EVENT_STATUS["employee.assigned"]).toBe("included");
});
test("merges duplicates and same-timestamp pages in canonical order without losing prior rows", () => {
  const old = [event(100), event(99)];
  expect(mergeActivity(old, [event(99), event(98), event(101)]).map(e => e.sequenceId)).toEqual([101,100,99,98]);
  expect(old).toHaveLength(2);
  // Live prepend and backward append must preserve the date section's identity/focus.
  expect(groupActivity(old)[0]!.key).toBe(groupActivity(mergeActivity(old,[event(101),event(98)]))[0]!.key);
});
test("strict project scope discards foreign and unscoped records even across merged pages", () => {
  expect(mergeActivity([event(1)], [event(2, { projectPath: "/other" }), event(3, { projectPath: null })], "/fixture/p")).toHaveLength(1);
});
test("date grouping preserves sequence under a backwards clock and equal timestamps", () => {
  const rows = [event(4, {createdAt:new Date(2026,9,27,12).getTime()}),event(3,{createdAt:new Date(2026,9,26,12).getTime()}),event(2,{createdAt:new Date(2026,9,26,12).getTime()}),event(1,{createdAt:new Date(2026,9,27,12).getTime()})];
  expect(groupActivity(rows).map(g => g.events.length)).toEqual([1,2,1]);
  expect(new Set(groupActivity(rows).map(g => g.key)).size).toBe(3);
});
test("date filters include the entire local final day and reject reverse ranges", () => {
  const range = activityDateRange("2026-10-26", "2026-10-27");
  expect(range.from).toBe(new Date(2026,9,26).getTime());
  expect(range.to).toBe(new Date(2026,9,28).getTime()-1);
  expect(() => activityDateRange("2026-10-28", "2026-10-27")).toThrow();
  expect(activityDateRange("", "")).toEqual({from:undefined,to:undefined});
});
test("one SSE fan-out supports reconnect/offline and idempotent unsubscribe", () => {
  const got: string[] = [];
  const unsubscribe = subscribeActivitySignal(s => got.push(s));
  publishActivitySignal("disconnected"); expect(activityConnection()).toBe("disconnected");
  publishActivitySignal("connected"); publishActivitySignal("changed");
  unsubscribe(); unsubscribe(); publishActivitySignal("changed");
  expect(got).toEqual(["disconnected","connected","changed"]);
});
test("rendered rows switch locale without altering events, escape user titles, and omit sensitive payloads", async () => {
  const record = event(1, {payload: {taskTitle:"Original <img src=x> задача",prompt:"PROMPT_SECRET",apiToken:"TOKEN_SECRET",credentials:"CREDENTIAL_SECRET",rationale:"RAW_RATIONALE_SECRET"}});
  const before = JSON.stringify(record);
  try {
    for (const locale of ["en", "ru"] as const) {
      await localeStore.choose(locale, async () => {});
      const html = renderToStaticMarkup(<LocaleProvider><ActivityRow event={record} employees={[]} projects={[]} onOpenEmployee={() => {}} onOpenProject={() => {}} onOpenTask={() => {}} /></LocaleProvider>);
      expect(html).toContain(translate(locale,"activity.event.turn.submitted"));
      expect(html).toContain("Original &lt;img src=x&gt; задача");
      expect(html).not.toContain("<img");
      for (const secret of ["PROMPT_SECRET","TOKEN_SECRET","CREDENTIAL_SECRET","RAW_RATIONALE_SECRET"]) expect(html).not.toContain(secret);
      expect(html).toContain('data-status="submitted"');
    }
    expect(JSON.stringify(record)).toBe(before);
  } finally { await localeStore.choose("en",async () => {}); }
});

test("synthetic actors have only localized roles while real actor and subject UUIDs keep distinct links", async () => {
  const actorId = "b4ba18de-1111-4111-8111-111111111111";
  const subjectId = "c5cb29ef-2222-4222-8222-222222222222";
  const render = (record: ActivityEvent) => renderToStaticMarkup(<LocaleProvider><ActivityRow event={record} employees={[]} projects={[]} onOpenEmployee={() => {}} onOpenProject={() => {}} onOpenTask={() => {}} /></LocaleProvider>);
  try {
    for (const locale of ["en", "ru"] as const) {
      await localeStore.choose(locale, async () => {});
      for (const [actorType, syntheticId] of [["owner", "owner"], ["system", "runtime"], ["project-manager", "project-manager"], ["employee", "project-manager"]] as const) {
        const html = render(event(1, { actorType, actorId: syntheticId, employeeId: subjectId, targetType: "proposal", targetId: "proposal1" }));
        expect(html).toContain(`</dt><dd>${translate(locale, `activity.actor.${actorType}`)}</dd>`);
        expect(html).not.toContain(` · ${syntheticId}`);
        expect(html.match(/<button /g)).toHaveLength(3); // subject, project, task
        expect(html).toContain(`${translate(locale, "activity.openEmployee")} · ${subjectId}`);
        expect(html).toContain(`>${locale === "en" ? "Task" : "Задача"}</dt><dd>task1</dd>`);
        expect(html).toContain(`>${translate(locale, "activity.openTask")}</button>`);
      }
      for (const actorType of ["employee", "project-manager"] as const) {
        const html = render(event(1, { actorType, actorId, employeeId: subjectId }));
        expect(html).toContain(`${translate(locale, `activity.actor.${actorType}`)} · ${actorId}`);
        for (const id of [actorId, subjectId]) expect(html).toContain(`${translate(locale, "activity.openEmployee")} · ${id}`);
        const missing = render(event(1, { actorType, actorId: null, employeeId: subjectId }));
        expect(missing).toContain(`${translate(locale, `activity.actor.${actorType}`)} · ${translate(locale, "activity.unknown")}`);
      }
    }
  } finally { await localeStore.choose("en", async () => {}); }
});
