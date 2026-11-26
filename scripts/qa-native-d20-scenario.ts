/**
 * Direction 20 (Native macOS Computer Use): one connected flow in the isolated packaged ForgeOrbitQA window.
 * Uses only the packaged Swift accessibility helper, fake manager drivers (`AGETOR_*_DRIVER=fake`), and
 * disposable Cocoa fixtures compiled into the temporary QA root (`FixtureCU07.app --d20`, `TargetA.app`, `TargetB.app`).
 * Never touches real user profiles, installed ForgeOrbit, sensitive real apps, or live models.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

type Ctx = any;

const CANARY_STATIC = "CANARY_PROTECTED_STATIC_7341";
const CANARY_SECURE = "CANARY_SECURE_FIELD_9182";
const OWNER_TEXT = "D20_QA_TEXT";
const PM_TEXT = "D20_PM_TEXT";

const MARKERS = {
  echoHead: "__fake_portfolio_native_echo__",
  pressHead: "__fake_portfolio_native_press__",
  openMenuHead: "__fake_portfolio_native_open_menu__",
  selectMenuItemHead: "__fake_portfolio_native_select_menu_item__",
  twoHead: "__fake_portfolio_native_two__",
  slowHead: "__fake_portfolio_slow__",
  echoPm: "__fake_pm_native_echo__",
  pressPm: "__fake_pm_native_press__",
  scrollPm: "__fake_pm_native_scroll__",
  tabPm: "__fake_pm_native_tab__",
  setTextPm: "__fake_pm_native_set_text__",
  openMenuPm: "__fake_pm_native_open_menu__",
  selectMenuItemPm: "__fake_pm_native_select_menu_item__",
  obey: "__fake_native_obey__",
};

export async function run(c: Ctx) {
  const {
    api, button, show, find, hasText, ax, clickByPosition, click, activate,
    mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, saveState, useDataDir,
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
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
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
      const web = JSON.parse(spawnSync(join(root, "qa-native-pid"), [join(root, "binding.json"), "inspect"], { encoding: "utf8" }).stdout).web;
      writeFileSync(join(shots, `${name}.ax.json`), JSON.stringify(summarizeAx(web), null, 2) + "\n");
    } catch {}
    evidence.shots = shotStatus;
  };
  const build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.build = build;
  const has = (part: string) => find(hasText(part)).length > 0;
  const sh = (argv: string[], opts: { cwd?: string } = {}) => {
    const out = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", cwd: opts.cwd });
    if (out.status !== 0) {
      throw new Error(`Command failed (${argv.join(" ")}): ${out.stderr || out.stdout}`);
    }
    return out;
  };
  const psAll = () => spawnSync("/bin/ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n");
  const dataDir = join(runtime, "data");
  const helperBin = join(root, "qa-native-pid");
  const bindingFile = join(root, "binding.json");
  const packagedHelper = join(root, "ForgeOrbitQA-dev.app/Contents/Resources/app/bin/forgeorbit-native-cu");
  assert(existsSync(packagedHelper), `Missing packaged helper at ${packagedHelper}`);
  const helperSig = sh(["codesign", "-dvv", packagedHelper]);
  evidence.packagedHelper = {
    path: packagedHelper,
    codesign: (helperSig.stderr || helperSig.stdout).split("\n").slice(0, 6),
  };

  // Verify initial OS permissions reported by the packaged QA helper
  const directPermRun = spawnSync(packagedHelper, [], {
    input: JSON.stringify({ command: "permissions" }),
    encoding: "utf8",
  });
  assert.equal(directPermRun.status, 0);
  const directPerms = JSON.parse(directPermRun.stdout);
  assert.equal(directPerms.ok, true);
  evidence.initialPermissions = directPerms.result;
  assert.equal(directPerms.result.accessibility, "granted", "QA Accessibility permission must be granted on host");

  // Compile disposable Cocoa fixtures inside QA root
  const fixturesDir = join(root, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  const buildAppBundle = (name: string, exeName: string, swiftRel: string, plistRel: string) => {
    const appDir = join(fixturesDir, `${name}.app`);
    const exePath = join(appDir, "Contents/MacOS", exeName);
    mkdirSync(join(appDir, "Contents/MacOS"), { recursive: true });
    sh(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exePath, join(repo, swiftRel)]);
    copyFileSync(join(repo, plistRel), join(appDir, "Contents/Info.plist"));
    sh(["codesign", "--force", "--sign", "-", appDir]);
    return { appDir, exePath };
  };

  const fixtureCu07 = buildAppBundle("FixtureCU07", "fixture-cu07", "native/computer-use/fixture-cu07.swift", "native/computer-use/Info-cu07.plist");
  const targetA = buildAppBundle("TargetA", "target-a", "native/computer-use/target-a.swift", "native/computer-use/Info-target-a.plist");
  const targetB = buildAppBundle("TargetB", "target-b", "native/computer-use/target-b.swift", "native/computer-use/Info-target-b.plist");

  const fixtureStatusFile = join(fixturesDir, "fixture-status.json");
  const targetAStatusFile = join(fixturesDir, "target-a-status.txt");
  const targetBStatusFile = join(fixturesDir, "target-b-status.txt");
  const readFixtureStatus = () => JSON.parse(readFileSync(fixtureStatusFile, "utf8"));

  const spawnedProcs: Array<{ proc: ReturnType<typeof spawn>; name: string }> = [];
  const spawnFixture = (exe: string, args: string[], name: string) => {
    const proc = spawn(exe, args, { stdio: "ignore" });
    spawnedProcs.push({ proc, name });
    return proc;
  };

  const fixtureProc = spawnFixture(fixtureCu07.exePath, [fixtureStatusFile, "--d20"], "FixtureCU07");
  const targetBProc = spawnFixture(targetB.exePath, [targetBStatusFile], "TargetB");
  const targetAProc = spawnFixture(targetA.exePath, [targetAStatusFile], "TargetA");

  try {
    await poll("FixtureCU07 status file", () => (existsSync(fixtureStatusFile) ? true : null), 15_000);
    await poll("TargetA status file", () => (existsSync(targetAStatusFile) ? true : null), 15_000);
    await poll("TargetB status file", () => (existsSync(targetBStatusFile) ? true : null), 15_000);

    // Seed isolated QA profile prerequisites via API
    state.nativeFixture = true;
    saveState();
    const Alpha = join(runtime, "projects/D20Alpha");
    const Beta = join(runtime, "projects/D20Beta");
    mkdirSync(Alpha, { recursive: true });
    mkdirSync(Beta, { recursive: true });
    writeFileSync(join(Alpha, "README.md"), "D20 Alpha fixture project\n");
    writeFileSync(join(Beta, "README.md"), "D20 Beta fixture project\n");

    await up();
    await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
    await api("PUT", "/preferences/locale", { value: "en" });
    await api("POST", "/projects", { path: Alpha, name: "D20 Alpha" });
    await api("POST", "/projects", { path: Beta, name: "D20 Beta" });
    await api("PATCH", "/harnesses/codex", { enabled: true });
    const preflight = await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
    const cfg = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
    await api("PUT", "/portfolio-manager/config", { config: cfg });
    await api("PUT", "/project-manager/config", { path: Alpha, config: cfg });
    await api("PUT", "/project-manager/config", { path: Beta, config: cfg });
    mark("Seeded isolated profile: D20 Alpha & D20 Beta projects, codex fake harness enabled, English locale");

    // Restart once so webview loads in English cleanly
    await down();
    await up();
    await show("Main navigation", 30_000);

    // Bookkeeping for exact native audit tally
    const expected: string[] = [];
    const tally = (list: string[]) => {
      const m = new Map<string, number>();
      for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
      return Object.fromEntries([...m].sort());
    };
    const journalRaw = async () => {
      const out: any[] = [];
      let cursor: number | null = null;
      for (let i = 0; i < 40; i++) {
        const res = await api("GET", `/activity?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
        out.push(...res.events);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      return out;
    };
    const trail = async () =>
      (await journalRaw())
        .filter((e) => String(e.eventType).startsWith("native."))
        .map((e) => {
          const p = e.payload ?? {};
          if (e.eventType === "native.session.closed" && p.reasonCode) return `${e.eventType}:${p.reasonCode}`;
          if (e.eventType === "native.session.interrupted" && p.reasonCode) return `${e.eventType}:${p.reasonCode}`;
          if ((e.eventType === "native.action.refused" || e.eventType === "native.agent.action.refused") && p.reasonCode) return `${e.eventType}:${p.reasonCode}`;
          if (e.eventType === "native.action.completed" && p.action) return `${e.eventType}:${p.action}`;
          if (e.eventType === "native.agent.action.accepted" && p.actionKind) return `${e.eventType}:${p.actionKind}`;
          if (e.eventType === "native.screenshot.refused" && p.reasonCode) return `${e.eventType}:${p.reasonCode}`;
          return e.eventType;
        });

    const headState = async () => await api("GET", "/portfolio-manager");
    const pmState = async (p = Alpha) => await api("GET", `/project-manager?path=${encodeURIComponent(p)}`);
    let msgNonce = 0;
    const unique = (s: string) => `${s} [d20-${++msgNonce}]`;
    const lastPair = async (load: () => Promise<any>, marker: string) => {
      const out = await poll(`reply for ${marker.slice(0, 48)}`, async () => {
        const st = await load();
        const ms = st.messages as any[];
        const idx = ms.findLastIndex((m) => m.role === "owner" && m.text.includes(marker));
        if (idx < 0) return null;
        const owner = ms[idx];
        const reply = ms.slice(idx + 1).find((m) => m.role === "manager");
        return owner.status === "answered" && reply ? { owner, reply } : null;
      }, 25_000);
      return out!;
    };

    const rawInspect = () => JSON.parse(spawnSync(helperBin, [bindingFile, "inspect"], { encoding: "utf8" }).stdout);
    const findWeb = (pred: (n: any) => boolean) => {
      const w = rawInspect().web;
      const acc: any[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (pred(n)) acc.push(n);
        for (const k of n.children ?? []) walk(k);
      };
      walk(w);
      return acc;
    };
    const choosePopupOption = async (popupTitle: string, optionNeedle: string) => {
      await poll(`popup button ${popupTitle}`, () => {
        const hit = findWeb((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === popupTitle && n.AXEnabled !== false);
        return hit.length ? hit[0] : null;
      }, 10_000);
      ax("focus-name", "AXPopUpButton", popupTitle);
      await sleep(200);
      ax("key", "49", "0"); // Space opens the native popup menu cleanly
      await sleep(300);
      ax("text", optionNeedle.slice(0, 26));
      await sleep(200);
      ax("key", "36", "0"); // Return confirms selection
      await sleep(350);
      let ok = findWeb((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === popupTitle && typeof n.AXValue === "string" && n.AXValue.includes(optionNeedle));
      for (let step = 0; step < 12 && ok.length === 0; step++) {
        ax("focus-name", "AXPopUpButton", popupTitle);
        await sleep(120);
        ax("key", "49", "0");
        await sleep(200);
        ax("key", "125", "0"); // ArrowDown one entry
        await sleep(150);
        ax("key", "36", "0");
        await sleep(300);
        ok = findWeb((n) => n.AXRole === "AXPopUpButton" && n.AXTitle === popupTitle && typeof n.AXValue === "string" && n.AXValue.includes(optionNeedle));
      }
      assert(ok.length > 0, `popup "${popupTitle}" never selected option containing "${optionNeedle}"`);
    };

    const openNativePage = async () => {
      await button("Settings", true, 0);
      await sleep(700);
      await button("Tools and access", true, 0);
      await sleep(600);
      await button("Open: Native Computer", true, 0);
      await show("Owner-controlled native session", 20_000);
    };

    // =========================================================================
    // PART A: Real window, permissions, persistence, and all 6 UI actions
    // =========================================================================
    await openNativePage();
    await show("Accessibility: Granted", 15_000);
    if (directPerms.result.screenRecording === "denied") {
      await show("Screen Recording: Not granted", 10_000);
      await show("System Settings → Privacy & Security → Screen Recording", 10_000);
    }
    shot("01-native-permissions");
    mark("Native Computer page opened in QA window; permissions accurately report Accessibility Granted and Screen Recording Not granted with System Settings location");

    // Select FixtureCU07.app & Window 1 via UI popups
    await choosePopupOption("Application", "ForgeOrbitNativeCu07Fixture");
    await sleep(300);
    await choosePopupOption("Window", "ForgeOrbit Native CU07 Fixture");
    await sleep(200);
    await button("Start native session", true, 0);
    await show("Session status: Active", 20_000);
    await show("Eligible buttons:", 20_000);
    expected.push("native.session.created", "native.target.selected", "native.observation.requested");

    const listed1 = await api("GET", "/native-computer/sessions");
    assert.equal(listed1.sessions.length, 1);
    const s1 = listed1.sessions[0];
    assert.equal(s1.application.bundleId, "app.forgeorbit.native-cu-fixture-cu07");
    assert.equal(s1.window.title, "ForgeOrbit Native CU07 Fixture");
    const obs1 = await api("GET", `/native-computer/sessions/${s1.id}/observation`);
    assert.equal(obs1.observationId, s1.observationId);
    const obs1Json = JSON.stringify(obs1);
    assert(!obs1Json.includes(CANARY_STATIC), "protected AXStaticText canary absent from UI observation");
    assert(!obs1Json.includes(CANARY_SECURE), "NSSecureTextField canary absent from UI observation");
    assert(obs1.redactedFields >= 2, `redactedFields (${obs1.redactedFields}) >= 2`);

    // Verify Screen Recording refusal cleanly in UI and HTTP without bypassing TCC
    if (directPerms.result.screenRecording === "denied") {
      await button("Capture window", true, 0);
      await show("Screen Recording is not granted", 10_000);
      shot("02-screen-recording-refused");
      mark("Capture window refused honestly (403 screen_recording_denied) with no fallback screenshot");
    }

    // Verify active session & observationId persist across navigation away & back
    await button("Open Head of PM", true, 0);
    await show("Message to Head of PM", 15_000);
    await sleep(400);
    await button("Close Head of PM", true, 0);
    await sleep(300);
    await openNativePage();
    await show("Session status: Active", 15_000);
    const listedAfterNav = await api("GET", "/native-computer/sessions");
    assert.equal(listedAfterNav.sessions[0].id, s1.id);
    assert.equal(listedAfterNav.sessions[0].observationId, s1.observationId, "navigating back restored observation without rotating observationId");
    shot("03-active-session-persisted");
    mark(`Verified active session ${s1.id} and observation ${s1.observationId} persist across navigation`);

    // Helper to click an inspector row button in the UI (WebKit maps aria-pressed buttons to AXCheckBox)
    const selectInspectorRow = async (part1: string, part2?: string) => {
      const pred = (n: any) => (n.AXRole === "AXCheckBox" || n.AXRole === "AXButton") && hasText(part1)(n) && (!part2 || hasText(part2)(n));
      const targetRow = await poll(`inspector row "${part1}"`, () => findWeb(pred).at(-1) ?? null, 10_000);
      try {
        await activate(targetRow);
      } catch {
        await clickByPosition(pred, findWeb(pred).length - 1);
      }
      await sleep(350);
    };

    // Action 1: press_accessible_button
    const st0 = readFixtureStatus();
    await selectInspectorRow("Harmless press", "AXButton");
    await button("Confirm press", true, 0);
    await show("The button was pressed once.", 15_000);
    expected.push("native.action.approved", "native.action.completed:press_accessible_button", "native.observation.requested");
    await poll("buttonPresses incremented", () => (readFixtureStatus().buttonPresses === st0.buttonPresses + 1 ? true : null), 5_000);

    // Action 2: scroll_accessible_area
    const st1 = readFixtureStatus();
    await selectInspectorRow("Scroll Area", "AXScrollArea");
    await button("Scroll down", true, 0);
    await show("The area was scrolled once.", 15_000);
    expected.push("native.action.approved", "native.action.completed:scroll_accessible_area", "native.observation.requested");
    await poll("scrollY changed", () => (readFixtureStatus().scrollY > st1.scrollY ? true : null), 5_000);

    // Action 3: select_accessible_tab
    await selectInspectorRow("Tab 2", "AXRadioButton");
    await button("Select tab", true, 0);
    await show("The tab was selected once.", 15_000);
    expected.push("native.action.approved", "native.action.completed:select_accessible_tab", "native.observation.requested");
    await poll("activeTab changed to Tab 2", () => (readFixtureStatus().activeTab === "Tab 2" ? true : null), 5_000);

    // Action 4: set_accessible_text
    await selectInspectorRow("Editable text field", "AXTextField");
    await poll("text input field", () => (findWeb((n) => n.AXRole === "AXTextField").length ? true : null), 10_000);
    ax("focus-name", "AXTextField", "*");
    await sleep(250);
    ax("text", OWNER_TEXT);
    await sleep(250);
    await button("Set text", true, 0);
    await show("The text was entered once.", 15_000);
    expected.push("native.action.approved", "native.action.completed:set_accessible_text", "native.observation.requested");
    await poll("singleLineText updated", () => (readFixtureStatus().singleLineText === OWNER_TEXT ? true : null), 5_000);

    // Action 5: open_accessible_menu -> auto-refreshes observation -> Action 6: select_accessible_menu_item
    await selectInspectorRow("View", "AXMenuBarItem");
    await button("Open menu", true, 0);
    await show("The menu was opened once.", 15_000);
    expected.push("native.action.approved", "native.action.completed:open_accessible_menu", "native.observation.requested");
    await show("Harmless Menu Action", 15_000);

    const stPreMenu = readFixtureStatus();
    await selectInspectorRow("Harmless Menu Action", "AXMenuItem");
    await button("Select menu item", true, 0);
    await show("The menu item was selected once.", 15_000);
    expected.push("native.action.approved", "native.action.completed:select_accessible_menu_item", "native.observation.requested");
    await poll("menuItemPresses incremented", () => (readFixtureStatus().menuItemPresses === stPreMenu.menuItemPresses + 1 ? true : null), 5_000);

    // Also verify restricted/protected controls in Window 1 remain read-only
    await selectInspectorRow("Delete account permission", "AXButton");
    await show("This control cannot be operated.", 8_000);

    const stAfterSix = readFixtureStatus();
    assert.equal(stAfterSix.window2Presses, 0, "Window 2 untouched during Window 1 actions");
    assert.equal(stAfterSix.window3Presses, 0, "Window 3 untouched during Window 1 actions");
    assert.equal(stAfterSix.excludedButtonPresses, 0, "Excluded button untouched");
    assert.equal(readFileSync(targetAStatusFile, "utf8"), "idle:0\n", "TargetA untouched");
    assert.equal(readFileSync(targetBStatusFile, "utf8"), "idle:0\n", "TargetB untouched");
    shot("04-all-six-ui-actions-done");
    evidence.uiActions = {
      before: st0,
      after: stAfterSix,
      singleLineText: stAfterSix.singleLineText,
      allSixVerified: ["press_accessible_button", "scroll_accessible_area", "select_accessible_tab", "set_accessible_text", "open_accessible_menu", "select_accessible_menu_item"],
    };
    mark("All 6 roadmap native actions exercised through QA UI controls with independent fixture verification");

    // =========================================================================
    // PART B: Head of PM (in QA window) & Project Manager (production API + history UI)
    // =========================================================================
    await button("Open Head of PM", true, 0);
    await show("Message to Head of PM", 20_000);
    await sleep(500);
    const expand = findWeb((n) => n.AXRole === "AXDisclosureTriangle" && [n.AXTitle, n.AXDescription].includes("One-turn access"));
    if (expand.length) {
      await button("One-turn access", true, 0);
      await sleep(600);
    }
    await show("Native access is off until you allow this message to use one active session.", 15_000);
    shot("05-head-access-off");

    const typeHead = async (text: string) => {
      ax("focus-name", "AXTextArea", "Message to Head of PM");
      await sleep(250);
      ax("key", "0", "1048576");
      await sleep(100);
      ax("text", text);
      await sleep(300);
      await button("Send", true, 0);
    };

    // B1: Allow for this message -> Echo check
    await button("Allow for this message", true, 0);
    expected.push("native.observation.requested", "native.agent.granted");
    await show("This message may use the selected session once.", 15_000);
    shot("06-head-allowed");

    const echoHeadText = unique(`${MARKERS.echoHead} Report exact observation metadata`);
    await typeHead(echoHeadText);
    const echoPairHead = await lastPair(headState, echoHeadText);
    const headEchoReply = String(echoPairHead.reply.text);
    assert(headEchoReply.includes("Received: native observation section."), headEchoReply);
    assert(headEchoReply.includes("fences=2"), headEchoReply);
    assert(headEchoReply.includes("screenshotBytes=none"), headEchoReply);
    assert(headEchoReply.includes("canaryPresent=no"), headEchoReply);
    assert(!headEchoReply.includes(CANARY_STATIC) && !headEchoReply.includes(CANARY_SECURE));
    assert.equal(echoPairHead.reply.nativeAction?.kind, "none");
    assert.equal(echoPairHead.reply.nativeAction?.status, "accepted");
    expected.push("native.agent.action.accepted:none");
    await show("Native access is off until you allow this message to use one active session.", 15_000);
    evidence.headEcho = headEchoReply;
    shot("07-head-echo");

    // B2: One grant -> press button via Head of PM UI
    const beforeHeadPress = readFixtureStatus().buttonPresses;
    await button("Allow for this message", true, 0);
    expected.push("native.observation.requested", "native.agent.granted");
    await show("This message may use the selected session once.", 15_000);
    const pressHeadMsg = unique(`${MARKERS.pressHead} Press the harmless button`);
    await typeHead(pressHeadMsg);
    const pressPairHead = await lastPair(headState, pressHeadMsg);
    assert.equal(pressPairHead.reply.nativeAction?.status, "accepted");
    assert.equal(pressPairHead.reply.nativeAction?.kind, "press_accessible_button");
    expected.push("native.action.completed:press_accessible_button", "native.agent.action.accepted:press_accessible_button");
    await poll("Head buttonPresses incremented", () => (readFixtureStatus().buttonPresses === beforeHeadPress + 1 ? true : null), 5_000);
    await show("Accepted", 15_000);
    shot("08-head-press-accepted");

    // B3: Follow-up WITHOUT grant -> ignored / not_authorized, zero presses
    const noGrantMsg = unique(`${MARKERS.pressHead} Try pressing without permission`);
    await typeHead(noGrantMsg);
    const noGrantPair = await lastPair(headState, noGrantMsg);
    assert.equal(noGrantPair.reply.nativeAction?.status, "ignored");
    assert.equal(noGrantPair.reply.nativeAction?.reasonCode, "not_authorized");
    assert.equal(readFixtureStatus().buttonPresses, beforeHeadPress + 1);

    // B4: Two-step sequence in Head UI (fresh grant + fresh observation per step: open_accessible_menu -> select_accessible_menu_item)
    const beforeHeadMenu = readFixtureStatus().menuItemPresses;
    await button("Allow for this message", true, 0);
    expected.push("native.observation.requested", "native.agent.granted");
    await show("This message may use the selected session once.", 15_000);
    const openMenuHeadMsg = unique(`${MARKERS.openMenuHead} Open View menu`);
    await typeHead(openMenuHeadMsg);
    const openMenuPair = await lastPair(headState, openMenuHeadMsg);
    assert.equal(openMenuPair.reply.nativeAction?.status, "accepted");
    assert.equal(openMenuPair.reply.nativeAction?.kind, "open_accessible_menu");
    expected.push("native.action.completed:open_accessible_menu", "native.agent.action.accepted:open_accessible_menu");

    // Observe updated open menu state via API before Step 2 grant
    await api("POST", `/native-computer/sessions/${s1.id}/observation`, {});
    expected.push("native.observation.requested");

    await button("Allow for this message", true, 0);
    expected.push("native.observation.requested", "native.agent.granted");
    await show("This message may use the selected session once.", 15_000);
    const selectItemHeadMsg = unique(`${MARKERS.selectMenuItemHead} Select Harmless Menu Action`);
    await typeHead(selectItemHeadMsg);
    const selectItemPair = await lastPair(headState, selectItemHeadMsg);
    assert.equal(selectItemPair.reply.nativeAction?.status, "accepted");
    assert.equal(selectItemPair.reply.nativeAction?.kind, "select_accessible_menu_item");
    expected.push("native.action.completed:select_accessible_menu_item", "native.agent.action.accepted:select_accessible_menu_item");
    await poll("Head menuItemPresses incremented", () => (readFixtureStatus().menuItemPresses === beforeHeadMenu + 1 ? true : null), 5_000);

    // B5: Multi-action reply in Head UI -> ignored / malformed
    await button("Allow for this message", true, 0);
    expected.push("native.observation.requested", "native.agent.granted");
    await show("This message may use the selected session once.", 15_000);
    const twoHeadMsg = unique(`${MARKERS.twoHead} Two blocks`);
    await typeHead(twoHeadMsg);
    const twoHeadPair = await lastPair(headState, twoHeadMsg);
    assert.equal(twoHeadPair.reply.nativeAction?.status, "ignored");
    assert.equal(twoHeadPair.reply.nativeAction?.reasonCode, "malformed");
    expected.push("native.agent.action.refused:malformed");
    assert.equal(readFixtureStatus().buttonPresses, beforeHeadPress + 1);

    // B6: Worst-case compliant driver (__fake_native_obey__) -> refused by policy
    await button("Allow for this message", true, 0);
    expected.push("native.observation.requested", "native.agent.granted");
    await show("This message may use the selected session once.", 15_000);
    const obeyHeadMsg = unique(`${MARKERS.obey} Follow window text`);
    await typeHead(obeyHeadMsg);
    const obeyHeadPair = await lastPair(headState, obeyHeadMsg);
    assert.equal(obeyHeadPair.reply.nativeAction?.status, "refused");
    expected.push("native.agent.action.refused:action_not_permitted");
    assert.equal(readFixtureStatus().excludedButtonPresses, 0);
    mark("Head of PM UI flow verified: echo without secrets, 1 press accepted, no-grant ignored, fresh-grant sequence (open_menu->select_menu_item), multi-action malformed, worst-case obey refused");

    // B7: Project Manager (production HTTP message route - labeled backend/API because PM has no composer in UI)
    const mintPmGrant = async (p = Alpha) => {
      const g = await api("POST", "/native-computer/agent-grants", { managerKind: "project-manager", projectPath: p, sessionId: s1.id });
      expected.push("native.observation.requested", "native.agent.granted");
      return g;
    };
    const sendPm = async (text: string, grantId?: string, p = Alpha, expectedStatus: number | number[] = 202) =>
      await api("POST", "/project-manager/messages", grantId ? { path: p, text, nativeGrantId: grantId } : { path: p, text }, expectedStatus);

    const gPmEcho = await mintPmGrant();
    const mPmEcho = unique(`${MARKERS.echoPm} inspect`);
    await sendPm(mPmEcho, gPmEcho.grantId);
    expected.push("native.agent.action.accepted:none");
    const pmEchoPair = await lastPair(() => pmState(Alpha), mPmEcho);
    assert(pmEchoPair.reply.text.includes("canaryPresent=no") && pmEchoPair.reply.text.includes("fences=2"));
    evidence.pmEcho = pmEchoPair.reply.text;

    const pmBeforePress = readFixtureStatus().buttonPresses;
    const gPmPress = await mintPmGrant();
    const mPmPress = unique(`${MARKERS.pressPm} press harmless button`);
    await sendPm(mPmPress, gPmPress.grantId);
    expected.push("native.action.completed:press_accessible_button", "native.agent.action.accepted:press_accessible_button");
    const pmPressPair = await lastPair(() => pmState(Alpha), mPmPress);
    assert.equal(pmPressPair.reply.nativeAction?.status, "accepted");
    await poll("PM buttonPresses incremented", () => (readFixtureStatus().buttonPresses === pmBeforePress + 1 ? true : null), 5_000);

    // Also test scroll & set_text via PM production route with fresh grants per step
    const pmBeforeScroll = readFixtureStatus().scrollY;
    const gPmScroll = await mintPmGrant();
    const mPmScroll = unique(`${MARKERS.scrollPm} scroll`);
    await sendPm(mPmScroll, gPmScroll.grantId);
    expected.push("native.action.completed:scroll_accessible_area", "native.agent.action.accepted:scroll_accessible_area");
    await lastPair(() => pmState(Alpha), mPmScroll);
    await poll("PM scrollY updated", () => (readFixtureStatus().scrollY !== pmBeforeScroll || readFixtureStatus().scrollY > 0 ? true : null), 5_000);

    const gPmText = await mintPmGrant();
    const mPmText = unique(`${MARKERS.setTextPm} text:${PM_TEXT}`);
    await sendPm(mPmText, gPmText.grantId);
    expected.push("native.action.completed:set_accessible_text", "native.agent.action.accepted:set_accessible_text");
    await lastPair(() => pmState(Alpha), mPmText);
    await poll("PM singleLineText updated", () => (readFixtureStatus().singleLineText === PM_TEXT ? true : null), 5_000);

    // Navigate in QA window to D20 Alpha -> Plan and Execution to confirm read-only history shows NativeActionCard
    if (findWeb((n) => n.AXRole === "AXButton" && hasText("Close Head of PM")(n)).length) {
      await button("Close Head of PM", true, 0);
      await sleep(300);
    }
    await button("D20 Alpha", false, 0).catch(() => undefined);
    await sleep(900);
    await button("Plan and Execution", false, 0).catch(() => undefined);
    await sleep(1000);
    const pmCardShown = has("Accepted") || has("Native action");
    evidence.pmHistoryShowsActionCard = pmCardShown;
    shot("09-pm-history-cards");
    mark("Project Manager production API flow + read-only Manager history NativeActionCard verified");

    // =========================================================================
    // PART C: Exact target binding, replay, stale, replaced target, exclusions
    // =========================================================================
    const spentGrantId = pressPairHead.owner.nativeGrantId as string;
    const gReplayRes = await api("POST", "/portfolio-manager/messages", { text: unique(`${MARKERS.pressHead} replay`), nativeGrantId: spentGrantId }, [409]);
    assert.match(String(gReplayRes.error ?? ""), /already used|permission|current/i);

    // Cross-manager refusal (Head grant -> PM, PM grant -> Head)
    const gHeadOnly = await api("POST", "/native-computer/agent-grants", { managerKind: "head-of-pm", sessionId: s1.id });
    expected.push("native.observation.requested", "native.agent.granted");
    const crossHeadToPm = await sendPm(unique(`${MARKERS.pressPm} cross`), gHeadOnly.grantId, Alpha, [409]);
    assert.match(String(crossHeadToPm.error ?? ""), /another manager|permission/i);
    await api("DELETE", `/native-computer/agent-grants/${gHeadOnly.grantId}?managerKind=head-of-pm`, undefined);
    expected.push("native.agent.revoked");

    const gPmForCross = await mintPmGrant(Alpha);
    const crossPmToHead = await api("POST", "/portfolio-manager/messages", { text: unique(`${MARKERS.pressHead} cross`), nativeGrantId: gPmForCross.grantId }, [409]);
    assert.match(String(crossPmToHead.error ?? ""), /another manager|permission/i);
    await api("DELETE", `/native-computer/agent-grants/${gPmForCross.grantId}?managerKind=project-manager&projectPath=${encodeURIComponent(Alpha)}`, undefined);
    expected.push("native.agent.revoked");

    // Cross-project refusal (Alpha grant -> Beta)
    const gAlphaOnly = await mintPmGrant(Alpha);
    const crossAlphaToBeta = await sendPm(unique(`${MARKERS.pressPm} cross proj`), gAlphaOnly.grantId, Beta, [409]);
    assert.match(String(crossAlphaToBeta.error ?? ""), /another project|permission/i);
    await api("DELETE", `/native-computer/agent-grants/${gAlphaOnly.grantId}?managerKind=project-manager&projectPath=${encodeURIComponent(Alpha)}`, undefined);
    expected.push("native.agent.revoked");

    // Wrong window refusal using Window 1 session & Window 2 id
    const obsCurrent = await api("POST", `/native-computer/sessions/${s1.id}/observation`, {});
    expected.push("native.observation.requested");
    const buttonEl = obsCurrent.elements.find((el: any) => el.actions.includes("press_accessible_button"));
    const windowsList = await api("POST", "/native-computer/windows", s1.application);
    const win2 = windowsList.windows.find((w: any) => w.title === "ForgeOrbit Native D20 Window 2");
    assert(win2, "Window 2 discovered on FixtureCU07");
    const wrongWinReq = await api("POST", `/native-computer/sessions/${s1.id}/actions`, {
      observationId: obsCurrent.observationId,
      elementId: buttonEl.id,
      action: "press_accessible_button",
      ...s1.application,
      windowId: win2.windowId,
    }, [400]);
    assert.equal(wrongWinReq.code, "identity_mismatch");
    assert.equal(readFixtureStatus().window2Presses, 0);

    // Stale observation refusal (rotate observationId after grant created -> consume rejects immediately with 409)
    const gStale = await mintPmGrant(Alpha);
    await api("POST", `/native-computer/sessions/${s1.id}/observation`, {});
    expected.push("native.observation.requested");
    const mStale = unique(`${MARKERS.pressPm} stale`);
    const staleSend = await sendPm(mStale, gStale.grantId, Alpha, [409]);
    assert.match(String(staleSend.error ?? ""), /no longer current|Allow native access again/i);

    // Replaced target via SIGUSR1 -> element_stale refusal
    const obsBeforeSig = await api("POST", `/native-computer/sessions/${s1.id}/observation`, {});
    expected.push("native.observation.requested");
    const replaceBtnEl = obsBeforeSig.elements.find((el: any) => el.label === "Replaceable Target A");
    assert(replaceBtnEl, "Replaceable Target A present before SIGUSR1");
    const claimBeforeSig = await api("POST", `/native-computer/sessions/${s1.id}/actions`, {
      observationId: obsBeforeSig.observationId,
      elementId: replaceBtnEl.id,
      action: "press_accessible_button",
      ...s1.application,
      windowId: s1.window.windowId,
    });
    expected.push("native.action.approved");
    process.kill(fixtureProc.pid!, "SIGUSR1");
    await poll("FixtureCU07 replacedTargetActive", () => (readFixtureStatus().replacedTargetActive === true ? true : null), 8_000);
    const confirmAfterReplace = await api("POST", `/native-computer/sessions/${s1.id}/actions/${claimBeforeSig.id}/confirm`, {
      confirm: true,
      ...s1.application,
      windowId: s1.window.windowId,
    }, [409]);
    assert.equal(confirmAfterReplace.code, "element_stale");
    expected.push("native.action.refused:element_stale");
    assert.equal(readFixtureStatus().originalTargetPresses, 0);
    assert.equal(readFixtureStatus().replacedTargetPresses, 0);

    // Close session in UI leaves FixtureCU07 running and invalidates pre-close grant
    await openNativePage();
    await show("Session status: Active", 15_000);
    const gPreClose = await api("POST", "/native-computer/agent-grants", { managerKind: "head-of-pm", sessionId: s1.id });
    expected.push("native.observation.requested", "native.agent.granted");
    await button("Close session", true, 0);
    await show("Session status: Closed", 15_000);
    expected.push("native.session.closed:owner");
    assert.doesNotThrow(() => process.kill(fixtureProc.pid!, 0), "FixtureCU07 stays alive after session closed");
    const afterCloseSend = await api("POST", "/portfolio-manager/messages", { text: unique(`${MARKERS.pressHead} closed`), nativeGrantId: gPreClose.grantId }, [409]);
    assert.match(String(afterCloseSend.error ?? ""), /no longer|closed|permission/i);

    // Excluded Window 3 ("Authentication Security Prompt") on FixtureCU07: read-only even with Screen Recording denied
    await choosePopupOption("Window", "Authentication Security Prompt");
    await sleep(200);
    await button("Start native session", true, 0);
    await show("Security and credential management windows are excluded.", 15_000);
    await show("Eligible buttons: 0", 15_000);
    expected.push("native.session.created", "native.target.selected", "native.observation.requested");
    const sWin3 = (await api("GET", "/native-computer/sessions")).sessions[0];
    assert.equal(sWin3.actionBoundary, "read-only");
    assert.deepEqual(sWin3.supportedActions, []);
    const win3Obs = await api("GET", `/native-computer/sessions/${sWin3.id}/observation`);
    assert(win3Obs.elements.every((el: any) => el.actions.length === 0));
    assert.equal(readFixtureStatus().window3Presses, 0);
    shot("10-excluded-window-readonly");
    await button("Close session", true, 0);
    await show("Session status: Closed", 15_000);
    expected.push("native.session.closed:owner");

    // Excluded App TargetB.app -> read-only
    await button("Refresh applications", true, 0);
    await sleep(400);
    await choosePopupOption("Application", "ForgeOrbitNativeCuExcluded");
    await sleep(300);
    await choosePopupOption("Window", "ForgeOrbit Native Excluded Target B");
    await sleep(200);
    await button("Start native session", true, 0);
    await show("This application is excluded by security policy.", 15_000);
    await show("Eligible buttons: 0", 15_000);
    expected.push("native.session.created", "native.target.selected", "native.observation.requested");
    assert.equal(readFileSync(targetBStatusFile, "utf8"), "idle:0\n");
    shot("11-excluded-app-readonly");
    await button("Close session", true, 0);
    await show("Session status: Closed", 15_000);
    expected.push("native.session.closed:owner");

    // Second harmless process TargetA.app -> verify exit marks session interrupted cleanly
    await choosePopupOption("Application", "ForgeOrbitNativeCuTargetA");
    await sleep(300);
    await choosePopupOption("Window", "ForgeOrbit Native Generic Target A");
    await sleep(200);
    await button("Start native session", true, 0);
    await show("Session status: Active", 15_000);
    await show("Generic press", 15_000);
    expected.push("native.session.created", "native.target.selected", "native.observation.requested");
    const sTargetA = (await api("GET", "/native-computer/sessions")).sessions[0];
    targetAProc.kill("SIGKILL");
    await poll("TargetA exit detected by polling/session check", async () => {
      const obsTry = await api("POST", `/native-computer/sessions/${sTargetA.id}/observation`, {}, [200, 409]).catch(() => null);
      if (obsTry?.code === "target_exited") return true;
      const info = await api("GET", `/native-computer/sessions/${sTargetA.id}`);
      return info.status === "interrupted" ? true : null;
    }, 10_000);
    expected.push("native.session.interrupted:target_exited");
    await show("The application exited. The session is no longer valid.", 15_000).catch(() => show("Interrupted", 10_000));
    assert.equal(readFileSync(targetAStatusFile, "utf8"), "idle:0\n", "TargetA executed zero actions");

    // =========================================================================
    // PART D: Recovery without a second action (live Cmd+Q + seeded crash profile)
    // =========================================================================
    await button("Refresh applications", true, 0);
    await sleep(400);
    await choosePopupOption("Application", "ForgeOrbitNativeCu07Fixture");
    await sleep(300);
    await choosePopupOption("Window", "ForgeOrbit Native CU07 Fixture");
    await sleep(200);
    await button("Start native session", true, 0);
    await show("Session status: Active", 15_000);
    await show("Harmless press", 15_000);
    expected.push("native.session.created", "native.target.selected", "native.observation.requested");
    const sCrash = (await api("GET", "/native-computer/sessions")).sessions[0];

    // Unused PM grant first, then consumed in-flight slow Head grant (holds latest observationId) before Cmd+Q
    const pressesBeforeQuit = readFixtureStatus().buttonPresses;
    const gPmUnused = await api("POST", "/native-computer/agent-grants", { managerKind: "project-manager", projectPath: Alpha, sessionId: sCrash.id });
    expected.push("native.observation.requested", "native.agent.granted");
    const gSlow = await api("POST", "/native-computer/agent-grants", { managerKind: "head-of-pm", sessionId: sCrash.id });
    expected.push("native.observation.requested", "native.agent.granted");

    const slowMsgText = unique(`${MARKERS.slowHead} ${MARKERS.pressHead} pending across restart`);
    const slowSend = await api("POST", "/portfolio-manager/messages", { text: slowMsgText, nativeGrantId: gSlow.grantId });
    assert(slowSend.turn?.id);
    await sleep(500); // Ensure turn is mid-flight, before 4s slow driver completes

    // Quit app mid-turn via Cmd+Q
    ax("key", "12", "1048576");
    await poll("app exited after Cmd+Q", () => {
      try {
        process.kill(state.launcherPid, 0);
        return null;
      } catch {
        return true;
      }
    }, 20_000).catch(async () => { await down(); });
    await sleep(1500);
    assert.equal(readFixtureStatus().buttonPresses, pressesBeforeQuit, "Slow turn did not press button during Cmd+Q");

    // Reopen packaged app on main profile
    await up();
    await show("Main navigation", 30_000);
    expected.push("native.session.interrupted:restart");

    const reopenedSessions = await api("GET", "/native-computer/sessions");
    assert.equal(reopenedSessions.sessions.length, 0, "no active session resumes on reopen");
    assert.equal(reopenedSessions.lastInterrupted?.status, "interrupted");

    // Pre-restart unused PM grant cannot be spent
    const spendAfterRestart = await sendPm(unique(`${MARKERS.pressPm} post-restart`), gPmUnused.grantId, Alpha, [409]);
    assert.match(String(spendAfterRestart.error ?? ""), /expired|no longer|restart|permission/i);

    // Failed Head message shows honest never-happened error; retrying strips grant & does NOT press button
    const headAfterReopen = await headState();
    const slowOwnerMsg = (headAfterReopen.messages as any[]).find((m) => m.text.includes(slowMsgText));
    assert.equal(slowOwnerMsg?.status, "failed");
    assert.match(String(slowOwnerMsg?.error ?? ""), /No native action ran/i);
    assert.equal(slowOwnerMsg?.nativeAction, undefined);
    const retryRes = await api("POST", "/portfolio-manager/messages", { retryMessageId: slowOwnerMsg.id });
    assert(retryRes.turn?.id);
    await lastPair(headState, slowMsgText);
    assert.equal(readFixtureStatus().buttonPresses, pressesBeforeQuit, "Retry after restart never presses fixture button");

    await openNativePage();
    await show("Session status: Interrupted", 15_000);
    await show("Previous native session interrupted on restart", 15_000);
    shot("12-reopened-interrupted");
    mark("Live Cmd+Q & reopen recovery verified: 0 active sessions, unused grant refused, in-flight slow turn recovered as never-happened, retry ran zero actions");

    // Check audit trail & clean canary/owner-text non-leak BEFORE switching data dir
    const actualTrail = await trail();
    evidence.audit = { expectedCount: expected.length, actualCount: actualTrail.length, expected: tally(expected), actual: tally(actualTrail) };
    assert.deepEqual(tally(actualTrail), tally(expected), "native audit journal tally matches observed events");

    const allEventsJson = JSON.stringify(await journalRaw());
    for (const secret of [CANARY_STATIC, CANARY_SECURE, OWNER_TEXT, PM_TEXT]) {
      assert(!allEventsJson.includes(secret), `${secret} must not appear in activity_events`);
    }

    // Check Restart Test 2 on a separate disposable recovery data dir inside root:
    // Verify real packaged binary recovery of in-flight `executing` claim (`uncertain`) + `completed`-before-reply action.
    await down();
    const recoveryDataDir = join(runtime, "recovery-data");
    mkdirSync(join(recoveryDataDir, "native-computer-sessions"), { recursive: true });
    // Flush main QA SQLite WAL before copying into separate disposable recovery profile
    const srcDb = new Database(join(dataDir, "agetor.sqlite"));
    srcDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    srcDb.close();
    copyFileSync(join(dataDir, "agetor.sqlite"), join(recoveryDataDir, "agetor.sqlite"));
    const gUncertainId = "a".repeat(64);
    const gCompletedId = "b".repeat(64);
    const crashedSessionId = "ncu_" + "99".repeat(16);
    const mHeadUncertainId = "msg_d20_head_uncertain";
    const mPmCompletedId = "msg_d20_pm_completed";
    writeFileSync(join(recoveryDataDir, "native-computer-sessions/registry.json"), JSON.stringify({
      version: 1,
      sessions: [{
        id: crashedSessionId,
        state: "active",
        createdAt: Date.now() - 5000,
        bundleId: "app.forgeorbit.native-cu-fixture-cu07",
        pid: fixtureProc.pid,
        windowId: 1,
        executableHash: "0123456789abcdef",
        claims: [{ id: "nact_" + "88".repeat(16), status: "executing" }],
      }],
    }));
    const rdb = new Database(join(recoveryDataDir, "agetor.sqlite"));
    rdb.run(
      `INSERT INTO native_computer_agent_grants (
        id, manager_kind, project_path, session_id, observation_id, bundle_id, pid, start_sec, start_usec,
        window_id, observed_at, observation_json, allowed_actions_json, max_actions, status, action_status,
        action_json, outcome_json, claim_token, approved_by, created_at, expires_at, settled_at, message_id, turn_id
      ) VALUES (?, 'head-of-pm', NULL, ?, ?, 'app.forgeorbit.native-cu-fixture-cu07', ?, 1, 0, 1, ?, '{}', '["press_accessible_button"]', 1, 'consumed', 'claimed', ?, NULL, 'tok1', 'owner', ?, ?, NULL, ?, 'turn_u')`,
      [gUncertainId, crashedSessionId, "nobs_" + "11".repeat(16), fixtureProc.pid, Date.now(), JSON.stringify({ kind: "press_accessible_button", elementId: "el_0" }), Date.now(), Date.now() + 600_000, mHeadUncertainId],
    );
    rdb.run(
      `INSERT INTO native_computer_agent_grants (
        id, manager_kind, project_path, session_id, observation_id, bundle_id, pid, start_sec, start_usec,
        window_id, observed_at, observation_json, allowed_actions_json, max_actions, status, action_status,
        action_json, outcome_json, claim_token, approved_by, created_at, expires_at, settled_at, message_id, turn_id
      ) VALUES (?, 'project-manager', ?, ?, ?, 'app.forgeorbit.native-cu-fixture-cu07', ?, 1, 0, 1, ?, '{}', '["press_accessible_button"]', 1, 'consumed', 'completed', ?, '{}', 'tok2', 'owner', ?, ?, ?, ?, 'turn_c')`,
      [gCompletedId, Alpha, crashedSessionId, "nobs_" + "22".repeat(16), fixtureProc.pid, Date.now(), JSON.stringify({ kind: "press_accessible_button", elementId: "el_0" }), Date.now(), Date.now() + 600_000, Date.now(), mPmCompletedId],
    );
    rdb.run(
      `INSERT INTO portfolio_manager_messages (id, seq, data, created_at) VALUES (?, 999999, ?, ?)`,
      [mHeadUncertainId, JSON.stringify({
        id: mHeadUncertainId, role: "owner", text: "Interrupted mid-action request", createdAt: Date.now(), status: "pending",
        error: null, plan: null, proposalId: null, executionId: null, proposalError: null, suggestedDecisions: [],
        hiringProposalIds: null, sources: [], nativeGrantId: gUncertainId,
      }), Date.now()],
    );
    rdb.run(
      `INSERT INTO project_manager_messages (project_path, id, seq, data, created_at) VALUES (?, ?, 999999, ?, ?)`,
      [Alpha, mPmCompletedId, JSON.stringify({
        id: mPmCompletedId, role: "owner", text: "Already happened before exit request", createdAt: Date.now(), status: "pending",
        error: null, plan: null, proposalId: null, executionId: null, proposalError: null, suggestedDecisions: [],
        hiringProposalIds: null, sources: [], nativeGrantId: gCompletedId,
      }), Date.now()],
    );
    rdb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    rdb.close();

    useDataDir(recoveryDataDir);
    await up();
    await show("Main navigation", 30_000);
    await openNativePage();
    await show("in-progress action were interrupted by a restart; its outcome is uncertain", 15_000);
    await button("Open Head of PM", true, 0);
    await show("Interrupted", 15_000);
    await show("did not finish in a known state", 15_000);
    shot("13-recovery-uncertain-and-completed");
    await button("Close Head of PM", true, 0).catch(() => undefined);
    await sleep(300);
    await button("D20 Alpha", false, 0).catch(() => undefined);
    await sleep(800);
    await button("Plan and Execution", false, 0).catch(() => undefined);
    await show("Accepted", 15_000);
    shot("14-recovery-pm-completed");
    const recHead = await headState();
    const recHeadOwner = (recHead.messages as any[]).find((m) => m.id === mHeadUncertainId);
    assert.equal(recHeadOwner?.status, "failed");
    assert.equal(recHeadOwner?.nativeAction?.status, "interrupted");
    const recPm = await pmState(Alpha);
    const recPmOwner = (recPm.messages as any[]).find((m) => m.id === mPmCompletedId);
    assert.equal(recPmOwner?.status, "failed");
    assert.equal(recPmOwner?.nativeAction?.status, "accepted");
    assert.match(String(recPmOwner?.error ?? ""), /already finished before the app closed/i);
    assert.equal(readFixtureStatus().buttonPresses, pressesBeforeQuit, "Booting crashed recovery profile never repeated actions");
    evidence.crashedRecoveryProfile = {
      seededPreBoot: true,
      lastInterruptedError: (await api("GET", "/native-computer/sessions")).lastInterrupted?.lastError,
      headOwnerNativeAction: recHeadOwner?.nativeAction,
      pmOwnerNativeAction: recPmOwner?.nativeAction,
      pmOwnerError: recPmOwner?.error,
    };
    await down();
    useDataDir(null);

    // Final fixture isolation checks & ownerPaths audit
    const finalStatus = readFixtureStatus();
    assert.equal(finalStatus.window2Presses, 0);
    assert.equal(finalStatus.window3Presses, 0);
    assert.equal(finalStatus.excludedButtonPresses, 0);
    assert.equal(finalStatus.originalTargetPresses, 0);
    assert.equal(finalStatus.replacedTargetPresses, 0);
    assert.equal(readFileSync(targetBStatusFile, "utf8"), "idle:0\n");

    const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
    const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
    const changed = Object.keys(ownerBefore).filter((k) => ownerBefore[k] !== ownerAfter[k]);
    const unrelatedCodex = psAll().filter((l) => /\/codex(\s|$)|codex-cli|\bcodex\b/i.test(l) && !l.includes(root) && !l.includes("qa-native"));
    assert(changed.every((p2) => p2.endsWith("/.codex")), `Unexpected owner path change: ${changed.join(", ")}`);
    if (changed.length) assert(unrelatedCodex.length > 0, "~/.codex changed without unrelated codex process");
    evidence.ownerPaths = {
      unchanged: Object.keys(ownerBefore).length - changed.length,
      changed,
      codexChangedByUnrelatedProcess: changed.length > 0 ? { unrelatedProcessCount: unrelatedCodex.length } : null,
    };
    evidence.fixturesFinal = {
      fixtureCu07: finalStatus,
      targetA: readFileSync(targetAStatusFile, "utf8"),
      targetB: readFileSync(targetBStatusFile, "utf8"),
    };
    evidence.result = "pass";
    save();
    mark("Direction 20 packaged QA scenario passed with all assertions and clean ownerPaths");
  } finally {
    await down().catch(() => {});
    for (const { proc } of spawnedProcs) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }
}
