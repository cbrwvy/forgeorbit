// Load floor for Mach-O we compile ourselves.
//
// Electrobun 1.18.1 ships libNativeWrapper.dylib with minos 14.0. That is the
// highest floor among binaries the inner app must load, and we do not rebuild
// the SDK. The DMG's self-extractor is a separate prebuilt (minos 14.8.5).
// Compiling with the host SDK and no -target makes clang stamp minos 27.0,
// which raises the whole app to this build machine.
//
// 14.0 is a compiler constraint, not a support claim. LSMinimumSystemVersion
// stays unset until a release is actually launched on that OS. The notifier
// helper is already pinned to arm64-apple-macos13 in scripts/build-notifier.ts;
// 13 is below this floor, so it does not raise it.

export const MACOS_DEPLOYMENT_TARGET = "14.0";

export function clangDeploymentArgs(): string[] {
  return ["-target", `arm64-apple-macos${MACOS_DEPLOYMENT_TARGET}`];
}

export function versionAtMost(actual: string, ceiling: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number(part));
  const left = parse(actual);
  const right = parse(ceiling);
  if (left.some((part) => !Number.isInteger(part)) || right.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return true;
}

/** LC_BUILD_VERSION minos from `vtool -show-build`, or null when it is not Mach-O. */
export async function machOMinOS(file: string): Promise<string | null> {
  const proc = Bun.spawn(["vtool", "-show-build", file], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  return out.match(/minos\s+(\d+(?:\.\d+)*)/)?.[1] ?? null;
}
