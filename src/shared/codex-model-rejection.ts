/**
 * A Codex provider rejection of one account's model. Login status is a
 * different fact: an authenticated ChatGPT profile can still reject a model.
 * Observations expire so an unsupported claim is not kept forever.
 */
export const CODEX_MODEL_REJECTION_TTL_MS = 24 * 60 * 60 * 1000;
export const CODEX_MODEL_REJECTION_SOURCE = "codex-provider-model-rejection";

export interface CodexModelRejection {
  code: "model_not_found";
  message: string;
  model: string | null;
}

const SENTENCE = /The '([^']{1,120})' model is not supported when using Codex with a ChatGPT account\./;

/** Reads adapter stderr. Does not treat "Not logged in" as a model rejection. */
export function classifyCodexModelRejection(text: string): CodexModelRejection | null {
  const sentence = SENTENCE.exec(text);
  if (!sentence && !text.includes('"code":"model_not_found"') && !text.includes('"code": "model_not_found"')) return null;
  const model = sentence?.[1] ?? null;
  return {
    code: "model_not_found",
    model,
    message: model
      ? `The '${model}' model is not supported when using Codex with a ChatGPT account.`
      : "The configured model is not supported when using Codex with a ChatGPT account.",
  };
}
