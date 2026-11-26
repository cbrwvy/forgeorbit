import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import type { AppBuildInfo } from "@/lib/api";
import { DiagnosticsSettings } from "./SettingsDialog";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

const SAMPLE_INFO: AppBuildInfo = {
  version: "1.0.3",
  buildNumber: 4,
  macBundleVersion: "1.0.3",
  sourceRevision: "89d2cb77ca0abddc91eee89ef8658e29ea229cdb",
  sourceTreeSHA256: "b".repeat(64),
  sourceDirty: true,
  channel: "dev",
  identifier: "app.forgeorbit",
  localBuild: true,
  builtAt: "2026-11-18T08:30:00.000Z",
  migrationCeiling: "145_task_access_mode",
  updatesEnabled: false,
};

describe("DiagnosticsSettings", () => {
  test("renders version, build, full source revision, migration ceiling, channel, and disabled updates in EN", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <DiagnosticsSettings info={SAMPLE_INFO} />
      </LocaleProvider>,
    );
    expect(html).toContain('data-testid="settings-diag-version"');
    expect(html).toContain("1.0.3");
    expect(html).toContain('data-testid="settings-diag-build"');
    expect(html).toContain("4 (1.0.3)");
    expect(html).toContain('data-testid="settings-diag-revision"');
    expect(html).toContain("89d2cb77ca0abddc91eee89ef8658e29ea229cdb");
    expect(html).toContain('data-testid="settings-diag-migration-ceiling"');
    expect(html).toContain("145_task_access_mode");
    expect(html).toContain('data-testid="settings-diag-channel"');
    expect(html).toContain("dev (local)");
    expect(html).toContain('data-testid="settings-diag-updates"');
    expect(html).toContain("Disabled");
  });

  test("renders localized Russian labels and fallback dashes when packaged fields are absent", async () => {
    await choose("ru");
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <DiagnosticsSettings
          info={{
            ...SAMPLE_INFO,
            buildNumber: null,
            macBundleVersion: null,
            sourceRevision: null,
            channel: null,
            localBuild: false,
            migrationCeiling: null,
          }}
        />
      </LocaleProvider>,
    );
    expect(html).toContain("Версия ForgeOrbit");
    expect(html).toContain("Номер сборки");
    expect(html).toContain("Ревизия исходников");
    expect(html).toContain("Верхняя миграция");
    expect(html).toContain("Канал сборки");
    expect(html).toContain("Автообновления");
    expect(html).toContain("Отключены");
  });
});
