/**
 * Bounded reader for a Server-Sent Events body.
 *
 * Live ForgeOrbit routes such as `/runs/:id/events` stay open until the
 * client disconnects. Parsing that body with `response.json()` or waiting
 * for end-of-stream never returns. This reader keeps every complete event
 * already received, then cancels the body when the event cap or the deadline
 * is hit.
 */

export interface CollectedSseEvent {
  event: string | null;
  id: string | null;
  data: string;
}

export interface SseEvidenceLimits {
  /** Stop after this many complete data events. Comment frames do not count. */
  maxEvents: number;
  /** Stop after this many milliseconds even if fewer events arrived. */
  timeoutMs: number;
}

export interface SseEvidenceResult {
  events: CollectedSseEvent[];
  /** Why the reader stopped. `end` means the server closed the body. */
  reason: "max-events" | "timeout" | "end";
  /** Trailing bytes that were not yet a complete event. */
  pending: string;
}

/** Split a text buffer into complete SSE events and the unfinished tail. */
export function takeSseEvents(buffer: string): { events: CollectedSseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: CollectedSseEvent[] = [];
  for (const block of parts) {
    const parsed = parseSseBlock(block);
    if (parsed) events.push(parsed);
  }
  return { events, rest };
}

function parseSseBlock(block: string): CollectedSseEvent | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  let sawField = false;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value;
      sawField = true;
    } else if (field === "data") {
      data.push(value);
      sawField = true;
    } else if (field === "id") {
      id = value;
      sawField = true;
    }
  }
  if (!sawField) return null;
  return { event, id, data: data.join("\n") };
}

/**
 * Read `body` until `maxEvents` complete events, the timeout, or the server
 * closing the stream. Always cancels the reader before returning, so a
 * never-ending live route cannot hold the connection open.
 */
export async function collectSseStream(
  body: ReadableStream<Uint8Array>,
  limits: SseEvidenceLimits,
): Promise<SseEvidenceResult> {
  if (limits.maxEvents < 1) throw new Error("maxEvents must be at least 1");
  if (limits.timeoutMs < 1) throw new Error("timeoutMs must be at least 1");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: CollectedSseEvent[] = [];
  let pending = "";
  const deadline = Date.now() + limits.timeoutMs;
  try {
    while (events.length < limits.maxEvents) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { events, reason: "timeout", pending };
      // The rejection handler stays attached when the timeout wins, so
      // cancelling the reader cannot surface an unhandled read error.
      const readPromise = reader.read().then(
        (value) => ({ kind: "read" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const next = await Promise.race([
        readPromise,
        Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
      ]);
      if (next.kind === "timeout") return { events, reason: "timeout", pending };
      if (next.kind === "error") throw next.error;
      if (next.value.done) {
        pending += decoder.decode();
        const taken = takeSseEvents(pending + "\n\n");
        // A stream that ends without a trailing blank line still holds its
        // last event in `pending`. Flushing a separator captures it, and
        // any extra empty block adds nothing.
        for (const ev of taken.events) {
          if (events.length >= limits.maxEvents) break;
          events.push(ev);
        }
        return { events, reason: events.length >= limits.maxEvents ? "max-events" : "end", pending: "" };
      }
      pending += decoder.decode(next.value.value, { stream: true });
      const taken = takeSseEvents(pending);
      pending = taken.rest;
      for (const ev of taken.events) {
        events.push(ev);
        if (events.length >= limits.maxEvents) return { events, reason: "max-events", pending };
      }
    }
    return { events, reason: "max-events", pending };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
