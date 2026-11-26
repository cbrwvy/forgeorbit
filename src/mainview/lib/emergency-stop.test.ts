import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { AttentionIndicator, EmergencyStopView, emergencyStatusText } from "@/components/EmergencyStopControl";
import { __resetEmergencyForTest, applyStatus, applyStatusError, beginStop, INITIAL_EMERGENCY, stopFailed, stopSucceeded } from "./emergency-stop";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); __resetEmergencyForTest(); });

const status = (active: boolean, outstanding: string[] = []) => ({ emergency: { active, outstanding } });

test("the stored flag decides the phase; an unreachable core changes nothing", () => {
  expect(applyStatus(INITIAL_EMERGENCY, status(false)).phase).toBe("clear");
  const active = applyStatus(INITIAL_EMERGENCY, status(true, ["run-1"]));
  expect(active).toMatchObject({ phase: "active", outstanding: ["run-1"] });
  expect(applyStatusError(active, "offline")).toMatchObject({ phase: "active", outstanding: ["run-1"], error: "offline" });
  expect(applyStatusError(INITIAL_EMERGENCY, "offline").phase).toBe("unknown");
});

test("a stale 'clear' status read cannot cancel an in-flight stop", () => {
  const stopping = beginStop(applyStatus(INITIAL_EMERGENCY, status(false)));
  expect(applyStatus(stopping, status(false)).phase).toBe("stopping");
  expect(applyStatus(stopping, status(true)).phase).toBe("active");
});

test("a failed stop is never shown as stopped", async () => {
  const failed = stopFailed(beginStop(applyStatus(INITIAL_EMERGENCY, status(false))), "network", "clear");
  expect(failed).toMatchObject({ phase: "clear", stopFailed: true, error: "network" });
  expect(emergencyStatusText(failed)).toContain("NOT confirmed");
  await choose("ru");
  expect(emergencyStatusText(failed)).toContain("НЕ подтверждена");
});

test("the status text reports only what the core returned", async () => {
  const none = stopSucceeded(INITIAL_EMERGENCY, []);
  const some = stopSucceeded(INITIAL_EMERGENCY, ["a", "b"]);
  expect(emergencyStatusText(none)).toContain("reported no autonomous run still alive");
  expect(emergencyStatusText(none)).not.toMatch(/terminated|killed|all/i);
  expect(emergencyStatusText(some)).toContain("had not stopped when the core answered: 2");
  await choose("ru");
  expect(emergencyStatusText(some)).toContain("ещё не остановились на момент ответа ядра: 2");
});

const noop = { onStop: () => {}, onResume: () => {} };
const render = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(LocaleProvider, null, node));

test("ready state renders one stop button with an accessible name and a scope description", () => {
  const html = render(createElement(EmergencyStopView, { state: applyStatus(INITIAL_EMERGENCY, status(false)), ...noop }));
  expect(html).toContain('data-testid="emergency-stop-button"');
  expect(html).toContain('aria-label="Emergency stop"');
  expect(html).toContain('aria-describedby="emergency-stop-hint"');
  expect(html).toContain("Tasks you started yourself keep running");
  expect(html).not.toContain('data-testid="emergency-stop-resume"');
});

test("stopped state shows the state and a resume control instead of the stop button, in Russian too", async () => {
  const state = stopSucceeded(INITIAL_EMERGENCY, ["run-9"]);
  let html = render(createElement(EmergencyStopView, { state, ...noop }));
  expect(html).toContain('data-testid="emergency-stop-active"');
  expect(html).toContain("Stopped");
  expect(html).toContain('data-testid="emergency-stop-outstanding"');
  expect(html).toContain('data-testid="emergency-stop-resume"');
  expect(html).not.toContain('data-testid="emergency-stop-button"');
  await choose("ru");
  html = render(createElement(EmergencyStopView, { state, ...noop }));
  expect(html).toContain("Остановлено");
  expect(html).toContain("Возобновить…");
});

test("the attention indicator names its count and hides the badge at zero", async () => {
  let html = render(createElement(AttentionIndicator, { count: 3, current: false, onOpen: () => {} }));
  expect(html).toContain('aria-label="Needs you: 3"');
  expect(html).toContain('data-testid="header-attention-badge"');
  html = render(createElement(AttentionIndicator, { count: 0, current: true, onOpen: () => {} }));
  expect(html).toContain('aria-label="Needs you: nothing is waiting"');
  expect(html).toContain('aria-current="page"');
  expect(html).not.toContain('data-testid="header-attention-badge"');
  await choose("ru");
  html = render(createElement(AttentionIndicator, { count: 120, current: false, onOpen: () => {} }));
  expect(html).toContain('aria-label="Нужно вам: 120"');
  expect(html).toContain("99+");
});

test("the stopped state names the running tasks the stop did not stop, only when there are some, in both languages", async () => {
  // Nothing left running: no chip and no "not stopped" sentence.
  const none = stopSucceeded(INITIAL_EMERGENCY, [], 0);
  expect(render(createElement(EmergencyStopView, { state: none, ...noop }))).not.toContain('data-testid="emergency-stop-left-running"');
  expect(emergencyStatusText(none)).not.toContain("Not stopped");

  // Two tasks the Owner started are still running: the chip carries the number and the sentence says what was left.
  const left = stopSucceeded(INITIAL_EMERGENCY, [], 2);
  const html = render(createElement(EmergencyStopView, { state: left, ...noop }));
  expect(html).toContain('data-testid="emergency-stop-left-running"');
  expect(html).toContain('data-count="2"');
  expect(emergencyStatusText(left)).toContain("Not stopped: 2 running task(s) you started yourself.");
  // A status read carries the live number; an older core that does not report it reads as 0, never as a claim.
  expect(applyStatus(INITIAL_EMERGENCY, { emergency: { active: true, outstanding: [], leftRunning: 3 } }).leftRunning).toBe(3);
  expect(applyStatus(INITIAL_EMERGENCY, { emergency: { active: true, outstanding: [] } }).leftRunning).toBe(0);
  expect(applyStatus(left, { emergency: { active: false, outstanding: [] } }).leftRunning).toBe(0);
  await choose("ru");
  expect(emergencyStatusText(left)).toContain("Не остановлено: запущенные вами задачи, которые ещё работают: 2.");
});
