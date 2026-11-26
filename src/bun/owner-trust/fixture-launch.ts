/**
 * Acceptance transport. A verified synthetic proof may reach this fixture.
 * It never calls the production Codex or Claude launcher.
 */
import type { OwnerTrustService } from "./service.ts";
import type { LiveLaunchResult } from "../provider-runtime/live-launch.ts";

export async function admitVerifiedFixture(input: {
  service: OwnerTrustService;
  operation: unknown;
  proof: unknown;
  fixture: () => Promise<void>;
}): Promise<LiveLaunchResult> {
  const decision = input.service.admit(input.proof, input.operation, { trustClasses: ["synthetic-test"], consume: true });
  if (!decision.ok || decision.executionReady || decision.trustClass !== "synthetic-test") {
    return {
      processStarted: false,
      launched: false,
      launcher: "none",
      launcherBound: false,
      code: decision.code,
      reason: decision.reason,
    };
  }
  await input.fixture();
  return {
    processStarted: false,
    launched: false,
    launcher: "none",
    launcherBound: false,
    code: "verified-fixture",
    provenance: "verified-fixture",
    reason: "The Owner proof was verified and consumed. The fixture ran. No provider process was started.",
  };
}
