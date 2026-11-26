/**
 * Pure, bounded unified diff generator for text files in a task working copy.
 * Browser-safe (no node:* imports), deterministic, and never shells out.
 */

const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: " " | "-" | "+"; line: string };

function diffLines(before: string[], after: string[]): Op[] {
  // Trim shared prefix & suffix first so large files with small edits stay fast.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: " ", line: before[i]! });

  const midBefore = before.slice(start, endBefore);
  const midAfter = after.slice(start, endAfter);
  const m = midBefore.length;
  const n = midAfter.length;

  if (m === 0) {
    for (const line of midAfter) ops.push({ kind: "+", line });
  } else if (n === 0) {
    for (const line of midBefore) ops.push({ kind: "-", line });
  } else if (m * n > MAX_LCS_CELLS) {
    // Bounded fallback for very large edits: emit removed block followed by added block.
    for (const line of midBefore) ops.push({ kind: "-", line });
    for (const line of midAfter) ops.push({ kind: "+", line });
  } else {
    const dp = new Int32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (midBefore[i] === midAfter[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)]! + 1;
        } else {
          const down = dp[(i + 1) * stride + j]!;
          const right = dp[i * stride + (j + 1)]!;
          dp[i * stride + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midBefore[i] === midAfter[j]) {
        ops.push({ kind: " ", line: midBefore[i]! });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
        ops.push({ kind: "-", line: midBefore[i]! });
        i += 1;
      } else {
        ops.push({ kind: "+", line: midAfter[j]! });
        j += 1;
      }
    }
    while (i < m) ops.push({ kind: "-", line: midBefore[i++]! });
    while (j < n) ops.push({ kind: "+", line: midAfter[j++]! });
  }

  for (let i = endBefore; i < before.length; i += 1) ops.push({ kind: " ", line: before[i]! });
  return ops;
}

export function formatUnifiedDiff(input: {
  path: string;
  kind: "created" | "modified" | "deleted";
  beforeText: string | null;
  afterText: string | null;
  renamedFrom?: string | null;
  contextLines?: number;
  maxChars?: number;
}): string {
  const ctx = input.contextLines ?? 3;
  const maxChars = input.maxChars ?? 16_000;
  const beforeLines = input.kind === "created" ? [] : splitLines(input.beforeText ?? "");
  const afterLines = input.kind === "deleted" ? [] : splitLines(input.afterText ?? "");

  const header: string[] = [];
  if (input.renamedFrom) {
    header.push(`diff --git a/${input.renamedFrom} b/${input.path}`);
    header.push(`rename from ${input.renamedFrom}`);
    header.push(`rename to ${input.path}`);
  } else {
    header.push(`diff --git a/${input.path} b/${input.path}`);
  }
  header.push(input.kind === "created" && !input.renamedFrom ? "--- /dev/null" : `--- a/${input.renamedFrom ?? input.path}`);
  header.push(input.kind === "deleted" ? "+++ /dev/null" : `+++ b/${input.path}`);

  if (input.renamedFrom && input.beforeText === input.afterText) {
    return header.join("\n");
  }

  const ops = diffLines(beforeLines, afterLines);
  const changedIndices: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== " ") changedIndices.push(i);
  }
  if (changedIndices.length === 0) return header.join("\n");

  // Group changed indices into hunks with `ctx` lines of surrounding context.
  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - ctx);
    const end = Math.min(ops.length - 1, idx + ctx);
    const prev = hunks[hunks.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const out: string[] = [...header];
  for (const hunk of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (let i = 0; i < hunk.start; i += 1) {
      const k = ops[i]!.kind;
      if (k === " " || k === "-") oldLine += 1;
      if (k === " " || k === "+") newLine += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let i = hunk.start; i <= hunk.end; i += 1) {
      const op = ops[i]!;
      if (op.kind === " " || op.kind === "-") oldCount += 1;
      if (op.kind === " " || op.kind === "+") newCount += 1;
      body.push(`${op.kind}${op.line}`);
    }
    const oldStart = oldCount === 0 ? 0 : oldLine;
    const newStart = newCount === 0 ? 0 : newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }

  const text = out.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (diff truncated at ${maxChars} chars)`;
}
