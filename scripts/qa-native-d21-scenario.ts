/**
 * Direction 21 packaged walkthrough: Access modes (Workspace, Isolated, Full Computer),
 * EN & RU pre-launch diagnostics, fail-closed refusals, and Full Computer disposable target
 * requiring its own per-action grant in ForgeOrbitQA-dev.app (fake drivers only).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

type Ctx = any;

export async function run(c: Ctx) {
  const {
    api, button, show, find, hasText, ax,
    mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp,
  } = c;

  const repo = join(import.meta.dir, "..");
  const shots = join(root, "shots");
  mkdirSync(shots, { recursive: true });
  const shotStatus: Record<string, { captured: boolean; blocker?: string }> = {};
  const summarizeAx = (node: any, out: Array<{ role: string; text: string }> = []): Array<{ role: string; text: string }> => {
    if (!node || typeof node !== "object" || out.length >= 250) return out;
    const parts = [node.AXTitle, node.AXDescription, node.AXValue].filter((v) => typeof v === "string" && v.trim()).map((v) => String(v).trim());
    if (parts.length && node.AXRole) out.push({ role: String(node.AXRole), text: parts.join(" | ").slice(0, 160) });
    for (const child of node.children ?? []) summarizeAx(child, out);
    return out;
  };
  const helperBin = join(root, "qa-native-pid");
  const bindingFile = join(root, "binding.json");
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(bindingFile, "utf8"));
    const pngPath = join(shots, `${name}.png`);
    const sc = spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, pngPath], { encoding: "utf8" });
    if (sc.status === 0 && existsSync(pngPath)) {
      shotStatus[name] = { captured: true };
    } else {
      shotStatus[name] = {
        captured: false,
        blocker: (sc.stderr || sc.stdout || "screencapture declined (Screen Recording not granted)").trim(),
      };
    }
    try {
      const web = JSON.parse(spawnSync(helperBin, [bindingFile, "inspect"], { encoding: "utf8" }).stdout).web;
      writeFileSync(join(shots, `${name}.ax.json`), JSON.stringify(summarizeAx(web), null, 2) + "\n");
    } catch {}
    evidence.shots = shotStatus;
  };

  const build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.build = build;
  const sh = (argv: string[], cwd = repo) => {
    const out = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", cwd });
    if (out.status !== 0) throw new Error(`Command failed (${argv.join(" ")}): ${out.stderr || out.stdout}`);
    return out;
  };
  const psAll = () => spawnSync("/bin/ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n");

  // Compile & spawn disposable Cocoa TargetA.app (never touches real user apps)
  const fixturesDir = join(root, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  const appDir = join(fixturesDir, "TargetA.app");
  const exePath = join(appDir, "Contents/MacOS/target-a");
  mkdirSync(join(appDir, "Contents/MacOS"), { recursive: true });
  sh(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exePath, join(repo, "native/computer-use/target-a.swift")]);
  copyFileSync(join(repo, "native/computer-use/Info-target-a.plist"), join(appDir, "Contents/Info.plist"));
  sh(["codesign", "--force", "--sign", "-", appDir]);
  const targetAStatusFile = join(fixturesDir, "target-a-status.txt");
  const targetProc = spawn(exePath, [targetAStatusFile], { stdio: "ignore" });

  // Prepare disposable Git project inside runtime/projects/D21Alpha
  const alpha = join(runtime, "projects/D21Alpha");
  mkdirSync(join(alpha, "src"), { recursive: true });
  writeFileSync(join(alpha, "README.md"), "# D21 Alpha\n");
  writeFileSync(join(alpha, "src/calc.ts"), "export const v = 1;\n");
  writeFileSync(join(alpha, ".env"), "SECRET=d21-omit\n");
  sh(["git", "init", "-b", "main"], alpha);
  sh(["git", "add", "README.md", "src/calc.ts"], alpha);
  sh(["git", "-c", "user.email=qa@example.com", "-c", "user.name=QA", "commit", "-m", "seed"], alpha);

  try {
    await poll("TargetA status file", () => (existsSync(targetAStatusFile) ? true : null), 15_000);
    await up();
    await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
    await api("PUT", "/preferences/locale", { value: "en" });
    await api("POST", "/projects", { path: alpha, name: "D21 Alpha" });
    await api("PATCH", "/harnesses/codex", { enabled: true });
    await api("PATCH", "/harnesses/claude-code", { enabled: true });
    const preflight = await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
    const cfg = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
    await api("PUT", "/portfolio-manager/config", { config: cfg });
    await api("PUT", "/project-manager/config", { path: alpha, config: cfg });

    await down();
    await up();
    await show("Main navigation", 30_000);

    // Helpers for NewTaskForm & AX inspection
    const { clickByPosition } = c;
    const rawInspect = () => JSON.parse(spawnSync(helperBin, [bindingFile, "inspect"], { encoding: "utf8" }).stdout);
    const findWeb = (pred: (n: any) => boolean) => {
      const w = rawInspect().web;
      const acc: any[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (pred(n)) acc.push(n);
        for (const ch of n.children ?? []) walk(ch);
      };
      walk(w);
      return acc;
    };
    const choosePopupOption = async (popupTitle: string, optionNeedle: string) => {
      await poll(`popup ${popupTitle}`, () => findWeb((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === popupTitle && n.AXEnabled !== false)[0] ?? null, 10_000);
      ax("focus-name", "AXPopUpButton", popupTitle);
      await sleep(200);
      ax("key", "49", "0");
      await sleep(300);
      ax("text", optionNeedle.slice(0, 26));
      await sleep(200);
      ax("key", "36", "0");
      await sleep(350);
      let ok = findWeb((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === popupTitle && typeof n.AXValue === "string" && n.AXValue.includes(optionNeedle));
      for (let step = 0; step < 12 && ok.length === 0; step++) {
        ax("focus-name", "AXPopUpButton", popupTitle);
        await sleep(120);
        ax("key", "49", "0");
        await sleep(200);
        ax("key", "125", "0");
        await sleep(150);
        ax("key", "36", "0");
        await sleep(300);
        ok = findWeb((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === popupTitle && typeof n.AXValue === "string" && n.AXValue.includes(optionNeedle));
      }
      assert(ok.length > 0, `popup "${popupTitle}" never selected "${optionNeedle}"`);
    };

    // EN walkthrough: open D21 Alpha -> Tasks -> New task
    await button("D21 Alpha", true, 0);
    await sleep(400);
    await button("Tasks", true, 0);
    await sleep(400);
    await button("New task", false, 0);

    await show("Access mode", 15_000);
    await show("Selecting a mode itself grants nothing.", 15_000);
    shot("01-en-new-task-workspace");

    // Fill Title & Prompt while they are in the initial viewport of NewTaskForm
    await poll("title field", () => {
      const list = findWeb((n) => n.AXRole === "AXTextField" && n.AXEnabled !== false);
      return list.length ? list : null;
    }, 10_000);
    await clickByPosition((n: any) => n.AXRole === "AXTextField" && n.AXEnabled !== false, 0);
    await sleep(150);
    ax("text", "D21 Isolated");
    ax("focus-name", "AXTextArea", "Prompt");
    await sleep(150);
    ax("text", "Update calc.ts");
    await sleep(200);

    // Switch harness to Claude Code in Workspace -> verify honest "None" OS sandbox disclosure
    await button("Claude Code", true, 0);
    await show("None — child process runs with your user's normal OS filesystem and network access.", 10_000);
    shot("02-en-workspace-claude-honest");

    // Switch Access Mode to Isolated with Claude Code -> must show refusal
    await button("Isolated", true, 0);
    await show("Cannot run with this combination", 10_000);
    await show("This harness has no ForgeOrbit OS-enforced workspace and no-network sandbox for Isolated mode.", 10_000);
    shot("03-en-isolated-claude-refused");

    // Switch harness to Codex while in Isolated -> requires prepared Task Workspace first
    await button("Codex", true, 0);
    await show("Isolated mode requires a prepared Task Workspace with explicitly supplied inputs and no automatic write-back.", 10_000);
    shot("04-en-isolated-codex-needs-staging");

    // Create Isolated Codex task into Backlog via NewTaskForm and inspect RunPanel + API refusals
    await sleep(200);
    await button("To backlog", true, 0);
    await show("D21 Isolated", 15_000);

    const listed = await api("GET", "/tasks");
    const isoTask = listed.find((t: any) => t.title === "D21 Isolated");
    assert(isoTask, "Isolated task created from NewTaskForm");
    assert.equal(isoTask.accessMode, "isolated");
    if (isoTask.column === "backlog") await api("POST", `/tasks/${isoTask.id}/admit-inbox`);
    await api("PATCH", `/tasks/${isoTask.id}`, { column: "ready" });
    const startBeforeStaging = await api("POST", `/tasks/${isoTask.id}/start`, undefined, [400]);
    assert.match(String(startBeforeStaging.error ?? ""), /Task Workspace|prepared/i);

    // Open Ready task in RunPanel, prepare staging, verify diagnostics update to allowed + fake-driver caveat
    await button("D21 Isolated", false, 0);
    await show("Launch review & boundaries", 10_000);
    await show("Cannot run with this combination", 10_000);
    shot("05-en-runpanel-isolated-refused");

    await api("POST", "/task-workspace/prepare", { taskId: isoTask.id, outputPaths: ["src/calc.ts"] });
    const diagStaged = await api("GET", `/tasks/${isoTask.id}/launch-diagnostics`);
    assert.equal(diagStaged.launchAllowed, true);
    assert.equal(diagStaged.osEnforcement.mechanism, "macos-seatbelt-restricted");
    assert.equal(diagStaged.driverIsFake, true);
    assert(diagStaged.unverifiedCodes.includes("gap-fake-driver-no-os-proof"));
    evidence.enStagedDiagnostics = diagStaged;

    // Close RunPanel, re-open NewTaskForm to inspect Full Computer disclosure & refusal
    await button("Close task details", true, 0);
    await sleep(400);
    await button("New task", false, 0);
    await show("Access mode", 10_000);
    await button("Full Computer", true, 0);
    await show("Full Computer allows separate per-action Owner grants for a selected origin, application, or window.", 10_000);
    shot("06-en-full-computer-refused");
    await button("Close", true, 0);
    await sleep(300);

    const fcTask = await api("POST", "/tasks", {
      title: "D21 Full Computer",
      prompt: "open app",
      workdir: alpha,
      agent: "codex",
      mode: "auto",
      accessMode: "full-computer",
      isolation: "none",
      column: "ready",
    });
    if (fcTask.column === "backlog") await api("POST", `/tasks/${fcTask.id}/admit-inbox`);
    if (fcTask.column !== "ready") await api("PATCH", `/tasks/${fcTask.id}`, { column: "ready" });
    const fcStart = await api("POST", `/tasks/${fcTask.id}/start`, undefined, [400]);
    assert.match(String(fcStart.error ?? ""), /Full Computer/i);
    evidence.fullComputerProcessRefusal = fcStart.error;
    mark("EN NewTaskForm, RunPanel, and API diagnostics/refusals verified");

    // Native Computer Use + Head of PM with disposable TargetA.app (never grants without per-action approval)
    await button("Settings", true, 0);
    await sleep(600);
    await button("Tools and access", true, 0);
    await sleep(500);
    await button("Open: Native Computer", true, 0);
    await show("Owner-controlled native session", 15_000);
    await show("Full Computer (Native): selecting an application or window grants nothing to tasks or processes.", 10_000);

    await choosePopupOption("Application", "ForgeOrbitNativeCuTargetA");
    await sleep(300);
    await choosePopupOption("Window", "ForgeOrbit Native Generic Target A");
    await sleep(200);
    await button("Start native session", true, 0);
    await show("Session status: Active", 15_000);
    assert.equal(readFileSync(targetAStatusFile, "utf8"), "idle:0\n", "Starting session must grant zero actions");
    shot("07-en-native-target-a");

    await button("Open Head of PM", true, 0);
    await show("Message to Head of PM", 15_000);
    const expandTurn = findWeb((n) => n.AXRole === "AXDisclosureTriangle" && [n.AXTitle, n.AXDescription].includes("One-turn access"));
    if (expandTurn.length) {
      await button("One-turn access", true, 0);
      await sleep(400);
    }
    await show("No outside capability is granted yet.", 10_000);

    const lastPair = async (needle: string) => await poll(`head reply for ${needle}`, async () => {
      const st = await api("GET", "/portfolio-manager");
      const ms = st.messages as any[];
      const i = ms.findLastIndex((m) => m.role === "owner" && m.text.includes(needle));
      if (i < 0) return null;
      const r = ms.slice(i + 1).find((m) => m.role === "manager");
      return ms[i].status === "answered" && r ? { owner: ms[i], reply: r } : null;
    }, 20_000);

    const noGrantMarker = "__fake_portfolio_native_press__ [d21-nogrant]";
    ax("focus-name", "AXTextArea", "Message to Head of PM");
    await sleep(200);
    ax("text", noGrantMarker);
    await sleep(200);
    await button("Send", true, 0);
    const noGrantPair = await lastPair(noGrantMarker);
    assert.equal(noGrantPair!.reply.nativeAction?.status, "ignored");
    assert.equal(noGrantPair!.reply.nativeAction?.reasonCode, "not_authorized");
    assert.equal(readFileSync(targetAStatusFile, "utf8"), "idle:0\n");

    await button("Allow for this message", true, 0);
    await show("This message may use the selected session once.", 10_000);
    const grantMarker = "__fake_portfolio_native_press__ [d21-granted]";
    ax("focus-name", "AXTextArea", "Message to Head of PM");
    await sleep(200);
    ax("key", "0", "1048576");
    await sleep(100);
    ax("text", grantMarker);
    await sleep(200);
    await button("Send", true, 0);
    const grantPair = await lastPair(grantMarker);
    assert.equal(grantPair!.reply.nativeAction?.status, "accepted");
    await poll("TargetA pressed:1", () => (readFileSync(targetAStatusFile, "utf8") === "pressed:1\n" ? true : null), 5_000);
    evidence.fullComputerTarget = readFileSync(targetAStatusFile, "utf8").trim();
    mark("Full Computer disposable TargetA.app verified: 0 without grant, 1 with single-use grant");

    // RU localization walkthrough: restart window in Russian and verify diagnostics & refusals
    await api("PUT", "/preferences/locale", { value: "ru" });
    await down();
    await up();
    await show("Основная навигация", 30_000);
    await button("D21 Alpha", true, 0);
    await sleep(400);
    await button("Задачи", true, 0);
    await sleep(400);
    await button("Новая задача", false, 0);
    await show("Режим доступа", 15_000);
    await show("Сам выбор режима не выдаёт никаких разрешений.", 15_000);
    await button("Весь компьютер", true, 0);
    await show("Запуск с таким сочетанием невозможен", 10_000);
    shot("08-ru-new-task-full-computer");
    await button("Закрыть", true, 0);
    await sleep(300);

    await button("D21 Isolated", false, 0);
    await show("Обзор прав и границ запуска", 10_000);
    await show("macOS Seatbelt ограничивает чтение рабочей папкой", 10_000);
    await show("Активен синтетический fake-драйвер", 10_000);
    shot("09-ru-runpanel-isolated-staged");

    await button("Настройки", true, 0);
    await sleep(600);
    await button("Инструменты и доступ", true, 0);
    await sleep(500);
    await button("Открыть: Нативный компьютер", true, 0);
    await show("Весь компьютер (Нативное управление):", 15_000);
    shot("10-ru-native-cu-note");

    await down();

    const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
    const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
    const changed = Object.keys(ownerBefore).filter((k) => ownerBefore[k] !== ownerAfter[k]);
    const unrelatedCodex = psAll().filter((l) => /\/codex(\s|$)|codex-cli|\bcodex\b/i.test(l) && !l.includes(root) && !l.includes("qa-native"));
    assert(changed.every((p2) => p2.endsWith("/.codex")), `Unexpected owner path change: ${changed.join(", ")}`);
    if (changed.length) assert(unrelatedCodex.length > 0, "~/.codex changed without unrelated codex process");
    evidence.ownerPaths = { unchanged: Object.keys(ownerBefore).length - changed.length, changed };
    evidence.fakeDriversUsed = true;
    evidence.provesOsIsolation = false;
    evidence.result = "pass";
    save();
    mark("Direction 21 packaged QA scenario passed");
  } finally {
    await down().catch(() => {});
    try { targetProc.kill("SIGKILL"); } catch {}
  }
}
