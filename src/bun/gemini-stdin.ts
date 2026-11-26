/** Gemini CLI v0.54.0 headless stdin contract. No CLI discovery or provider calls. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { GEMINI_PROMPT_MAX_BYTES } from "../shared/prompt-limits.ts";

export function validateGeminiStdinPrompt(prompt: string) {
  if (Buffer.byteLength(prompt, "utf8") > GEMINI_PROMPT_MAX_BYTES) throw new Error(`prompt exceeds ${GEMINI_PROMPT_MAX_BYTES} bytes — Gemini stdin budget; no truncation is allowed.`);
  if (!prompt || !prompt.isWellFormed() || prompt.includes("\0")) {
    throw new Error(`Gemini stdin payload must be valid UTF-8 and at most ${GEMINI_PROMPT_MAX_BYTES} bytes; no truncation is allowed.`);
  }
}

/** Upstream's sandbox relaunch serializes stdin into argv. Refuse it, never disable it. */
export function verifyGeminiStdinConfiguration(cwd: string, supplied: Record<string, string>, argv: string[], inherited: NodeJS.ProcessEnv = process.env) {
  const env = { ...inherited, ...supplied };
  if (env.GEMINI_TELEMETRY_LOG_PROMPTS && env.GEMINI_TELEMETRY_LOG_PROMPTS !== "false") throw new Error("Gemini prompt telemetry is unsupported for this transport.");
  if (env.DEBUG || env.DEBUG_MODE) throw new Error("Gemini debug logging is unsupported for stdin transport.");
  if (argv.some(a => /^(--sandbox(?:=|$)|-s$|--debug(?:=|$)|-d$|--prompt-interactive(?:=|$)|--acp(?:=|$)|--experimental-acp(?:=|$)|-[sdi](?:=|$))/.test(a))
    || (env.GEMINI_SANDBOX && !["false", "0"].includes(env.GEMINI_SANDBOX))) throw new Error("Gemini stdin transport is unsupported with sandbox relaunch, debug or interactive flags. Existing permissions will not be changed.");
  const home = env.GEMINI_CLI_HOME || env.HOME || homedir();
  const system = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (process.platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json" : "/etc/gemini-cli/settings.json");
  const configPaths = [system, env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), "system-defaults.json"), path.join(home, ".gemini", "settings.json"), path.join(cwd, ".gemini", "settings.json")];
  for (const file of configPaths) {
    if (!existsSync(file)) continue;
    let config: { sandbox?: unknown; tools?: { sandbox?: unknown }; telemetry?: { enabled?: unknown; logPrompts?: unknown } };
    try { config = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("Gemini stdin configuration cannot be verified. No prompt was submitted."); }
    if (!config || typeof config !== "object" || [config.sandbox, config.tools?.sandbox].some(v => v !== undefined && v !== false)
      || (config.telemetry?.enabled && config.telemetry.logPrompts !== false)) throw new Error("Gemini stdin transport cannot preserve the argv/log boundary with this configuration. No prompt was submitted.");
  }
  if (env.GEMINI_TELEMETRY_ENABLED && env.GEMINI_TELEMETRY_ENABLED !== "false" && env.GEMINI_TELEMETRY_LOG_PROMPTS !== "false") throw new Error("Gemini prompt telemetry is unsupported for this transport.");
  // Do not read dotenv files: they may contain credentials. Unknown overrides fail closed.
  const dotenvDirs = new Set([home, path.join(home, ".gemini")]);
  for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
    dotenvDirs.add(dir); dotenvDirs.add(path.join(dir, ".gemini"));
    if (path.dirname(dir) === dir) break;
  }
  if ([...dotenvDirs].some(dir => existsSync(path.join(dir, ".env")))) throw new Error("Gemini dotenv overrides cannot be verified without reading credentials. Stdin transport is unsupported in this environment.");
}

// The supervisor is transport only: one existing CLI invocation, inherited
// permissions, exact stdin bytes, sanitized NDJSON. No retries or new sessions.
// User echoes and raw stderr never enter ForgeOrbit's recoverable log file.
export const GEMINI_STDIN_BRIDGE = `
import {readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
const file=process.argv.at(-1);
let p;
try{p=JSON.parse(readFileSync(file,'utf8'));unlinkSync(file);rmdirSync(path.dirname(file));}
catch{console.log(JSON.stringify({type:'error',error:'Gemini input preparation failed'}));process.exit(1);}
try{
const child=Bun.spawn(p.argv,{stdin:new Blob([p.prompt]),stdout:'pipe',stderr:'pipe'});
const drain=(async()=>{let n=0;for await(const c of child.stderr)n+=c.length;return n;})();
const decoder=new TextDecoder();let pending='';
const line=s=>{try{const e=JSON.parse(s);if(e.type==='message'&&e.role==='user')return;
if(e.type==='error'||(e.type==='result'&&e.status!=='success'))e.error={message:'Gemini reported an error; raw diagnostics withheld'};
console.log(JSON.stringify(e));}catch{if(s.trim())console.log(JSON.stringify({type:'error',error:'Gemini diagnostic withheld'}));}};
for await(const c of child.stdout){pending+=decoder.decode(c,{stream:true});let i;while((i=pending.indexOf('\\n'))>=0){line(pending.slice(0,i));pending=pending.slice(i+1);}}
pending+=decoder.decode();if(pending.trim())line(pending);
const code=await child.exited;if(await drain)console.log(JSON.stringify({type:'error',error:'Gemini stderr diagnostics withheld'}));
process.exit(code);
}catch{console.log(JSON.stringify({type:'error',error:'Gemini stdin transport interrupted; delivery Unknown'}));process.exit(1);}
`;

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function prepareGeminiStdinLaunch(root: string, argv: string[], prompt: string, runtime = process.execPath) {
  validateGeminiStdinPrompt(prompt);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(root, "input-")); chmodSync(dir, 0o700);
  const manifest = path.join(dir, "payload.json");
  try { writeFileSync(manifest, JSON.stringify({ argv, prompt }), { mode: 0o600, flag: "wx" }); }
  catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  return {
    command: `exec ${[runtime, "-e", GEMINI_STDIN_BRIDGE, "--", manifest].map(sq).join(" ")}`,
    manifest,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
