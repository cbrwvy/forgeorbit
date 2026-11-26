import { expect, test } from "bun:test";
import type { TurnHistory } from "../../shared/execution/turn.ts";
import { publishPipelineGlobalEvent, __forTest } from "./pipeline-events.ts";
import { watchProfessionalTurns } from "./professional-turn-watch.ts";

const history = (state = "recoverable", status = "included", observed: string | null = "succeeded") => ({
  session: { state, reason: null }, turns: [{ status, observed_run_status: observed }],
}) as TurnHistory;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      set: (fn: () => void) => { pending.set(++next, fn); return next as unknown as ReturnType<typeof setTimeout>; },
      clear: (id: ReturnType<typeof setTimeout>) => { pending.delete(id as unknown as number); },
    },
    count: () => pending.size,
    tick: async () => { const [id, fn] = pending.entries().next().value ?? []; if (id !== undefined) pending.delete(id); fn?.(); await flush(); },
  };
}
const settled = () => publishPipelineGlobalEvent({ kind: "run-status", runId: "run", taskId: "task", status: "succeeded", ts: 1 });

test("fast turn settles without a parent running transition or an event", async () => {
  const c = clock(); let reads = 0;
  const seen: TurnHistory[] = [];
  const stop = watchProfessionalTurns("run", async () => ++reads === 1 ? history("attached", "included", null) : history(), h => seen.push(h), () => {}, c.timers);
  await flush(); expect(c.count()).toBe(1);
  await c.tick(); expect(reads).toBe(2); expect(seen.at(-1)?.turns[0]?.observed_run_status).toBe("succeeded");
  expect(c.count()).toBe(0); stop.stop();
});

test("unsettled included/prepared/claimed evidence polls even if the session is unsupported", async () => {
  for (const status of ["included", "prepared", "claimed", "approved"]) {
    const c = clock();
    const watch = watchProfessionalTurns("run", async () => history("unsupported", status, null), () => {}, () => {}, c.timers);
    await flush(); expect(c.count()).toBe(1); watch.stop(); expect(c.count()).toBe(0);
  }
});

test("long execution has a finite fallback budget; the existing lifecycle event still settles it", async () => {
  const c = clock(); let response = history("attached", "included", null); let reads = 0;
  const seen: TurnHistory[] = [];
  const watch = watchProfessionalTurns("run", async () => { reads++; return response; }, h => seen.push(h), () => {}, c.timers);
  await flush(); for (let i = 0; i < 30; i++) await c.tick();
  expect(reads).toBe(21); expect(c.count()).toBe(0);
  publishPipelineGlobalEvent({ kind: "run-status", runId: "other", taskId: "task", status: "succeeded", ts: 1 });
  await flush(); expect(reads).toBe(21);
  response = history(); settled(); await flush();
  expect(reads).toBe(22); expect(seen.at(-1)).toBe(response); expect(c.count()).toBe(0); watch.stop();
});

test("offline read stops polling, retains evidence and can recover on explicit refresh", async () => {
  const c = clock(); let offline = false; let reads = 0; let errors = 0;
  const seen: TurnHistory[] = [];
  const watch = watchProfessionalTurns("run", async () => { reads++; if (offline) throw Error("offline"); return history("attached", "included", null); }, h => seen.push(h), () => { errors++; }, c.timers);
  await flush(); offline = true; await c.tick();
  for (let i = 0; i < 10; i++) await c.tick();
  expect(reads).toBe(2); expect(errors).toBe(1); expect(seen).toHaveLength(1); expect(c.count()).toBe(0);
  offline = false; await watch.refresh(); expect(seen).toHaveLength(2); watch.stop();
});

test("events during a pending read coalesce into one follow-up without overlapping requests", async () => {
  const c = clock(); let resolve!: (h: TurnHistory) => void; let reads = 0;
  const watch = watchProfessionalTurns("run", () => ++reads === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(history()), () => {}, () => {}, c.timers);
  await flush();
  settled(); settled(); void watch.refresh(); expect(reads).toBe(1);
  resolve(history()); await flush(); expect(c.count()).toBe(1);
  await c.tick(); expect(reads).toBe(2); expect(c.count()).toBe(0); watch.stop();
});

test("unmount/switch aborts reads, removes subscription and discards late success or error", async () => {
  for (const rejectLate of [false, true]) {
    const c = clock(); const initial = __forTest.listenerCount();
    let resolve!: (h: TurnHistory) => void; let reject!: (e: Error) => void; let delivered = 0;
    const old = watchProfessionalTurns("old", () => new Promise((r, j) => { resolve = r; reject = j; }), () => { delivered++; }, () => { delivered++; }, c.timers);
    await flush();
    old.stop(); expect(old.signal.aborted).toBe(true); expect(__forTest.listenerCount()).toBe(initial);
    const current = watchProfessionalTurns("run", async () => history(), () => { delivered++; }, () => {}, c.timers);
    if (rejectLate) reject(Error("offline")); else resolve(history("attached", "included", null));
    await flush(); expect(delivered).toBe(1); expect(c.count()).toBe(0); current.stop();
    expect(__forTest.listenerCount()).toBe(initial);
  }
});

test("a synchronous read error also permits a later explicit refresh", async () => {
  const c = clock(); let broken = true; let received = 0; let errors = 0;
  const watch = watchProfessionalTurns("run", () => { if (broken) throw Error("offline"); return Promise.resolve(history()); }, () => { received++; }, () => { errors++; }, c.timers);
  await flush(); expect(errors).toBe(1); expect(c.count()).toBe(0);
  broken = false; await watch.refresh(); expect(received).toBe(1); watch.stop();
});

test("reopening reads fresh evidence; Indeterminate remains unknown and historical snapshots stay untouched", async () => {
  const c = clock(); const response = history("unsupported", "indeterminate", null);
  const snapshot = JSON.stringify(response); const seen: TurnHistory[] = [];
  const open = () => watchProfessionalTurns("run", async () => response, h => seen.push(h), () => {}, c.timers);
  const first = open(); await flush(); expect(c.count()).toBe(0); first.stop();
  const second = open(); await flush(); expect(seen).toEqual([response, response]);
  expect(JSON.stringify(response)).toBe(snapshot); expect(c.count()).toBe(0); second.stop();
});
