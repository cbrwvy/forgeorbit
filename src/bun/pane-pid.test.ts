import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pane-pid-"));
const { panePidFor } = await import("./claude-tmux.ts");

/** Fake `tmux` whose `list-panes` prints `stdout` and exits `code`; every
 *  other subcommand succeeds silently. Socket args (`-L …`) may precede the
 *  subcommand, hence the arg scan. */
function fakeTmux(stdout: string, code = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-fake-tmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(
    bin,
    "#!/bin/sh\n"
    + "for a in \"$@\"; do\n"
    + "  if [ \"$a\" = \"list-panes\" ]; then\n"
    + `    printf ${JSON.stringify(stdout)}\n`
    + `    exit ${code}\n`
    + "  fi\n"
    + "done\n"
    + "exit 0\n",
  );
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return () => {
    if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prev;
  };
}

test("panePidFor: exact session-name match on the list-panes listing", async () => {
  const restore = fakeTmux("agetor-other 111\nagetor-x 4242\nagetor-x2 9\n");
  try {
    expect(await panePidFor("agetor-x")).toBe(4242);
    expect(await panePidFor("agetor-x2")).toBe(9);
    expect(await panePidFor("agetor-other")).toBe(111);
  } finally { restore(); }
});

test("panePidFor: a name prefix never matches (agetor-x must not read agetor-x2's pid)", async () => {
  const restore = fakeTmux("agetor-x2 9\n");
  try { expect(await panePidFor("agetor-x")).toBeNull(); } finally { restore(); }
});

test("panePidFor: the first listed pane wins when the user split the window", async () => {
  const restore = fakeTmux("agetor-x 4242\nagetor-x 5151\n");
  try { expect(await panePidFor("agetor-x")).toBe(4242); } finally { restore(); }
});

test("panePidFor: an empty/unparseable pid field is null, never 0 (tmux 3.6a empty-format trap)", async () => {
  for (const out of ["agetor-x \n", "agetor-x abc\n", "agetor-x 0\n", "agetor-x\n", ""]) {
    const restore = fakeTmux(out);
    try { expect(await panePidFor("agetor-x")).toBeNull(); } finally { restore(); }
  }
});

test("panePidFor: a failing tmux is null", async () => {
  const restore = fakeTmux("agetor-x 4242\n", 1);
  try { expect(await panePidFor("agetor-x")).toBeNull(); } finally { restore(); }
});

test("panePidFor: a session name that itself contains a space is matched whole", async () => {
  const restore = fakeTmux("my session 77\nmy 5\n");
  try {
    expect(await panePidFor("my session")).toBe(77);
    expect(await panePidFor("my")).toBe(5);
  } finally { restore(); }
});

test("panePidFor: reads the pid of a real tmux session (tmux 3.8 turns a TAB in -F output into '_')", async () => {
  const bin = Bun.which("tmux");
  if (!bin) return;
  const prevBin = process.env.AGETOR_TMUX_BIN;
  const prevSocket = process.env.AGETOR_TMUX_SOCKET;
  const socket = `agetor-panepid-${process.pid}`;
  process.env.AGETOR_TMUX_BIN = bin;
  process.env.AGETOR_TMUX_SOCKET = socket;
  try {
    const started = Bun.spawnSync([bin, "-L", socket, "new-session", "-d", "-s", "agetor-real-pane", "sleep", "30"]);
    expect(started.exitCode).toBe(0);
    const pid = await panePidFor("agetor-real-pane");
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid!, 0)).not.toThrow();
  } finally {
    Bun.spawnSync([bin, "-L", socket, "kill-server"]);
    if (prevBin === undefined) delete process.env.AGETOR_TMUX_BIN; else process.env.AGETOR_TMUX_BIN = prevBin;
    if (prevSocket === undefined) delete process.env.AGETOR_TMUX_SOCKET; else process.env.AGETOR_TMUX_SOCKET = prevSocket;
  }
});
