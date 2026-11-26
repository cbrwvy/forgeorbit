import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { commandProvesToken } from "../../shared/environment/command.ts";
import { createBunCommandRunner } from "./command-runner.ts";
import { createBunProcessHost } from "./process-host.ts";

const token = "ab".repeat(16);

test("a local command receives argv literally, including characters a shell would expand", async () => {
  const host = createBunProcessHost({ perlAvailable: false });
  let stdout = "";
  const started = await host.start({
    executable: "/bin/echo",
    args: ["$HOME", "a; rm -rf /"],
    cwd: "/tmp",
    env: { PATH: "/bin:/usr/bin" },
    processGroup: false,
    token,
    onOutput(stream, text) {
      if (stream === "stdout") stdout += text;
    },
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  await started.process.exited;
  await Bun.sleep(50);
  expect(stdout).toBe("$HOME a; rm -rf /\n");
});

test("stdout and stderr are captured from the child", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo-proc-"));
  const script = path.join(dir, "speak.ts");
  writeFileSync(script, "console.log('out-line');\nconsole.error('err-line');\n");
  const host = createBunProcessHost({ perlAvailable: false });
  let stdout = "";
  let stderr = "";
  const started = await host.start({
    executable: process.execPath,
    args: [script],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    processGroup: false,
    token,
    onOutput(stream, text) {
      if (stream === "stdout") stdout += text;
      else stderr += text;
    },
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  await started.process.exited;
  await Bun.sleep(50);
  expect(stdout).toContain("out-line");
  expect(stderr).toContain("err-line");
});

test("a process-group supervisor is identifiable by its token and dies with its child", async () => {
  const host = createBunProcessHost({ perlAvailable: true });
  const started = await host.start({
    executable: "/bin/sleep",
    args: ["30"],
    cwd: "/tmp",
    env: { PATH: "/bin:/usr/bin" },
    processGroup: true,
    token,
    onOutput() {},
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const pid = started.process.pid;
  try {
    let text = "";
    let fields: string[] = [];
    const deadline = Date.now() + 2_000;
    do {
      const ps = Bun.spawn(["/bin/ps", "-p", String(pid), "-ww", "-o", "pid=,pgid=,command="], {
        stdout: "pipe",
        stderr: "pipe",
      });
      text = await new Response(ps.stdout).text();
      fields = text.trim().split(/\s+/);
      if (fields[0] === String(pid) && fields[1] === String(pid)) break;
      await Bun.sleep(20);
    } while (Date.now() < deadline);
    expect(commandProvesToken(text, token, "/bin/sleep")).toBe(true);
    expect(fields[0]).toBe(String(pid));
    expect(fields[1]).toBe(String(pid));
    started.process.signal("SIGTERM");
    const exit = await Promise.race([
      started.process.exited.then(() => "exited" as const),
      Bun.sleep(3_000).then(() => "timeout" as const),
    ]);
    expect(exit).toBe("exited");
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("a timed-out command runner kills its own child", async () => {
  const runner = createBunCommandRunner();
  const result = await runner.run(["/bin/sleep", "30"], { cwd: "/tmp", timeoutMs: 300 });
  expect(result.timedOut).toBe(true);
  expect(result.pid).not.toBeNull();
  await Bun.sleep(50);
  if (result.pid === null) return;
  expect(() => process.kill(result.pid as number, 0)).toThrow();
});
