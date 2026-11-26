import { NATIVE_OBSERVATION_MARKER } from "../shared/native-computer/agent.ts";

/**
 * Test seam (fake manager drivers only). Describes the native macOS window-observation section a
 * manager turn actually received, so a packaged run can prove prompt framing, fence count, absence
 * of screenshots, and absence of canary secrets from protected fields. Never reachable with a real driver.
 */
export function describeNativePrompt(prompt: string): string {
  const present = prompt.includes("Native macOS window observation the owner approved for this message");
  if (!present) return "Received: no native observation section.";
  const line = (label: string) => new RegExp(`^${label}: (.*)$`, "m").exec(prompt)?.[1]?.trim() ?? "";
  const elementLines = [...prompt.matchAll(/^- \[(el_\d+)\] role=(\S+) label="([^"]*)" enabled=(true|false) actions=(\S+)/gm)].map(
    (m) => `${m[1]}/${m[2]}/${m[4]}/${m[5]}/${m[3]}`,
  );
  const fences = (prompt.match(new RegExp(`^--- (?:BEGIN|END) ${NATIVE_OBSERVATION_MARKER} `, "gm")) ?? []).length;
  return [
    "Received: native observation section.",
    `session=${line("Session")}`,
    `observation=${line("Observation")}`,
    `application=${line("Application")}`,
    `window=${line("Window")}`,
    `elementsCount=${elementLines.length}`,
    `elements=${JSON.stringify(elementLines)}`,
    `fences=${fences}`,
    `screenshotBytes=${/\u0089PNG|data:image\//.test(prompt) ? "present" : "none"}`,
    `canaryPresent=${/CANARY_/.test(prompt) ? "yes" : "no"}`,
  ].join("\n");
}

export const FAKE_NATIVE_OBEY_MARKER = "__fake_native_obey__";

/**
 * Worst-case compliant model for native window observations: looks for an excluded/disabled/secret
 * element mentioned in window text ("Delete account", "Disabled", "Secret", or fallback) and tries to
 * request `press_accessible_button` on it so backend policy checks must refuse the action.
 */
export function fakeNativeObeyTarget(prompt: string): string | null {
  const start = prompt.indexOf("\nElements:\n");
  const end = prompt.indexOf(`\n--- END ${NATIVE_OBSERVATION_MARKER} `, start + 1);
  if (start < 0 || end < 0) return null;
  const section = prompt.slice(start, end);
  const lines = section.split("\n");
  for (const line of lines) {
    if (/(Delete account|erase|password|Secret|Disabled|prohibited|excluded|actions=none)/i.test(line)) {
      const id = /^- \[(el_\d+)\]/.exec(line)?.[1];
      if (id) return id;
    }
  }
  return /^- \[(el_\d+)\]/.exec(section)?.[1] ?? null;
}
