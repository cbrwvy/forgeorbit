import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness } from "../../shared/types.ts";
import { hasDeepSeekLocalCredentials, parseDeepSeekBalance, readDeepSeekApiKey } from "./deepseek-usage.ts";

function makeDeepSeekHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    id: "deepseek-dsh",
    label: "DeepSeek",
    kind: "custom",
    isBuiltin: false,
    home: null,
    bin: "dsh",
    env: {},
    enabled: true,
    cliConfig: { args: ["--profile", "headless"], promptDelivery: "arg", interactionMode: "manual", serviceId: "deepseek" },
    ...overrides,
  };
}

describe("deepseek-usage", () => {
  test("parseDeepSeekBalance maps positive and zero balances truthfully", () => {
    const ok = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "14.25", granted_balance: "0.00", topped_up_balance: "14.25" }],
    });
    expect(ok.planType).toBe("14.25 USD");
    expect(ok.meters).toHaveLength(1);
    expect(ok.meters[0]?.usedPercent).toBe(0);
    expect(ok.meters[0]?.scope).toBe("14.25 USD");

    const empty = parseDeepSeekBalance({
      is_available: false,
      balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
    });
    expect(empty.planType).toBe("0.00 CNY");
    expect(empty.meters[0]?.usedPercent).toBe(100);
  });

  test("detects local credentials and API key from $DSH_HOME/.credentials.yaml or harness env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-dsh-usage-"));
    try {
      const h = makeDeepSeekHarness({ home: dir });
      expect(hasDeepSeekLocalCredentials(h)).toBe(false);
      expect(readDeepSeekApiKey(h)).toBeNull();

      writeFileSync(
        path.join(dir, ".credentials.yaml"),
        "version: 1\nrecords:\n  - kind: api_key\n    payload:\n      secret: sk-test-deepseek-key-123456\n",
      );
      expect(hasDeepSeekLocalCredentials(h)).toBe(true);
      expect(readDeepSeekApiKey(h)).toBe("sk-test-deepseek-key-123456");

      const hEnv = makeDeepSeekHarness({ home: dir, env: { DEEPSEEK_API_KEY: "sk-env-override-999999" } });
      expect(readDeepSeekApiKey(hEnv)).toBe("sk-env-override-999999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
