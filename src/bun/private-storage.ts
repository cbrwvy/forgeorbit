import { closeSync, constants, mkdirSync, openSync } from "node:fs";

/** Restrictive creation only: do not chmod or migrate existing owner data. */
export function ensurePrivateDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
export function createPrivateSqliteFile(file: string): void {
  try {
    closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
