/**
 * Test-only replies for portfolio-manager prompts under `AGETOR_*_DRIVER=fake`
 * (FO-008C). Reached only from `makeFakeAgent` (agents.ts), which runs only
 * when a fake driver env var is set — never on a real agent.
 *
 * The reply depends on the owner's message:
 * - mentions a plan / "план" → a portfolio plan over the first two projects
 *   (P2 suggests a harness that doesn't exist, which must be dropped);
 * - mentions delegating / "поручи" / "попроси" → one delegation, to the
 *   project whose name the message contains (else P1);
 * - mentions "blocked" / "заблок" → lists the blocked task lines it was given;
 * - anything else → a summary of what the prompt said.
 *
 * Markers:
 * - `__fake_portfolio_fail__` — the turn fails like a CLI error.
 * - `__fake_portfolio_slow__` — the reply takes 4 s (cancel tests).
 * - `__fake_portfolio_garbage__` — a broken plan and no answer (turn fails).
 * - `__fake_portfolio_badplan__` — an answer plus a plan naming P99.
 * - `__fake_portfolio_baddelegation__` — an answer plus a delegation to P99.
 * - `__fake_portfolio_two__` — delegations to P1 and P2.
 * - `__fake_portfolio_secret__` — fails with a credential in stderr.
 */

import { OBJECTIVE_MISSION_PROMPT_PREFIX } from "../shared/orchestration/types.ts";
import { PORTFOLIO_MANAGER_PROMPT_PREFIX } from "../shared/portfolio-manager.ts";
import { describeBrowserPrompt, fakeNavigateTarget, fakeObeyTarget, FAKE_BROWSER_OBEY_MARKER } from "./browser-fake-echo.ts";
import { describeNativePrompt, fakeNativeObeyTarget, FAKE_NATIVE_OBEY_MARKER } from "./native-fake-echo.ts";

export const FAKE_PORTFOLIO_FAIL_MARKER = "__fake_portfolio_fail__";
/** The provider's usage-limit sentence on a Codex error line, dated clock form. */
export const FAKE_PORTFOLIO_USAGE_LIMIT_MARKER = "__fake_portfolio_usage_limit__";
/** The same refusal as a machine token with no retry hint. */
export const FAKE_PORTFOLIO_USAGE_LIMIT_TOKEN_MARKER = "__fake_portfolio_usage_limit_token__";
/** The sentence with the clock only: ambiguous, no date. */
export const FAKE_PORTFOLIO_USAGE_LIMIT_CLOCK_MARKER = "__fake_portfolio_usage_limit_clock__";
/** Model text that merely resembles the refusal, on a failed turn with an unrelated provider error. */
export const FAKE_PORTFOLIO_USAGE_LIMIT_TEXT_MARKER = "__fake_portfolio_usage_limit_text__";
/** The sentence on a stderr line the adapter did not mark as a provider error. */
export const FAKE_PORTFOLIO_USAGE_LIMIT_UNMARKED_MARKER = "__fake_portfolio_usage_limit_unmarked__";
/** A temporary rate limit, which is not a usage limit. */
export const FAKE_PORTFOLIO_RATE_LIMIT_MARKER = "__fake_portfolio_rate_limit__";
export const FAKE_PORTFOLIO_SLOW_MARKER = "__fake_portfolio_slow__";
export const FAKE_PORTFOLIO_GARBAGE_MARKER = "__fake_portfolio_garbage__";
export const FAKE_PORTFOLIO_BADPLAN_MARKER = "__fake_portfolio_badplan__";
export const FAKE_PORTFOLIO_BADDELEGATION_MARKER = "__fake_portfolio_baddelegation__";
export const FAKE_PORTFOLIO_TWO_MARKER = "__fake_portfolio_two__";
export const FAKE_PORTFOLIO_SECRET_MARKER = "__fake_portfolio_secret__";
export const FAKE_PORTFOLIO_INITIATIVE_MARKER = "__fake_portfolio_initiative__";
export const FAKE_PORTFOLIO_BADINITIATIVE_MARKER = "__fake_portfolio_badinitiative__";
export const FAKE_PORTFOLIO_MEMORY_MARKER = "__fake_portfolio_memory__";
export const FAKE_PORTFOLIO_BROWSER_PROBE_MARKER = "__fake_portfolio_browser_probe__";
export const FAKE_PORTFOLIO_BROWSER_ECHO_MARKER = "__fake_portfolio_browser_echo__";
export const FAKE_PORTFOLIO_BROWSER_LINK_MARKER = "__fake_portfolio_browser_link__";
export const FAKE_PORTFOLIO_BROWSER_EVIL_MARKER = "__fake_portfolio_browser_evil__";
export const FAKE_PORTFOLIO_MEMORY_COMPANY_MARKER = "__fake_portfolio_memory_company__";
export const FAKE_PORTFOLIO_NATIVE_PROBE_MARKER = "__fake_portfolio_native_probe__";
export const FAKE_PORTFOLIO_NATIVE_ECHO_MARKER = "__fake_portfolio_native_echo__";
export const FAKE_PORTFOLIO_NATIVE_PRESS_MARKER = "__fake_portfolio_native_press__";
export const FAKE_PORTFOLIO_NATIVE_SCROLL_MARKER = "__fake_portfolio_native_scroll__";
export const FAKE_PORTFOLIO_NATIVE_TAB_MARKER = "__fake_portfolio_native_tab__";
export const FAKE_PORTFOLIO_NATIVE_SET_TEXT_MARKER = "__fake_portfolio_native_set_text__";
export const FAKE_PORTFOLIO_NATIVE_OPEN_MENU_MARKER = "__fake_portfolio_native_open_menu__";
export const FAKE_PORTFOLIO_NATIVE_SELECT_MENU_ITEM_MARKER = "__fake_portfolio_native_select_menu_item__";
export const FAKE_PORTFOLIO_NATIVE_NONE_MARKER = "__fake_portfolio_native_none__";
export const FAKE_PORTFOLIO_NATIVE_BAD_MARKER = "__fake_portfolio_native_bad__";
export const FAKE_PORTFOLIO_NATIVE_TWO_MARKER = "__fake_portfolio_native_two__";

/** Turns the fake drivers answered, by kind, plus the last portfolio prompt.
 *  Tests use these to prove no hidden model call happened. */
export const fakeTurnLog = {
  portfolio: 0,
  manager: 0,
  lastPortfolioPrompt: "",
  lastManagerPrompt: "",
};

export function isPortfolioManagerPrompt(prompt: string): boolean {
  return prompt.startsWith(PORTFOLIO_MANAGER_PROMPT_PREFIX) || prompt.startsWith(OBJECTIVE_MISSION_PROMPT_PREFIX);
}

export interface FakePortfolioReply {
  delayMs: number;
  code: number;
  assistant: string | null;
  stderr: string | null;
  /** Provider error events with the adapter's line ids, as the Codex driver emits them. */
  stderrEvents?: { data: string; lineUuid?: string }[];
}

const USAGE_LIMIT_SENTENCE = (clock: string) =>
  `You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at ${clock}.`;

function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const from = start + heading.length + 5;
  const end = prompt.indexOf("\n## ", from);
  return prompt.slice(from, end < 0 ? undefined : end).trim();
}

function projectsOf(prompt: string): { ref: string; name: string; path: string }[] {
  const out: { ref: string; name: string; path: string }[] = [];
  for (const line of prompt.split("\n")) {
    const match = /^#### (P\d+) — (.+?) \((.+)\)$/.exec(line);
    if (match) out.push({ ref: match[1]!, name: match[2]!, path: match[3]! });
  }
  return out;
}

function portfolioBrowserReply(prompt: string, message: string, delayMs: number): FakePortfolioReply | null {
  const present = prompt.includes("Webpage observation the owner approved for this message");
  const title = /^Title: (.*)$/m.exec(prompt)?.[1]?.trim() ?? "";
  const link = /^- (l\d+) permitted /m.exec(prompt)?.[1] ?? "l1";
  const block = (body: unknown) => `<browser_action>\n${JSON.stringify(body)}\n</browser_action>`;
  const navigateTo = fakeNavigateTarget(message);
  if (navigateTo) return { delayMs, code: 0, assistant: reply("Opening the address you named.", block({ kind: "navigate", url: navigateTo })), stderr: null };
  if (message.includes(FAKE_BROWSER_OBEY_MARKER)) {
    const told = fakeObeyTarget(prompt);
    return { delayMs, code: 0, assistant: reply(told ? "The page told me to open an address, so I am." : "The page did not name an address.", told ? block({ kind: "navigate", url: told }) : ""), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_BROWSER_ECHO_MARKER)) {
    return { delayMs, code: 0, assistant: reply(describeBrowserPrompt(prompt)), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_BROWSER_PROBE_MARKER)) {
    return { delayMs, code: 0, assistant: reply(present ? `Observed page: ${title}` : "No webpage observation was provided."), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_BROWSER_LINK_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed page: ${title}`, block({ kind: "open_link", linkId: link })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_BROWSER_EVIL_MARKER)) {
    return { delayMs, code: 0, assistant: reply("The page asked for another site.", block({ kind: "navigate", url: "https://evil.example/phish" })), stderr: null };
  }
  return null;
}

function portfolioNativeReply(prompt: string, message: string, delayMs: number): FakePortfolioReply | null {
  const present = prompt.includes("Native macOS window observation the owner approved for this message");
  const appMatch = /^Application: (.*)$/m.exec(prompt)?.[1]?.trim() ?? "";
  const elementId = /^- \[(el_[0-9a-zA-Z_-]+)\]/m.exec(prompt)?.[1] ?? "el_1";
  const replaceableButtonMatch = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*Replaceable[^\n]*press_accessible_button/m.exec(prompt)?.[1];
  const window2ButtonMatch = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*Window 2[^\n]*press_accessible_button/m.exec(prompt)?.[1];
  const defaultButtonId = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*press_accessible_button/m.exec(prompt)?.[1] ?? elementId;
  const buttonId = (message.includes("Replaceable") && replaceableButtonMatch)
    ? replaceableButtonMatch
    : (message.includes("Window 2") && window2ButtonMatch)
      ? window2ButtonMatch
      : defaultButtonId;
  const scrollId = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*scroll_accessible_area/m.exec(prompt)?.[1] ?? elementId;
  const tab2Match = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*Tab 2[^\n]*select_accessible_tab/m.exec(prompt)?.[1];
  const tab1Match = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*select_accessible_tab/m.exec(prompt)?.[1];
  const tabId = (message.includes("Tab 2") && tab2Match) ? tab2Match : (tab1Match ?? elementId);
  const textId = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*set_accessible_text/m.exec(prompt)?.[1] ?? elementId;
  const viewMenuMatch = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*View[^\n]*open_accessible_menu/m.exec(prompt)?.[1];
  const menuId = (message.includes("View") && viewMenuMatch) ? viewMenuMatch : (/^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*open_accessible_menu/m.exec(prompt)?.[1] ?? elementId);
  const harmlessItemMatch = /^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*Harmless[^\n]*select_accessible_menu_item/m.exec(prompt)?.[1];
  const menuItemId = (message.includes("Harmless") && harmlessItemMatch) ? harmlessItemMatch : (/^- \[(el_[0-9a-zA-Z_-]+)\] [^\n]*select_accessible_menu_item/m.exec(prompt)?.[1] ?? elementId);
  const block = (body: unknown) => `<native_action>\n${JSON.stringify(body)}\n</native_action>`;
  if (message.includes(FAKE_NATIVE_OBEY_MARKER)) {
    const obeyId = fakeNativeObeyTarget(prompt);
    return {
      delayMs,
      code: 0,
      assistant: reply(
        obeyId ? "The window text told me to press an excluded/protected control, so I requested it." : "No window target found.",
        obeyId ? block({ kind: "press_accessible_button", elementId: obeyId }) : "",
      ),
      stderr: null,
    };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_ECHO_MARKER)) {
    return { delayMs, code: 0, assistant: reply(describeNativePrompt(prompt)), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_PROBE_MARKER)) {
    return { delayMs, code: 0, assistant: reply(present ? `Observed app: ${appMatch}` : "No native window observation was provided."), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_PRESS_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "press_accessible_button", elementId: buttonId })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_SCROLL_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "scroll_accessible_area", elementId: scrollId, direction: "down", increment: 1 })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_TAB_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "select_accessible_tab", elementId: tabId })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_SET_TEXT_MARKER)) {
    const textMatch = /text:([^\s]+)/.exec(message)?.[1] ?? "Sample text from Head of PM";
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "set_accessible_text", elementId: textId, text: textMatch })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_OPEN_MENU_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "open_accessible_menu", elementId: menuId })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_SELECT_MENU_ITEM_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "select_accessible_menu_item", elementId: menuItemId })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_NONE_MARKER)) {
    return { delayMs, code: 0, assistant: reply(`Observed app: ${appMatch}`, block({ kind: "none" })), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_BAD_MARKER)) {
    return { delayMs, code: 0, assistant: reply("The action was malformed.", "<native_action>{nope</native_action>"), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_NATIVE_TWO_MARKER)) {
    return { delayMs, code: 0, assistant: reply("Two actions.", `${block({ kind: "none" })}\n${block({ kind: "press_accessible_button", elementId: buttonId })}`), stderr: null };
  }
  return null;
}

function reply(text: string, extra = ""): string {
  return `<reply>\n${text}\n</reply>${extra ? `\n${extra}` : ""}`;
}

export function fakePortfolioReply(prompt: string): FakePortfolioReply {
  fakeTurnLog.portfolio += 1;
  fakeTurnLog.lastPortfolioPrompt = prompt;
  const message = section(prompt, "The owner's message");
  const env = Number(process.env.AGETOR_FAKE_PORTFOLIO_DELAY_MS ?? 0);
  const delayMs = message.includes(FAKE_PORTFOLIO_SLOW_MARKER) ? 4000 : Number.isFinite(env) && env > 0 ? env : 30;
  if (prompt.startsWith(OBJECTIVE_MISSION_PROMPT_PREFIX)) {
    const objective = JSON.parse(prompt.split("\n").at(-1) ?? "{}").objective as string;
    const contract = "mission-contract.json";
    const write = (path: string, contents: string) => `__agetor_fake_task_files__: ${JSON.stringify({ writes: [{ path, contents }] })}`;
    const tasks = [
      { ref: "T1", project: "P1", title: "Produce shared contract", description: write(contract, '{"version":1,"kind":"mission-handoff"}'), deliverable: "Versioned contract", dependsOn: objective.includes("__cycle__") ? ["T3"] : [], artifactPath: contract },
      { ref: "T2", project: objective.includes("__outside__") ? "P3" : "P2", title: "Prepare consumer independently", description: "Prepare the consumer before the contract arrives.", deliverable: "Preparation report", dependsOn: [] },
      { ref: "T3", project: "P2", title: "Implement contract consumer", description: "Use the approved inline contract data.", deliverable: "Contract consumer", dependsOn: ["T1"], ...(objective.includes("__cycle__") ? { artifactPath: "consumer.json" } : {}) },
    ];
    return { delayMs, code: 0, assistant: `<mission_plan>${JSON.stringify({ title: "Shared contract rollout", tasks })}</mission_plan>`, stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_USAGE_LIMIT_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: null, stderrEvents: [{ data: USAGE_LIMIT_SENTENCE("Nov 16th, 2026 9:31 PM"), lineUuid: "error:1" }] };
  }
  if (message.includes(FAKE_PORTFOLIO_USAGE_LIMIT_CLOCK_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: null, stderrEvents: [{ data: USAGE_LIMIT_SENTENCE("9:31 PM"), lineUuid: "turn.failed:1" }] };
  }
  if (message.includes(FAKE_PORTFOLIO_USAGE_LIMIT_TOKEN_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: null, stderrEvents: [{ data: JSON.stringify({ type: "error", error: { codex_error_info: "usage_limit_exceeded" } }), lineUuid: "error:1" }] };
  }
  if (message.includes(FAKE_PORTFOLIO_USAGE_LIMIT_TEXT_MARKER)) {
    return { delayMs, code: 1, assistant: USAGE_LIMIT_SENTENCE("Nov 16th, 2026 9:31 PM"), stderr: null, stderrEvents: [{ data: "codex turn failed", lineUuid: "error:1" }] };
  }
  if (message.includes(FAKE_PORTFOLIO_USAGE_LIMIT_UNMARKED_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: USAGE_LIMIT_SENTENCE("Nov 16th, 2026 9:31 PM") };
  }
  if (message.includes(FAKE_PORTFOLIO_RATE_LIMIT_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: null, stderrEvents: [{ data: "Rate limit reached for requests. Please try again in 20s.", lineUuid: "error:1" }] };
  }
  if (message.includes(FAKE_PORTFOLIO_SECRET_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: "auth failed for token sk-fakeSECRETfakeSECRETfake1234 (401)" };
  }
  if (message.includes(FAKE_PORTFOLIO_FAIL_MARKER)) {
    return { delayMs, code: 1, assistant: null, stderr: "fake portfolio manager: the CLI exited with an error" };
  }
  if (message.includes(FAKE_PORTFOLIO_GARBAGE_MARKER)) {
    return { delayMs, code: 0, assistant: "<portfolio_plan>{\"projects\": [ {\"project\": \"P1\"</portfolio_plan>", stderr: null };
  }
  // Test seam: reports exactly which Brain records the prompt this driver received carried (by the ids and bodies between
  // the fenced markers). The reply is computed from the received prompt, so it is evidence of what reached the driver,
  // not a canned answer. (A board proposal cannot ride on a turn with attached memory; the next turn carries it.)
  if (message.startsWith("__fake_head_context__")) {
    const records = [...prompt.matchAll(/--- BEGIN brain memory (\S+) (\S+) ---\n([\s\S]*?)\n--- END brain memory \1 \2 ---/g)]
      .map((match) => ({ id: match[2]!, tokens: [...new Set(match[3]!.match(/SYNTH-[A-Z0-9-]+/g) ?? [])].sort() }));
    const everyToken = [...new Set(prompt.match(/SYNTH-[A-Z0-9-]+/g) ?? [])].sort();
    const text = `Brain records received: ${records.length}. Tokens in those records: ${records.flatMap((r) => r.tokens).join(", ") || "none"}. Tokens anywhere in the prompt: ${everyToken.join(", ") || "none"}.`;
    return { delayMs, code: 0, assistant: reply(text), stderr: null };
  }
  if (message.startsWith("__fake_head_board__ ")) {
    const action = message.slice("__fake_head_board__ ".length);
    return { delayMs, code: 0, assistant: reply("Review the board proposal.",
      `<head_board_action>${action}</head_board_action>`), stderr: null };
  }
  if (/(estimat|forecast|quota|spent|rework|how long|how much|оцен|прогноз|квот|затрат|переработ|сколько)/i.test(message)) {
    const start = prompt.indexOf("\n### Estimates\n");
    const from = start < 0 ? "" : prompt.slice(start + "\n### Estimates\n".length);
    const end = from.indexOf("\n### ");
    const evidence = (end < 0 ? from : from.slice(0, end)).replace(/\s+/g, " ").trim();
    const markers = ["Usage Analytics evidence", "Forecasts are informational", "synthetic fixture", "A synthetic source is a fixture"]
      .filter(marker => evidence.includes(marker));
    const task = /"taskId":"[0-9a-f-]{36}"/.exec(evidence)?.[0] ?? "";
    return { delayMs, code: 0, assistant: reply(markers.includes("Usage Analytics evidence")
      ? `Usage evidence from stored records: ${[...markers, task, evidence.slice(0, 1500)].filter(Boolean).join(" ")}`
      : "No usage evidence was attached to this message."), stderr: null };
  }
  if (message.startsWith("__fake_head_scope__")) {
    const lines = section(prompt, "Portfolio data").split("\n").filter((line) =>
      /^(Selected context|Workspace registry|Cluster names|Project names|#### P|-( Board counts| Task | Execution | Latest board run| Registry resource)|Registry resource)/.test(line));
    return { delayMs, code: 0, assistant: reply(lines.join("\n\n")), stderr: null };
  }
  const browser = portfolioBrowserReply(prompt, message, delayMs);
  if (browser) return browser;
  const native = portfolioNativeReply(prompt, message, delayMs);
  if (native) return native;
  const projects = projectsOf(prompt);
  const lower = message.toLowerCase();

  if (message.includes(FAKE_PORTFOLIO_BADPLAN_MARKER)) {
    const plan = { title: "Broken", projects: [{ project: "P99", actions: [{ title: "Nothing" }] }] };
    return { delayMs, code: 0, assistant: reply("Here is a plan.", `<portfolio_plan>\n${JSON.stringify(plan)}\n</portfolio_plan>`), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_BADDELEGATION_MARKER)) {
    const body = { delegations: [{ project: "P99", objective: "Ghost", request: "Do something." }] };
    return { delayMs, code: 0, assistant: reply("Here is a request.", `<delegations>\n${JSON.stringify(body)}\n</delegations>`), stderr: null };
  }
  if (message.includes(FAKE_PORTFOLIO_MEMORY_MARKER) || message.includes(FAKE_PORTFOLIO_MEMORY_COMPANY_MARKER)) {
    const projects = projectsOf(prompt);
    const first = projects[0];
    const proposals = [];
    if (message.includes(FAKE_PORTFOLIO_MEMORY_COMPANY_MARKER) || message.includes(FAKE_PORTFOLIO_MEMORY_MARKER)) {
      proposals.push({
        title: "Rejected deployment strategy",
        kind: "decision",
        claim: "owner-stated",
        scope: "company",
        content: "The Owner rejected the proposed deployment strategy because it did not establish an acceptable security boundary.",
        source: "Owner said this in this conversation.",
      });
    }
    if (first && message.includes(FAKE_PORTFOLIO_MEMORY_MARKER) && !message.includes(FAKE_PORTFOLIO_MEMORY_COMPANY_MARKER)) {
      proposals.push({
        title: `${first.name} stays local`,
        kind: "observation",
        claim: "observation",
        scope: "project",
        projectPath: first.path,
        content: `Work for ${first.name} stays on this machine.`,
        source: "Observed in the portfolio snapshot for this turn.",
      });
    }
    return {
      delayMs,
      code: 0,
      assistant: reply("I can suggest memories. Nothing is stored until you approve each one.", `<memory_proposals>\n${JSON.stringify({ proposals })}\n</memory_proposals>`),
      stderr: null,
    };
  }
  if (message.includes(FAKE_PORTFOLIO_BADINITIATIVE_MARKER)) {
    const body = { title: "Bad", goal: "g", projects: [{ project: "P99", objective: "x", request: "y" }] };
    return { delayMs, code: 0, assistant: reply("Here is an initiative.", `<initiative_proposal>\n${JSON.stringify(body)}\n</initiative_proposal>`), stderr: null };
  }

  if (
    message.includes(FAKE_PORTFOLIO_INITIATIVE_MARKER)
    || /(coordinate.*(project|alpha|beta)|cross-project initiative|initiative across|authentication improvements)/i.test(message)
  ) {
    const chosen = projects.slice(0, 2);
    if (chosen.length === 0) return { delayMs, code: 0, assistant: reply("There are no projects for an initiative."), stderr: null };
    const body = {
      title: "Coordinate authentication improvements",
      goal: "Align authentication work across the selected projects",
      description: "Cross-project initiative proposed from the Owner message. Delegations are prepared only after you approve.",
      projects: chosen.map((target) => ({
        project: target.ref,
        objective: `Authentication improvements in ${target.name}`,
        request: `Prepare tasks and plans for authentication improvements in ${target.name}. Do not start runs until the Owner approves.`,
        reason: "The Owner asked Head of PM to coordinate authentication work across projects.",
        context_summary: `${target.name} is in the portfolio snapshot with its project manager.`,
        expected_output: "A task proposal or plan for the Owner to review.",
      })),
    };
    return {
      delayMs,
      code: 0,
      assistant: reply(
        `I propose a cross-project initiative covering ${chosen.map((p) => p.name).join(" and ")}. Nothing is sent to project managers until you approve it.`,
        `<initiative_proposal>\n${JSON.stringify(body)}\n</initiative_proposal>`,
      ),
      stderr: null,
    };
  }

  if (/(delegat|поручи|попроси|ask the manager|manager of)/i.test(message)) {
    if (projects.length === 0) return { delayMs, code: 0, assistant: reply("There are no projects to delegate to."), stderr: null };
    const named = projects.find((item) => lower.includes(item.name.toLowerCase())) ?? projects[0]!;
    const targets = message.includes(FAKE_PORTFOLIO_TWO_MARKER) ? projects.slice(0, 2) : [named];
    const body = {
      delegations: targets.map((target) => ({
        project: target.ref,
        objective: `Check the remaining blockers in ${target.name}`,
        request: `Please review the blocked and waiting tasks of ${target.name} and propose the next steps as a plan.`,
        reason: "The portfolio shows work waiting in this project.",
        context_summary: `${target.name} is part of the portfolio snapshot.`,
        expected_output: "A short plan with the next steps.",
      })),
    };
    return {
      delayMs,
      code: 0,
      assistant: reply(`I suggest asking the project manager of ${targets.map((item) => item.name).join(" and ")}. Nothing is sent until you approve.`, `<delegations>\n${JSON.stringify(body)}\n</delegations>`),
      stderr: null,
    };
  }

  if (/(plan|план)/i.test(message)) {
    const chosen = projects.slice(0, 2);
    if (chosen.length === 0) return { delayMs, code: 0, assistant: reply("There are no projects to plan for."), stderr: null };
    const plan = {
      title: "Plan for today",
      summary: "Focus on unblocking work first.",
      projects: chosen.map((item, index) => ({
        project: item.ref,
        actions: [
          { title: index === 0 ? "Fix the blocking errors" : "Prepare the next execution batch", detail: "Based on the board state.", priority: index === 0 ? "high" : "normal" },
          { title: "Review finished work", detail: "Two tasks wait in Review.", priority: "normal" },
        ],
        depends_on: index === 1 ? [chosen[0]!.ref] : [],
        suggested_harness: index === 0 ? "codex" : "ghost-harness",
        constraints: ["Quota is unknown"],
        expected_effect: null,
        risks: ["Estimates are incomplete"],
        missing_data: ["No confirmed deadlines"],
        owner_approvals: ["Starting any run needs your approval"],
      })),
      risks: ["Harness accounts are not identified and may be shared"],
      missing_data: ["Remaining quota"],
    };
    return { delayMs, code: 0, assistant: reply("Here is a plan across projects.", `<portfolio_plan>\n${JSON.stringify(plan)}\n</portfolio_plan>`), stderr: null };
  }

  if (/(blocked|заблок)/i.test(message)) {
    const lines = prompt.split("\n").filter((line) => line.includes("blocked") || line.includes("Blocked") || line.includes("lifecycle state: paused"));
    return {
      delayMs,
      code: 0,
      assistant: reply(lines.length > 0 ? `Observed blocked work:\n${lines.join("\n")}` : "No blocked tasks are observed in the portfolio data."),
      stderr: null,
    };
  }

  if (/(completed|завершен)/i.test(message)) {
    const lines = prompt.split("\n").filter((line) => line.includes("[done]") || line.includes("Done:") || line.includes("completed"));
    return {
      delayMs,
      code: 0,
      assistant: reply(lines.length > 0 ? `Observed completed work:\n${lines.join("\n")}` : "No completed tasks observed today."),
      stderr: null,
    };
  }

  if (/(remaining|оставш)/i.test(message)) {
    const lines = prompt.split("\n").filter((line) => /\[(backlog|inbox|ready|running|review)\]/.test(line));
    return {
      delayMs,
      code: 0,
      assistant: reply(lines.length > 0 ? `Remaining tasks in scope:\n${lines.join("\n")}` : "No remaining tasks in scope."),
      stderr: null,
    };
  }

  const earlier = section(prompt, "Conversation so far").split("\n").filter((line) => line.startsWith("Owner: ")).length;
  const answers = (section(prompt, "Portfolio data").match(/ — answered: /g) ?? []).length;
  const decisions = section(prompt, "Confirmed decisions").split("\n").filter((line) => line.startsWith("- ")).length;
  const summary = [
    `Portfolio: ${projects.length} project(s)${projects.length > 0 ? ` (${projects.map((item) => `${item.ref} ${item.name}`).join(", ")})` : ""}.`,
    `Answers from project managers: ${answers}.`,
    `Confirmed decisions: ${decisions}.`,
    `Earlier messages: ${earlier}.`,
  ].join(" ");
  const extra = /(decide|решени)/i.test(message) ? "<decisions>\n- Focus on one project at a time\n</decisions>" : "";
  return { delayMs, code: 0, assistant: reply(summary, extra), stderr: null };
}
