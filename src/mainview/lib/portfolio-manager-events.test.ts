import { expect, test } from "bun:test";
import { createLatestLoader, publishPortfolioManagerSignal, subscribePortfolioManagerSignals } from "./portfolio-manager-events.ts";

/** FO-008D: event-driven re-reads are coalesced and never apply stale answers. */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("a burst of requests runs one load plus one trailing load", async () => {
  const pending: Array<ReturnType<typeof deferred<number>>> = [];
  let calls = 0;
  const applied: number[] = [];
  const loader = createLatestLoader(() => {
    calls += 1;
    const d = deferred<number>();
    pending.push(d);
    return d.promise;
  }, (value) => applied.push(value));
  void loader.request();
  void loader.request();
  void loader.request();
  expect(calls).toBe(1);
  pending[0]!.resolve(1);
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(calls).toBe(2);
  pending[1]!.resolve(2);
  await Bun.sleep(0);
  expect(applied).toEqual([1, 2]);
});

test("an answer made stale by a local write is dropped", async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const applied: string[] = [];
  const loader = createLatestLoader(() => {
    const d = deferred<string>();
    pending.push(d);
    return d.promise;
  }, (value) => applied.push(value));
  void loader.request();
  loader.invalidate();
  void loader.request();
  pending[0]!.resolve("old");
  await Bun.sleep(0);
  await Bun.sleep(0);
  pending[1]!.resolve("new");
  await Bun.sleep(0);
  expect(applied).toEqual(["new"]);
  loader.dispose();
  void loader.request();
  expect(pending.length).toBe(2);
});

test("signals reach every subscriber until it unsubscribes", () => {
  const seen: string[] = [];
  const stop = subscribePortfolioManagerSignals((signal) => seen.push(signal.kind));
  publishPortfolioManagerSignal({ kind: "reconnect" });
  publishPortfolioManagerSignal({ kind: "delegation", event: { type: "portfolio_delegation", delegationId: "d", projectPath: "/p", status: "answered", ts: 1 } });
  stop();
  publishPortfolioManagerSignal({ kind: "reconnect" });
  expect(seen).toEqual(["reconnect", "delegation"]);
});
