/**
 * Owner API for one task-owned staging directory.
 * Prepare and read do not start a Developer. Publish does not start a Reviewer
 * or a test, and it does not commit or push.
 */
import {
  abandonTaskWorkspace,
  getTaskWorkspace,
  prepareTaskWorkspace,
  publishTaskWorkspace,
  TaskWorkspaceError,
} from "./task-workspace.ts";
import { runWorkingCopyCheck } from "./working-copy-checks.ts";

async function readJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new TaskWorkspaceError("JSON body required.", 400, "invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > 64_000) throw new TaskWorkspaceError("Request body is too large.", 400, "invalid");
    chunks.push(next.value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TaskWorkspaceError("Request body is not JSON.", 400, "invalid");
  }
}

function taskIdOf(value: unknown): string {
  const record = value && typeof value === "object" ? value as { taskId?: unknown } : {};
  const taskId = typeof record.taskId === "string" ? record.taskId : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new TaskWorkspaceError("taskId is required.", 400, "invalid");
  return taskId;
}

export async function taskWorkspaceHttp(req: Request, authorized: boolean): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (!authorized) return reply({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  try {
    if (url.pathname === "/task-workspace" && req.method === "GET") {
      const taskId = url.searchParams.get("taskId") ?? "";
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) return reply({ error: "taskId is required." }, 400);
      return reply({ workspace: getTaskWorkspace(taskId) });
    }
    if (url.search) return reply({ error: "Unsupported field." }, 400);
    if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
    const body = await readJson(req) as {
      taskId?: unknown;
      outputPaths?: unknown;
      dependencyPaths?: unknown;
      includePaths?: unknown;
      writeScope?: unknown;
      approve?: unknown;
      paths?: unknown;
      command?: unknown;
    };
    const taskId = taskIdOf(body);
    if (url.pathname === "/task-workspace/prepare") return reply({ workspace: await prepareTaskWorkspace(taskId, body) });
    if (url.pathname === "/task-workspace/abandon") return reply({ workspace: abandonTaskWorkspace(taskId) });
    if (url.pathname === "/task-workspace/publish") return reply({ workspace: await publishTaskWorkspace(taskId, body) });
    if (url.pathname === "/task-workspace/check") {
      const cmd = body.command;
      const validCmd = (typeof cmd === "string" && cmd.trim().length > 0)
        || (Array.isArray(cmd) && cmd.length > 0 && cmd.every((item) => typeof item === "string"));
      if (!validCmd) throw new TaskWorkspaceError("command is required.", 400, "invalid");
      const check = await runWorkingCopyCheck({ taskId, command: cmd as string | readonly string[] });
      return reply({ check, workspace: getTaskWorkspace(taskId) });
    }
    return reply({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof TaskWorkspaceError) return reply({ error: error.message, code: error.code }, error.status);
    return reply({ error: "The request could not be completed." }, 500);
  }
}
