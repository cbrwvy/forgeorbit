import { expect, test } from "bun:test";
import { watchEmployeeExecutions } from "./employee-execution-poll.ts";
import type { EmployeeRunView } from "../../shared/execution/run.ts";
const view = (phase: EmployeeRunView["phase"]) => ({ phase } as EmployeeRunView);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function clock() {
  let callback: (() => void) | null = null;
  return {
    timers: { set: (fn: () => void) => { callback = fn; return 1 as unknown as ReturnType<typeof setTimeout>; }, clear: () => { callback = null; } },
    pending: () => callback !== null,
    tick: async () => { const fn = callback; callback = null; fn?.(); await flush(); },
  };
}

test("polls only active attempts and stops at canonical terminal state", async () => {
  const c = clock();
  let calls = 0;
  const seen: string[] = [];
  const phases = ["starting", "running", "completed"] as const;
  const stop = watchEmployeeExecutions(async () => ({ attempts: [view(phases[calls++]!)] }), (list) => seen.push(list[0]!.phase), c.timers);
  await flush(); expect(c.pending()).toBe(true);
  await c.tick(); expect(c.pending()).toBe(true);
  await c.tick(); expect(c.pending()).toBe(false);
  await c.tick(); expect(calls).toBe(3);
  expect(seen).toEqual([...phases]);
  stop();
});

for (const phase of ["failed", "cancelled", "unknown-outcome", "expired", "withdrawn", "superseded"] as const) {
  test(`no recurring polling for ${phase}`, async () => {
    const c = clock();
    const stop = watchEmployeeExecutions(async () => ({ attempts: [view(phase)] }), () => {}, c.timers);
    await flush(); expect(c.pending()).toBe(false); stop();
  });
}

test("unmount cancels scheduled work and aborts the in-flight request", async () => {
  const c = clock();
  let signal: AbortSignal | undefined;
  const stop = watchEmployeeExecutions(async (s) => { signal = s; return { attempts: [view("running")] }; }, () => {}, c.timers);
  await flush(); expect(c.pending()).toBe(true); stop();
  expect(signal!.aborted).toBe(true); expect(c.pending()).toBe(false);
});

test("switching tasks discards the previous task's late status response", async () => {
  const c = clock();
  let resolve!: (value: { attempts: EmployeeRunView[] }) => void;
  const seen: string[] = [];
  const old = watchEmployeeExecutions(() => new Promise((r) => { resolve = r; }), () => seen.push("old"), c.timers);
  old();
  const current = watchEmployeeExecutions(async () => ({ attempts: [view("completed")] }), () => seen.push("new"), c.timers);
  resolve({ attempts: [view("running")] }); await flush();
  expect(seen).toEqual(["new"]); expect(c.pending()).toBe(false); current();
});

test("a failed status request never invents terminal state or retries globally", async () => {
  const c = clock(); let received = false;
  const stop = watchEmployeeExecutions(async () => { throw new Error("offline"); }, () => { received = true; }, c.timers);
  await flush(); expect(received).toBe(false); expect(c.pending()).toBe(false); stop();
});
