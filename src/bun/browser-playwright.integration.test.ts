import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pidsForProfile } from "./browser-engine.ts";
import { BrowserSessionManager, isOwnedProfile } from "./browser-session.ts";

test("a real Chromium session navigates a local fixture and then releases its profile", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-browser01-live-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = `${url.protocol}//${url.host}`;
      if (url.pathname === "/ok") {
        return new Response(`<!doctype html><title>Fixture Page</title><p>Visible greeting</p><a href="${origin}/next">Next</a><a href="https://example.com/out">Out</a><input type="password" value="super-secret-password"><div style="display:none">hidden-token-value</div><script>document.cookie="session=super-secret-cookie"</script>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/next") {
        return new Response("<!doctype html><title>Next Page</title><p>Second page</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/long") {
        return new Response(`<!doctype html><title>Long</title><p>${"a".repeat(20_000)}END_MARKER</p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/redirect-external") return Response.redirect("https://example.com/out", 302);
      if (url.pathname === "/redirect-private") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      if (url.pathname === "/redirect-file") return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
      if (url.pathname === "/redirect-js") return new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } });
      return new Response("missing", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const manager = new BrowserSessionManager({ root, mode: "loopback-fixture" });
  try {
    const session = await manager.create();
    expect(session.agentControl).toBe("unavailable");
    await expect(manager.navigate(session.id, "file:///etc/passwd")).rejects.toMatchObject({ code: "scheme_forbidden" });
    await expect(manager.navigate(session.id, "javascript:alert(1)")).rejects.toMatchObject({ code: "scheme_forbidden" });
    await expect(manager.navigate(session.id, "https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "metadata_endpoint" });
    const opened = await manager.navigate(session.id, `${origin}/ok`);
    expect(opened.approvedOrigins).toEqual([origin]);
    const seen = await manager.observe(session.id);
    expect(seen.title).toBe("Fixture Page");
    expect(seen.visibleText).toContain("Visible greeting");
    expect(seen.visibleText).not.toContain("super-secret-password");
    expect(seen.visibleText).not.toContain("hidden-token-value");
    expect(seen.visibleText).not.toContain("super-secret-cookie");
    expect(JSON.stringify(seen)).not.toContain("super-secret-cookie");
    const next = seen.links.find((link) => link.href.endsWith("/next"));
    const external = seen.links.find((link) => link.href.startsWith("https://example.com/"));
    expect(next?.permitted).toBe(true);
    expect(external?.permitted).toBe(false);
    await expect(manager.openLink(session.id, seen.observationId, external!.id)).rejects.toMatchObject({ code: "origin_not_approved" });
    const moved = await manager.openLink(session.id, seen.observationId, next!.id);
    expect(moved.url).toBe(`${origin}/next`);
    expect((await manager.observe(session.id)).title).toBe("Next Page");
    const back = await manager.back(session.id);
    expect(back.url).toBe(`${origin}/ok`);
    expect((await manager.observe(session.id)).title).toBe("Fixture Page");
    await expect(manager.navigate(session.id, `${origin}/redirect-external`)).rejects.toMatchObject({ code: "redirect_forbidden" });
    await expect(manager.navigate(session.id, `${origin}/redirect-private`)).rejects.toMatchObject({ code: "metadata_endpoint" });
    await expect(manager.navigate(session.id, `${origin}/redirect-file`)).rejects.toMatchObject({ code: "scheme_forbidden" });
    await expect(manager.navigate(session.id, `${origin}/redirect-js`)).rejects.toMatchObject({ code: "scheme_forbidden" });
    await Bun.sleep(150);
    expect((await manager.inspect(session.id)).url).toBe(`${origin}/ok`);
    const long = await manager.navigate(session.id, `${origin}/long`);
    expect(long.url).toBe(`${origin}/long`);
    const bounded = await manager.observe(session.id);
    expect(bounded.textTruncated).toBe(true);
    expect(bounded.visibleText).not.toContain("END_MARKER");
    expect(bounded.textChars).toBeLessThanOrEqual(16_000);
    const shot = await manager.screenshot(session.id);
    expect(Buffer.from(shot.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");
    const profile = path.join(root, session.id);
    expect(isOwnedProfile(root, profile)).toBe(true);
    await manager.close(session.id);
    await manager.close(session.id);
    expect(isOwnedProfile(root, profile)).toBe(false);
    expect(pidsForProfile(profile)).toEqual([]);
  } finally {
    server.stop(true);
    manager.closeSync();
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test("production mode does not open the loopback fixture in a real browser", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-browser01-prod-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("<title>Fixture Page</title><p>Visible greeting</p>", { headers: { "content-type": "text/html" } });
    },
  });
  const manager = new BrowserSessionManager({ root, mode: "production" });
  try {
    const session = await manager.create();
    await expect(manager.navigate(session.id, `http://127.0.0.1:${server.port}/`)).rejects.toMatchObject({ code: "loopback_forbidden" });
    const seen = await manager.observe(session.id);
    expect(seen.title).not.toContain("Fixture Page");
    expect(seen.visibleText).not.toContain("Visible greeting");
    await manager.close(session.id);
  } finally {
    server.stop(true);
    manager.closeSync();
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });
