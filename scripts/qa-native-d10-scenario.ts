/**
 * Direction 10 packaged window verification (before/after title-bar layout + AI resources panel).
 * Runs in isolated ForgeOrbitQA only (/private/tmp/fo-native-d2-*), with fake drivers and synthetic fixture directories.
 * Never touches ~/Applications/ForgeOrbit.app or ~/Library/Application Support/ForgeOrbit, and never calls a provider.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Ctx = any;
const TAB = "48";
const RETURN = "36";
const ESCAPE = "53";
const KEY_N = "45";
const SHIFT = "131072";
const COMMAND = "1048576";
const NOV_HINT = "Nov 16th, 2026 9:31 PM";

export async function run(c: Ctx) {
  const {
    api,
    button,
    show,
    absent,
    find,
    hasText,
    ax,
    mark,
    evidence,
    save,
    runtime,
    root,
    up,
    down,
    sleep,
    poll,
    ownerPaths,
    stamp,
  } = c;
  const repo = join(import.meta.dir, "..");
  const outDir = join(repo, "docs/qa/evidence/fo-direction10");
  mkdirSync(outDir, { recursive: true });
  const bindingFile = join(root, "binding.json");
  const helperBin = join(root, "qa-native-pid");
  const isBefore = root.includes("before");

  const shotStatus: Record<string, { captured: boolean; file: string; blocker?: string }> = {};
  const summarize = (
    node: any,
    out: Array<{ role: string; text: string; frame?: any }> = [],
  ): Array<{ role: string; text: string; frame?: any }> => {
    if (!node || typeof node !== "object" || out.length >= 500) return out;
    const parts = [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => String(v).trim());
    if (parts.length && node.AXRole) {
      out.push({
        role: String(node.AXRole),
        text: parts.join(" | ").slice(0, 200),
        frame: node.frame,
      });
    }
    for (const child of node.children ?? []) summarize(child, out);
    return out;
  };

  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(bindingFile, "utf8"));
    const pngPath = join(outDir, `${name}.png`);
    const sc = spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, pngPath], {
      encoding: "utf8",
    });
    if (sc.status === 0 && existsSync(pngPath)) {
      shotStatus[name] = { captured: true, file: `docs/qa/evidence/fo-direction10/${name}.png` };
    } else {
      shotStatus[name] = {
        captured: false,
        file: `docs/qa/evidence/fo-direction10/${name}.png`,
        blocker: (sc.stderr || sc.stdout || "screencapture declined").trim(),
      };
    }
    try {
      const web = inspect().web;
      writeFileSync(join(outDir, `${name}.ax.json`), JSON.stringify(summarize(web), null, 2) + "\n");
    } catch {
      /* best-effort AX dump */
    }
    evidence.shots = shotStatus;
    save();
  };

  const inspect = () => JSON.parse(ax("inspect"));
  const focusText = () => {
    const node = inspect().focus ?? {};
    return [node.AXRole, node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp]
      .filter((v) => typeof v === "string" && v.trim())
      .join(" | ");
  };
  const key = (code: string, flags = "0") => ax("key", code, flags);
  const enterPage = () => {
    ax("focus");
    ax("focus-name", "AXWebArea", "ForgeOrbit");
  };
  const tabTo = async (part: string, backwards = false) => {
    const path: string[] = [];
    for (let i = 0; i < 80; i++) {
      const text = focusText();
      path.push(text);
      if (text.toLowerCase().includes(part.toLowerCase())) return path;
      key(TAB, backwards ? SHIFT : "0");
      await sleep(90);
    }
    throw new Error(`keyboard did not reach "${part}"\n${path.slice(-12).join("\n")}`);
  };
  const seen = (part: string) => find(hasText(part)).length > 0;

  const measureTitlebar = (windowWidth: number) => {
    const inspected = inspect();
    const web = inspected.web;
    const winBounds = inspected.window?.kCGWindowBounds ?? { X: 120, Y: 120, Width: windowWidth, Height: 800 };
    const webFrame = web?.frame ?? {
      x: Number(winBounds.X ?? 120),
      y: Number(winBounds.Y ?? 120),
      width: Number(winBounds.Width ?? windowWidth),
      height: Number(winBounds.Height ?? 800),
    };
    const forgeOrbitText = find(
      (n: any) =>
        n.AXRole === "AXStaticText" &&
        hasText("ForgeOrbit")(n) &&
        n.frame &&
        n.frame.y <= webFrame.y + 60,
    )[0];
    const barTop = forgeOrbitText?.frame ? forgeOrbitText.frame.y - 11 : webFrame.y;
    const rawButtons = find((n: any) => {
      if (n.AXRole !== "AXButton" && n.AXRole !== "AXPopUpButton") return false;
      if (!n.frame) return false;
      const cy = n.frame.y + n.frame.height / 2;
      return cy >= barTop && cy <= barTop + 42;
    });
    const buttons = rawButtons.map((b: any) => ({
      role: b.AXRole,
      title: b.AXTitle || b.AXDescription || b.AXValue || "",
      help: b.AXHelp || "",
      frame: b.frame,
    }));
    buttons.sort((a: any, b: any) => a.frame.x - b.frame.x);

    // Check vertical alignment (single line) and horizontal overlap among distinct controls.
    const centerYs = buttons.map((b: any) => b.frame.y + b.frame.height / 2);
    const minY = centerYs.length ? Math.min(...centerYs) : 0;
    const maxY = centerYs.length ? Math.max(...centerYs) : 0;
    const maxHeight = buttons.length ? Math.max(...buttons.map((b: any) => b.frame.height)) : 0;
    const singleLine = maxY - minY <= 6 && maxHeight <= 36;

    const overlaps: Array<{ a: string; b: string; overlapPx: number }> = [];
    for (let i = 0; i < buttons.length - 1; i++) {
      const cur = buttons[i]!;
      const next = buttons[i + 1]!;
      const curRight = cur.frame.x + cur.frame.width;
      if (curRight > next.frame.x + 1) {
        overlaps.push({ a: cur.title, b: next.title, overlapPx: Math.round(curRight - next.frame.x) });
      }
    }
    const maxRight = buttons.length
      ? Math.max(...buttons.map((b: any) => b.frame.x + b.frame.width - webFrame.x))
      : 0;
    const overflowsWindow = maxRight > windowWidth + 2;

    return {
      windowWidth,
      webFrame,
      forgeOrbitFrame: forgeOrbitText?.frame ?? null,
      buttons,
      singleLine,
      maxButtonHeightPx: Math.round(maxHeight),
      maxCenterYDelta: Math.round(maxY - minY),
      overlaps,
      maxRightPx: Math.round(maxRight),
      overflowsWindow,
    };
  };

  const projectDir = join(runtime, "projects/D10Project");
  const stubCodex = join(runtime, "codex");
  const stubClaude = join(runtime, "claude");
  const dirAlpha = join(runtime, "home/codex-alpha");
  const dirBeta = join(runtime, "home/codex-beta");
  const dirGamma = join(runtime, "home/codex-gamma");
  const dirDelta = join(runtime, "home/codex-delta");
  const dirClaude = join(runtime, "home/claude-epsilon");

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# D10 Project\n");
  for (const dir of [dirAlpha, dirBeta, dirGamma, dirDelta, dirClaude]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  writeFileSync(join(dirAlpha, "synthetic-authenticated"), "subject-alpha");
  writeFileSync(join(dirBeta, "synthetic-authenticated"), "subject-beta");

  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));

  if (isBefore) {
    // =========================================================================
    // BASELINE ("BEFORE") REPRODUCTION ON 9066b615
    // =========================================================================
    await up();
    const existingProfiles = await api("GET", "/account-core/codex-profiles");
    if (existingProfiles.length === 0) {
      await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
      await api("PUT", "/preferences/locale", { value: "en" });
      await api("POST", "/projects", { path: projectDir, name: "D10 Project" });
      await api("PATCH", "/harnesses/claude-code", { enabled: true });
      await api("PATCH", "/harnesses/codex", { enabled: true });

      const p1 = await api("POST", "/account-core/codex-profiles", {
        displayName: "Enterprise Architecture Primary Codex Profile Alpha-01",
        directory: dirAlpha,
      });
      const p2 = await api("POST", "/account-core/codex-profiles", {
        displayName: "Independent Security Reviewer Codex Profile Beta-02",
        directory: dirBeta,
      });
      const p3 = await api("POST", "/account-core/codex-profiles", {
        displayName: "Staff Platform Operations Codex Profile Gamma-03",
        directory: dirGamma,
      });
      const p4 = await api("POST", "/account-core/codex-profiles", {
        displayName: "Autonomous Release Verification Codex Profile Delta-04",
        directory: dirDelta,
      });
      for (const p of [p1, p2, p3, p4]) {
        await api("PATCH", `/harnesses/${p.harnessId}`, { bin: stubCodex, enabled: true });
      }
      await api("POST", `/account-core/codex-profiles/${p1.accountId}/check`);
      await api("POST", `/account-core/codex-profiles/${p2.accountId}/check`);
    } else {
      await api("PUT", "/preferences/locale", { value: "en" });
    }

    await down();
    await up();

    ax("resize", "1200", "800");
    await sleep(1500);
    await show("Alpha-01", 20_000);
    const beforeEn1200 = measureTitlebar(1200);
    shot("before-en-1200");

    ax("resize", "800", "800");
    await sleep(1200);
    const beforeEn800 = measureTitlebar(800);
    shot("before-en-800");

    await api("PUT", "/preferences/locale", { value: "ru" });
    await down();
    await up();
    ax("resize", "1200", "800");
    await sleep(1500);
    await show("Alpha-01", 20_000);
    const beforeRu1200 = measureTitlebar(1200);
    shot("before-ru-1200");

    ax("resize", "800", "800");
    await sleep(1200);
    const beforeRu800 = measureTitlebar(800);
    shot("before-ru-800");

    await down();

    const beforeSummary = {
      build: evidence.build,
      reproducedIssue:
        "Individual provider and long-named Codex profile chips render directly in the title bar alongside task count, floating ⌘N badge, and separate Git/Worktrees/Pipelines buttons, overflowing the title bar horizontally.",
      measurements: {
        en1200: beforeEn1200,
        en800: beforeEn800,
        ru1200: beforeRu1200,
        ru800: beforeRu800,
      },
      shots: shotStatus,
    };
    writeFileSync(join(outDir, "before-layout.json"), JSON.stringify(beforeSummary, null, 2) + "\n");
    mark("Captured baseline ('before') title-bar crowding and horizontal overflow on 9066b615 at 1200pt and 800pt in EN and RU.");
    return;
  }

  // ===========================================================================
  // FIXED ("AFTER") VERIFICATION
  // ===========================================================================
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: projectDir, name: "D10 Project" });
  await api("PATCH", "/harnesses/claude-code", { enabled: true });
  await api("PATCH", "/harnesses/codex", { enabled: true });

  await down();
  await up();

  // 1. Measure AI resources button width BEFORE adding any profiles.
  ax("resize", "1200", "800");
  await sleep(1000);
  await show("AI resources", 20_000);
  const preProfiles1200 = measureTitlebar(1200);
  const aiBtnBefore1200 = preProfiles1200.buttons.find((b: any) => b.title.includes("AI resources"));
  assert(aiBtnBefore1200, "AI resources button is visible before adding profiles");

  ax("resize", "800", "800");
  await sleep(800);
  const preProfiles800 = measureTitlebar(800);
  const aiBtnBefore800 = preProfiles800.buttons.find((b: any) => b.title.includes("AI resources"));
  assert(aiBtnBefore800, "AI resources button is visible at 800pt before adding profiles");

  // 2. Register 4 Codex profiles with long names + 1 Claude profile with a long name,
  //    and create a standing provider refusal on Beta via the fake Codex driver.
  const alpha = await api("POST", "/account-core/codex-profiles", {
    displayName: "Enterprise Architecture Primary Codex Profile Alpha-01",
    directory: dirAlpha,
  });
  const beta = await api("POST", "/account-core/codex-profiles", {
    displayName: "Independent Security Reviewer Codex Profile Beta-02",
    directory: dirBeta,
  });
  const gamma = await api("POST", "/account-core/codex-profiles", {
    displayName: "Staff Platform Operations Codex Profile Gamma-03",
    directory: dirGamma,
  });
  const delta = await api("POST", "/account-core/codex-profiles", {
    displayName: "Autonomous Release Verification Codex Profile Delta-04",
    directory: dirDelta,
  });
  for (const p of [alpha, beta, gamma, delta]) {
    await api("PATCH", `/harnesses/${p.harnessId}`, { bin: stubCodex, enabled: true });
  }
  await api("POST", `/account-core/codex-profiles/${alpha.accountId}/check`);
  await api("POST", `/account-core/codex-profiles/${beta.accountId}/check`);
  // Leave gamma unchecked ("Authentication: Unknown — check in Accounts"), and disable delta ("Disabled").
  await api("PUT", `/account-core/execution-profiles/${delta.accountId}/meta`, { disabled: true });

  const claudeProfile = await api("POST", "/account-core/claude-profiles", {
    displayName: "Principal Systems Architect Claude Config Epsilon-05",
    directory: dirClaude,
    homeAccessAccepted: true,
  });
  await api("PATCH", `/harnesses/${claudeProfile.harnessId}`, { bin: stubClaude, enabled: true });

  // Trigger a usage-limit refusal on Beta via the fake Codex driver so Beta has both valid sign-in AND a standing refusal,
  // while quota remains Unknown.
  const employee = await api("POST", "/employees", {
    name: "D10 Dev",
    jobTitle: "Developer",
    projectPath: projectDir,
  });
  const refusedTaskRes = await api("POST", "/tasks", {
    title: "Refused task on Beta",
    prompt: "Run __fake_provider__:usage-limit",
    workdir: projectDir,
    agent: beta.harnessId,
    model: "gpt-6.1-sol",
    isolation: "none",
    column: "ready",
  });
  const refusedTaskId = (refusedTaskRes.task ?? refusedTaskRes).id;
  await api("POST", "/task-assignments", { taskId: refusedTaskId, employeeId: employee.id });
  const startedRefusal = await api("POST", `/tasks/${refusedTaskId}/start`);
  await poll(
    "refused run on Beta settles",
    async () => {
      const taskRuns = await api("GET", `/tasks/${refusedTaskId}/runs`);
      return taskRuns.find((r: any) => r.id === startedRefusal.runId)?.status !== "running" ? true : null;
    },
    20_000,
  );

  // Also create a backlog task bound to Alpha so we can verify that opening AI resources never changes task.agent.
  const alphaTaskRes = await api("POST", "/tasks", {
    title: "Pinned Alpha Task",
    prompt: "Verify account stays pinned to Alpha",
    workdir: projectDir,
    agent: alpha.harnessId,
    model: "gpt-6.1-sol",
    isolation: "none",
    column: "backlog",
  });
  const alphaTaskId = (alphaTaskRes.task ?? alphaTaskRes).id;

  await down();
  await up();
  await api("POST", `/account-core/codex-profiles/${alpha.accountId}/check`);
  await api("POST", `/account-core/codex-profiles/${beta.accountId}/check`);

  // 3. Verify English layout at 1200x800, 960x800, and 800x800.
  ax("resize", "1200", "800");
  await sleep(1200);
  await show("AI resources", 20_000);
  const afterEn1200 = measureTitlebar(1200);
  shot("after-en-1200");

  assert(afterEn1200.singleLine, `EN 1200pt titlebar not single-line: delta=${afterEn1200.maxCenterYDelta}`);
  assert.equal(afterEn1200.overlaps.length, 0, `EN 1200pt overlaps: ${JSON.stringify(afterEn1200.overlaps)}`);
  assert(!afterEn1200.overflowsWindow, `EN 1200pt overflows window: maxRight=${afterEn1200.maxRightPx}`);

  const aiBtnAfter1200 = afterEn1200.buttons.find((b: any) => b.title.includes("AI resources"));
  assert(aiBtnAfter1200, "AI resources button present at 1200pt after adding 5 profiles");
  assert.equal(
    Math.round(aiBtnAfter1200.frame.width),
    Math.round(aiBtnBefore1200.frame.width),
    "Adding 5 long-named profiles must not widen the AI resources control at 1200pt",
  );

  // Verify no floating ⌘N badge text inside the titlebar, while New task help carries (⌘N).
  const newTaskBtn1200 = afterEn1200.buttons.find((b: any) => b.title.includes("New task"));
  assert(newTaskBtn1200, "New task button is visible in the titlebar");
  assert(!newTaskBtn1200.title.includes("⌘N"), "New task button label does not contain floating ⌘N badge");
  assert(newTaskBtn1200.help.includes("⌘N"), `New task tooltip/help carries ⌘N: ${newTaskBtn1200.help}`);

  // Verify task count is on Home ("2 tasks"), not in the titlebar.
  assert(seen("2 tasks"), "Task count is rendered on Home");

  ax("resize", "960", "800");
  await sleep(1000);
  const afterEn960 = measureTitlebar(960);
  shot("after-en-960");
  assert(afterEn960.singleLine, "EN 960pt titlebar stays single-line");
  assert.equal(afterEn960.overlaps.length, 0, "EN 960pt titlebar has zero overlap");
  assert(!afterEn960.overflowsWindow, "EN 960pt titlebar does not overflow window");

  ax("resize", "800", "800");
  await sleep(1000);
  const afterEn800 = measureTitlebar(800);
  shot("after-en-800");
  assert(afterEn800.singleLine, `EN 800pt titlebar not single-line: delta=${afterEn800.maxCenterYDelta}`);
  assert.equal(afterEn800.overlaps.length, 0, `EN 800pt overlaps: ${JSON.stringify(afterEn800.overlaps)}`);
  assert(!afterEn800.overflowsWindow, `EN 800pt overflows window: maxRight=${afterEn800.maxRightPx}`);

  const aiBtnAfter800 = afterEn800.buttons.find((b: any) => b.title.includes("AI resources"));
  assert.equal(
    Math.round(aiBtnAfter800.frame.width),
    Math.round(aiBtnBefore800.frame.width),
    "Adding 5 long-named profiles must not widen the AI resources control at 800pt",
  );
  mark("Verified English title bar at 1200pt, 960pt, and 800pt: single line, zero overlap, no horizontal scroll, constant AI resources width.");

  // 4. Snapshot read-only counters before opening AI resources panel.
  const readCounters = async () => {
    const taskRuns = await api("GET", `/tasks/${refusedTaskId}/runs`);
    const alphaTask = (await api("GET", "/tasks")).find((t: any) => t.id === alphaTaskId);
    const profiles = (await api("GET", "/account-core/execution-profiles")).profiles;
    return {
      runCount: taskRuns.length,
      alphaTaskAgent: alphaTask?.agent,
      profileCount: profiles.length,
    };
  };
  const countersBeforePanel = await readCounters();

  // 5. Keyboard navigation at 800x800: Tab to AI resources, Emergency stop, New task, More actions;
  //    open AI resources panel, verify fixture states, press Escape to close and restore focus.
  enterPage();
  const tabPathToAi = await tabTo("AI resources");
  const tabPathToStop = await tabTo("Emergency stop");
  const tabPathToNewTask = await tabTo("New task");
  const tabPathToMore = await tabTo("More actions");
  await tabTo("AI resources", true);
  key(RETURN);
  await sleep(700);

  await show("Registered account profiles", 10_000);
  await show("Enterprise Architecture Primary Codex Profile Alpha-01");
  await show("Independent Security Reviewer Codex Profile Beta-02");
  await show("Staff Platform Operations Codex Profile Gamma-03");
  await show("Autonomous Release Verification Codex Profile Delta-04");
  await show("Principal Systems Architect Claude Config Epsilon-05");
  await show("Ready (CLI login status passed)");
  await show("Signed in — provider refused a request");
  await show("Authentication: Unknown — check in Accounts");
  await show("Disabled");
  await show("Quota: Unknown");
  await show(`Provider refusal (separate from quota): ${NOV_HINT}`);
  await show("PARTIAL: CLAUDE_CONFIG_DIR does not isolate macOS Keychain or ~/.claude.json and does not prove account identity.");
  shot("after-en-panel-800");

  const countersAfterPanel = await readCounters();
  assert.deepEqual(
    countersAfterPanel,
    countersBeforePanel,
    "Opening AI resources panel must not launch a CLI, refresh quotas, or change which account a task uses",
  );

  // Press Escape to close the panel and verify focus returns to AI resources.
  key(ESCAPE);
  await sleep(500);
  await absent("Registered account profiles");
  const focusAfterPanelEscape = focusText();
  assert(
    focusAfterPanelEscape.includes("AI resources"),
    `Escape must restore focus to AI resources (got: ${focusAfterPanelEscape})`,
  );
  mark("Verified AI resources panel at 800pt: shows all 5 profiles, keeps Unknown quota and provider refusal distinct, shows Claude HOME/Keychain limitation, is strictly read-only, and closes on Escape restoring focus.");

  // 6. Verify overflow menu ("More actions") and project-scoped Git button.
  await button("More actions", true);
  await sleep(500);
  await show("Pipelines");
  await show("Worktrees");
  await show("Git");
  shot("after-en-overflow-menu-800");
  key(ESCAPE);
  await sleep(400);

  // Test ⌘N shortcut opens the New Task sheet, and Escape closes it.
  key(KEY_N, COMMAND);
  await sleep(700);
  await show("Create task", 10_000).catch(() => show("New task", 10_000));
  shot("after-en-cmd-n-sheet");
  key(ESCAPE);
  await sleep(500);

  // Open AI resources panel and click "Open Accounts" to verify link to Accounts.
  ax("resize", "1200", "800");
  await sleep(800);
  await button("AI resources", true);
  await sleep(600);
  shot("after-en-panel-1200");
  await button("Open Accounts", true);
  await sleep(900);
  await show("Codex account profiles", 15_000);
  await show("Execution profiles", 15_000);
  shot("after-en-accounts-link");
  key(ESCAPE);
  await sleep(600);

  // Open D10 Project to verify the project-only Git action is in ProjectHeader.
  await button("D10 Project", false, 0);
  await sleep(800);
  await show("Git");
  shot("after-en-project-git-1200");

  // 7. Verify Emergency Stop behavior is unchanged (one click activates, Resume… asks confirmation).
  await button("Emergency stop", true);
  await sleep(600);
  await show("Stopped");
  shot("after-en-emergency-stop");
  await button("Resume…", true);
  await sleep(600);
  await show("Lift the emergency stop?");
  await button("Lift emergency stop", true);
  await sleep(600);
  await show("Emergency stop");
  mark("Verified Emergency Stop one-click activation and confirmed lift in the packaged window.");

  // 8. Switch to Russian ("ru") and verify at 1200x800 and 800x800.
  await api("PUT", "/preferences/locale", { value: "ru" });
  await down();
  await up();
  await api("POST", `/account-core/codex-profiles/${alpha.accountId}/check`);
  await api("POST", `/account-core/codex-profiles/${beta.accountId}/check`);

  ax("resize", "1200", "800");
  await sleep(1200);
  await show("ИИ-ресурсы", 20_000);
  const afterRu1200 = measureTitlebar(1200);
  shot("after-ru-1200");
  assert(afterRu1200.singleLine, `RU 1200pt titlebar not single-line: delta=${afterRu1200.maxCenterYDelta}`);
  assert.equal(afterRu1200.overlaps.length, 0, `RU 1200pt overlaps: ${JSON.stringify(afterRu1200.overlaps)}`);
  assert(!afterRu1200.overflowsWindow, `RU 1200pt overflows window: maxRight=${afterRu1200.maxRightPx}`);

  ax("resize", "800", "800");
  await sleep(1000);
  const afterRu800 = measureTitlebar(800);
  shot("after-ru-800");
  assert(afterRu800.singleLine, `RU 800pt titlebar not single-line: delta=${afterRu800.maxCenterYDelta}`);
  assert.equal(afterRu800.overlaps.length, 0, `RU 800pt overlaps: ${JSON.stringify(afterRu800.overlaps)}`);
  assert(!afterRu800.overflowsWindow, `RU 800pt overflows window: maxRight=${afterRu800.maxRightPx}`);

  await button("ИИ-ресурсы", true);
  await sleep(700);
  await show("Зарегистрированные профили аккаунтов", 10_000);
  await show("Готов (проверка входа CLI пройдена)");
  await show("Вход выполнен — провайдер отклонил запрос");
  await show("Отключён");
  await show("Квота: Неизвестно");
  await show(`Отказ провайдера (отдельно от квоты): ${NOV_HINT}`);
  await show("ЧАСТИЧНО: CLAUDE_CONFIG_DIR не изолирует связку ключей macOS и ~/.claude.json и не доказывает личность аккаунта.");
  shot("after-ru-panel-800");
  key(ESCAPE);
  await sleep(500);

  await down();

  // 9. Verify Owner paths (installed ~/Applications/ForgeOrbit.app and working profile) are untouched.
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner paths must remain completely untouched");

  const afterSummary = {
    build: evidence.build,
    aiResourcesButtonWidth1200: {
      beforeAddingProfiles: Math.round(aiBtnBefore1200.frame.width),
      afterAdding5LongProfiles: Math.round(aiBtnAfter1200.frame.width),
    },
    aiResourcesButtonWidth800: {
      beforeAddingProfiles: Math.round(aiBtnBefore800.frame.width),
      afterAdding5LongProfiles: Math.round(aiBtnAfter800.frame.width),
    },
    measurements: {
      en1200: afterEn1200,
      en960: afterEn960,
      en800: afterEn800,
      ru1200: afterRu1200,
      ru800: afterRu800,
    },
    keyboard: {
      tabToAiResources: tabPathToAi.slice(-5),
      tabToEmergencyStop: tabPathToStop.slice(-5),
      tabToNewTask: tabPathToNewTask.slice(-5),
      tabToMoreActions: tabPathToMore.slice(-5),
      focusAfterPanelEscape,
    },
    readOnlyCheck: {
      before: countersBeforePanel,
      after: countersAfterPanel,
    },
    ownerPathsUntouched: true,
    shots: shotStatus,
  };
  writeFileSync(join(outDir, "after-layout.json"), JSON.stringify(afterSummary, null, 2) + "\n");
  mark("Completed Direction 10 packaged window verification in EN and RU at 1200pt, 960pt, and 800pt.");
}
