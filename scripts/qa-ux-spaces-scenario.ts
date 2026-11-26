/**
 * Packaged walkthrough for the spaces navigation milestone.
 * Isolated ForgeOrbitQA, disposable profile, fake drivers. Opening screens does not
 * authorize, resume or start work. Emergency Stop is observed, not pressed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;

export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, runtime, root, up, down, sleep, poll } = c;
  const repo = join(import.meta.dir, "..");
  const shots = join(repo, "docs/qa/evidence/fo-ux-spaces");
  mkdirSync(shots, { recursive: true });
  const bindingFile = join(root, "binding.json");
  const helperBin = join(root, "qa-native-pid");
  const shotStatus: Record<string, { captured: boolean; blocker?: string }> = {};
  const summarize = (node: any, out: Array<{ role: string; text: string }> = []): Array<{ role: string; text: string }> => {
    if (!node || typeof node !== "object" || out.length >= 300) return out;
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
    } catch { /* accessibility dump is best-effort beside the screenshot */ }
    evidence.shots = shotStatus;
    save();
  };
  const seen = (part: string) => find(hasText(part)).length > 0;
  const runs = async () => {
    const tasks = await api("GET", "/tasks");
    const list = Array.isArray(tasks) ? tasks : tasks.tasks ?? [];
    return list.filter((task: { runId?: string | null; column?: string }) => task.runId || task.column === "running");
  };

  const alpha = join(runtime, "projects/Alpha");
  const beta = join(runtime, "projects/Beta");
  const lone = join(runtime, "projects/Lone");
  for (const dir of [alpha, beta, lone]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(alpha, "README.md"), "alpha\n");
  writeFileSync(join(beta, "README.md"), "beta\n");
  writeFileSync(join(lone, "README.md"), "lone\n");

  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: alpha, name: "Alpha" });
  await api("POST", "/projects", { path: beta, name: "Beta" });
  await api("POST", "/projects", { path: lone, name: "Lone" });
  const spaceOne = await api("POST", "/clusters", { name: "Space One" });
  const spaceTwo = await api("POST", "/clusters", { name: "Space Two" });
  await api("POST", `/clusters/${spaceOne.id}/projects`, { projectPath: alpha });
  await api("POST", `/clusters/${spaceTwo.id}/projects`, { projectPath: beta });
  await api("POST", "/tasks", { title: "Needs a look", prompt: "Review the notes.", workdir: alpha, isolation: "none", column: "review" });
  await api("POST", "/tasks", { title: "Beta remaining", prompt: "Still to do.", workdir: beta, isolation: "none", column: "ready" });
  await down();
  await up();
  ax("resize", "1280", "860");
  await show("Home", 30_000);
  shot("en-home-1280");
  mark("Home is the first screen. Emergency Stop is visible and was not pressed.");
  await show("Emergency stop");
  assert.equal((await runs()).length, 0, "opening Home started a run");

  await show("Needs a look");
  await button("Review");
  await show("Alpha");
  await show("Space One");
  shot("en-review-board-1280");
  mark("The review on Home opened Alpha's board in Space One.");
  ax("key", "53", "0");
  await sleep(400);
  await show("Space One");
  assert.equal((await runs()).length, 0, "opening the review started a run");

  await button("Workspaces");
  await show("Space Two");
  await show("Projects without a space");
  await show("Lone");
  shot("en-workspaces-1280");
  mark("Two spaces and the project without a space are on one page. Lone was not put into a space.");

  await button("Open", true, 1);
  await show("Beta");
  await button("Beta");
  await show("Space Two");
  await button("Analytics");
  await show("Already used in this project");
  await show("Estimated for the remaining work");
  await show("Account-wide quota");
  await show("Showing only Beta");
  shot("en-beta-analytics-1280");
  mark("Beta analytics opened already scoped to Beta, with recorded use, the estimate and account quota separated.");
  assert(seen("Showing only Beta"), "Beta analytics was not scoped to Beta");

  await button("Workspaces");
  await button("Open board");
  await show("No space");
  await show("Lone");
  shot("en-lone-board-1280");
  mark("The project without a space opened on its own board.");

  await button("Analytics");
  await show("Showing only Lone");
  await button("Filters, views and export");
  shot("en-lone-analytics-details-1280");
  mark("Lone's filters and export stay behind the secondary disclosure and name Lone.");

  await button("Settings");
  await button("Execution plans");
  await show("Opening this page does not authorize");
  await show("Emergency stop");
  shot("en-plans-1280");
  mark("Execution plans are in Settings. Opening them did not start work.");
  assert.equal((await runs()).length, 0, "opening execution plans started a run");
  ax("key", "53", "0");
  await sleep(300);

  ax("resize", "800", "600");
  await sleep(400);
  await button("Workspaces");
  await show("Projects without a space");
  await show("Emergency stop");
  shot("en-workspaces-800");
  mark("English workspaces still fit and Emergency Stop stays available at 800×600.");

  await api("PUT", "/preferences/locale", { value: "ru" });
  await down();
  await up();
  ax("resize", "1280", "860");
  await show("Пространства", 30_000);
  await show("Экстренная остановка");
  shot("ru-home-1280");
  await button("Пространства");
  await show("Проекты без пространства");
  await show("Space One");
  shot("ru-workspaces-1280");
  mark("Russian calls spaces Пространства and keeps the project without a space.");
  await button("Настройки");
  await button("Планы выполнения");
  await show("не разрешает");
  shot("ru-plans-1280");
  ax("resize", "800", "600");
  await sleep(400);
  await show("Планы выполнения");
  shot("ru-plans-800");
  ax("key", "53", "0");
  await sleep(400);
  await show("Экстренная остановка");
  mark("Russian execution plans stay open at 800×600, and Emergency Stop is still available after the page closes.");
  assert.equal((await runs()).length, 0, "the Russian walk started a run");

  evidence.result = "pass";
  evidence.runs = await runs();
  save();
  await down();
}
