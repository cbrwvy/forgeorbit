/**
 * FO-BROWSER01 Playwright Chromium launcher.
 * Each session gets its own profile directory. The browser is not the Owner's
 * Chrome or Safari, and no remote-debugging port is opened.
 */

import { spawnSync } from "node:child_process";
import type { BrowserContext, Page } from "playwright";
import { addressDecision, type BrowserPolicyMode, type DestinationDecision } from "../shared/browser/policy.ts";
import { BROWSER_LIMITS } from "../shared/browser/types.ts";
import { loginLabel, type BrowserTaskAction, type TaskComputerOutcome } from "../shared/task-computer-workflow.ts";
import { BrowserSessionError } from "./browser-session-error.ts";
import { resolveChromiumRuntime } from "./browser-runtime.ts";

export const BROWSER_ISOLATION_ARGS = [
  "--disable-extensions",
  "--disable-sync",
  "--disable-translate",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication",
  "--password-store=basic",
  "--use-mock-keychain",
] as const;

const DOWNLOAD_REFUSAL: DestinationDecision = {
  ok: false,
  code: "download_forbidden",
  error: "File downloads are blocked in this session. Nothing was saved.",
};

export const BLOCKED_PAGE_TEXT = "The page tried to open a destination this session blocks, so the browser replaced it with an error page. There is no page content to read.";

export interface PageRead {
  /** The address the browser document actually has. A browser error page reports chrome-error://. */
  href?: string;
  title: string;
  text: string;
  textTruncated: boolean;
  links: { href: string; text: string }[];
  linksTruncated: boolean;
}

export interface BrowserController {
  pid: number | null;
  currentUrl(): string;
  goto(url: string, guard: (url: string) => Promise<DestinationDecision>): Promise<DestinationDecision>;
  read(): Promise<PageRead>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
  useTaskScope?(admit: () => void): Promise<void>;
  taskAction?(action: Exclude<BrowserTaskAction, { kind: "navigate" }>, value: string | undefined, confirmAfterSubmit: string | null, admit: () => void): Promise<TaskComputerOutcome | null>;
  taskObservation?(expected: string): Promise<{ outcome: TaskComputerOutcome; observed?: string }>;
  taskScreenshot?(values: string[]): Promise<Uint8Array>;
}

export interface BrowserEngine {
  launch(profileDir: string, mode: BrowserPolicyMode): Promise<BrowserController>;
}

export function chromiumIsolationOptions(profileDir: string, executablePath?: string) {
  return {
    headless: true as const,
    acceptDownloads: false as const,
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: true,
    serviceWorkers: "block" as const,
    ignoreHTTPSErrors: false,
    bypassCSP: false,
    userDataDir: profileDir,
    channel: undefined,
    executablePath: executablePath || undefined,
    args: [...BROWSER_ISOLATION_ARGS],
    env: {
      HOME: profileDir,
      TMPDIR: profileDir,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
    },
  };
}

export function pidsForProfile(profileDir: string): number[] {
  if (!profileDir.includes("brw_")) return [];
  const result = spawnSync("/bin/ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  const pids: number[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(profileDir)) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

export async function createPlaywrightBrowserEngine(options?: { executablePath?: string }): Promise<BrowserEngine> {
  const runtime = options?.executablePath
    ? { executablePath: options.executablePath }
    : resolveChromiumRuntime();
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new BrowserSessionError("Playwright is not available to this ForgeOrbit process.", 503, "browser_runtime_unavailable");
  }
  const chromium = playwright.chromium;
  return {
    async launch(profileDir: string, mode: BrowserPolicyMode): Promise<BrowserController> {
      let context: BrowserContext;
      try {
        context = await chromium.launchPersistentContext(profileDir, chromiumIsolationOptions(profileDir, runtime.executablePath));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/Executable doesn't exist|Failed to launch|browserType\.launch|ENOENT/i.test(message)) {
          throw new BrowserSessionError("The Playwright Chromium runtime is not installed for this process.", 503, "browser_runtime_unavailable");
        }
        throw new BrowserSessionError("The browser process failed to start.", 500, "browser_crashed");
      }
      const page = context.pages()[0] ?? await context.newPage();
      const controller = new PlaywrightController(context, page, mode, profileDir);
      await controller.install();
      controller.pid = pidsForProfile(profileDir)[0] ?? null;
      return controller;
    },
  };
}

class PlaywrightController implements BrowserController {
  pid: number | null = null;
  private guard: (url: string) => Promise<DestinationDecision> = async () => ({
    ok: false,
    code: "invalid_request",
    error: "Navigation has not been requested.",
  });
  private blocked: DestinationDecision | null = null;
  private rebinding: DestinationDecision | null = null;
  private downloadRefused = false;
  private allowBlank = false;
  private lastGood: string | null = null;
  private closed = false;
  private taskAdmission: (() => void) | null = null;
  private taskSubmission: { url: string; method: string; claimed: boolean } | null = null;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly mode: BrowserPolicyMode,
    private readonly profileDir: string,
  ) {}

  async install(): Promise<void> {
    this.page.on("download", (download) => {
      this.downloadRefused = true;
      void download.cancel().catch(() => undefined);
    });
    this.page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
    this.page.on("frameattached", () => {
      if (this.taskAdmission) this.blockTaskContext();
    });
    this.context.on("page", page => {
      if (!this.taskAdmission || page === this.page) return;
      this.blockTaskContext();
      void page.close().catch(() => undefined);
    });
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = request.url();
      if (this.taskAdmission) {
        let mainFrame = false;
        try { mainFrame = request.frame() === this.page.mainFrame(); } catch { /* A new tab has no verified frame yet. */ }
        if (!mainFrame) {
          this.blockTaskContext();
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
      }
      if (this.allowBlank && requestUrl === "about:blank") {
        await route.continue();
        return;
      }
      const decision = await this.guard(requestUrl);
      if (!decision.ok) {
        this.blocked = decision;
        await route.abort("blockedbyclient");
        return;
      }
      if (this.taskAdmission && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        const permit = this.taskSubmission;
        if (!permit || permit.claimed || permit.method !== request.method() || permit.url !== requestUrl) {
          this.blockTaskContext();
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        permit.claimed = true;
      }
      // Fetch one hop. Chromium can follow a redirect before Playwright
      // reports the next request, so a forbidden Location is refused here.
      let response;
      try {
        this.taskAdmission?.();
        response = await route.fetch({ maxRedirects: 0 });
      } catch {
        await route.abort("failed").catch(() => undefined);
        return;
      }
      const location = response.headers()["location"];
      if (location && response.status() >= 300 && response.status() < 400) {
        let next = location;
        try { next = new URL(location, requestUrl).href; } catch { /* the guard rejects the raw value */ }
        const hop = await this.guard(next);
        if (!hop.ok) {
          this.blocked = hop.code === "origin_not_approved"
            ? { ok: false, code: "redirect_forbidden", error: "The page redirected outside this session's approved destinations." }
            : hop;
          await route.abort("blockedbyclient");
          return;
        }
      }
      // A file download is refused before Chromium receives the bytes. Without
      // this the navigation ended in a thrown "Download is starting" error that
      // the session reported as a crashed browser.
      if (/^\s*attachment\b/i.test(response.headers()["content-disposition"] ?? "")) {
        this.blocked = DOWNLOAD_REFUSAL;
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({ response }).catch(() => undefined);
    });
    try {
      const cdp = await this.context.newCDPSession(this.page);
      await cdp.send("Network.enable");
      cdp.on("Network.responseReceived", (event: { response?: { remoteIPAddress?: string } }) => {
        const ip = event.response?.remoteIPAddress;
        if (!ip) return;
        const decision = addressDecision(ip, this.mode);
        if (!decision.ok) {
          this.rebinding = { ok: false, code: "dns_rebinding", error: "The connection reached a blocked address." };
        }
      });
    } catch {
      // URL and DNS checks still apply. This session does not listen on a debugging port.
    }
  }

  currentUrl(): string {
    return this.page.url();
  }

  async goto(url: string, guard: (url: string) => Promise<DestinationDecision>): Promise<DestinationDecision> {
    this.guard = guard;
    if (this.taskAdmission && this.refusal()) return this.refusal()!;
    this.blocked = null;
    this.rebinding = null;
    this.downloadRefused = false;
    const decided = await guard(url);
    if (!decided.ok) return decided;
    try {
      this.taskAdmission?.();
      await this.page.goto(decided.url, { waitUntil: "domcontentloaded", timeout: BROWSER_LIMITS.navigationTimeoutMs });
    } catch (error) {
      // A download that Chromium starts on its own (no attachment header, such as an
      // octet-stream body) surfaces as an aborted navigation plus a download event.
      if (!this.refusal() && /Download is starting|ERR_ABORTED/i.test(error instanceof Error ? error.message : "")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (this.downloadRefused) this.blocked = DOWNLOAD_REFUSAL;
      }
      const reason = this.refusal();
      if (!this.taskAdmission) await this.restore();
      if (reason) return reason;
      throw new BrowserSessionError("The browser process failed.", 500, "browser_crashed");
    }
    const landed = await guard(this.page.url());
    const reason = this.rebinding ?? this.blocked ?? (!landed.ok ? landed : null);
    if (reason && !reason.ok) {
      if (!this.taskAdmission) await this.restore();
      return reason;
    }
    this.lastGood = this.page.url();
    return { ok: true, url: this.lastGood, origin: new URL(this.lastGood).origin, host: new URL(this.lastGood).hostname };
  }

  async useTaskScope(admit: () => void) {
    this.taskAdmission = admit;
    await this.context.routeWebSocket("**/*", socket => {
      this.blockTaskContext();
      return socket.close();
    });
  }

  private blockTaskContext() {
    this.blocked = { ok: false, code: "origin_not_approved", error: "The task blocked a tab, frame or request outside its scope." };
  }

  private async taskPageOutcome(): Promise<TaskComputerOutcome | null> {
    if (this.refusal() || this.page.frames().length !== 1) return "scope";
    const destination = await this.guard(this.page.url());
    if (!destination.ok) return "scope";
    const credentials = this.page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible, input[autocomplete="current-password"]:visible, input[autocomplete="username"]:visible');
    const loginHeading = this.page.getByRole("heading", { name: /^(?:sign in|log in|login|вход|войти)(?:$|\s)/i });
    return await credentials.count() || await loginHeading.count() ? "login" : null;
  }

  async taskAction(action: Exclude<BrowserTaskAction, { kind: "navigate" }>, value: string | undefined, confirmAfterSubmit: string | null, admit: () => void): Promise<TaskComputerOutcome | null> {
    const pageIssue = await this.taskPageOutcome();
    if (pageIssue) return pageIssue;
    if (loginLabel(action.label)) return "login";
    const timeout = 4500;
    try {
      if (action.kind === "link") {
        const link = this.page.getByRole("link", { name: action.label, exact: true });
        if (await link.count() !== 1 || !await link.isVisible()) return "control";
        const href = await link.evaluate(el => el instanceof HTMLAnchorElement && (!el.target || el.target === "_self") && !el.hasAttribute("download") ? el.href : null);
        if (!href) return "scope";
        admit();
        return (await this.goto(href, this.guard)).ok ? null : "scope";
      }
      if (action.kind === "fill") {
        if (value === undefined) return "scope";
        const fields = await this.page.getByLabel(action.label, { exact: true }).elementHandles();
        const [field] = fields;
        if (fields.length !== 1 || !field || !await field.isVisible()) return "control";
        const plain = await field.evaluate(el => (el instanceof HTMLTextAreaElement ||
          el instanceof HTMLInputElement && ["text", "email", "tel", "number", "search", "url"].includes(el.type))
          && !/password|one-time-code|credit-card|cc-/i.test(el.getAttribute("autocomplete") ?? ""));
        if (!plain) return "login";
        const fresh = await this.taskPageOutcome();
        if (fresh) return fresh;
        admit();
        await field.fill(value, { timeout });
        return this.taskPageOutcome();
      }
      const buttons = await this.page.getByRole("button", { name: action.label, exact: true }).elementHandles();
      const [button] = buttons;
      if (buttons.length !== 1 || !button || !await button.isVisible()) return "control";
      const form = await button.evaluate(el => {
        if (!(el instanceof HTMLButtonElement || el instanceof HTMLInputElement) || el.type !== "submit" || !el.form) return null;
        return {
          url: el.hasAttribute("formaction") ? el.formAction : el.form.action,
          method: (el.hasAttribute("formmethod") ? el.formMethod : el.form.method).toUpperCase(),
          target: el.hasAttribute("formtarget") ? el.formTarget : el.form.target,
        };
      });
      if (action.kind === "submit") {
        if (!confirmAfterSubmit) return "read-only";
        if (!form || form.method !== "POST" || (form.target && form.target !== "_self") || !(await this.guard(form.url)).ok) return "scope";
        if (await this.taskConfirmationVisible(confirmAfterSubmit)) return "existing-confirmation";
      } else if (form) {
        return "read-only";
      }
      const fresh = await this.taskPageOutcome();
      if (fresh) return fresh;
      admit();
      // Keep the one exact POST authorized until verification settles because
      // the form's approved request may be delivered after the action resolves.
      if (action.kind === "submit" && form) this.taskSubmission = { url: form.url, method: form.method, claimed: false };
      await button.click({ timeout });
      return this.taskPageOutcome();
    } catch {
      admit();
      return this.refusal() ? "scope" : "control";
    }
  }

  private async taskConfirmationVisible(expected: string): Promise<boolean> {
    return (await this.page.getByText(expected, { exact: true }).filter({ visible: true }).count()) > 0;
  }

  async taskObservation(expected: string): Promise<{ outcome: TaskComputerOutcome; observed?: string }> {
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const problem = await this.taskPageOutcome();
      if (problem) return { outcome: problem };
      const invalid = await this.page.locator(':is(input,textarea,select):invalid:visible').first().evaluate(el =>
        (el as HTMLInputElement).validationMessage.slice(0, 240), undefined, { timeout: 300 }).catch(() => "");
      const alert = await this.page.locator('[role="alert"]:visible, [aria-invalid="true"]:visible').first().innerText({ timeout: 300 }).catch(() => null);
      if (invalid || alert?.trim()) return { outcome: "validation", observed: invalid || alert?.trim().slice(0, 240) };
      if ((!this.taskSubmission || this.taskSubmission.claimed) &&
        await this.taskConfirmationVisible(expected)) {
        return { outcome: "verified", observed: expected };
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return { outcome: "missing-confirmation" };
  }

  async taskScreenshot(values: string[]): Promise<Uint8Array> {
    if (await this.taskPageOutcome()) return new Uint8Array();
    const mask = [this.page.locator("input, textarea, select, [contenteditable], iframe, canvas, video")];
    for (const value of values) if (value.trim()) mask.push(this.page.getByText(value, { exact: false }));
    const bytes = await this.page.screenshot({ type: "png", animations: "disabled", timeout: 2500, mask });
    return bytes.byteLength <= BROWSER_LIMITS.maxScreenshotBytes ? bytes : new Uint8Array();
  }

  async read(): Promise<PageRead> {
    const read = await this.page.evaluate(readVisiblePage, {
      maxText: BROWSER_LIMITS.maxVisibleTextChars,
      maxLinks: BROWSER_LIMITS.maxLinks,
      maxLinkText: BROWSER_LIMITS.maxLinkTextChars,
      maxTitle: BROWSER_LIMITS.maxTitleChars,
    });
    // A page that tries to open a blocked destination on its own (a script or a meta refresh)
    // is replaced by Chromium's error page. That page is the browser's text in the browser's
    // language, and the session's recorded address is no longer where the browser is.
    // Report what happened instead of presenting the error page as the page reached.
    if (read.href?.startsWith("chrome-error:")) {
      return { href: read.href, title: "", text: BLOCKED_PAGE_TEXT, textTruncated: false, links: [], linksTruncated: false };
    }
    return read;
  }

  async screenshot(): Promise<Uint8Array> {
    const bytes = await this.page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide", timeout: 10_000 });
    if (bytes.byteLength > BROWSER_LIMITS.maxScreenshotBytes) return new Uint8Array();
    return bytes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.race([
      this.context.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    for (const pid of pidsForProfile(this.profileDir)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
    }
  }

  private refusal(): DestinationDecision | null {
    const reason = this.rebinding ?? this.blocked;
    return reason !== null && reason.ok === false ? reason : null;
  }

  private async restore(): Promise<void> {
    try {
      if (this.lastGood) {
        await this.page.goto(this.lastGood, { waitUntil: "domcontentloaded", timeout: BROWSER_LIMITS.navigationTimeoutMs });
        return;
      }
      this.allowBlank = true;
      await this.page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
    } catch {
      // The caller marks the session failed when the process is gone.
    } finally {
      this.allowBlank = false;
    }
  }
}

function readVisiblePage(limits: { maxText: number; maxLinks: number; maxLinkText: number; maxTitle: number }): PageRead {
  const visible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const rawText = document.body?.innerText ?? "";
  const textTruncated = rawText.length > limits.maxText;
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const links: { href: string; text: string }[] = [];
  let linksTruncated = false;
  for (const anchor of anchors) {
    if (!visible(anchor)) continue;
    const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
    if (!href) continue;
    if (links.length >= limits.maxLinks) {
      linksTruncated = true;
      break;
    }
    const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limits.maxLinkText);
    links.push({ href, text });
  }
  return {
    href: location.href,
    title: (document.title ?? "").slice(0, limits.maxTitle),
    text: rawText.slice(0, limits.maxText),
    textTruncated,
    links,
    linksTruncated,
  };
}
