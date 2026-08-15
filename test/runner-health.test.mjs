import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { healthSpecFromEnv, runHealthWithRetry } from "../src/dsh-health.mjs";
import { buildRunnerInvocation, removeOrphanedHeadlessProfile, runDshTask, runnerSpecFromEnv, summarizeTaskResult } from "../src/dsh-runner.mjs";

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

test("health retry cancellation interrupts the retry delay", async () => {
  const controller = new AbortController();
  const promise = runHealthWithRetry({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    signal: controller.signal,
    timeout: 5000,
  }, { maxAttempts: 2, delayMs: 30_000 });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, /cancelled/);
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

test("runner environment override is used by the task path", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-runner-env-"));
  const marker = join(root, "runner.txt");
  try {
    const script = "require('node:fs').writeFileSync(process.env.PI_DSH_FIXTURE_LOG, 'env');";
    const result = await runDshTask({ task: "env runner", workspace: process.cwd() }, {
      env: {
        ...process.env,
        PI_DSH_FIXTURE_LOG: marker,
        PI_DSH_RUNNER_COMMAND: process.execPath,
        PI_DSH_RUNNER_ARGS: JSON.stringify(["-e", script, "--"]),
      },
      timeout: 5000,
    });
    assert.equal(result.code, 0);
    assert.equal(readFileSync(marker, "utf8"), "env");
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

test("abort cleanup removes a profile left behind by a killed runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-profile-cleanup-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const args=process.argv.slice(1);",
    "const home=args[args.indexOf('-DshHome')+1];",
    "const profile=args[args.indexOf('-ProfileName')+1];",
    "fs.mkdirSync(path.join(home,'profiles',profile),{recursive:true});",
    "setTimeout(()=>{},60000);",
  ].join("");
  try {
    const controller = new AbortController();
    const promise = runDshTask({ task: "hang", workspace, dshHome: home }, {
      runner: { command: process.execPath, args: ["-e", script, "--"] },
      signal: controller.signal,
      timeout: 5000,
      env: { ...process.env, DSH_HOME: home },
    });
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    assert.equal(result.killed, true);
    assert.equal(result.timedOut, false);
    const profiles = readdirSync(join(home, "profiles"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.deepEqual(profiles, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout cleanup removes a profile left behind by a timed-out runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-profile-timeout-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const args=process.argv.slice(1);",
    "const home=args[args.indexOf('-DshHome')+1];",
    "const profile=args[args.indexOf('-ProfileName')+1];",
    "fs.mkdirSync(path.join(home,'profiles',profile),{recursive:true});",
    "setTimeout(()=>{},60000);",
  ].join("");
  try {
    const result = await runDshTask({ task: "timeout", workspace, dshHome: home }, {
      runner: { command: process.execPath, args: ["-e", script, "--"] },
      timeout: 100,
      env: { ...process.env, DSH_HOME: home },
    });
    assert.equal(result.killed, true);
    assert.equal(result.timedOut, true);
    const profiles = readdirSync(join(home, "profiles"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.deepEqual(profiles, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("junction cleanup removes only the profile link, not its target", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows junction behavior is only asserted on Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-junction-cleanup-"));
  const home = join(root, "home");
  const target = join(root, "shared-node-modules");
  const profileName = "headless-pi-0123456789abcdef0123456789abcdef";
  const profile = join(home, "profiles", profileName);
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "keep");
    mkdirSync(profile, { recursive: true });
    symlinkSync(target, join(profile, "node_modules"), "junction");
    await removeOrphanedHeadlessProfile(home, profileName);
    assert.equal(existsSync(profile), false);
    assert.equal(existsSync(join(target, "keep.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
