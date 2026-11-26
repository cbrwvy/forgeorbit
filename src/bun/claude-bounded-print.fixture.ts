/** Offline executable: never invokes an AI provider. Used only by adapter tests. */
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("2.1.318-offline-fixture"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("Offline Claude fixture --print --max-turns --max-budget-usd"); process.exit(0); }
if (process.argv[2] === "auth" && process.argv[3] === "status") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: process.env.CLAUDE_CONFIG_DIR })); process.exit(0); }
const prompt = await Bun.stdin.text();
appendFileSync(".fixture-launches", JSON.stringify({ argv: process.argv.slice(2), prompt, orchestrationTokenPresent: !!process.env.AGETOR_API_TOKEN,
  home: process.env.HOME, configDirectory: process.env.CLAUDE_CONFIG_DIR }) + "\n");
const scenario = prompt.match(/fixture-case:(\S+)/)?.[1] ?? "success";
const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
const emit = (event: unknown) => console.log(JSON.stringify(event));
if (scenario === "delayed") await Bun.sleep(700);
if (scenario === "timeout") await Bun.sleep(60_000);
if (scenario === "malformed") { console.log("not-json"); process.exit(0); }
emit({ type: "system", subtype: "init", model: scenario === "model-mismatch" ? "other-model" : value("--model"), tools: scenario === "advertised-shell" ? ["Bash"] : value("--tools")?.split(",") });
if (scenario === "no-result") process.exit(0);
console.error("offline fixture stderr");
emit({ type: "assistant", message: { model: scenario === "model-fallback" ? "other-model" : value("--model"), content: scenario === "forbidden-tool" ? [{ type: "tool_use", name: "Bash", id: "forbidden", input: {} }]
  : [{ type: "text", text: prompt.includes("independent code reviewer")
    ? `<qc_verdict>${prompt.includes('fixture-case:changes') ? 'CHANGES_REQUESTED' : 'PASS'}</qc_verdict><qc_summary>Offline fixture only.</qc_summary><qc_findings>[]</qc_findings><qc_feedback>Fixture changes requested.</qc_feedback>`
    : "Offline fixture completed; no real inference." }] } });
const subtype = scenario === "turn-limit" ? "error_max_turns" : scenario === "budget-limit" ? "error_max_budget_usd" : "success";
const result = { type: "result", subtype, is_error: subtype !== "success", num_turns: scenario === "too-many-turns" ? 7 : 2,
  total_cost_usd: scenario === "budget-limit" ? 0.26 : 0.001, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] };
emit(result);
if (scenario === "duplicate-result") emit(result);
process.exit(scenario === "exit-failure" ? 7 : 0);
