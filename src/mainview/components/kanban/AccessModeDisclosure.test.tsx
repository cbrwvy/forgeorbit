import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "../../i18n/core.ts";
import { LocaleProvider } from "../../i18n/react.tsx";
import { assessAccessDiagnostics } from "../../../shared/execution/access-mode.ts";
import { AccessModeDisclosure, AccessModeSelector } from "./AccessModeDisclosure.tsx";
import { BrowserComputerUse } from "../workspace/browser/BrowserComputerUse.tsx";
import { NativeComputerUse } from "../workspace/native/NativeComputerUse.tsx";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

test("AccessModeSelector, AccessModeDisclosure, Browser and Native CU notes render honestly in EN and RU", async () => {
  const refusedIsolated = assessAccessDiagnostics({
    requestedAccessMode: "isolated",
    kind: "claude-code",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    stagedCwd: null,
    layout: "repo-root",
    seatbeltStatus: "available",
  });

  const fullComp = assessAccessDiagnostics({
    requestedAccessMode: "full-computer",
    kind: "codex",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    layout: "repo-root",
  });

  const enMarkup = renderToStaticMarkup(
    <LocaleProvider>
      <AccessModeSelector value="isolated" onChange={() => {}} />
      <AccessModeDisclosure diagnostics={refusedIsolated} testId="test-disclosure" />
      <AccessModeDisclosure diagnostics={fullComp} testId="test-full-computer" />
      <BrowserComputerUse />
      <NativeComputerUse />
    </LocaleProvider>,
  );
  expect(enMarkup).toContain("Access mode");
  expect(enMarkup).toContain("Isolated");
  expect(enMarkup).toContain("Full Computer");
  expect(enMarkup).toContain("Selecting a mode itself grants nothing.");
  expect(enMarkup).toContain("Cannot run with this combination");
  expect(enMarkup).toContain("Full Computer (Browser):");
  expect(enMarkup).toContain("Full Computer (Native):");

  await choose("ru");
  const ruMarkup = renderToStaticMarkup(
    <LocaleProvider>
      <AccessModeSelector value="full-computer" onChange={() => {}} />
      <AccessModeDisclosure diagnostics={refusedIsolated} testId="test-disclosure" />
      <AccessModeDisclosure diagnostics={fullComp} testId="test-full-computer" />
      <BrowserComputerUse />
      <NativeComputerUse />
    </LocaleProvider>,
  );
  expect(ruMarkup).toContain("Режим доступа");
  expect(ruMarkup).toContain("Изолированный");
  expect(ruMarkup).toContain("Весь компьютер");
  expect(ruMarkup).toContain("Сам выбор режима не выдаёт никаких разрешений.");
  expect(ruMarkup).toContain("Запуск с таким сочетанием невозможен");
  expect(ruMarkup).toContain("Весь компьютер (Браузер):");
  expect(ruMarkup).toContain("Весь компьютер (Нативное управление):");
  expect(ruMarkup).not.toContain("Cannot run with this combination");
});
