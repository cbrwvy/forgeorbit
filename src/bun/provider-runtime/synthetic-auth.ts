/**
 * Recorded-driver authentication for an inert QA stub.
 * A synthetic marker is not a provider subject and is not a credential.
 * A real CLI binary always falls through to its own status command.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { NATIVE_QA_STUB } from "../native-qa-environment.ts";

const MARKER = "synthetic-authenticated";

/** Exact inert QA stub. A real provider CLI never has these bytes. */
export function isInertQaStub(bin: string | null | undefined): boolean {
  if (!bin) return false;
  try {
    return readFileSync(bin, "utf8") === NATIVE_QA_STUB;
  } catch {
    return false;
  }
}

export function syntheticRecordedAuthentication(
  kind: "codex" | "claude-code",
  bin: string,
  directory: string,
): "authenticated" | null {
  const driver = kind === "codex" ? process.env.AGETOR_CODEX_DRIVER : process.env.AGETOR_CLAUDE_DRIVER;
  if (driver !== "fake") return null;
  try {
    if (readFileSync(bin, "utf8") !== NATIVE_QA_STUB) return null;
    const text = readFileSync(path.join(directory, MARKER), "utf8").trim();
    if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) return null;
    return "authenticated";
  } catch {
    return null;
  }
}
