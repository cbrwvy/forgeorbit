// FO-UX02-D: recomputes the numbers shown in index.html / fo-ux02d-ia-proposal.md.
//   node docs/design/prototypes/fo-ux02d/metrics.mjs     (from the repo root; no dependencies, no network)
import { readFileSync, readdirSync } from "node:fs";
const here = new URL(".", import.meta.url);
const html = readFileSync(new URL("index.html", here), "utf8");
const { FUNCS, DECISIONS } = new Function(html.split("/*DATA*/")[1].split("/*END*/")[0] + ";return {FUNCS,DECISIONS}")();
const keys = ["cur", "A", "B", "C"], idx = { cur: 3, A: 4, B: 5, C: 6 };
const wsum = FUNCS.reduce((s, f) => s + f[2], 0);
console.log(`functions: ${FUNCS.length}`);
for (const k of keys) {
  const clicks = FUNCS.reduce((s, f) => s + f[idx[k]].length, 0), weighted = FUNCS.reduce((s, f) => s + f[idx[k]].length * f[2], 0);
  const better = FUNCS.filter((f) => f[idx[k]].length < f[3].length).length, worse = FUNCS.filter((f) => f[idx[k]].length > f[3].length).length;
  console.log(`${k.padEnd(4)} avg clicks ${(clicks / FUNCS.length).toFixed(2)}  weighted ${(weighted / wsum).toFixed(2)}  shorter ${better}  longer ${worse}`);
}
const e2eDir = new URL("../../../../e2e/", here);
const specs = readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts")).map((f) => [f, readFileSync(new URL(f, e2eDir), "utf8")]);
const A = "new-task-panel|project-new-task|manager-tab-(chat|autonomy)";
const B = `${A}|project-page-(estimates|environment|knowledge|manager)|workspace-(clusters|knowledge|all-tasks)|global-open-board`;
const C = `${B}|project-page-(overview|board)|workspace-(company|portfolio|overview)`;
for (const [n, re] of [["A", A], ["B", B], ["C", C]]) console.log(`${n} e2e specs touching moved elements: ${specs.filter(([, s]) => new RegExp(re).test(s)).length} / ${specs.length}`);
console.log(`decisions: ${DECISIONS.length}`);
