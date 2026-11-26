import { afterEach, expect, test } from "bun:test";
import { localeStore } from "@/i18n/core";
import {
  brainKindText,
  brainOriginText,
  dependencyConditionText,
  missionEventText,
  missionPhaseText,
  missionStatusText,
} from "./status-presenters";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

test("mission history events get plain names in both languages", async () => {
  expect(missionEventText("created")).toBe("Mission created");
  expect(missionEventText("paused_authorization_mismatch")).toBe("Paused: the plan changed after it was approved");
  expect(missionEventText("recovery tick")).toBe("Continued after a restart");
  expect(missionEventText("resource_reauthorized")).toBe("New AI resources approved by the Owner");
  await choose("ru");
  expect(missionEventText("completed_all_tasks")).toBe("Все задачи завершены");
  expect(missionEventText("paused")).toBe("Миссия поставлена на паузу");
});

test("an event, phase, status or condition with no label stays exactly as written", () => {
  expect(missionEventText("revoked policy must not launch")).toBe("revoked policy must not launch");
  expect(missionPhaseText("brand_new_phase")).toBe("brand_new_phase");
  expect(missionStatusText("archived")).toBe("archived");
  expect(dependencyConditionText("merged")).toBe("merged");
});

test("a missing value reads Unknown, never a reassuring word", () => {
  expect(missionEventText(null)).toBe("Unknown");
  expect(missionPhaseText(undefined)).toBe("Unknown");
  expect(dependencyConditionText("")).toBe("Unknown");
  expect(brainOriginText(null)).toBe("Unknown");
});

test("known codes are mapped", () => {
  expect(missionPhaseText("awaiting_owner")).toBe("Awaiting Owner");
  expect(missionStatusText("paused")).toBe("Paused");
  expect(dependencyConditionText("qc_pass")).toBe("after it passes quality control");
  expect(brainKindText("decision")).toBe("Decision");
});

test("an unrecognized Brain origin is not presented as the Owner", () => {
  expect(brainOriginText("owner")).toBe("Owner");
  expect(brainOriginText("automatic-extraction")).toBe("Automatically extracted");
  expect(brainOriginText("imported-archive")).toBe("imported-archive");
});
