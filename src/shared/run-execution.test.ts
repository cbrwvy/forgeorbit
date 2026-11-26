import { expect, test } from "bun:test";
import { executionFromEvents } from "./run-execution.ts";
const status = (v: object) => ({ stream: "status", data: JSON.stringify(v) });
test("legacy, selected model, stdout spoof and old bounded argv cannot establish real provenance", () => {
  for (const events of [[], [{stream:"stdout",data:JSON.stringify({kind:"execution-identity", executionType:"real-provider"})}], [status({kind:"claude-bounded-start",argv:["claude"],maxTurns:6,maxBudgetUsd:0.25})]]) {
    expect(executionFromEvents(events,"succeeded").type).toBe("unknown");
  }
});
test("per-run dispatch survives changed global driver and separates fixture measurements from configured thresholds", () => {
  process.env.AGETOR_CODEX_DRIVER = "fake";
  for (const type of ["real-provider", "synthetic", "fixture"] as const) {
    const view = executionFromEvents([status({kind:"execution-identity",executionType:type,provider:"claude-code",model:"claude-haiku-5-5",mode:"bounded-print"}), status({kind:"claude-bounded-start", maxTurns:6,maxBudgetUsd:0.25}), status({kind:"claude-bounded-result",num_turns:2,total_cost_usd:0.001,subtype:"success"})],"succeeded");
    expect(view).toMatchObject({type,turns:2,reportedCostUsd:0.001,configuredThresholdUsd:0.25,limitTermination:false,quota:"unknown"});
  }
});
test("absent or malformed usage stays unknown; limit failures remain visible", () => {
  expect(executionFromEvents([status({kind:"claude-bounded-result",total_cost_usd:-1,num_turns:"6"})],"failed")).toMatchObject({turns:null,reportedCostUsd:null});
  expect(executionFromEvents([status({kind:"claude-bounded-result",subtype:"error_max_budget_usd",num_turns:3,total_cost_usd:0.26})],"failed")).toMatchObject({limitTermination:true,reportedCostUsd:0.26,outcome:"failed"});
});
