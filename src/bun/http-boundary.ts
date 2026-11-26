/**
 * Request failure boundary for the local HTTP API.
 *
 * The API runs inside the backend Worker. A route handler that rejects or throws and is not
 * caught does not only fail its own request: Bun reports it to the Worker, the Worker emits
 * `error`, and the lifecycle supervisor exits the whole app (FO-UPGRADE02, exit status 1).
 * Everything that goes through `authed` and the `Bun.serve` `error` hook therefore ends in
 * `failedRequestResponse`: one 500 for that request, one diagnostic line, and the server keeps
 * serving.
 *
 * The diagnostic never carries the error message (it can quote task titles, prompts or paths),
 * the query string or a raw path segment that looks like an id. It has a short random id that
 * is returned to the caller, the error class name, the masked route and the top stack frames
 * (function and file:line only). It does not touch startup or process-level failures: those
 * are not request errors and still stop the process.
 */
import { randomBytes } from "node:crypto";

const FRAME_LIMIT = 4;

/**
 * Keep the shape of a path and drop anything that could name something. A segment is kept only
 * if it is a plain lower-case word and the segment before it is not a plural collection name
 * (`/tasks/<id>/supervised-workflow` becomes `/tasks/:x/supervised-workflow`).
 */
export function maskPath(pathname: string): string {
  let previous = "";
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      const word = /^[a-z][a-z-]{0,31}$/.test(segment) && !previous.endsWith("s");
      previous = word ? segment : ":x";
      return word ? segment : ":x";
    })
    .join("/");
}

/** `fn (file.ts:12)` for the first frames of a stack, without the message line. */
export function stackFrames(err: unknown, limit = FRAME_LIMIT): string[] {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const match = /^\s*at\s+(?:(.+?)\s+\()?(?:.*[\\/])?([^\\/():]+):(\d+)(?::\d+)?\)?\s*$/.exec(line);
    if (!match) continue;
    frames.push(`${match[1] ? match[1].replace(/[^\w.$<>]/g, "") : "<anonymous>"} (${match[2]}:${match[3]})`);
    if (frames.length >= limit) break;
  }
  return frames;
}

export interface RequestDiagnostic {
  id: string;
  line: string;
}

export function diagnosticFor(err: unknown, method: string, pathname: string): RequestDiagnostic {
  const id = randomBytes(4).toString("hex");
  const name = err instanceof Error && /^[A-Za-z0-9_$]{1,64}$/.test(err.name) ? err.name : typeof err;
  const frames = stackFrames(err);
  return {
    id,
    line: `[http] request failed ${id} ${method.toUpperCase()} ${maskPath(pathname)} ${name}${frames.length ? " at " + frames.join(" < ") : ""}`,
  };
}

/** Log the diagnostic and answer that one request with a 500. */
export function failedRequestResponse(req: Request, err: unknown, headers?: HeadersInit): Response {
  let pathname = "/";
  try { pathname = new URL(req.url).pathname; } catch { /* keep "/" */ }
  const diagnostic = diagnosticFor(err, req.method, pathname);
  try { console.error(diagnostic.line); } catch { /* logging must never fail a request */ }
  return Response.json({ error: "Internal error.", diagnosticId: diagnostic.id }, { status: 500, headers });
}

/** Last-resort handler for the `Bun.serve` `error` hook, which has no request to read. */
export function serverErrorResponse(err: unknown): Response {
  const diagnostic = diagnosticFor(err, "-", "/");
  try { console.error(diagnostic.line); } catch { /* ignore */ }
  return Response.json({ error: "Internal error.", diagnosticId: diagnostic.id }, { status: 500 });
}
