/**
 * Stage the multilingual embedding model and its ONNX runtime for the app bundle.
 * The staged tree lives under gitignored vendor/ and is copied by electrobun.
 * It is not a development-only node_modules lookup and it is not the user cache.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const RUNTIME_PACKAGES = ["@xenova/transformers", "onnxruntime-node", "onnxruntime-web"];

function copyDir(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  const result = spawnSync("/bin/cp", ["-cRp", from, to], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `copy failed: ${from}`);
}

function modelSource(project: string): string {
  const candidates = [
    path.join(project, "node_modules/@xenova/transformers/.cache", MODEL_ID),
    path.join(process.env.HOME ?? "", ".cache/forgeorbit-models", MODEL_ID),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "onnx/model_quantized.onnx")) && existsSync(path.join(candidate, "tokenizer.json"))) {
      return candidate;
    }
  }
  throw new Error(`Missing local ${MODEL_ID}. The packaged app cannot download it.`);
}

function packageDir(project: string, name: string): string {
  const dir = path.join(project, "node_modules", name);
  if (!existsSync(path.join(dir, "package.json"))) throw new Error(`Missing package ${name}`);
  return dir;
}

function stageRuntime(project: string, destModules: string): void {
  const seen = new Set<string>();
  const queue = [...RUNTIME_PACKAGES];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const source = packageDir(project, name);
    const dest = path.join(destModules, name);
    copyDir(source, dest);
    if (name === "@xenova/transformers") rmSync(path.join(dest, ".cache"), { recursive: true, force: true });
    const meta = JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(meta.dependencies ?? {})) queue.push(dep);
  }
}

export function prepareBrainModel(project: string): void {
  const modelDest = path.join(project, "vendor/brain-model", MODEL_ID);
  copyDir(modelSource(project), modelDest);
  stageRuntime(project, path.join(project, "vendor/brain-runtime/node_modules"));
  console.log("[FO-BRAIN-PACK] staged multilingual model and ONNX runtime");
}

export function verifyBrainModelPackage(appCode: string): void {
  const model = path.join(appCode, "models", MODEL_ID, "onnx/model_quantized.onnx");
  const tokenizer = path.join(appCode, "models", MODEL_ID, "tokenizer.json");
  const runtime = path.join(appCode, "node_modules/@xenova/transformers/package.json");
  const binding = path.join(appCode, "node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node");
  for (const file of [model, tokenizer, runtime, binding]) {
    if (!existsSync(file)) throw new Error(`Packaged Brain model is incomplete: ${file}`);
  }
  console.log("[FO-BRAIN-PACK] packaged multilingual model accepted");
}

if (import.meta.main) prepareBrainModel(process.cwd());
