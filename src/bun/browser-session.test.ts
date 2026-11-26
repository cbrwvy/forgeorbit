import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BROWSER_ISOLATION_ARGS, chromiumIsolationOptions, type BrowserController, type BrowserEngine, type PageRead } from "./browser-engine.ts";
import { browserHttp } from "./browser-http.ts";
import { BrowserSessionManager, isOwnedProfile, type BrowserJournalEvent } from "./browser-session.ts";
import { BROWSER_LIMITS } from "../shared/browser/types.ts";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "fo-browser01-"));
}

function controller(pages: Map<string, PageRead>, stats: { goto: number; inFlight: number; max: number; crash: boolean }): BrowserController {
  let current = "about:blank";
  return {
    pid: null,
    currentUrl: () => current,
    async goto(url, guard) {
      stats.inFlight += 1;
      stats.max = Math.max(stats.max, stats.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stats.inFlight -= 1;
      stats.goto += 1;
      if (stats.crash) throw new Error("browser crashed");
      const decision = await guard(url);
      if (!decision.ok) return decision;
      if (url.endsWith("/redirect-external")) return guard("https://example.com/out");
      current = decision.url;
      return decision;
    },
    async read() {
      return pages.get(current) ?? { title: "", text: "", textTruncated: false, links: [], linksTruncated: false };
    },
    async screenshot() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
    async close() {},
  };
}

function harness(mode: "production" | "loopback-fixture" = "production") {
  const root = tempRoot();
  const pages = new Map<string, PageRead>();
  const stats = { goto: 0, inFlight: 0, max: 0, crash: false, launches: 0 };
  const events: BrowserJournalEvent[] = [];
  let now = 1_000_000;
  const engine: BrowserEngine = {
    async launch(profileDir) {
      stats.launches += 1;
      expect(profileDir.startsWith(root)).toBe(true);
      expect(profileDir).not.toContain("Google/Chrome");
      expect(profileDir).not.toContain("Safari");
      return controller(pages, stats);
    },
  };
  const manager = new BrowserSessionManager({
    root,
    mode,
    engine,
    now: () => now,
    journal: (event) => events.push(event),
    resolveHost: async () => ["93.184.216.34"],
  });
  return { root, pages, stats, events, manager, advance: (ms: number) => { now += ms; } };
}

test("a session launches an isolated profile and records creation without page content", async () => {
  const { manager, events, root, stats } = harness();
  const session = await manager.create();
  expect(session.state).toBe("active");
  expect(session.ownerId).toBe("owner");
  expect(session.agentControl).toBe("unavailable");
  expect(session.storage).toBe("ephemeral-session-profile");
  expect(stats.launches).toBe(1);
  expect(events.map((event) => event.eventType)).toEqual(["browser.session.created"]);
  expect(JSON.stringify(events)).not.toContain("cookie");
  expect(isOwnedProfile(root, path.join(root, session.id))).toBe(true);
  const options = chromiumIsolationOptions(path.join(root, session.id));
  expect(options.channel).toBeUndefined();
  expect(options.executablePath).toBeUndefined();
  expect(options.acceptDownloads).toBe(false);
  expect(options.env.HOME).toBe(path.join(root, session.id));
  expect(BROWSER_ISOLATION_ARGS.join(" ")).toContain("--use-mock-keychain");
  expect(BROWSER_ISOLATION_ARGS.join(" ")).toContain("--password-store=basic");
  expect(BROWSER_ISOLATION_ARGS.join(" ")).not.toContain("remote-debugging-port");
});

test("production mode refuses private, loopback, file, and javascript destinations before navigation", async () => {
  const { manager, stats, events } = harness("production");
  const session = await manager.create();
  for (const url of ["http://127.0.0.1:9/ok", "https://10.1.1.1/", "https://192.168.0.8/", "file:///etc/passwd", "javascript:alert(1)"]) {
    await expect(manager.navigate(session.id, url)).rejects.toMatchObject({ status: 400 });
  }
  expect(stats.goto).toBe(0);
  expect(events.some((event) => event.eventType === "browser.navigation.refused")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("/etc/passwd");
  expect(JSON.stringify(events)).not.toContain("alert");
});

test("fixture mode can open loopback HTTP and production mode cannot", async () => {
  const fixture = harness("loopback-fixture");
  const session = await fixture.manager.create();
  fixture.pages.set("http://127.0.0.1:9/ok", { title: "Fixture", text: "hello", textTruncated: false, links: [], linksTruncated: false });
  const opened = await fixture.manager.navigate(session.id, "http://127.0.0.1:9/ok");
  expect(opened.url).toBe("http://127.0.0.1:9/ok");
  expect(opened.approvedOrigins).toEqual(["http://127.0.0.1:9"]);

  const production = harness("production");
  const blocked = await production.manager.create();
  await expect(production.manager.navigate(blocked.id, "http://127.0.0.1:9/ok")).rejects.toMatchObject({ code: "loopback_forbidden" });
  expect(production.stats.goto).toBe(0);
});

test("link navigation stays on the approved origin and back returns to the previous page", async () => {
  const { manager, pages } = harness("loopback-fixture");
  const session = await manager.create();
  const origin = "http://127.0.0.1:9";
  pages.set(`${origin}/ok`, {
    title: "Fixture Page",
    text: "Visible greeting",
    textTruncated: false,
    links: [
      { href: `${origin}/next`, text: "Next" },
      { href: "https://example.com/out", text: "Out" },
    ],
    linksTruncated: false,
  });
  pages.set(`${origin}/next`, { title: "Next Page", text: "Second", textTruncated: false, links: [], linksTruncated: false });
  await manager.navigate(session.id, `${origin}/ok`);
  const seen = await manager.observe(session.id);
  expect(seen.title).toBe("Fixture Page");
  expect(seen.visibleText).toBe("Visible greeting");
  expect(seen.untrusted).toBe(true);
  expect(seen.links.map((link) => link.permitted)).toEqual([true, false]);
  expect(seen.visibleText).not.toContain("cookie");
  const shot = await manager.screenshot(session.id);
  expect(shot[0]).toBe(0x89);
  await expect(manager.openLink(session.id, seen.observationId, "l2")).rejects.toMatchObject({ code: "origin_not_approved" });
  const next = await manager.openLink(session.id, seen.observationId, "l1");
  expect(next.url).toBe(`${origin}/next`);
  const back = await manager.back(session.id);
  expect(back.url).toBe(`${origin}/ok`);
  await expect(manager.navigate(session.id, `${origin}/redirect-external`)).rejects.toMatchObject({ code: "redirect_forbidden" });
  expect((await manager.inspect(session.id)).url).toBe(`${origin}/ok`);
});

test("commands for one session do not overlap", async () => {
  const { manager, pages, stats } = harness("production");
  const session = await manager.create();
  pages.set("https://public.example/a", { title: "A", text: "A", textTruncated: false, links: [], linksTruncated: false });
  pages.set("https://public.example/b", { title: "B", text: "B", textTruncated: false, links: [], linksTruncated: false });
  await Promise.all([
    manager.navigate(session.id, "https://public.example/a"),
    manager.navigate(session.id, "https://public.example/b"),
  ]);
  expect(stats.max).toBe(1);
});

test("an idle session expires without being recreated", async () => {
  const { manager, advance, stats } = harness();
  const session = await manager.create();
  advance(BROWSER_LIMITS.idleTimeoutMs + 1);
  await expect(manager.navigate(session.id, "https://public.example/")).rejects.toMatchObject({ code: "session_expired" });
  const closed = await manager.inspect(session.id);
  expect(closed.state).toBe("closed");
  expect(stats.launches).toBe(1);
});

test("a browser crash is recorded and not relaunched", async () => {
  const { manager, stats } = harness();
  const session = await manager.create();
  stats.crash = true;
  await expect(manager.navigate(session.id, "https://public.example/")).rejects.toMatchObject({ code: "browser_crashed" });
  await expect(manager.observe(session.id)).rejects.toMatchObject({ code: "session_failed" });
  expect(stats.launches).toBe(1);
});

test("closing a session removes only its profile and can be repeated", async () => {
  const { manager, root, events } = harness();
  const session = await manager.create();
  const sibling = path.join(root, "keep.txt");
  writeFileSync(sibling, "keep");
  const profile = path.join(root, session.id);
  writeFileSync(path.join(profile, "cookie.txt"), "session-cookie");
  const closed = await manager.close(session.id);
  expect(closed.state).toBe("closed");
  expect(await manager.close(session.id)).toMatchObject({ state: "closed" });
  expect(readFileSync(sibling, "utf8")).toBe("keep");
  expect(isOwnedProfile(root, profile)).toBe(false);
  expect(events.filter((event) => event.eventType === "browser.session.closed")).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("restart marks a leftover session interrupted and does not launch a browser", async () => {
  const root = tempRoot();
  const id = "brw_0123456789abcdef0123456789abcdef";
  const profile = path.join(root, id);
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "marker.txt"), "profile");
  writeFileSync(path.join(root, "registry.json"), JSON.stringify({
    sessions: [{ id, createdAt: 10, state: "active", profileDir: profile, pid: process.pid }],
  }));
  const events: BrowserJournalEvent[] = [];
  let launches = 0;
  const manager = new BrowserSessionManager({
    root,
    engine: { async launch() { launches += 1; throw new Error("should not launch"); } },
    journal: (event) => events.push(event),
  });
  await manager.reconcileInterrupted();
  expect(launches).toBe(0);
  expect(process.pid).toBeGreaterThan(1);
  const inspected = await manager.inspect(id);
  expect(inspected.state).toBe("failed");
  expect(events.map((event) => event.eventType)).toEqual(["browser.session.interrupted"]);
  expect(isOwnedProfile(root, profile)).toBe(false);
  await manager.reconcileInterrupted();
  expect(events).toHaveLength(1);
});

test("the HTTP API requires authentication and rejects unknown sessions and unknown fields", async () => {
  const { manager } = harness();
  const unauthorized = await browserHttp(new Request("http://127.0.0.1/browser/sessions", { method: "POST", body: "{}" }), false, { manager });
  expect(unauthorized.status).toBe(401);
  const missing = await browserHttp(new Request("http://127.0.0.1/browser/sessions/brw_0123456789abcdef0123456789abcdef"), true, { manager });
  expect(missing.status).toBe(404);
  const widened = await browserHttp(new Request("http://127.0.0.1/browser/sessions", {
    method: "POST",
    body: JSON.stringify({ allowLoopback: true }),
  }), true, { manager });
  expect(widened.status).toBe(400);
  const created = await browserHttp(new Request("http://127.0.0.1/browser/sessions", { method: "POST", body: "{}" }), true, { manager });
  expect(created.status).toBe(201);
  const again = await browserHttp(new Request("http://127.0.0.1/browser/sessions", { method: "POST", body: "{}" }), true, { manager });
  expect(again.status).toBe(409);
});

test("browser control does not import agent execution", () => {
  for (const file of ["browser-session.ts", "browser-engine.ts", "browser-http.ts", "browser-agent.ts"]) {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    expect(source).not.toContain("spawnAgent");
    expect(source).not.toContain("openai");
    expect(source).not.toContain("anthropic");
    expect(source).not.toContain("orchestrator");
  }
});
