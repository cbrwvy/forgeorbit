# Packaged Brain embeddings

Brain 2.0 search uses one local model, `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions, through `@xenova/transformers`. No embedding API is called. `env.allowRemoteModels` stays false.

## Where the model lives

Resolution order:

1. `FORGEORBIT_EMBEDDING_MODEL_ROOT`, when set. A missing pin does not fall through to another cache.
2. `Contents/Resources/app/models` next to the packaged Bun executable.
3. `<data dir>/models`, when a profile already has a copy.
4. The development tree `node_modules/@xenova/transformers/.cache`.
5. `~/.cache/forgeorbit-models`, then `~/.cache/xenova`.

A directory counts only when it contains `onnx/model_quantized.onnx` and `tokenizer.json` for that model. `scripts/prepare-brain-model.ts` stages the model and the ONNX runtime closure under gitignored `vendor/` before `electrobun build`. The package verify step refuses a bundle that lacks the quantized model or the darwin arm64 ONNX binding.

## What the status is allowed to say

The engine is `transformers-local` only when the model files are present or the extractor has loaded. The reported model name is then the MiniLM id. A test double reports `test-mock`.

If the model cannot be loaded, the engine is `lexical-fallback`, `enabled` is false, and the model name is `none`. The Brain page says semantic embeddings are unavailable. A semantic query returns no rows and `mode: "lexical"` instead of scoring those rows with word overlap. Hybrid search may still use lexical scores, and the response mode says `lexical` when no vector was produced.

Apple NaturalLanguage embeddings are not a substitute. Their vectors are a different width and are not this multilingual model.

Vectors are stored in the Brain SQLite index. Restart and profile restore keep those rows. Rebuild reads the same packaged model; the model itself is not part of the profile backup.
