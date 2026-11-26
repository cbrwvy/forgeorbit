// FO-UX02-D prototype self-check (run from the repo root: bun docs/design/prototypes/fo-ux02d/verify.mjs).
// Contrast of every visible text node in both themes, horizontal overflow at several widths,
// keyboard contract of the variant tabs, finder filter, decision summary. No network, no app data.
import { chromium } from "playwright";
const URL_ = new URL("./index.html", import.meta.url).href;
const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const browser = await chromium.launch(); let failed = 0; const fail = (m) => { failed++; console.log("FAIL", m); };
const errors = [];
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme }); const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_); await page.waitForTimeout(300);
  let worst = { r: 99, t: "" }, n = 0;
  for (const k of ["cur", "A", "B", "C"]) {
    await page.click(`#vt-${k}`);
    const data = await page.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const node = w.currentNode, t = node.textContent.trim(), e = node.parentElement; if (!t || !e || e.closest("script,style,option,.sr-only")) continue; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || !e.getBoundingClientRect().width) continue;
        const chain = []; for (let x = e; x; x = x.parentElement) { const b = getComputedStyle(x).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)") { chain.push(b); if (/^rgb\(/.test(b)) break; } }
        out.push({ t: t.slice(0, 36), color: cs.color, size: parseFloat(cs.fontSize), weight: +cs.fontWeight, chain }); } return { out, bg: getComputedStyle(document.body).backgroundColor }; });
    for (const it of data.out) { let bg = parse(data.bg); for (const c of it.chain.reverse()) bg = over(parse(c), bg); const r = ratio(over(parse(it.color), bg), bg); n++;
      const large = it.size >= 18 || (it.size >= 14 && it.weight >= 700); if (r < (large ? 3 : 4.5)) fail(`${scheme} ${k} contrast ${r.toFixed(2)} "${it.t}" ${it.size}px`); if (r < worst.r) worst = { r, t: it.t }; }
  }
  console.log(`${scheme}: ${n} text samples over 4 variants, min contrast ${worst.r.toFixed(2)} ("${worst.t}")`); await ctx.close();
}
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage(); await p.goto(URL_);
await p.focus("#vt-B"); await p.keyboard.press("ArrowRight"); if ((await p.getAttribute("#vt-C", "aria-selected")) !== "true") fail("ArrowRight on variant tabs");
await p.keyboard.press("Home"); if ((await p.getAttribute("#vt-cur", "aria-selected")) !== "true") fail("Home on variant tabs");
await p.fill("#q", "очередь"); if ((await p.locator("#ftb tr").count()) !== 1) fail("finder filter should leave exactly the queue row");
await p.fill("#q", "zzzz"); if (!(await p.textContent("#ftb")).includes("Ничего не найдено")) fail("finder empty state");
await p.check('input[name="d2"][value="keep"]'); if (!(await p.inputValue("#sum")).includes("d2 New task: Оставить панель")) fail("summary does not follow the answers");
// wireframe interactivity: select a project tab and a rail item
await p.click("#vt-B"); await p.click('#shot [data-t="2"]'); if (!(await p.textContent("#shot .card")).includes("Очередь задач")) fail("project tab content");
await p.click('#shot [data-r="1"]'); if (!(await p.textContent("#shot .ptitle")).includes("Нужно вам")) fail("rail item content");
for (const w of [1440, 1024, 760, 420]) { const c = await browser.newContext({ viewport: { width: w, height: 900 } }); const q = await c.newPage(); await q.goto(URL_);
  const ox = await q.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (ox > 0) fail(`page overflows horizontally by ${ox}px at ${w}`); await c.close(); }
if (errors.length) fail("console/page errors: " + errors.join(" | "));
await browser.close(); console.log(failed ? `${failed} FAILED` : "ALL CHECKS PASSED"); process.exit(failed ? 1 : 0);
