import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEvents } from "../src/dsh-debug.mjs";

test("debug summaries expose structural tool and reasoning diagnostics without reasoning text", () => {
  const summary = summarizeEvents([
    { type: "request/header", data: { header: { tools: [{ name: "read" }, { name: "pwsh" }] } } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", text: "internal reasoning" } } },
    { type: "tool/call", data: { turn: 1, step: 1, name: "read" } },
    { type: "tool/result", data: { turn: 1, step: 1, message: { isError: false } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "final answer" }] } } },
    { type: "turn/end", data: { reason: { kind: "completed" } } },
  ], { agentPreset: "dst-fast", provider: "opencode-go", model: "deepseek-v4-pro" });

  assert.deepEqual(summary.headerTools, ["read", "pwsh"]);
  assert.equal(summary.toolCalls[0].name, "read");
  assert.equal(summary.toolErrorCount, 0);
  assert.equal(summary.reasoningChunks[0].chars, "internal reasoning".length);
  assert.equal(JSON.stringify(summary.reasoningChunks).includes("internal reasoning"), false);
  assert.equal(summary.assistantText, "final answer");
  assert.equal(summary.turnEnd.kind, "completed");
});
