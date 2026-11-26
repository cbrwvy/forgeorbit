import { updateDecision, type BuildMetadata } from "../shared/release-version.ts";

interface SdkUpdater {
  checkForUpdate: () => Promise<any>;
  getLocalInfo: () => Promise<{ hash: string; version: string; channel: string; identifier: string }>;
}
const guards = new WeakMap<object, { beginCheck(): void }>();

/** Guard the SDK method itself, including its internal download/apply rechecks.
 * A feed changing after selection aborts the operation rather than silently
 * switching the artifact. No updater framework or SDK files are replaced.
 */
export function installUpdateGuard(sdk: SdkUpdater, readBuild: () => BuildMetadata) {
  const existing = guards.get(sdk); if (existing) return existing;
  const original = sdk.checkForUpdate.bind(sdk);
  let pinned: string | undefined;
  sdk.checkForUpdate = async () => {
    const local = readBuild(), info = await sdk.getLocalInfo();
    if (info.version !== local.productVersion || info.channel !== local.channel || info.identifier !== local.identifier) throw new Error("Local SDK/build identity mismatch");
    if (local.channel === "dev") return { version: local.productVersion, hash: info.hash, updateAvailable: false, updateReady: false, error: "" };
    const candidate = await original();
    if (candidate.error) {
      // SDK download/apply reads .hash without checking .error. Abort an
      // operation's internal recheck instead of returning an empty hash.
      if (pinned) throw new Error("Update recheck failed: " + candidate.error);
      return candidate;
    }
    const decision = updateDecision(local, info.hash, candidate);
    const fingerprint = JSON.stringify([candidate.version, candidate.hash, candidate.forgeorbit]);
    if (pinned && pinned !== fingerprint) throw new Error("Update feed changed during operation");
    pinned = fingerprint;
    return { ...candidate, updateAvailable: decision === "upgrade" };
  };
  const guard = { beginCheck() { pinned = undefined; } };
  guards.set(sdk, guard); return guard;
}

/** Disabled by default pending separate production auto-updater acceptance. */
export function updatesEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.FORGEORBIT_ENABLE_UPDATES === "1" && env.FORGEORBIT_DISABLE_UPDATES !== "1" && env.AGETOR_DISABLE_UPDATES !== "1";
}
