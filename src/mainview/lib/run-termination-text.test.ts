import { expect, test } from "bun:test";
import { stopToast, terminationNotice } from "./run-termination-text.ts";
import { en } from "../i18n/en";
import { ru } from "../i18n/ru";
import type { RunTermination } from "../../shared/run-termination.ts";

const base: RunTermination = {
  runId: "r", limitSeconds: null, deadlineAt: null, reason: "manual", requestedAt: 1, attempts: 1, outcome: "exited",
  processId: 4242, methods: ["session-kill"], checkedAt: 2, exitedAt: 2, note: null,
};

test("each state reads as what was observed, and the next step uses an existing control", () => {
  expect(terminationNotice(null, "cancelled", "developer")).toBeNull();
  const exited = terminationNotice(base, "cancelled", "developer")!;
  expect(exited.headline.key).toBe("stop.state.exited.manual");
  expect(exited.next).toBe("stop.next.developer");
  expect(terminationNotice(base, "cancelled", "reviewer")!.next).toBe("stop.next.reviewer");
  const limit = terminationNotice({ ...base, reason: "time-limit", limitSeconds: 12 }, "cancelled", "developer")!;
  expect(limit.headline).toEqual({ key: "stop.state.exited.time-limit", params: { seconds: "12", pid: "4242" } });
  const stuck = terminationNotice({ ...base, outcome: "unconfirmed" }, "running", "developer")!;
  expect(stuck.tone).toBe("warning");
  expect(stuck.headline.key).toBe("stop.state.unconfirmed.manual");
  expect(stuck.next).toBe("stop.next.unconfirmed");
  const unreported = terminationNotice({ ...base, outcome: "unverified" }, "cancelled", "developer")!;
  expect(unreported.headline.key).toBe("stop.state.not-reported.manual");
  expect(unreported.tone).toBe("warning");
  expect(terminationNotice({ ...base, outcome: "recovered-alive" }, "orphaned", "reviewer")!.next).toBe("stop.next.recovered");
});

test("a Stop click's toast never reads an unconfirmed or unreported stop as an exit", () => {
  expect(stopToast({ cancelled: false, termination: null }).key).toBe("stop.toast.nothing");
  expect(stopToast({ cancelled: true, termination: base }).key).toBe("stop.toast.exited");
  expect(stopToast({ cancelled: true, termination: { ...base, outcome: "unconfirmed" } }, "running")).toEqual({ key: "stop.toast.unconfirmed", tone: "warning" });
  expect(stopToast({ cancelled: true, termination: { ...base, outcome: "unverified" } }, "running").tone).toBe("warning");
});

test("every stop string exists in English and Russian with the same placeholders", () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("stop."));
  expect(keys.length).toBeGreaterThan(20);
  for (const key of keys) {
    const english = (en as Record<string, string>)[key]!;
    const russian = (ru as Record<string, string>)[key];
    expect(russian, key).toBeTruthy();
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(holes(russian!), key).toEqual(holes(english));
  }
});
