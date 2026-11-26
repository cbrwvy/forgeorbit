/**
 * Test seam (fake manager drivers only). Describes the webpage-observation section a manager turn
 * actually received, so a packaged run can record what the driver was given. It reports counts and the
 * observation's own lines; it never invents content and is not reachable with a real driver.
 */
export function describeBrowserPrompt(prompt: string): string {
  const present = prompt.includes("Webpage observation the owner approved for this message");
  if (!present) return "Received: no webpage observation section.";
  const line = (label: string) => new RegExp(`^${label}: (.*)$`, "m").exec(prompt)?.[1]?.trim() ?? "";
  const textBlock = /^Visible text:\n([\s\S]*?)\nLinks:\n/m.exec(prompt)?.[1] ?? "";
  const links = [...prompt.matchAll(/^- (l\d+) (permitted|blocked) (\S+) (.*)$/gm)].map((m) => `${m[1]}/${m[2]}/${m[3]}/${m[4]}`);
  const fences = (prompt.match(/^--- (BEGIN|END) webpage observation /gm) ?? []).length;
  return [
    "Received: webpage observation section.",
    `session=${line("Session")}`,
    `observation=${line("Observation")}`,
    `url=${line("URL")}`,
    `title=${line("Title")}`,
    `textChars=${textBlock.length}`,
    `text=${JSON.stringify(textBlock.slice(0, 300))}`,
    `links=${JSON.stringify(links)}`,
    `fences=${fences}`,
    `screenshotBytes=${/\u0089PNG|data:image\//.test(prompt) ? "present" : "none"}`,
  ].join("\n");
}

export const FAKE_BROWSER_NAVIGATE_MARKER = "__fake_browser_navigate__";
export const FAKE_BROWSER_OBEY_MARKER = "__fake_browser_obey__";

/** `__fake_browser_navigate__ <url>`: the driver requests a navigate action to the URL the Owner message names. */
export function fakeNavigateTarget(message: string): string | null {
  const at = message.indexOf(FAKE_BROWSER_NAVIGATE_MARKER);
  if (at < 0) return null;
  return /^\s*(\S+)/.exec(message.slice(at + FAKE_BROWSER_NAVIGATE_MARKER.length))?.[1] ?? null;
}

/**
 * `__fake_browser_obey__`: the worst-case compliant model. It does what the PAGE says: the first
 * "open <url>" in the page text becomes a navigate request. Used to show page text confers no authority.
 */
export function fakeObeyTarget(prompt: string): string | null {
  const start = prompt.indexOf("\nVisible text:\n");
  const end = prompt.indexOf("\nLinks:\n", start + 1);
  if (start < 0 || end < 0) return null;
  const match = /\bopen (https?:\/\/[^\s"'<>]+)/i.exec(prompt.slice(start, end));
  return match ? match[1]!.replace(/[.,;:!?)]+$/, "") : null;
}
