import { expect, test } from "bun:test";
import { classifyCodexModelRejection } from "./codex-model-rejection.ts";

const PROVIDER = `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`;

test("preserves a ChatGPT account model_not_found and does not treat login failure as entitlement", () => {
  expect(classifyCodexModelRejection(`Model metadata for gpt-6.1-sol not found\n${PROVIDER}`)).toEqual({
    code: "model_not_found",
    model: "gpt-6.1-sol",
    message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
  });
  expect(classifyCodexModelRejection("Not logged in")).toBeNull();
  expect(classifyCodexModelRejection("Logged in using ChatGPT")).toBeNull();
});
