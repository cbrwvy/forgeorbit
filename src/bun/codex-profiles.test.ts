import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, renameSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-multiaccount01-unit-")));
const ownerHome = path.join(root, "owner"); mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
const bin = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_CODEX_BIN = bin;
const { db, harnesses, projects } = await import("./db.ts");
const { AccountCore, AccountCoreError } = await import("./account-core.ts");
const { CodexProfiles, assertCodexProfileAuthentication, __setCodexProfileRealpathForTest } = await import("./codex-profiles.ts");
const { resourceKey, freezeWorkflowExecution, workflowResourceBlock } = await import("./orchestrated-resources.ts");
const { buildCommand, buildCodexCommand } = await import("./agents.ts");
const { executionFromEvents } = await import("../shared/run-execution.ts");
const { makeTask } = await import("../cli/test-fixtures.ts");
const core = new AccountCore(db), profiles = new CodexProfiles(core);
let seq = 0;
function add(name = "Synthetic") {
  const directory = path.join(ownerHome, `profile-${++seq}`);
  writeSyntheticCodexProfile(directory, `subject-${seq}`);
  return profiles.register({ displayName: name, directory });
}
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("two independent AccountCore profiles pass their own supported status; quota remains Unknown", async () => {
  const a = add("A"), b = add("B");
  expect(a.accountId).not.toBe(b.accountId);
  for (const p of [a,b]) {
    const checked = await profiles.check(p.accountId);
    expect(checked).toMatchObject({ authentication: "authenticated", availability: "ready", quota: "unknown" });
    expect(core.resolveIdentity(p.harnessId).accountId).toBe(p.accountId);
    expect(core.currentQuotas(p.accountId)).toEqual([]);
  }
  expect(resourceKey(harnesses.get(a.harnessId)!)).not.toBe(resourceKey(harnesses.get(b.harnessId)!));
});

test("missing/authentication-failed profile blocks with no inherited default fallback", async () => {
  const p = add();
  rmSync(path.join(p.directory, "synthetic-authenticated"));
  process.env.OPENAI_API_KEY = "synthetic-ambient-forbidden";
  try {
    expect(await profiles.check(p.accountId)).toMatchObject({ authentication: "required", availability: "authentication-required" });
    await expect(assertCodexProfileAuthentication(harnesses.get(p.harnessId)!)).rejects.toThrow("No default fallback");
    renameSync(p.directory, p.directory + "-missing");
    expect(profiles.view(p.accountId).availability).toBe("unavailable");
    expect(() => buildCommand(harnesses.get(p.harnessId)!, "never delivered", { model:"gpt-6.1-sol",effort:"low",mode:"ask" })).toThrow();
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("actual concurrent fixture processes receive selected CODEX_HOME, independent identities and no ambient auth", async () => {
  const a = add("Concurrent A"), b = add("Concurrent B");
  process.env.OPENAI_API_KEY = "synthetic-ambient-forbidden";
  process.env.CODEX_ACCESS_TOKEN = "synthetic-ambient-forbidden";
  try {
    await Promise.all([a,b].map(async p => {
      const built = buildCommand(harnesses.get(p.harnessId)!, "synthetic", { model:"gpt-6.1-sol", effort:"low", mode:"ask", codexWorkspaceLayout:"non-git" });
      const proc = Bun.spawn(built.cmd, { env: { ...process.env, ...built.env }, cwd: root, stdin:"pipe", stdout:"pipe", stderr:"pipe" });
      proc.stdin.write("synthetic only"); proc.stdin.end();
      const [output, code] = await Promise.all([new Response(proc.stdout).text(),proc.exited]);
      expect(code).toBe(0); expect(output).toContain('"type":"turn.completed"');
      const launch = JSON.parse(readFileSync(path.join(p.directory,"synthetic-launches.jsonl"),"utf8"));
      expect(launch).toMatchObject({ home:p.directory,clean:true,fileStore:true,cwd:root });
      expect(launch.subject).toBe(readFileSync(path.join(p.directory,"synthetic-authenticated"),"utf8"));
    }));
    expect(process.env.OPENAI_API_KEY).toBe("synthetic-ambient-forbidden");
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.CODEX_ACCESS_TOKEN; }
});

test("actual adapter binds each profile home and keeps reviewer read-only while developer stays workspace-write", async () => {
  const a = add("Boundary A"), b = add("Boundary B");
  const repo = path.join(ownerHome, `repo-${++seq}`);
  mkdirSync(repo);
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  const parentHome = process.env.CODEX_HOME;
  process.env.OPENAI_API_KEY = "synthetic-ambient-forbidden";
  process.env.CODEX_ACCESS_TOKEN = "synthetic-ambient-forbidden";
  const opts = { model: "gpt-6.1-sol", effort: "low" as const };
  try {
    const cases = [
      { profile: a, mode: "auto" as const, sandbox: "workspace-write" },
      { profile: b, mode: "auto" as const, sandbox: "workspace-write" },
      { profile: b, mode: "ask" as const, sandbox: "read-only" },
    ];
    for (const c of cases) {
      const other = c.profile === a ? b.directory : a.directory;
      const built = await buildCodexCommand(harnesses.get(c.profile.harnessId)!, "synthetic", { ...opts, mode: c.mode }, repo);
      expect(built.env?.CODEX_HOME).toBe(c.profile.directory);
      expect(built.cmd[0]).toBe("/usr/bin/env");
      expect(built.cmd).toContain('cli_auth_credentials_store="file"');
      expect(built.cmd).toContain("-u");
      expect(built.cmd[built.cmd.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
      expect(built.cmd[built.cmd.indexOf("--sandbox") + 1]).toBe(c.sandbox);
      expect(built.cmd).not.toContain("danger-full-access");
      expect(built.cmd.join("\0")).not.toContain(other);
      const proc = Bun.spawn(built.cmd, { env: { ...process.env, ...built.env }, cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.write("synthetic only"); proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const launch = JSON.parse(readFileSync(path.join(c.profile.directory, "synthetic-launches.jsonl"), "utf8").trim().split("\n").at(-1)!);
      expect(launch).toMatchObject({ home: c.profile.directory, clean: true, fileStore: true, cwd: repo });
      expect(launch.argv[launch.argv.indexOf("--sandbox") + 1]).toBe(c.sandbox);
      expect(JSON.stringify(launch)).not.toContain(other);
    }
    expect(process.env.CODEX_HOME).toBe(parentHome);
    const task = makeTask({ agent: a.harnessId, mode: "auto", model: "gpt-6.1-sol", workdir: repo, isolation: "none" });
    const body = { implementerEmployeeId: "employee", implementerHarnessId: a.harnessId, implementerModel: "gpt-6.1-sol", implementerMode: "auto", reviewerHarness: b.harnessId, reviewerModel: "gpt-6.1-sol", reviewerMode: "ask" };
    const execution = freezeWorkflowExecution(task, body);
    expect(execution.implementerAccountProfile).toEqual({ id: a.accountId, displayName: "Boundary A" });
    expect(execution.reviewerAccountProfile).toEqual({ id: b.accountId, displayName: "Boundary B" });
    expect(execution.boundedPolicy).toBeNull();
    expect(execution.implementerHarnessKey).not.toBe(execution.reviewerHarnessKey);
    expect(() => freezeWorkflowExecution(task, { ...body, reviewerMode: "auto" })).toThrow(/read-only/);
    expect(executionFromEvents([{ stream: "status", data: JSON.stringify({ kind: "execution-identity", executionType: "fixture", provider: "codex", model: "gpt-6.1-sol", mode: "ask", accountProfile: { id: b.accountId, displayName: "Boundary B", harnessId: b.harnessId } }) }], "succeeded")).toMatchObject({
      type: "fixture", provider: "codex", model: "gpt-6.1-sol", mode: "ask", turns: null, reportedCostUsd: null, quota: "unknown",
      accountProfile: { id: b.accountId, displayName: "Boundary B" },
    });
    await expect(buildCodexCommand(harnesses.get(a.harnessId)!, "no", { ...opts, mode: "auto" }, path.join(repo, "missing"))).rejects.toThrow(/Unknown/);
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.CODEX_ACCESS_TOKEN; }
});

test("rename keeps stable identity/resource key and frozen historical attribution", () => {
  const p = add("Original"); const h = harnesses.get(p.harnessId)!, key = resourceKey(h);
  const events = [{stream:"status",data:JSON.stringify({kind:"execution-identity",executionType:"synthetic",provider:"codex",accountProfile:{id:p.accountId,displayName:"Original",harnessId:p.harnessId}})}];
  profiles.register({displayName:"Renamed",directory:p.directory},p.accountId);
  expect(resourceKey(harnesses.get(p.harnessId)!)).toBe(key);
  expect(profiles.view(p.accountId).displayName).toBe("Renamed");
  expect(executionFromEvents(events,"completed").accountProfile?.displayName).toBe("Original");
  expect(executionFromEvents([],"completed").accountProfile).toBeUndefined();
});

test("path change, directory replacement and removal invalidate grant resource; credentials are never removed", () => {
  const p = add(); const h = harnesses.get(p.harnessId)!, key = resourceKey(h);
  const other = path.join(ownerHome,`new-${++seq}`); writeSyntheticCodexProfile(other,"independent-new");
  profiles.register({displayName:"Moved",directory:other},p.accountId);
  expect(resourceKey(harnesses.get(p.harnessId)!)).not.toBe(key);
  expect(() => buildCommand(h,"stale",{model:"gpt-6.1-sol",effort:"low"})).toThrow();
  renameSync(other,other+"-retained"); mkdirSync(other);
  expect(profiles.view(p.accountId).availability).toBe("unavailable");
  const q = add(); profiles.remove(q.accountId);
  expect(existsSync(path.join(q.directory,"synthetic-authenticated"))).toBe(true);
  expect(harnesses.get(q.harnessId)?.enabled).toBe(false);
  harnesses.setEnabled(q.harnessId,true);
  expect(() => resourceKey(harnesses.get(q.harnessId)!)).toThrow();
});

test("invalid, duplicate, symlink, nested, workspace and app-data paths are rejected", () => {
  const p = add();
  const nested = path.join(p.directory,"nested"); mkdirSync(nested);
  const link = path.join(ownerHome,`link-${++seq}`); symlinkSync(p.directory,link);
  const project = path.join(ownerHome,`project-${++seq}`); mkdirSync(project); projects.upsert(project,"Never an auth root");
  for (const directory of ["relative",ownerHome,"/",p.directory,nested,link,project,path.join(ownerHome,"missing"),process.env.AGETOR_DATA_DIR!]) {
    expect(() => profiles.register({displayName:"Unsafe",directory})).toThrow();
  }
  const linkedAuth = path.join(ownerHome,`linked-auth-${++seq}`); mkdirSync(linkedAuth);
  symlinkSync(path.join(p.directory,"synthetic-authenticated"),path.join(linkedAuth,"auth.json"));
  expect(() => profiles.register({displayName:"Linked auth",directory:linkedAuth})).toThrow();
});

test("AccountCore restart read preserves identities and selected resource; single-account Codex remains unchanged", () => {
  const p = add();
  expect(new CodexProfiles(new AccountCore(db)).view(p.accountId)).toMatchObject(p);
  const builtin = harnesses.get("codex")!;
  const built = buildCommand(builtin,"",{model:"gpt-6.1-sol",effort:"low",mode:"ask",codexWorkspaceLayout:"non-git"});
  expect(built.cmd[0]).toBe(bin); expect(built.cmd).not.toContain('cli_auth_credentials_store="file"');
  expect(core.resolveIdentity("codex").accountId).toBeNull();
});

test("FO-AUTO01 resource freeze explicitly binds each selected profile and catches later changes", () => {
  const a = add("Grant A"), b = add("Grant B");
  const task = makeTask({agent:a.harnessId,mode:"ask",model:"gpt-6.1-sol",workdir:root});
  const execution = freezeWorkflowExecution(task,{implementerEmployeeId:"employee",implementerHarnessId:a.harnessId,implementerModel:"gpt-6.1-sol",implementerMode:"ask",reviewerHarness:b.harnessId,reviewerModel:"gpt-6.1-sol",reviewerMode:"ask"});
  expect(execution.implementerAccountProfile).toEqual({id:a.accountId,displayName:"Grant A"});
  expect(execution.reviewerAccountProfile).toEqual({id:b.accountId,displayName:"Grant B"});
  const grant = { taskId:task.id,implementerHarnessId:a.harnessId,implementerModel:task.model,reviewerHarness:b.harnessId,reviewerModel:task.model,execution } as any;
  profiles.remove(b.accountId);
  expect(workflowResourceBlock(grant,true)).toContain("unavailable");
});


test("removed profile can be registered again with a new ID; old identity stays blocked", () => {
  const p = add(); profiles.remove(p.accountId);
  const readded = profiles.register({displayName:"Registered again",directory:p.directory});
  expect(readded.accountId).not.toBe(p.accountId);
  expect(() => resourceKey(harnesses.get(p.harnessId)!)).toThrow();
  expect(core.resolveIdentity(readded.harnessId).accountId).toBe(readded.accountId);
});

test("status strips ANSI formatting, alternate account binding is refused and terminal launch keeps file auth", async () => {
  const p = add(); const h = harnesses.get(p.harnessId)!;
  const old = process.env.FORCE_COLOR; process.env.FORCE_COLOR = "1";
  try { expect((await profiles.check(p.accountId)).availability).toBe("ready"); }
  finally { if (old === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = old; }
  const other = core.createAccount({provider:"openai",displayName:"Unrelated metadata"});
  expect(() => core.bindHarness(other.id,p.harnessId)).toThrow();
  const { buildHarnessTerminalCommand } = await import("./agents.ts");
  const command = buildHarnessTerminalCommand(h);
  expect(command).toContain(p.directory); expect(command).toContain("cli_auth_credentials_store");
  expect(command).toContain("'-u' 'CODEX_ACCESS_TOKEN'");
});


test("consented catalog transport keeps the selected file-auth context and strips ambient credentials", async () => {
  const p = add();
  const { harnessEnv } = await import("./agents.ts");
  const { openCodexStdio } = await import("./codex-stdio.ts");
  process.env.CODEX_ACCESS_TOKEN = "synthetic-ambient-forbidden";
  const connection = openCodexStdio({bin,env:harnessEnv(harnesses.get(p.harnessId)!),timeoutMs:3000});
  try {
    const reply = await connection.call("initialize", {}) as any;
    expect(reply.result).toMatchObject({home:p.directory,clean:true,fileStore:true});
    expect(reply.result.subject).toBe(readFileSync(path.join(p.directory,"synthetic-authenticated"),"utf8"));
  } finally { connection.close(); delete process.env.CODEX_ACCESS_TOKEN; }
});


function denied(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
function realpathDenying(blocked: string, code: string) {
  return (candidate: string) => {
    if (candidate === blocked) throw denied(code);
    return realpathSync(candidate);
  };
}

test("default, second and third Codex homes stay distinct and do not replace built-in Codex", () => {
  const homes = [".codex", ".codex-secondary", ".codex-extra"].map((name) => path.join(ownerHome, name));
  const registered = homes.map((directory, index) => {
    writeSyntheticCodexProfile(directory, `subject-home-${index}`);
    return profiles.register({ displayName: `Home ${index}`, directory });
  });
  expect(new Set(registered.map((p) => p.accountId)).size).toBe(3);
  expect(new Set(registered.map((p) => p.harnessId)).size).toBe(3);
  for (const profile of registered) {
    expect(profile.harnessId).toBe(`codex-profile-${profile.accountId}`);
    expect(harnesses.get(profile.harnessId)).toMatchObject({ home: null, env: { CODEX_HOME: profile.directory } });
    expect(Object.keys(harnesses.get(profile.harnessId)!.env)).toEqual(["CODEX_HOME"]);
  }
  expect(core.resolveIdentity("codex").accountId).toBeNull();
  expect(harnesses.get("codex")!.id).not.toBe(registered[0]!.harnessId);
  expect(() => profiles.register({ displayName: "Duplicate default", directory: homes[0]! })).toThrow(AccountCoreError);
});

test("an unreadable non-symlink protected directory does not crash an unrelated profile", () => {
  const trash = path.join(ownerHome, ".Trash");
  const ssh = path.join(ownerHome, ".ssh");
  const aws = path.join(ownerHome, ".aws");
  mkdirSync(trash);
  mkdirSync(ssh);
  mkdirSync(aws);
  const directory = path.join(ownerHome, "profile-beside-trash");
  writeSyntheticCodexProfile(directory, "beside-trash");
  __setCodexProfileRealpathForTest(realpathDenying(trash, "EPERM"));
  try {
    const registered = profiles.register({ displayName: "Beside Trash", directory });
    expect(registered.directory).toBe(directory);
    expect(harnesses.get(registered.harnessId)!.env).toEqual({ CODEX_HOME: directory });
    expect(() => profiles.register({ displayName: "Trash", directory: trash })).toThrow(/cannot overlap/);
    const hidden = path.join(trash, "hidden-profile");
    mkdirSync(hidden);
    expect(() => profiles.register({ displayName: "Hidden", directory: hidden })).toThrow(/cannot overlap/);
  } finally { __setCodexProfileRealpathForTest(null); }
});

test("readable protected directories, descendants, symlinks and aliases are refused", () => {
  const trash = path.join(ownerHome, ".Trash");
  const ssh = path.join(ownerHome, ".ssh");
  const aws = path.join(ownerHome, ".aws");
  mkdirSync(path.join(ssh, "keys"), { recursive: true });
  mkdirSync(path.join(aws, "sub"), { recursive: true });
  for (const directory of [trash, ssh, aws, path.join(ssh, "keys"), path.join(aws, "sub"), path.join(trash, "hidden-profile")]) {
    expect(() => profiles.register({ displayName: "Forbidden", directory })).toThrow(AccountCoreError);
  }
  const alias = path.join(ownerHome, "ssh-alias");
  symlinkSync(ssh, alias);
  expect(() => profiles.register({ displayName: "Alias", directory: alias })).toThrow(/symlink aliases/);
  rmSync(alias);
  const profile = path.join(ownerHome, "profile-alias-target");
  writeSyntheticCodexProfile(profile, "alias-target");
  rmSync(ssh, { recursive: true });
  symlinkSync(profile, ssh);
  try {
    expect(() => profiles.register({ displayName: "Overlapped", directory: profile })).toThrow(/cannot overlap/);
  } finally { rmSync(ssh); mkdirSync(ssh); }
  const renamed = profiles.register({ displayName: "Alias target", directory: profile });
  const again = profiles.register({ displayName: "Renamed alias target", directory: profile }, renamed.accountId);
  expect(again.accountId).toBe(renamed.accountId);
  expect(again.harnessId).toBe(renamed.harnessId);
});

test("missing directories and non-file authentication records are validation errors", () => {
  expect(() => profiles.register({ displayName: "Missing", directory: path.join(ownerHome, "missing-profile") })).toThrow(/missing or unreadable/);
  const directory = path.join(ownerHome, "auth-is-directory");
  mkdirSync(path.join(directory, "auth.json"), { recursive: true });
  expect(() => profiles.register({ displayName: "Bad auth", directory })).toThrow(/regular, independent files/);
});

test("a protected symlink or non-permission realpath failure refuses registration", () => {
  const trash = path.join(ownerHome, ".Trash");
  const directory = path.join(ownerHome, "profile-ambiguous");
  writeSyntheticCodexProfile(directory, "ambiguous");
  const target = path.join(ownerHome, "trash-target");
  rmSync(trash, { recursive: true });
  mkdirSync(target);
  symlinkSync(target, trash);
  __setCodexProfileRealpathForTest(realpathDenying(trash, "EPERM"));
  try {
    expect(() => profiles.register({ displayName: "Ambiguous", directory })).toThrow(/could not be resolved/);
  } finally {
    __setCodexProfileRealpathForTest(null);
    rmSync(trash);
    mkdirSync(trash);
  }
  __setCodexProfileRealpathForTest(realpathDenying(trash, "EIO"));
  try {
    let thrown: unknown;
    try { profiles.register({ displayName: "EIO", directory }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AccountCoreError);
    expect((thrown as Error).message).not.toBe("Account operation failed.");
    expect((thrown as NodeJS.ErrnoException).code).toBeUndefined();
  } finally { __setCodexProfileRealpathForTest(null); }
});

test("default Codex home still registers when a task path is under its worktrees", () => {
  const directory = path.join(ownerHome, ".codex");
  const worktree = path.join(directory, "worktrees", "sample");
  mkdirSync(worktree, { recursive: true });
  projects.upsert(worktree, "Disposable worktree");
  const registered = new CodexProfiles(new AccountCore(db)).list().find((profile) => profile.directory === directory)!;
  const refreshed = profiles.register({ displayName: registered.displayName, directory }, registered.accountId);
  expect(refreshed.accountId).toBe(registered.accountId);
  expect(refreshed.directory).toBe(directory);
});

test("profile registration HTTP returns validation status instead of an unexpected failure", async () => {
  const { accountHttp } = await import("./account-http.ts");
  const { LegacyUsageBridge } = await import("./account-usage-bridge.ts");
  const trash = path.join(ownerHome, ".Trash");
  const directory = path.join(ownerHome, "profile-http");
  writeSyntheticCodexProfile(directory, "http");
  const call = (value: unknown) => accountHttp(
    new Request("http://127.0.0.1/account-core/codex-profiles", { method: "POST", body: JSON.stringify(value) }),
    core, new LegacyUsageBridge(db), true);
  __setCodexProfileRealpathForTest(realpathDenying(trash, "EPERM"));
  try {
    const created = await call({ displayName: "HTTP", directory });
    expect(created.status).toBe(201);
    const body = await created.json() as { accountId: string; harnessId: string; directory: string; error?: string };
    expect(body.directory).toBe(directory);
    expect(body.harnessId).toBe(`codex-profile-${body.accountId}`);
    const forbidden = await call({ displayName: "Trash", directory: trash });
    expect(forbidden.status).toBe(409);
    expect((await forbidden.json()).error).not.toBe("Account operation failed.");
    const duplicate = await call({ displayName: "HTTP again", directory });
    expect(duplicate.status).toBe(409);
  } finally { __setCodexProfileRealpathForTest(null); }
});

test("legacy single-profile resource digest stays byte-compatible with existing approved grants", async () => {
  const { createHash } = await import("node:crypto");
  const { resolveBin, agentDriverIsFake } = await import("./agents.ts");
  const h = harnesses.get("codex")!;
  const legacyIdentity = [h.id,h.kind,h.enabled,resolveBin(h),h.home,h.env,agentDriverIsFake(h.kind),null];
  expect(resourceKey(h)).toBe(createHash("sha256").update(JSON.stringify(legacyIdentity)).digest("hex"));
});
