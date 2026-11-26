import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnNativeBridge } from "./native-computer-bridge.ts";
import { NativeComputerSessionManager } from "./native-computer-session.ts";
import type { TaskComputerStep } from "../shared/task-computer-workflow.ts";

// Run with an explicitly selected development helper and an interactive macOS
// session with Accessibility permission. The two TextEdit fixtures may stay open.
const helper = process.env.FORGEORBIT_TEST_TEXTEDIT_HELPER;
test.skipIf(process.platform !== "darwin" || !helper)("real TextEdit edits only the approved document", async () => {
  const root = mkdtempSync("/tmp/forgeorbit-textedit-qa-");
  const id = Date.now();
  const document = `approved-${id}.txt`;
  const second = `other-${id}.txt`;
  const initial = "Status: Draft\n";
  const sentinel = "Unrelated fixture\n";
  writeFileSync(join(root, document), initial);
  writeFileSync(join(root, second), sentinel);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const bridge = spawnNativeBridge(helper!);
  const manager = new NativeComputerSessionManager({ root: join(root, "session"), bridge, journal: () => {} });
  expect(await bridge.call({ command: "permissions" })).toMatchObject({ ok: true, result: { accessibility: "granted" } });

  const edit = { find: "Draft", replace: "Reviewed" };
  const scope = { kind: "textedit" as const, document, edit };
  const steps: TaskComputerStep[] = [];
  const run = (workflowScope: typeof scope | { kind: "textedit"; document: string; edit: null }, action: "read" | "edit") =>
    manager.runTaskDocument(workflowScope, root, digest(initial), action, new AbortController().signal, () => {}, step => steps.push(step));
  expect(await run({ ...scope, edit: null }, "edit")).toBe("read-only");

  const subject = { workspace: root, document, expected: digest(initial) };
  const opened = await bridge.call({ command: "task-document-open", ...subject });
  if (!opened.ok) throw new Error(opened.message);
  expect(await bridge.call({
    command: "task-document-open", workspace: root, document: second, expected: digest(sentinel),
  })).toMatchObject({ ok: true });
  expect(await bridge.call({
    command: "task-document-edit", ...subject, target: opened.result.target, windowId: opened.result.windowId, writable: true, ...edit,
  })).toMatchObject({ ok: false, code: "window_mismatch" });
  expect(readFileSync(join(root, document), "utf8")).toBe(initial);
  expect(readFileSync(join(root, second), "utf8")).toBe(sentinel);

  const outcome = await run(scope, "edit");
  expect({ outcome, steps }).toMatchObject({ outcome: "verified", steps: [
    { operation: "edit", outcome: "read-only" },
    { operation: "open", outcome: "verified" },
    { operation: "read", outcome: "verified" },
    { operation: "edit", outcome: "verified" },
    { operation: "save", outcome: "verified" },
  ] });
  expect(readFileSync(join(root, document), "utf8")).toBe("Status: Reviewed\n");
  expect(readFileSync(join(root, second), "utf8")).toBe(sentinel);
}, 30_000);
