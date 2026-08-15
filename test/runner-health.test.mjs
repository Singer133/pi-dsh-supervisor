import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import process from "node:process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { healthSpecFromEnv, runHealthWithRetry } from "../src/dsh-health.mjs";
import { buildRunnerInvocation, runDshTask, runnerSpecFromEnv, summarizeTaskResult } from "../src/dsh-runner.mjs";

test("buildRunnerInvocation keeps task and paths as separate argv values", () => {
  const workspace = resolve("fixture", "workspace");
  const invocation = buildRunnerInvocation({
    task: "task with spaces; never shell-evaluate this",
    workspace,
    runner: { command: "pwsh", args: ["-File", "runner.ps1"] },
  });
  assert.equal(invocation.command, "pwsh");
  assert.deepEqual(invocation.args.slice(-4), ["-Task", "task with spaces; never shell-evaluate this", "-Workspace", workspace]);
  assert.equal(invocation.args.includes("&&"), false);
});

test("buildRunnerInvocation rejects relative workspaces", () => {
  assert.throws(
    () => buildRunnerInvocation({ task: "x", workspace: "relative", runner: { command: "node", args: [] } }),
    /absolute path/,
  );
});

test("health command configuration stays argv-based", () => {
  assert.deepEqual(healthSpecFromEnv({ PI_DSH_HEALTH_COMMAND: "pwsh", PI_DSH_HEALTH_ARGS: '["-NoProfile","-Command","dsh --version"]' }), {
    command: "pwsh",
    args: ["-NoProfile", "-Command", "dsh --version"],
  });
  assert.throws(() => healthSpecFromEnv({ PI_DSH_HEALTH_COMMAND: "pwsh", PI_DSH_HEALTH_ARGS: "not-json" }), /JSON array/);
});

test("runner configuration rejects malformed or unbounded environment values", () => {
  assert.deepEqual(runnerSpecFromEnv({ PI_DSH_RUNNER_COMMAND: "node" }), { command: "node", args: [] });
  assert.throws(() => runnerSpecFromEnv({ PI_DSH_RUNNER_COMMAND: "node", PI_DSH_RUNNER_ARGS: "not-json" }), /JSON array/);
  assert.throws(() => runnerSpecFromEnv({ PI_DSH_RUNNER_COMMAND: "node", PI_DSH_RUNNER_ARGS: JSON.stringify(["x".repeat(5000)]) }), /bounded argument/);
});

test("task timeout configuration rejects invalid values", async () => {
  await assert.rejects(
    () => runDshTask({ task: "x", workspace: process.cwd() }, { timeout: 0 }),
    /PI_DSH_TIMEOUT_MS/,
  );
});

test("health retry uses a fresh no-model process and stops after success", async () => {
  const result = await runHealthWithRetry({
    command: process.execPath,
    args: ["-e", "process.stdout.write('healthy')"],
    timeout: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.stdout, "healthy");
});

test("health retry is bounded", async () => {
  const result = await runHealthWithRetry({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    timeout: 5000,
    delayMs: 1,
  }, { maxAttempts: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});

test("failed handshakes retry without exposing stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-handshake-"));
  const marker = join(root, "launches.txt");
  try {
    const script = "require('node:fs').appendFileSync(process.env.PI_DSH_FIXTURE_LOG, 'x'); process.stderr.write('private handshake detail'); process.exit(9);";
    const result = await runHealthWithRetry({
      command: process.execPath,
      args: ["-e", script],
      env: { ...process.env, PI_DSH_FIXTURE_LOG: marker },
      timeout: 5000,
      delayMs: 1,
    }, { maxAttempts: 2 });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(result.diagnostic.includes("private handshake detail"), false);
    assert.equal(readFileSync(marker, "utf8"), "xx");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed write task is not automatically replayed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-no-replay-"));
  const marker = join(root, "writes.txt");
  try {
    const script = "require('node:fs').appendFileSync(process.env.PI_DSH_FIXTURE_LOG, 'x'); process.exit(17);";
    const result = await runDshTask({
      task: "write once",
      workspace: process.cwd(),
    }, {
      runner: { command: process.execPath, args: ["-e", script, "--"] },
      env: { ...process.env, PI_DSH_FIXTURE_LOG: marker },
      timeout: 5000,
    });
    assert.equal(result.code, 17);
    assert.equal(result.killed, false);
    assert.equal(readFileSync(marker, "utf8"), "x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh runner invocations do not pretend to restore a DSH session", () => {
  const first = buildRunnerInvocation({ task: "first", workspace: process.cwd(), runner: { command: "node", args: [] } });
  const second = buildRunnerInvocation({ task: "second", workspace: process.cwd(), runner: { command: "node", args: [] } });
  assert.equal(first.args.includes("--session"), false);
  assert.equal(second.args.includes("--session"), false);
  assert.notDeepEqual(first.args, second.args);
});

test("task summaries do not claim killed work succeeded", () => {
  assert.deepEqual(summarizeTaskResult({ code: 0, killed: false, timedOut: false, stdout: "ok" }), {
    ok: true,
    code: 0,
    killed: false,
    timedOut: false,
    output: "ok",
    diagnostic: undefined,
    truncated: false,
  });
  assert.equal(summarizeTaskResult({ code: 1, killed: true, timedOut: true, stdout: "" }).ok, false);
});
