import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";
import path from "node:path";

/** macOS advisory lock: released by the kernel even after a crash. Keep the
 * inode in place; unlinking a held lock would let another process bypass it.
 * This guards boot recovery as well as the API bind, before either can run.
 */
export function acquireNativeInstanceLock(dataDir: string): () => void {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number;
  try {
    fd = openSync(path.join(dataDir, "desktop-instance.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    libc.close();
    throw error;
  }
  // F_SETFD / FD_CLOEXEC: a CLI child must never inherit ownership of the lock.
  if (libc.symbols.fcntl(fd, 2, 1) !== 0 || libc.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    libc.close();
    throw new Error("Another ForgeOrbit desktop instance owns this data directory, or its startup lock is unavailable.");
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    closeSync(fd);
    libc.close();
  };
}
