/**
 * Direction 29 Packaged Native QA (`PN`) scenario for ForgeOrbitQA-dev.app.
 * Strictly isolated sandbox (`FO_QA_HOME`/`FO_QA_DATA` in /private/tmp/fo-native-d29-*)
 * with fake drivers only. Never touches Owner app, working profile, real
 * accounts, or provider homes.
 *
 * Usage:
 *   bun --no-env-file scripts/qa-native-d2.ts /private/tmp/fo-native-d29-base run d29 baseline
 *   bun --no-env-file scripts/qa-native-d2.ts /private/tmp/fo-native-d29-post run d29 post
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

type Ctx = any;

interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPercent: number;
  comm: string;
}

function listAllProcesses(): ProcRow[] {
  const out: ProcRow[] = [];
  const res = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm="], { encoding: "utf8" });
  for (const line of (res.stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpuPercent: Number(m[4]),
      comm: m[5]!.trim(),
    });
  }
  return out;
}

function collectSandboxProcs(root: string, bindingFile: string, credsFile: string) {
  let binding: { pid?: number; launcherPid?: number; windowId?: number } = {};
  let creds: { pid?: number; port?: number } = {};
  try { binding = JSON.parse(readFileSync(bindingFile, "utf8")); } catch {}
  try { creds = JSON.parse(readFileSync(credsFile, "utf8")); } catch {}

  const all = listAllProcesses();
  const seeds = new Set<number>();
  if (typeof binding.launcherPid === "number") seeds.add(binding.launcherPid);
  if (typeof binding.pid === "number") seeds.add(binding.pid);
  if (typeof creds.pid === "number") seeds.add(creds.pid);

  let added = true;
  while (added) {
    added = false;
    for (const p of all) {
      if (seeds.has(p.ppid) && !seeds.has(p.pid)) {
        seeds.add(p.pid);
        added = true;
      }
    }
  }
  const tree = all.filter(
    (p) =>
      seeds.has(p.pid) ||
      (p.comm.includes("ForgeOrbitQA-dev") && p.comm.includes(root)),
  );
  // Also snapshot WebKit helper processes alive right now that belong cleanly to our app/session
  const webkit = all.filter((p) => p.comm.includes("com.apple.WebKit.") && p.ppid === 1);
  return {
    launcherPid: binding.launcherPid ?? null,
    appPid: binding.pid ?? null,
    corePid: creds.pid ?? null,
    windowId: binding.windowId ?? null,
    processTree: tree,
    totalTreeRssMb: Number((tree.reduce((s, r) => s + r.rssKb, 0) / 1024).toFixed(1)),
    webkitSystemHelpersCount: webkit.length,
    webkitSystemHelpersSample: webkit.slice(0, 6).map((w) => ({
      pid: w.pid,
      rssMb: Number((w.rssKb / 1024).toFixed(1)),
      cpuPercent: w.cpuPercent,
      comm: w.comm.split("/").pop() ?? w.comm,
    })),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function statBytes(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readDaemonStalls(daemonLogPath: string): string[] {
  try {
    return readFileSync(daemonLogPath, "utf8")
      .split("\n")
      .filter((l) => l.includes("core was unresponsive"));
  } catch {
    return [];
  }
}

export async function run(c: Ctx) {
  const { api, button, show, find, hasText, seek, activate, ax, mark, evidence, save, runtime, root, up, down, sleep, ownerPaths, stamp, state } = c;
  const phase = process.argv[5] === "post" ? "post" : "baseline";
  const repo = join(import.meta.dir, "..");
  const outDir = join(repo, "docs/qa/evidence/fo-direction29");
  const shotsDir = join(outDir, `${phase}-shots`);
  mkdirSync(shotsDir, { recursive: true });

  const dataDir = join(runtime, "data");
  const bindingFile = join(root, "binding.json");
  const credsFile = join(dataDir, "agetor-core.json");
  const daemonLog = join(root, "native.log");
  const helperBin = join(root, "qa-native-pid");
  const outPath = join(outDir, `${phase}-native.json`);
  const buildReceipt = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(root, "forgeorbit-provenance.json"), "utf8"));

  const seen = (part: string) => find(hasText(part)).length > 0;
  const summarizeAx = (node: any, out: Array<{ role: string; text: string }> = []): Array<{ role: string; text: string }> => {
    if (!node || typeof node !== "object" || out.length >= 250) return out;
    const parts = [node.AXTitle, node.AXDescription, node.AXValue].filter((v) => typeof v === "string" && v.trim()).map((v) => String(v).trim());
    if (parts.length && node.AXRole) out.push({ role: String(node.AXRole), text: parts.join(" | ").slice(0, 180) });
    for (const child of node.children ?? []) summarizeAx(child, out);
    return out;
  };
  const shots: Record<string, { captured: boolean; blocker?: string }> = {};
  const results: Record<string, unknown> = {
    phase,
    kind: "packaged-native-PN-observations",
    recordedAt: new Date().toISOString(),
    qaBuild: {
      bundleIdentifier: buildReceipt.bundleIdentifier,
      artifactManifestSHA256: buildReceipt.artifactManifestSHA256,
      sourceRevision: provenance.metadata?.sourceRevision,
      channel: provenance.metadata?.channel,
      signing: buildReceipt.signing,
    },
    machine: {
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      ramGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    },
    ownerBefore: Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)])),
  };
  const flushResults = () => {
    results.shots = shots;
    results.totalDaemonStalls = readDaemonStalls(daemonLog).length;
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  };
  const shot = (name: string) => {
    try {
      const { windowId } = JSON.parse(readFileSync(bindingFile, "utf8"));
      const pngPath = join(shotsDir, `${name}.png`);
      const sc = spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, pngPath], { encoding: "utf8" });
      if (sc.status === 0 && existsSync(pngPath)) shots[name] = { captured: true };
      else shots[name] = { captured: false, blocker: (sc.stderr || sc.stdout || "screencapture declined").trim() };
    } catch (e) {
      shots[name] = { captured: false, blocker: (e as Error).message };
    }
    try {
      const web = JSON.parse(spawnSync(helperBin, [bindingFile, "inspect"], { encoding: "utf8" }).stdout).web;
      writeFileSync(join(shotsDir, `${name}.ax.json`), JSON.stringify(summarizeAx(web), null, 2) + "\n");
    } catch { /* best-effort AX snapshot */ }
    flushResults();
  };

  // ── 1. Seed a realistic larger working profile via API ONLY ─────────────────
  console.log(`[d29-native:${phase}] booting sandbox to seed 30 projects / 180+ tasks + 3,500-event history...`);
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("PUT", "/preferences/archivedHistoryRetentionDays", { value: "30" });

  const projectNames: string[] = [];
  const projectDirs: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const name = i === 1 ? "Alpha D29" : i === 2 ? "Beta D29" : i === 3 ? "Gamma D29" : i === 4 ? "Delta D29" : `Proj ${String(i).padStart(2, "0")}`;
    const dir = join(runtime, "projects", name.replace(/\s+/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    await api("POST", "/projects", { path: dir, name });
    projectNames.push(name);
    projectDirs.push(dir);
  }
  const space = await api("POST", "/clusters", { name: "D29 Core Space" });
  await api("POST", `/clusters/${space.id}/projects`, { projectPath: projectDirs[0]! });
  await api("POST", `/clusters/${space.id}/projects`, { projectPath: projectDirs[1]! });

  let largeTaskId = "";
  const monitorTasks: Array<{ id: string; projectDir: string; projectName: string }> = [];

  // 6 tasks per project = 180 tasks across backlog/ready/review/done/archived
  for (let p = 0; p < projectDirs.length; p++) {
    const dir = projectDirs[p]!;
    await api("POST", "/tasks", { title: `P${p + 1} backlog item`, prompt: "Queued idea", workdir: dir, isolation: "none", column: "backlog" });
    await api("POST", "/tasks", { title: `P${p + 1} ready task`, prompt: "Pending execution", workdir: dir, isolation: "none", column: "ready" });
    await api("POST", "/tasks", { title: `P${p + 1} needs review A`, prompt: "Inspect output A", workdir: dir, isolation: "none", column: "review" });
    await api("POST", "/tasks", { title: `P${p + 1} needs review B`, prompt: "Inspect output B", workdir: dir, isolation: "none", column: "review" });
    await api("POST", "/tasks", { title: `P${p + 1} completed task`, prompt: "Already shipped", workdir: dir, isolation: "none", column: "done" });
    const arch = await api("POST", "/tasks", { title: `P${p + 1} old archived`, prompt: "Historical work", workdir: dir, isolation: "none", column: "done" });
    await api("POST", `/tasks/${arch.id}/archive`, {});
  }

  // Real 3,500-event large-history task via fake driver prompt marker in Alpha D29
  const tLarge = await api("POST", "/tasks", {
    title: "Large 3500-event task",
    prompt: "LARGE_PN_PROMPT_ANCHOR\n\n__agetor_fake_claude_long_reply__:3500",
    agent: "claude-code",
    workdir: projectDirs[0]!,
    isolation: "none",
    column: "ready",
  });
  largeTaskId = tLarge.id;
  await api("POST", `/tasks/${largeTaskId}/start`, {});
  for (let w = 0; w < 120; w++) {
    const cur = await api("GET", `/tasks/${largeTaskId}`);
    if (cur.column === "review" && !cur.runId) break;
    await sleep(250);
  }

  // 4 ready held tasks for later load test (Projects 2, 3, 4, 5)
  for (let m = 1; m <= 4; m++) {
    const tm = await api("POST", "/tasks", {
      title: `Load monitor ${m}`,
      prompt: "__agetor_fake_claude_handoff__ __agetor_fake_claude_subagent__:5000[LoadGuard]",
      agent: "claude-code",
      workdir: projectDirs[m]!,
      isolation: "none",
      column: "ready",
    });
    monitorTasks.push({ id: tm.id, projectDir: projectDirs[m]!, projectName: projectNames[m]! });
  }

  await down();

  const dbSizeSeeded = {
    sqliteBytes: statBytes(join(dataDir, "agetor.sqlite")),
    walBytes: statBytes(join(dataDir, "agetor.sqlite-wal")),
    shmBytes: statBytes(join(dataDir, "agetor.sqlite-shm")),
  };
  results.dataset = {
    projects: projectDirs.length,
    seededTasksApprox: 185,
    largeTaskEventsTarget: 3500,
    dbSizeSeeded,
  };

  // ── 2. Cold & Warm Packaged Launch + Cmd+Q Clean Quit ──────────────────────
  const launchMetrics: Array<Record<string, unknown>> = [];
  for (let pass = 0; pass < 3; pass++) {
    const stallsBefore = readDaemonStalls(daemonLog).length;
    const t0 = performance.now();
    await up();
    const toReadyMs = performance.now() - t0;
    ax("resize", "1280", "860");
    await show("Home", 30_000);
    await show("Emergency stop", 15_000);
    const toHomeUsableMs = performance.now() - t0;
    const idleBusyBannerVisible = seen("ForgeOrbit is busy");
    const snap = collectSandboxProcs(root, bindingFile, credsFile);
    const stallsDuringOpen = readDaemonStalls(daemonLog).length - stallsBefore;

    if (pass === 0) {
      shot("pn-home-cold");
      mark(`Cold open on 30-project / 185-task profile took ${(toHomeUsableMs / 1000).toFixed(2)}s`);
    }

    // Measure Cmd+Q shutdown on pass 0 & pass 1; keep pass 2 open for interactive walkthrough
    let cmdQMetrics: Record<string, unknown> | null = null;
    if (pass < 2) {
      const pidsToTrack = [snap.launcherPid, snap.appPid, snap.corePid].filter((v): v is number => typeof v === "number");
      const logSizeBeforeQuit = statBytes(daemonLog);
      const tQuit = performance.now();
      ax("key", "12", "1048576"); // Cmd+Q
      const qDeadline = Date.now() + 10_000;
      while (Date.now() < qDeadline && pidsToTrack.some((p) => isAlive(p))) {
        await sleep(50);
      }
      const quitExitMs = performance.now() - tQuit;
      await sleep(1200);
      const strayAfterQuit = pidsToTrack.filter((p) => isAlive(p));
      const logGrowthAfterQuit = statBytes(daemonLog) - logSizeBeforeQuit;
      cmdQMetrics = {
        quitExitMs: Number(quitExitMs.toFixed(1)),
        trackedPids: pidsToTrack,
        strayAfterQuit,
        logBytesAfterQuit: logGrowthAfterQuit,
      };
      await down();
    }

    launchMetrics.push({
      pass: pass === 0 ? "cold" : `warm-${pass}`,
      toUpReadyMs: Number(toReadyMs.toFixed(1)),
      toHomeUsableMs: Number(toHomeUsableMs.toFixed(1)),
      idleBusyBannerVisible,
      stallsDuringOpen,
      processes: snap,
      cmdQ: cmdQMetrics,
    });
  }
  results.launches = launchMetrics;

  // ── 3. Interactive UI Walkthrough on Large Profile (pass 2 stays open) ─────
  const uiTimings: Record<string, unknown> = {};
  try {
    ax("resize", "1280", "860");
    await sleep(300);
    const tb = performance.now();
    await button("All tasks");
    await show("Large 3500-event task", 20_000);
    uiTimings.allTasksBoardOpenMs = Number((performance.now() - tb).toFixed(1));
    shot("pn-board");

    // Project switching across Alpha D29, Beta D29, Gamma D29, Alpha D29 via sidebar
    const switchTimesMs: Record<string, number> = {};
    for (const name of ["Alpha D29", "Beta D29", "Gamma D29", "Alpha D29"]) {
      const ts = performance.now();
      await button(name, true);
      await show(name, 20_000);
      switchTimesMs[`to_${name}`] = Number((performance.now() - ts).toFixed(1));
    }
    uiTimings.projectSwitchesMs = switchTimesMs;
    flushResults();
    shot("pn-project-alpha");

    // Large 3500-event task opening + "Load earlier messages"
    const tl = performance.now();
    await button("Large 3500-event task", true);
    await show("Load earlier messages", 15_000);
    await show("long reply chunk 3500/3500", 15_000);
    uiTimings.largeTaskInitialWindowMs = Number((performance.now() - tl).toFixed(1));
    shot("pn-large-task-initial");

    const te = performance.now();
    // CSS uppercase on RunPanel "Load earlier messages" causes WebKit AX to expose uppercase AXTitle/AXDescription.
    const isLoadEarlierButton = (n: any) =>
      n.AXRole === "AXButton"
      && [n.AXTitle, n.AXDescription, n.AXValue].some((v) => typeof v === "string" && /load earlier messages/i.test(v))
      && n.AXEnabled !== false;
    const loadBtn = await seek("Missing enabled control \"Load earlier messages\"", isLoadEarlierButton);
    activate(loadBtn);
    await sleep(600);
    await show("long reply chunk 2500/3500", 15_000).catch(async () => {
      await show("long reply chunk 2400/3500", 5_000);
    });
    uiTimings.largeTaskLoadEarlierMs = Number((performance.now() - te).toFixed(1));
    shot("pn-large-task-earlier");

    // Close task details & open Analytics on Alpha D29
    ax("key", "53", "0");
    await sleep(300);
    const ta = performance.now();
    await button("Analytics");
    await show("Estimated for the remaining work", 15_000);
    uiTimings.analyticsOpenMs = Number((performance.now() - ta).toFixed(1));
    shot("pn-analytics");

    // Settings -> Advanced -> Data (disk use + retention + Compact database)
    const td = performance.now();
    await button("Settings");
    await show("Advanced", 10_000);
    await button("Advanced");
    await show("Archived task history", 10_000);
    await show("Compact database", 10_000);
    uiTimings.settingsDataOpenMs = Number((performance.now() - td).toFixed(1));
    shot("pn-settings-data");
    ax("key", "53", "0");
    await sleep(300);
  } catch (err) {
    uiTimings.walkthroughError = (err as Error).message;
  }
  results.uiWalkthrough = uiTimings;

  // ── 4. Sustained Load / Contention in Packaged App (PN) ───────────────────
  const loadMetrics: Record<string, unknown> = {};
  const stallsBeforeLoad = readDaemonStalls(daemonLog).length;
  try {
    // Launch 4 concurrent 4.5s monitor tasks across Projects 2, 3, 4, 5
    for (const mt of monitorTasks) {
      await api("POST", `/tasks/${mt.id}/start`, {});
    }
    await sleep(400);
    const runningSnap = (await api("GET", "/tasks")).filter((t: { column: string }) => t.column === "running");
    loadMetrics.concurrentRunningObserved = runningSnap.length;

    // Try Compact database while running -> verify UI refusal!
    await button("Settings");
    await button("Advanced");
    await show("Compact database", 10_000);
    await button("Compact database");
    await show("Compact the database?", 10_000);
    await button("Compact");
    await sleep(600);
    loadMetrics.compactRefusedWhileRunningVisible = seen("running") || seen("stop or wait") || seen("Refused");
    shot("pn-compact-refused");
    ax("key", "53", "0");
    await sleep(250);
    if (seen("Compact the database?") || seen("Archived task history")) {
      ax("key", "53", "0");
      await sleep(250);
    }

    // Stop Beta D29 while Gamma D29 / Delta D29 keep running, and navigate views live!
    const tStop = performance.now();
    await button("Beta D29", true);
    await show("Stop new work", 15_000);
    await button("Stop new work");
    await sleep(400);
    loadMetrics.betaLifecycleAfterStop = (await api("POST", "/projects/lifecycle", { path: projectDirs[1]! }).catch(async () => {
      const list = await api("GET", "/projects");
      return list.find((p: { path: string }) => p.path === projectDirs[1]!)?.lifecycle ?? null;
    }));
    loadMetrics.stopClickMs = Number((performance.now() - tStop).toFixed(1));

    const tSwitchActive = performance.now();
    await button("Gamma D29", true);
    await show("Gamma D29", 15_000);
    await button("Home", false);
    await show("Home", 15_000);
    loadMetrics.navWhileRunningMs = Number((performance.now() - tSwitchActive).toFixed(1));
    loadMetrics.processSampleDuringLoad = collectSandboxProcs(root, bindingFile, credsFile);
    shot("pn-active-load");

    // Wait for monitor runs to settle and check zero duplicate / lost runs
    for (let w = 0; w < 60; w++) {
      const tasksNow = await api("GET", "/tasks");
      const active = tasksNow.filter((t: { column: string }) => t.column === "running");
      if (active.length === 0) break;
      await sleep(250);
    }
    const perMonitorRuns: Record<string, number> = {};
    for (const mt of monitorTasks) {
      const r = await api("GET", `/tasks/${mt.id}/runs`);
      perMonitorRuns[mt.id] = r.length;
    }
    loadMetrics.perMonitorRunsCount = perMonitorRuns;
    loadMetrics.zeroDuplicates = Object.values(perMonitorRuns).every((n) => n === 1);

    // Compact database cleanly now that idle
    await button("Settings");
    await button("Advanced");
    await button("Compact database");
    await show("Compact the database?", 10_000);
    await button("Compact");
    await show("Compacted:", 15_000);
    loadMetrics.compactIdleSucceeded = seen("Compacted:");
    shot("pn-compact-idle");
    ax("key", "53", "0");
    await sleep(200);
  } catch (err) {
    loadMetrics.loadError = (err as Error).message;
  }
  loadMetrics.stallsDuringLoad = readDaemonStalls(daemonLog).slice(stallsBeforeLoad);
  results.sustainedLoad = loadMetrics;

  // Cmd+Q exit check after load
  const finalSnap = collectSandboxProcs(root, bindingFile, credsFile);
  const pidsToCheck = [finalSnap.launcherPid, finalSnap.appPid, finalSnap.corePid].filter((v): v is number => typeof v === "number");
  const logBeforeEnd = statBytes(daemonLog);
  ax("key", "12", "1048576");
  const endDeadline = Date.now() + 10_000;
  while (Date.now() < endDeadline && pidsToCheck.some((p) => isAlive(p))) {
    await sleep(50);
  }
  await sleep(1200);
  results.postLoadCmdQ = {
    strayPids: pidsToCheck.filter((p) => isAlive(p)),
    logBytesAfterQuit: statBytes(daemonLog) - logBeforeEnd,
  };
  await down();

  // ── 5. Crash Interruption (SIGKILL core) & Recovery in Packaged App ────────
  await up();
  await show("Home", 30_000);
  const tCrash = await api("POST", "/tasks", {
    title: "Packaged crash victim",
    prompt: "__agetor_fake_claude_handoff__ __agetor_fake_claude_subagent__:20000[CrashGuard]",
    agent: "claude-code",
    workdir: projectDirs[0]!,
    isolation: "none",
    column: "ready",
  });
  await api("POST", `/tasks/${tCrash.id}/start`, {});
  await sleep(400);
  const preKillTask = await api("GET", `/tasks/${tCrash.id}`);
  assert.equal(preKillTask.column, "running", "crash victim must be running before SIGKILL");

  const crashSnap = collectSandboxProcs(root, bindingFile, credsFile);
  const targetKillPid = crashSnap.corePid ?? crashSnap.appPid;
  assert.ok(targetKillPid, "expected core/app PID to SIGKILL");
  try { process.kill(targetKillPid, "SIGKILL"); } catch {}
  await sleep(600);
  await down();

  // Reopen cleanly
  await up();
  await show("Home", 30_000);
  const postCrashTask = await api("GET", `/tasks/${tCrash.id}`);
  const postCrashRuns = await api("GET", `/tasks/${tCrash.id}/runs`);
  shot("pn-after-crash-reopen");
  await down();

  let integrityCheck = "";
  {
    using checkDb = new Database(join(dataDir, "agetor.sqlite"), { readonly: true });
    integrityCheck = (checkDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check) ?? "missing";
  }

  results.crashRecovery = {
    killedPid: targetKillPid,
    taskBeforeKill: { column: preKillTask.column, runId: preKillTask.runId },
    taskAfterReopen: { column: postCrashTask.column, runId: postCrashTask.runId },
    runsAfterReopen: postCrashRuns.map((r: { id: string; status: string }) => ({ id: r.id, status: r.status })),
    noAutoReplay: postCrashRuns.length === 1 && postCrashRuns[0]?.status === "orphaned",
    integrityCheck,
  };

  results.ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  results.ownerUntouched = ownerPaths.every((p: string) => (results.ownerBefore as any)[p] === (results.ownerAfter as any)[p]);
  results.shots = shots;
  results.totalDaemonStalls = readDaemonStalls(daemonLog).length;
  results.daemonStallsSample = readDaemonStalls(daemonLog).slice(0, 10);

  evidence.d29 = results;
  save();
  flushResults();
  console.log(`[d29-native:${phase}] wrote ${outPath}`);
}
