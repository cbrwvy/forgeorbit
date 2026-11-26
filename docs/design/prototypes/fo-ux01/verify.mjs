// FO-UX01 prototype self-check: WCAG contrast of every visible text node (composited over its ancestor backgrounds),
// horizontal overflow, keyboard/focus contract of the Head of PM orb. Run from the repo root:
//   bun docs/design/prototypes/fo-ux01/verify.mjs
// Needs the repo's playwright (node_modules). No network, no AI, no app data.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const URL_ = new URL("./index.html", import.meta.url).href;
const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const browser = await chromium.launch();
let failed = 0;
const fail = (m) => { failed++; console.log("FAIL", m); };
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(URL_ + "?view=project&tab=board&pm=1"); await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Составь план работ" }).click(); await page.waitForTimeout(1300);
  const data = await page.evaluate(() => {
    const out = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const canvas = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim();
    while (walker.nextNode()) {
      const n = walker.currentNode; const t = n.textContent.trim(); const e = n.parentElement; if (!t || !e) continue;
      if (e.closest("script,style,[hidden],.sr-only,option,select")) continue;
      const cs = getComputedStyle(e); if (cs.visibility === "hidden" || cs.display === "none" || e.getBoundingClientRect().width === 0) continue;
      const chain = []; for (let x = e; x; x = x.parentElement) { const b = getComputedStyle(x).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") chain.push(b); if (/rgb\(/.test(b)) break; }
      out.push({ t: t.slice(0, 40), color: cs.color, size: parseFloat(cs.fontSize), weight: +cs.fontWeight, chain, op: +cs.opacity });
    }
    return { out, canvas, bg: getComputedStyle(document.body).backgroundColor };
  });
  let worst = { r: 99 }, n = 0;
  for (const it of data.out) {
    let bg = parse(data.bg); for (const c of it.chain.reverse()) bg = over(parse(c), bg);
    const fg = over(parse(it.color), bg); const r = ratio(fg, bg); n++;
    const large = it.size >= 18 || (it.size >= 14 && it.weight >= 700); const need = large ? 3 : 4.5;
    if (r < need) fail(`${scheme} contrast ${r.toFixed(2)} < ${need} "${it.t}" ${it.size}px`);
    if (r < worst.r) worst = { r, t: it.t };
  }
  console.log(`${scheme}: ${n} text nodes, min contrast ${worst.r.toFixed(2)} ("${worst.t}")`);
  await ctx.close();
}
// keyboard + focus contract
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); await p.goto(URL_ + "?view=project&tab=board");
const open = () => p.evaluate(() => !document.getElementById("pmPanel").hidden);
await p.keyboard.press("Control+j"); if (!(await open())) fail("Ctrl+J does not open the panel");
if ((await p.evaluate(() => document.activeElement.id)) !== "pmInput") fail("focus not moved to composer on open");
await p.keyboard.press("Escape"); if (await open()) fail("Esc does not close the panel");
if ((await p.evaluate(() => document.activeElement.id)) !== "orb") fail("focus not returned to orb on close");
await p.keyboard.press("Enter"); if (!(await open())) fail("Enter on focused orb does not open the panel");
await p.keyboard.press("ArrowRight"); /* radiogroup is not focused yet: Tab to it */
await p.locator('#pmSeg [role=radio][aria-checked=true]').focus(); await p.keyboard.press("ArrowRight");
if ((await p.getAttribute('#pmSeg [data-ctx=all]', "aria-checked")) !== "true") fail("ArrowRight does not switch context to All projects");
const sub = await p.textContent("#pmSub"); if (!/все проекты/i.test(sub)) fail("context label not updated: " + sub);
await p.keyboard.press("Escape");
await p.locator("#orb").focus(); await p.keyboard.press("Shift+ArrowLeft"); if ((await p.getAttribute("#orb", "data-corner")) !== "bl") fail("Shift+Arrow does not move the orb");
// Owner gate: approving a proposal is an explicit click; nothing is created before.
await p.goto(URL_ + "?view=project&tab=board&pm=1"); const before = await p.locator(".task").count();
await p.getByRole("button", { name: "Составь план работ" }).click(); await p.waitForTimeout(1300);
if ((await p.locator(".task").count()) !== before) fail("tasks created before Owner approval");
await p.getByRole("button", { name: "Одобрить и создать" }).click(); await p.waitForTimeout(200);
if ((await p.locator(".task").count()) <= before) fail("approval did not create tasks");
// orb states
for (const s of ["idle", "thinking", "working", "needs-owner", "error"]) { await p.selectOption("#dtOrb", s); const l = await p.getAttribute("#orb", "aria-label"); if (!l.includes("Состояние")) fail("orb label missing state " + s); }
// reduced motion: no running animations on the orb
const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" }); const rp = await rm.newPage(); await rp.goto(URL_ + "?orb=thinking");
const dur = await rp.evaluate(() => getComputedStyle(document.querySelector("#orb .ring")).animationDuration); if (parseFloat(dur) > 0.001) fail("reduced-motion not honoured: " + dur);
// details panel open: the orb is anchored to the work column and never covers the panel
{ const c = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const q = await c.newPage(); await q.goto(URL_ + "?view=project&tab=board");
  await q.locator('[data-open="t4"]').click(); await q.waitForTimeout(400);
  const ins = await q.locator("#inspector").boundingBox(); const orb = await q.locator("#orb").boundingBox();
  if (ins && orb && orb.x + orb.width > ins.x) fail("orb overlaps the open details panel"); await c.close(); }
// overflow at several widths
for (const w of [1440, 1100, 820, 600, 420]) { const c = await browser.newContext({ viewport: { width: w, height: 800 } }); const q = await c.newPage(); await q.goto(URL_ + "?view=project&tab=board&pm=1");
  const ox = await q.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (ox > 0) fail(`horizontal overflow ${ox}px at ${w}px`);
  const orb = await q.locator("#orb").boundingBox(); const pn = await q.locator("#pmPanel").boundingBox(); const send = await q.locator("#pmForm button[type=submit]").boundingBox();
  const hid = await q.evaluate(() => getComputedStyle(document.getElementById("orb")).visibility === "hidden");
  if (!hid && orb && send && !(orb.x + orb.width < send.x || send.x + send.width < orb.x || orb.y + orb.height < send.y || send.y + send.height < orb.y)) fail(`orb overlaps Send at ${w}px`);
  await c.close(); }
await browser.close(); console.log(failed ? `${failed} FAILED` : "ALL CHECKS PASSED"); process.exit(failed ? 1 : 0);
