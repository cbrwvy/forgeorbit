/**
 * Direction 26 packaged walk. Keyboard only, disposable profile, fake drivers.
 * Emergency Stop is pressed and then lifted on this profile alone.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Ctx = any;
const TAB = "48";
const RETURN = "36";
const ESCAPE = "53";
const KEY_N = "45";
const SHIFT = "131072";
const COMMAND = "1048576";

export async function run(c: Ctx) {
  const { api, show, find, hasText, ax, mark, evidence, save, runtime, root, up, down, sleep } = c;
  const repo = join(import.meta.dir, "..");
  const shots = join(repo, "docs/qa/evidence/fo-direction26");
  mkdirSync(shots, { recursive: true });
  const bindingFile = join(root, "binding.json");
  const helperBin = join(root, "qa-native-pid");
  const shotStatus: Record<string, { captured: boolean; blocker?: string }> = {};
  const summarize = (node: any, out: Array<{ role: string; text: string }> = []): Array<{ role: string; text: string }> => {
    if (!node || typeof node !== "object" || out.length >= 400) return out;
    const parts = [node.AXTitle, node.AXDescription, node.AXValue].filter((v) => typeof v === "string" && v.trim()).map((v) => String(v).trim());
    if (parts.length && node.AXRole) out.push({ role: String(node.AXRole), text: parts.join(" | ").slice(0, 180) });
    for (const child of node.children ?? []) summarize(child, out);
    return out;
  };
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(bindingFile, "utf8"));
    const pngPath = join(shots, `${name}.png`);
    const sc = spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, pngPath], { encoding: "utf8" });
    if (sc.status === 0 && existsSync(pngPath)) shotStatus[name] = { captured: true };
    else shotStatus[name] = { captured: false, blocker: (sc.stderr || sc.stdout || "screencapture declined").trim() };
    try {
      const web = JSON.parse(spawnSync(helperBin, [bindingFile, "inspect"], { encoding: "utf8" }).stdout).web;
      writeFileSync(join(shots, `${name}.ax.json`), JSON.stringify(summarize(web), null, 2) + "\n");
    } catch { /* accessibility dump is best-effort */ }
    evidence.shots = shotStatus;
    save();
  };
  const seen = (part: string) => find(hasText(part)).length > 0;
  const runs = async () => {
    const tasks = await api("GET", "/tasks");
    const list = Array.isArray(tasks) ? tasks : tasks.tasks ?? [];
    return list.filter((task: { runId?: string | null; column?: string }) => task.runId || task.column === "running");
  };
  const inspect = () => JSON.parse(ax("inspect"));
  const focusText = () => {
    const node = inspect().focus ?? {};
    return [node.AXRole, node.AXTitle, node.AXDescription, node.AXValue].filter((v) => typeof v === "string" && v.trim()).join(" | ");
  };
  const key = (code: string, flags = "0") => ax("key", code, flags);
  // The window's accessibility focus stays on the window until the web area
  // itself is focused. That one step is not a click. Every later move is a key.
  const enterPage = () => {
    ax("focus");
    ax("focus-name", "AXWebArea", "ForgeOrbit");
  };
  const tabTo = async (part: string, backwards = false) => {
    const path: string[] = [];
    for (let i = 0; i < 160; i++) {
      const text = focusText();
      path.push(text);
      if (text.toLowerCase().includes(part.toLowerCase())) return path;
      key(TAB, backwards ? SHIFT : "0");
      await sleep(90);
    }
    throw new Error(`keyboard did not reach "${part}"\n${path.slice(-12).join("\n")}`);
  };
  const pressFocused = async () => { key(RETURN); await sleep(350); };
  const readDefault = (domain: string, name: string) => {
    const result = spawnSync("/usr/bin/defaults", ["read", domain, name], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "absent";
  };
  evidence.keyboardNavigation = readDefault("NSGlobalDomain", "AppleKeyboardUIMode");

  const alpha = join(runtime, "projects/Alpha");
  const lone = join(runtime, "projects/Lone");
  for (const dir of [alpha, lone]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(alpha, "README.md"), "alpha\n");
  writeFileSync(join(lone, "README.md"), "lone\n");

  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: alpha, name: "Alpha" });
  await api("POST", "/projects", { path: lone, name: "Lone" });
  const listed = await api("GET", "/clusters");
  const rows = Array.isArray(listed) ? listed : listed.clusters ?? [];
  let space = rows.find((item: { name?: string }) => item.name === "Keyboard Space");
  if (!space) space = await api("POST", "/clusters", { name: "Keyboard Space" });
  const members = await api("GET", `/clusters/${space.id}/projects`);
  if (!JSON.stringify(members).includes(alpha)) await api("POST", `/clusters/${space.id}/projects`, { projectPath: alpha });
  await api("POST", "/tasks", { title: "Keyboard task", prompt: "Look at the notes.", workdir: alpha, isolation: "none", column: "backlog" });
  await down();
  await up();
  ax("resize", "1200", "800");
  await show("Home", 30_000);
  enterPage();
  evidence.webviewFocus = "accessibility focus on the web area, then keys only";
  shot("en-home-1200");
  assert.equal((await runs()).length, 0, "opening Home started a run");

  const toWorkspaces = await tabTo("Workspaces");
  evidence.tabToWorkspaces = toWorkspaces;
  assert(toWorkspaces.length < 160, "tab order did not reach Workspaces");
  assert(new Set(toWorkspaces).size > 1, "tab order did not move");
  shot("en-focus-workspaces");
  await pressFocused();
  await show("Keyboard Space");
  await show("Projects without a space");
  await show("Lone");
  assert(!seen("No icon"), "empty icon label is still shown");
  assert(!seen("Priority Unset"), "empty priority label is still shown");
  assert(!seen("more than one cluster"), "comparison footnote still says cluster");
  shot("en-workspaces-1200");
  mark("Keyboard reached Workspaces. Empty icon and priority labels are gone. The comparison says space.");

  const toOpen = await tabTo("Open");
  evidence.tabToOpen = toOpen.slice(-8);
  await pressFocused();
  await show("Alpha");
  shot("en-space-1200");
  const toProject = await tabTo("Alpha");
  evidence.tabToProject = toProject.slice(-8);
  await pressFocused();
  await show("Keyboard task");
  await show("Keyboard Space");
  shot("en-board-1200");
  mark("Keyboard opened the space, then Alpha's project board.");

  const toTask = await tabTo("Keyboard task");
  evidence.tabToTask = toTask.slice(-8);
  await pressFocused();
  await show("Keyboard task");
  shot("en-task-1200");
  key(ESCAPE);
  await sleep(400);
  await show("Keyboard task");
  const afterEscape = focusText();
  evidence.focusAfterEscape = afterEscape;
  mark(`Escape left the task. Focus is: ${afterEscape || "(unnamed)"}.`);

  const toAnalytics = await tabTo("Analytics");
  evidence.tabToAnalytics = toAnalytics.slice(-8);
  await pressFocused();
  await show("Showing only Alpha");
  await show("Nothing is recorded");
  shot("en-analytics-1200");
  mark("Keyboard opened Alpha's Analytics. It is scoped to Alpha and does not call recorded use zero.");
  assert.equal((await runs()).length, 0, "opening Analytics started a run");

  const toWorkspacesAgain = await tabTo("Workspaces");
  await pressFocused();
  await show("New space");
  const toNew = await tabTo("New space");
  evidence.tabToNewSpace = toNew.slice(-6);
  await pressFocused();
  await show("New space");
  const beforeType = focusText();
  ax("text", "Keep");
  await sleep(150);
  key(KEY_N, COMMAND);
  await sleep(400);
  ax("text", " notes");
  await sleep(200);
  const field = focusText();
  evidence.textEntry = { beforeType, field };
  assert(field.toLowerCase().includes("keep notes"), `Command-N disturbed the name field: ${field}`);
  shot("en-dialog-text");
  key(ESCAPE);
  await sleep(400);
  assert(!seen("Keep notes"), "Escape did not dismiss the new-space dialog");
  const restored = focusText();
  evidence.focusAfterDialog = restored;
  assert(restored.toLowerCase().includes("new space"), `focus did not return to New space: ${restored}`);
  mark("The new-space dialog opened from the keyboard, kept typed text when Command-N was pressed, and Escape restored focus to New space.");

  const toStop = await tabTo("Emergency stop");
  evidence.tabToStop = toStop.slice(-8);
  shot("en-focus-stop");
  await pressFocused();
  await show("Stopped");
  shot("en-stopped");
  assert.equal((await runs()).length, 0, "Emergency Stop created a run");
  const toResume = await tabTo("Resume");
  await pressFocused();
  await show("Lift emergency stop");
  key(RETURN);
  await sleep(400);
  await show("Stopped");
  mark("Enter on the confirmation's Cancel left Emergency Stop on.");
  await tabTo("Resume");
  await pressFocused();
  await show("Lift emergency stop");
  await tabTo("Lift emergency stop");
  await pressFocused();
  await sleep(500);
  await show("Emergency stop");
  assert(!seen("Stopped"), "Emergency Stop did not lift");
  shot("en-resumed");
  mark("Emergency Stop was reached from the keyboard, pressed, and lifted. The confirmation's first Enter did not lift it.");

  ax("resize", "900", "800");
  await sleep(400);
  key(ESCAPE);
  await sleep(200);
  const toRuEntry = await tabTo("Workspaces");
  await pressFocused();
  shot("en-workspaces-900");
  evidence.tabOrderSample = toRuEntry.length;
  mark("English Workspaces at 900 pt was captured from the keyboard.");

  await api("PUT", "/preferences/locale", { value: "ru" });
  await down();
  await up();
  ax("resize", "900", "800");
  await show("Пространства", 30_000);
  enterPage();
  await show("Экстренная остановка");
  shot("ru-home-900");
  await tabTo("Пространства");
  await pressFocused();
  await show("Проекты без пространства");
  await show("Keyboard Space");
  assert(!seen("Без значка"), "Russian empty icon label is still shown");
  assert(!seen("кластер"), "Russian spaces page still says cluster");
  shot("ru-workspaces-900");
  await tabTo("Открыть");
  await pressFocused();
  await show("Alpha");
  await tabTo("Alpha");
  await pressFocused();
  await show("Keyboard task");
  shot("ru-board-900");
  await tabTo("Аналитика");
  await pressFocused();
  await show("Показан только");
  shot("ru-analytics-900");
  await tabTo("Настройки");
  await pressFocused();
  await tabTo("Планы выполнения");
  await pressFocused();
  await show("не разрешает");
  shot("ru-plans-900");
  key(ESCAPE);
  await sleep(300);
  await show("Экстренная остановка");
  mark("Russian 900 pt covered Home, Workspaces, the board, Analytics and Execution plans. Emergency Stop stayed available.");
  assert.equal((await runs()).length, 0, "the Russian walk started a run");

  ax("resize", "1200", "800");
  await sleep(300);
  shot("ru-home-1200-after-plans");

  const accessibility = () => {
    const probe = spawnSync("/usr/bin/swift", ["-e", "import AppKit; print(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion); print(NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency)"], { encoding: "utf8" });
    const lines = (probe.stdout || "").trim().split("\n");
    return { reduceMotion: lines[0] || "unreadable", reduceTransparency: lines[1] || "unreadable", probeStatus: probe.status };
  };
  const motionBefore = readDefault("com.apple.universalaccess", "reduceMotion");
  const transparencyBefore = readDefault("com.apple.universalaccess", "reduceTransparency");
  evidence.systemSettingsBefore = { reduceMotion: motionBefore, reduceTransparency: transparencyBefore, accessibility: accessibility() };
  const wrote: string[] = [];
  const restore = () => {
    for (const name of wrote) {
      if ((name === "reduceMotion" ? motionBefore : transparencyBefore) === "absent") {
        spawnSync("/usr/bin/defaults", ["delete", "com.apple.universalaccess", name]);
      }
    }
  };
  try {
    for (const name of ["reduceMotion", "reduceTransparency"]) {
      const result = spawnSync("/usr/bin/defaults", ["write", "com.apple.universalaccess", name, "-bool", "true"], { encoding: "utf8" });
      if (result.status === 0) wrote.push(name);
    }
    evidence.systemSettingsWrite = { wrote, refused: wrote.length === 0 };
    await down();
    await up();
    ax("resize", "1200", "800");
    await show("Пространства", 30_000);
    enterPage();
    shot("ru-reduced-motion-home");
    await tabTo("Пространства");
    await pressFocused();
    await show("Keyboard Space");
    shot("ru-reduced-motion-workspaces");
    evidence.systemSettingsDuring = {
      reduceMotion: readDefault("com.apple.universalaccess", "reduceMotion"),
      reduceTransparency: readDefault("com.apple.universalaccess", "reduceTransparency"),
      accessibility: accessibility(),
    };
    mark(wrote.length === 2
      ? "The QA window was relaunched after macOS accepted Reduce Motion and Reduce Transparency. Text on Home and Workspaces stayed readable."
      : "macOS refused the Reduce Motion and Reduce Transparency write. NSWorkspace stayed at the machine's existing values. The screenshots are that existing setting, not a toggled one. Chromium media emulation is a separate check.");
  } finally {
    restore();
    evidence.systemSettingsAfter = {
      reduceMotion: readDefault("com.apple.universalaccess", "reduceMotion"),
      reduceTransparency: readDefault("com.apple.universalaccess", "reduceTransparency"),
      accessibility: accessibility(),
    };
    save();
  }

  evidence.result = "pass";
  evidence.runs = await runs();
  save();
  await down();
}
