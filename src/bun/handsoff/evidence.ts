/**
 * What the independent Reviewer sees for work that is still in its task-owned working copy.
 *
 * The ordinary review evidence reads published bytes from the project folder. Hands-off work reviews BEFORE anything
 * is applied, so the evidence is built from the working copy itself: the exact changed files, their diff and the
 * observed test. The fingerprint names those bytes; the same fingerprint is checked again right before the change is
 * applied, so a revision after the review can never inherit a passing result.
 */
import { listedFiles } from "../autonomy/observed-test.ts";
import { getTaskWorkspace } from "../task-workspace.ts";
import { sourceFingerprint } from "../../shared/review-evidence.ts";
import type { HandsoffResult } from "../../shared/handsoff.ts";

const MAX_SECTION_BYTES = 40_000;
const MAX_FILE_BYTES = 8_000;

/** Fingerprint of the settled working copy (the bytes a test judged and a publication would write). */
export function stagingFingerprint(taskId: string): string | null {
  const ws = getTaskWorkspace(taskId);
  if (!ws || (ws.status !== "settled" && ws.status !== "published" && ws.status !== "publication-partial")) return null;
  try { return sourceFingerprint(listedFiles(ws.stagingPath)); } catch { return null; }
}

/** A bounded, plain-text evidence section. Untrusted data for the Reviewer, never instructions. */
export function renderStagedEvidence(taskId: string, tests: HandsoffResult["tests"], fingerprint: string): string {
  const ws = getTaskWorkspace(taskId);
  const lines: string[] = [
    "Implementation evidence (the task's isolated working copy; nothing has been applied to the project folder yet).",
    `Source fingerprint: ${fingerprint}`,
  ];
  const changes = (ws?.changes ?? []).filter((change) => change.scope === "output" && change.kind !== "unchanged");
  lines.push(`Changed files (${changes.length}): ${changes.map((change) => `${change.kind} ${change.path}`).join(", ") || "none"}`);
  let budget = MAX_SECTION_BYTES;
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    const body = change.diff ?? change.text ?? "(no text available for this file)";
    const clipped = Buffer.byteLength(body) > MAX_FILE_BYTES ? `${body.slice(0, MAX_FILE_BYTES)}\n… (clipped at ${MAX_FILE_BYTES} bytes)` : body;
    if (Buffer.byteLength(clipped) > budget) { lines.push(`--- ${change.path}: omitted, the evidence size limit was reached ---`); continue; }
    budget -= Buffer.byteLength(clipped);
    lines.push(`--- ${change.path} (${change.kind}) ---`, clipped);
  }
  if (tests.state === "passed") lines.push(`Observed test: ${tests.command ?? "the project test"} PASSED in the offline sandbox. ${tests.summary ?? ""}`.trim());
  else if (tests.state === "failed") lines.push(`Observed test: ${tests.command ?? "the project test"} FAILED. ${tests.summary ?? ""}`.trim());
  else lines.push(`Observed test: none (${tests.state}). ${tests.summary ?? ""}`.trim());
  return lines.join("\n");
}
