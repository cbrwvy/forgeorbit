/**
 * Structured "please run my project test" suggestion from a Developer worker.
 *
 * The worker only emits a tag in its final assistant message. It never calls an API, holds no
 * token and names no command, path, rule or approval: the core reads the tag when it settles the
 * run it already knows (task, project, run), and derives the target itself. The body is accepted
 * only as a fixed marker; every other field is ignored, never used.
 */

export const WORKER_TEST_REQUEST_TAG = "project_test_request";
export const WORKER_TEST_REQUEST_ACTION = "run_project_test";
/** Only the tail of the assistant text is scanned, so one huge message cannot stall the core. */
export const WORKER_SUGGESTION_SCAN_CHARS = 64_000;

/** True only when the LAST tag in the tail is closed and holds `{"action":"run_project_test"}`. Linear time. */
export function parseWorkerTestSuggestion(text: string): boolean {
  const tail = text.length > WORKER_SUGGESTION_SCAN_CHARS ? text.slice(-WORKER_SUGGESTION_SCAN_CHARS) : text;
  const open = `<${WORKER_TEST_REQUEST_TAG}>`;
  const close = `</${WORKER_TEST_REQUEST_TAG}>`;
  const start = tail.lastIndexOf(open);
  if (start < 0) return false;
  const end = tail.indexOf(close, start + open.length);
  if (end < 0) return false;
  const body = tail.slice(start + open.length, end).trim();
  if (body.length > 2_000) return false;
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).action === WORKER_TEST_REQUEST_ACTION;
  } catch {
    return false;
  }
}
