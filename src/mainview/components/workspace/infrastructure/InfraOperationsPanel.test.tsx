import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/i18n/react";
import { localeStore } from "@/i18n/core";
import { InfraOperationsPanel } from "./InfraOperationsPanel";
import type { InfraSnapshot } from "../../../../shared/infra-auto/model.ts";
import { TRUSTED_OWNER_CHANNEL } from "../../../../shared/infra-auto/model.ts";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => {
  await choose("en");
});

const snapshot: InfraSnapshot = {
  channel: TRUSTED_OWNER_CHANNEL,
  paused: false,
  cancelled: false,
  note: "Recorded configuration and local inspection only.",
  clusters: [{
    id: "cluster-1",
    name: "North",
    servers: [{ id: "srv", name: "declared-host", resourceType: "vps", status: "not-verified" }],
    projects: [{
      path: "/tmp/app",
      name: "App",
      role: "application",
      gitBranch: "develop",
      gitSha: "abc",
      gitError: null,
      ciFailing: 1,
      ciPassing: 1,
    }],
  }],
  plans: [
    {
      id: "plan-fail",
      projectPath: "/tmp/app",
      projectName: "App",
      clusterName: "North",
      environment: "staging",
      branch: "develop",
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      adapter: "fake",
      state: "failed",
      authorization: "synthetic-consumed",
      health: "failed",
      failure: "The configured health check failed.",
      provenance: "fake-adapter",
    },
    {
      id: "plan-sim",
      projectPath: "/tmp/shared",
      projectName: "Shared",
      clusterName: "North",
      environment: "staging",
      branch: "develop",
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      adapter: "fake",
      state: "simulated",
      authorization: "synthetic-consumed",
      health: "passed",
      failure: null,
      provenance: "fake-adapter",
    },
  ],
  dependencies: [{ projectName: "Dependent", dependsOn: "Shared", blocked: false, reason: "Upstream staging health passed." }],
  production: [{ projectName: "App", ready: false, executionAuthorized: false, reasons: ["Production execution capability has not been issued."] }],
};

describe("FO-INFRA-AUTO01 compiled infrastructure panel", () => {
  test("shows truthful states in English and Russian", async () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <InfraOperationsPanel snapshot={snapshot} onPause={() => {}} onCancel={() => {}} onResume={() => {}} />
      </LocaleProvider>,
    );
    expect(html).toContain('data-testid="infra-operations-panel"');
    expect(html).toContain('data-testid="infra-channel-blocked"');
    expect(html).toContain("Trusted Owner authorization is unavailable");
    expect(html).toContain('data-operation-state="failed"');
    expect(html).toContain('data-operation-state="simulated"');
    expect(html).toContain("Simulated");
    expect(html).toContain("The configured health check failed.");
    expect(html).not.toContain("Remote deployment succeeded");
    expect(html).toContain("Not verified");
    expect(html).toContain("Production execution is denied.");

    await choose("ru");
    const russian = renderToStaticMarkup(
      <LocaleProvider>
        <InfraOperationsPanel snapshot={snapshot} />
      </LocaleProvider>,
    );
    expect(russian).toContain("Инфраструктурные операции");
    expect(russian).toContain("Имитация");
    expect(russian).toContain("Доверенное подтверждение Владельца недоступно");
    expect(russian).toContain('data-operation-state="failed"');
  });
});
