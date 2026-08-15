import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DshDebugError, rpc, runDshDebug, safeTurnReason, summarizeEvents } from "../src/dsh-debug.mjs";

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
  assert.equal("sha256" in summary.reasoningChunks[0], false);
  assert.equal(JSON.stringify(summary.reasoningChunks).includes("internal reasoning"), false);
  assert.equal(summary.assistantText, "final answer");
  assert.equal(summary.turnEnd.kind, "completed");
});

test("reasoning delta and final reasoning block are not counted twice", () => {
  const summary = summarizeEvents([
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", text: "same reasoning" } } },
    { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "reasoning", thinking: "same reasoning" }] } } },
  ]);
  assert.equal(summary.reasoningTotalChars, "same reasoning".length);
  assert.equal(summary.reasoningChunks[0].chars, "same reasoning".length);
});

test("startup failure cleans the owned debug home without exposing process output", async (t) => {
  if (process.platform !== "win32") {
    t.skip("The built-in Web launcher is Windows-only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-debug-startup-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, "profiles", "web", "package.json"), "{}");
  try {
    await assert.rejects(
      () => runDshDebug({
        task: "should not run",
        workspace,
        dshHome: home,
        dshCommand: "missing_dsh_command_fixture",
        timeoutMs: 5000,
      }),
      (error) => {
        assert.equal(error instanceof DshDebugError, true);
        assert.equal(error.message.includes("missing_dsh_command_fixture"), false);
        return true;
      },
    );
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("pi-dsh-debug-")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC failures exclude response bodies and payload text", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { ok: false, error: { code: "INTERNAL_ERROR", message: "private prompt secret", data: { stack: "private stack" } } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => rpc(`http://127.0.0.1:${port}`, "session.prompt", { content: "private prompt secret" }, AbortSignal.timeout(2000)),
      (error) => {
        assert.equal(error instanceof DshDebugError, true);
        assert.equal(error.message.includes("private"), false);
        assert.equal(JSON.stringify(error).includes("private"), false);
        assert.equal(error.details.code, "INTERNAL_ERROR");
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fingerprints are opt-in and turn reasons are structural", () => {
  const summary = summarizeEvents([
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", text: "candidate" } } },
    { type: "turn/end", data: { reason: { kind: "error", code: "INTERNAL_ERROR", message: "private prompt", stack: "private stack" } } },
  ], {}, { includeReasoningFingerprint: true });
  assert.match(summary.reasoningChunks[0].sha256, /^[a-f0-9]{16}$/);
  assert.deepEqual(summary.turnEnd, { kind: "error", code: "INTERNAL_ERROR" });
  assert.equal(JSON.stringify(summary).includes("private prompt"), false);
  assert.deepEqual(safeTurnReason({ kind: "error", data: "secret" }), { kind: "error" });
  const error = new DshDebugError("safe", { phase: "rpc", category: "rpc_failure", method: "session.prompt", code: "INTERNAL_ERROR" });
  assert.equal(JSON.stringify(error).includes("private"), false);
});
