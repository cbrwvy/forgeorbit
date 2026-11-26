import { describe, expect, it } from "bun:test";
import { collectSseStream, takeSseEvents } from "./sse-evidence.ts";

const encoder = new TextEncoder();

function streamFrom(chunks: string[], opts: { holdOpen?: boolean; onCancel?: () => void } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!opts.holdOpen) controller.close();
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

describe("takeSseEvents", () => {
  it("keeps complete events and the unfinished tail", () => {
    const fixture = "event: status\ndata: {\"ok\":true}\n\ndata: partial";
    const taken = takeSseEvents(fixture);
    expect(taken.events).toEqual([{ event: "status", id: null, data: "{\"ok\":true}" }]);
    expect(taken.rest).toBe("data: partial");
  });

  it("joins continued data lines and ignores comment frames", () => {
    const fixture = ": connected\n\ndata: line-1\ndata: line-2\n\n";
    const taken = takeSseEvents(fixture);
    expect(taken.events).toEqual([{ event: null, id: null, data: "line-1\nline-2" }]);
    expect(taken.rest).toBe("");
  });
});

describe("collectSseStream", () => {
  it("returns events already received and cancels a stream that never ends", async () => {
    let cancelled = false;
    const started = Date.now();
    const result = await collectSseStream(
      streamFrom(["data: first\n\n", "data: second\n\n"], { holdOpen: true, onCancel: () => { cancelled = true; } }),
      { maxEvents: 1, timeoutMs: 1000 },
    );
    expect(result.reason).toBe("max-events");
    expect(result.events.map((event) => event.data)).toEqual(["first"]);
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stops on the deadline and keeps the event that arrived before it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 7\ndata: saved\n\n"));
      },
    });
    const started = Date.now();
    const result = await collectSseStream(body, { maxEvents: 5, timeoutMs: 40 });
    expect(result.reason).toBe("timeout");
    expect(result.events).toEqual([{ event: null, id: "7", data: "saved" }]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reads a synthetic server that stays open after one frame", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("event: run\ndata: {\"stream\":\"status\"}\n\n"));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/events`);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const result = await collectSseStream(response.body!, { maxEvents: 1, timeoutMs: 1000 });
      expect(result.reason).toBe("max-events");
      expect(result.events[0]).toEqual({ event: "run", id: null, data: "{\"stream\":\"status\"}" });
    } finally {
      server.stop(true);
    }
  });

  it("reports end when the fixture closes, including a final event without a trailing blank line", async () => {
    const result = await collectSseStream(streamFrom(["data: done"]), { maxEvents: 3, timeoutMs: 1000 });
    expect(result.reason).toBe("end");
    expect(result.events.map((event) => event.data)).toEqual(["done"]);
    expect(result.pending).toBe("");
  });
});
