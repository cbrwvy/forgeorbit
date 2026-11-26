import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Each directory has its own synthetic marker; no auth.json and no real credentials. */
export function writeCodexProfileFixture(root: string, bun: string): string {
  mkdirSync(root, { recursive: true });
  const bin = path.join(root, "codex-profile-fixture");
  writeFileSync(bin, `#!${bun}
import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2), home = process.env.CODEX_HOME;
appendFileSync(${JSON.stringify(path.join(root, "synthetic-invocations.jsonl"))}, JSON.stringify({ argv, home }) + "\\n");
if (argv.includes("--version")) { console.log("codex-cli 0.162.1-fixture"); process.exit(0); }
const keys = ${JSON.stringify(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_FEDERATION_RULE_ID"])};
const clean = keys.every(k => process.env[k] === undefined);
let subject;
try { subject = readFileSync(path.join(home, "synthetic-authenticated"), "utf8").trim(); } catch {}
const fileStore = argv.includes('cli_auth_credentials_store="file"');
if (argv.includes("app-server")) {
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let newline;
    while ((newline = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1);
      const message = JSON.parse(line);
      if (message.id != null) console.log(JSON.stringify({id:message.id,result:{home,subject,clean,fileStore}}));
    }
  }
  process.exit(0);
}
if (argv.includes("login") && argv.includes("status")) {
  if (!clean || !fileStore || !subject) { console.error("Not logged in"); process.exit(1); }
  console.error("Logged in using ChatGPT"); process.exit(0);
}
if (!argv.includes("exec") || !clean || !fileStore || !subject) process.exit(64);
await Bun.stdin.text();
appendFileSync(path.join(home, "synthetic-launches.jsonl"), JSON.stringify({home,subject,clean,fileStore,cwd:process.cwd(),argv}) + "\\n");
console.log(JSON.stringify({type:"thread.started",thread_id:"fixture-" + subject + "-" + crypto.randomUUID()}));
await Bun.sleep(100);
console.log(JSON.stringify({type:"item.completed",item:{id:"answer",type:"agent_message",text:"Synthetic profile " + subject + " completed."}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:3}}));
`, { mode: 0o700 });
  return bin;
}
export function writeSyntheticCodexProfile(directory: string, subject: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "synthetic-authenticated"), subject);
}
