/**
 * Server-side validation of the one command a project rule may name.
 * Kept apart from `project-permissions.ts` because it needs `review-evidence.ts`
 * (node:crypto), which must not enter the webview bundle.
 */
import { approvedTestCommand } from "./review-evidence.ts";

const TEST_COMMAND_PREFIX = "bun test ./";

export function validateRuleCommand(raw: unknown): { ok: true; command: string; testPath: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "A command is required." };
  const command = raw.trim();
  if (!command.startsWith(TEST_COMMAND_PREFIX)) {
    return { ok: false, error: "Only one fixed test command is supported: bun test ./<path to a test file>." };
  }
  const testPath = command.slice(TEST_COMMAND_PREFIX.length);
  if (approvedTestCommand(testPath) !== command) {
    return { ok: false, error: "That is not a fixed test command for a test file inside the project." };
  }
  return { ok: true, command, testPath };
}
