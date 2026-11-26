import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareGeminiStdinLaunch, validateGeminiStdinPrompt, verifyGeminiStdinConfiguration } from "./gemini-stdin.ts";
import { GEMINI_PROMPT_MAX_BYTES } from "../shared/prompt-limits.ts";

test("large UTF-8 Markdown reaches an offline fake through exact stdin bytes, off argv and logs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo014e-gemini-"));
  const fake = path.join(root, "fake-cli.ts"), receipt = path.join(root, "receipt.json");
  writeFileSync(fake, `const text=await Bun.stdin.text();await Bun.write(${JSON.stringify(receipt)},JSON.stringify({text,argv:process.argv}));
console.log(JSON.stringify({type:'message',role:'user',content:text}));
console.error(text);console.log('raw diagnostic '+text.slice(0,80));
console.log(JSON.stringify({type:'message',role:'assistant',content:'Fake response'}));
console.log(JSON.stringify({type:'result',status:'success'}));`);
  const prompt = '# PRIVATE_PROFESSIONAL_MARKER\n' + 'Привет 世界 😀 \\ `id` $(touch SHOULD_NOT_EXIST) " --yolo\n'.repeat(12000);
  const input = prepareGeminiStdinLaunch(root, [process.execPath, fake, "-p", ""], prompt);
  try {
    expect(statSync(input.manifest).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(input.manifest)).mode & 0o777).toBe(0o700);
    expect(input.command).not.toContain("PRIVATE_PROFESSIONAL_MARKER"); expect(Buffer.byteLength(input.command)).toBeLessThan(4096);
    const proc = Bun.spawn(["/bin/sh", "-c", input.command], { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); expect(err).toBe(""); expect(out).not.toContain("PRIVATE_PROFESSIONAL_MARKER");
    const delivered = JSON.parse(readFileSync(receipt, "utf8")) as { text: string; argv: string[] };
    expect(Buffer.from(delivered.text).equals(Buffer.from(prompt))).toBe(true);
    expect(createHash("sha256").update(delivered.text).digest("hex")).toBe(createHash("sha256").update(prompt).digest("hex"));
    expect(delivered.argv).not.toContain(prompt); expect(delivered.argv.slice(-2)).toEqual(["-p", ""]);
    expect(existsSync(path.join(root, "SHOULD_NOT_EXIST"))).toBe(false); expect(existsSync(input.manifest)).toBe(false);
    expect(out).toContain("Fake response");
  } finally { input.cleanup(); }
});

test("stdin pipe interruption does not expose payload or retry the child", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo014e-pipe-")), fake = path.join(root, "reject.ts");
  writeFileSync(fake, "process.exit(9)");
  const input = prepareGeminiStdinLaunch(root, [process.execPath, fake], "PRIVATE_PROMPT\n".repeat(10000));
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", input.command], { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0); expect(out + err).not.toContain("PRIVATE_PROMPT"); expect(existsSync(input.manifest)).toBe(false);
  } finally { input.cleanup(); }
});

test("full composed payload is bounded below upstream truncation; malformed Unicode is refused", () => {
  expect(() => validateGeminiStdinPrompt("x".repeat(GEMINI_PROMPT_MAX_BYTES))).not.toThrow();
  for (const prompt of ["x".repeat(GEMINI_PROMPT_MAX_BYTES + 1), "bad\ud800", "bad\0", ""]) expect(() => validateGeminiStdinPrompt(prompt)).toThrow("no truncation");
});

test("sandbox, dotenv, prompt telemetry and interactive/debug modes fail closed without rewriting settings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo014e-config-"));
  const env = { HOME: root, GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, "system.json"), GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(root, "defaults.json") };
  expect(() => verifyGeminiStdinConfiguration(root, env, ["fake", "-p", ""], {})).not.toThrow();
  for (const flag of ["--sandbox", "--sandbox=true", "-s", "-i", "--debug"]) expect(() => verifyGeminiStdinConfiguration(root, env, ["fake", flag], {})).toThrow("unsupported");
  expect(() => verifyGeminiStdinConfiguration(root, { ...env, GEMINI_SANDBOX: "true" }, ["fake"], {})).toThrow("unsupported");
  mkdirSync(path.join(root, ".gemini")); const file = path.join(root, ".gemini", "settings.json");
  for (const value of [{ tools: { sandbox: true } }, { telemetry: { enabled: true, logPrompts: true } }]) {
    writeFileSync(file, JSON.stringify(value));
    expect(() => verifyGeminiStdinConfiguration(root, env, ["fake"], {})).toThrow("cannot preserve");
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(value));
  }
  rmSync(file); writeFileSync(path.join(root, ".env"), "SYNTHETIC=fixture");
  expect(() => verifyGeminiStdinConfiguration(root, env, ["fake"], {})).toThrow("without reading credentials");
});
