/**
 * Structured argv checks.
 *
 * The runner always calls `Bun.spawn(argv)`. A shell string would be one
 * argument to `sh -c`, which expands `$`, quotes, and `;`. Rejecting those
 * shapes here means a profile cannot opt back into interpolation by accident.
 * Arguments may contain spaces — they stay separate argv entries.
 */

const SHELL_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "powershell",
  "pwsh",
]);

const SHELL_COMMAND_FLAGS = new Set(["-c", "-lc", "-cl", "--command", "/c", "-Command"]);

/** Metacharacters that only matter if something joins argv into a shell line. */
const SHELL_META = /[\s$&|;<>\\`'\"()*?!{}\n\r\0]/;

const BARE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ABSOLUTE_EXECUTABLE = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;

export function executableBasename(executable: string): string {
  const slash = executable.lastIndexOf("/");
  return slash === -1 ? executable : executable.slice(slash + 1);
}

/**
 * `null` when the command is safe to pass as argv. Otherwise a reason that
 * validation surfaces on the profile.
 */
export function commandRejection(executable: string, args: readonly string[]): string | null {
  if (typeof executable !== "string" || executable.length === 0) {
    return "executable is required";
  }
  if (executable.includes("\0") || args.some((arg) => arg.includes("\0"))) {
    return "command contains a NUL byte";
  }
  if (SHELL_META.test(executable) || !isExecutableToken(executable)) {
    return "executable must be a bare name or an absolute path, not a shell command";
  }
  if (executable.split("/").includes("..")) {
    return "executable must not contain '..'";
  }
  const base = executableBasename(executable);
  if (SHELL_BASENAMES.has(base)) {
    for (const arg of args) {
      if (SHELL_COMMAND_FLAGS.has(arg)) {
        return "refusing to run a shell with a command flag; pass the program and its arguments as argv";
      }
    }
  }
  for (const arg of args) {
    if (typeof arg !== "string") return "every argument must be a string";
  }
  return null;
}

function isExecutableToken(executable: string): boolean {
  if (executable.startsWith("/")) return ABSOLUTE_EXECUTABLE.test(executable);
  return BARE_EXECUTABLE.test(executable);
}

/**
 * Supervisor script. Bun.spawn cannot call setsid, and macOS `ps` does not
 * show another process's environment, so a PID plus an env var would be
 * unverifiable after restart.
 *
 * perl is started as its own session, forks the user program, and waits.
 * The ownership token is a separate argv entry (never interpolated into the
 * script). `ps -ww -o command=` shows that token, which is how a later
 * process proves the pid still belongs to this launch. The script ignores
 * TERM/INT so a group signal can stop the child without the supervisor
 * exiting first; the supervisor exits when the child does.
 *
 * Children that call setsid themselves leave the group. This core will not
 * hunt them down by name or port.
 */
export const PROCESS_GROUP_HELPER = {
  executable: "/usr/bin/perl",
  script: [
    "use POSIX qw(setsid);",
    "my $sid = setsid();",
    'exit 126 if !defined $sid || $sid < 0;',
    "my $token = shift @ARGV;",
    "my $child = fork();",
    'exit 127 unless defined $child;',
    'if ($child == 0) { exec @ARGV or exit 127; }',
    '$SIG{TERM} = "IGNORE";',
    '$SIG{INT} = "IGNORE";',
    '$SIG{HUP} = "IGNORE";',
    "waitpid($child, 0);",
    "my $status = $?;",
    'exit(($status & 127) ? 128 + ($status & 127) : ($status >> 8));',
  ].join(" "),
} as const;

export function directArgv(executable: string, args: readonly string[]): string[] {
  return [executable, ...args];
}

/** Token sits between the script and the user executable so `exec` never sees it. */
export function processGroupArgv(token: string, executable: string, args: readonly string[]): string[] {
  return [PROCESS_GROUP_HELPER.executable, "-e", PROCESS_GROUP_HELPER.script, token, executable, ...args];
}

/**
 * `ps` prints argv separated by spaces. The token is a whitespace-delimited
 * field and the next field is the executable (executables cannot contain
 * spaces — {@link commandRejection} rejects them).
 */
export function commandProvesToken(command: string, token: string, executable: string): boolean {
  if (!/^[a-f0-9]{32}$/.test(token)) return false;
  const fields = command.trim().split(/\s+/);
  const at = fields.indexOf(token);
  if (at < 0) return false;
  return fields[at + 1] === executable;
}

/** True when `argv` would hand a user string to a shell `-c` / `--command`. */
export function argvUsesShellCommandFlag(argv: readonly string[]): boolean {
  const executable = argv[0];
  if (!executable) return false;
  if (!SHELL_BASENAMES.has(executableBasename(executable))) return false;
  return argv.slice(1).some((arg) => SHELL_COMMAND_FLAGS.has(arg));
}
