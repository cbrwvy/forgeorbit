import { db } from "../db.ts";
import type { MissionWait } from "../orchestration/mission-wait.ts";

type Span = { start: number; end: number };
type Category = MissionWait | "runtime" | "testing";
type Boundary = { at: number; category: Category; priority: number; delta: number };

export function taskWaiting(taskId: string, cutoff: number, runtime: Span[], testing: Span[], queue: Span | null) {
  const rows = db.query<{ mission_id: string; category: MissionWait | null; at: number }, [string, number]>(
    "SELECT mission_id, category, at FROM mission_wait_transitions WHERE task_id = ? AND at <= ? ORDER BY at, id",
  ).all(taskId, cutoff);
  const events: Boundary[] = [];
  const add = (span: Span, category: Category, priority: number) => {
    const end = Math.min(span.end, cutoff);
    if (end <= span.start) return;
    events.push({ at: span.start, category, priority, delta: 1 }, { at: end, category, priority, delta: -1 });
  };
  for (const span of runtime) add(span, "runtime", 0);
  for (const span of testing) add(span, "testing", 1);
  const previous = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const prior = previous.get(row.mission_id);
    if (prior?.category) add({ start: prior.at, end: row.at }, prior.category, 2);
    previous.set(row.mission_id, row);
  }
  for (const row of previous.values()) {
    if (row.category) add({ start: row.at, end: cutoff }, row.category, 2);
  }
  if (queue) add(queue, "project-queue", 3);

  const order: Category[] = ["runtime", "testing", "owner", "dependency", "quota", "account-capacity", "specialist-capacity", "project-queue"];
  events.sort((a, b) => a.at - b.at);
  const totals = new Map<Category, number>();
  const active = new Map<string, number>();
  let priorAt = events[0]?.at ?? cutoff;
  let unknown = 0;
  for (const event of events) {
    const ms = event.at - priorAt;
    if (ms > 0) {
      const category = [0, 1, 2, 3].flatMap(priority => order.filter(key => (active.get(`${priority}:${key}`) ?? 0) > 0))[0];
      if (category) totals.set(category, (totals.get(category) ?? 0) + ms);
      else unknown += ms;
    }
    const key = `${event.priority}:${event.category}`;
    active.set(key, (active.get(key) ?? 0) + event.delta);
    priorAt = event.at;
  }
  const measured = Object.fromEntries(order.filter(k => k !== "runtime" && k !== "testing" && totals.has(k))
    .map(k => [k, totals.get(k)!])) as Partial<Record<MissionWait, number>>;
  return {
    measured, measuredMs: Object.values(measured).reduce((sum, ms) => sum + ms, 0),
    coverageMs: events.length ? cutoff - events[0]!.at : null,
    unknownMs: events.length ? unknown + cutoff - priorAt : null,
    runtimeInternalUnknownMs: totals.get("runtime") ?? null,
    testMs: totals.get("testing") ?? null,
    providerReportedMs: null,
  };
}
