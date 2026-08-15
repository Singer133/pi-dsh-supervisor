import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoundedInteger, parseStringArray } from "./config.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  boundedDiagnostic,
  cleanOutput,
  execProcessTree,
} from "./process-tree.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WINDOWS_RUNNER = join(PACKAGE_ROOT, "scripts", "run-dsh.ps1");

export function defaultRunnerSpec() {
  if (process.platform !== "win32") {
    throw new Error("The prototype runner currently requires Windows PowerShell 7");
  }
  return {
    command: "pwsh",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_RUNNER,
    ],
  };
}

export function runnerSpecFromEnv(env = process.env) {
  if (env.PI_DSH_RUNNER_COMMAND?.trim()) {
    return {
      command: env.PI_DSH_RUNNER_COMMAND.trim(),
      args: parseStringArray(env.PI_DSH_RUNNER_ARGS, "PI_DSH_RUNNER_ARGS") ?? [],
    };
  }
  return defaultRunnerSpec();
}

export function buildRunnerInvocation({
  task,
  workspace,
  dshHome,
  dshCommand,
  patch,
  lockTimeoutSeconds,
  profileName,
  runner,
} = {}) {
  if (typeof task !== "string" || task.trim() === "") throw new Error("DSH task must not be empty");
  if (typeof workspace !== "string" || !isAbsolute(workspace)) {
    throw new Error("DSH workspace must be an absolute path");
  }
  if (dshHome !== undefined && (typeof dshHome !== "string" || !isAbsolute(dshHome))) {
    throw new Error("DSH home must be an absolute path when provided");
  }
  if (patch !== undefined && (typeof patch !== "string" || !isAbsolute(patch))) {
    throw new Error("DSH patch must be an absolute path when provided");
  }
  if (profileName !== undefined && (typeof profileName !== "string" || !/^headless-pi-[0-9a-f]{32}$/.test(profileName))) {
    throw new Error("DSH profileName must match the isolated profile format when provided");
  }

  const spec = runner ?? defaultRunnerSpec();
  const args = [...spec.args, "-Task", task, "-Workspace", workspace];
  if (dshHome) args.push("-DshHome", dshHome);
  if (profileName) args.push("-ProfileName", profileName);
  if (dshCommand) args.push("-DshCommand", dshCommand);
  if (patch) args.push("-Patch", patch);
  if (lockTimeoutSeconds !== undefined) args.push("-LockTimeoutSeconds", String(lockTimeoutSeconds));
  return { command: spec.command, args };
}

export async function removeOrphanedHeadlessProfile(dshHome, profileName) {
  if (typeof dshHome !== "string" || !isAbsolute(dshHome)) return;
  if (typeof profileName !== "string" || !/^headless-pi-[0-9a-f]{32}$/.test(profileName)) return;
  const profileDir = join(dshHome, "profiles", profileName);
  await rm(profileDir, { recursive: true, force: true });
}

export async function runDshTask(input, options = {}) {
  const timeout = parseBoundedInteger(
    options.timeout ?? process.env.PI_DSH_TIMEOUT_MS,
    "PI_DSH_TIMEOUT_MS",
    { fallback: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS },
  );
  const profileName = `headless-pi-${randomUUID().replaceAll("-", "")}`;
  const invocation = buildRunnerInvocation({
    ...input,
    dshCommand: input.dshCommand ?? process.env.PI_DSH_COMMAND,
    profileName,
    runner: options.runner ?? runnerSpecFromEnv(options.env ?? process.env),
  });
  const cleanupHome = input.dshHome ?? options.env?.DSH_HOME ?? process.env.DSH_HOME;
  let result;
  try {
    result = await execProcessTree(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeout,
    });
  } finally {
    await removeOrphanedHeadlessProfile(cleanupHome, profileName).catch(() => {});
  }
  return { ...result, invocation, diagnostic: boundedDiagnostic(result) };
}

export function summarizeTaskResult(result) {
  return {
    ok: result.code === 0 && !result.killed,
    code: result.code,
    killed: Boolean(result.killed),
    timedOut: Boolean(result.timedOut),
    output: cleanOutput(result.stdout),
    diagnostic: result.diagnostic,
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}
