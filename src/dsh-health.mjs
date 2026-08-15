import { parseBoundedInteger, parseStringArray } from "./config.mjs";
import { execProcessTree } from "./process-tree.mjs";

export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;

export function healthSpecFromEnv(env = process.env) {
  if (env.PI_DSH_HEALTH_COMMAND?.trim()) {
    return {
      command: env.PI_DSH_HEALTH_COMMAND.trim(),
      args: parseStringArray(env.PI_DSH_HEALTH_ARGS, "PI_DSH_HEALTH_ARGS") ?? ["--version"],
    };
  }
  if (process.platform === "win32") {
    return {
      command: "pwsh",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& (Get-Command dsh -ErrorAction Stop).Source --version",
      ],
    };
  }
  return { command: "dsh", args: ["--version"] };
}

/**
 * Run a no-model DSH health command. The caller supplies read-only args such
 * as `--version` or `--dump-config`; this function never sends a user task.
 */
export async function runHealthProbe({
  command,
  args,
  cwd,
  env,
  signal,
  timeout = DEFAULT_HEALTH_TIMEOUT_MS,
} = {}) {
  const spec = command ? { command, args: args ?? [] } : healthSpecFromEnv(env ?? process.env);
  const result = await execProcessTree(spec.command, spec.args, { cwd, env, signal, timeout });
  const ok = result.code === 0 && !result.killed;
  const diagnostic = ok
    ? "health check passed"
    : result.timedOut
      ? "health check timed out"
      : result.killed
        ? "health check terminated"
        : `health check exited with code ${result.code}`;
  return {
    ok,
    code: result.code,
    killed: result.killed,
    timedOut: result.timedOut,
    diagnostic,
    stdout: ok ? result.stdout.trim() : "",
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

/**
 * Health probes are safe to retry because they have no user task and no model
 * side effect. This is deliberately not used by dsh_call.
 */
export async function runHealthWithRetry(input, { maxAttempts = 2, delayMs = 250 } = {}) {
  const attempts = parseBoundedInteger(maxAttempts, "maxAttempts", { fallback: 2, max: 3 });
  const delay = parseBoundedInteger(delayMs, "delayMs", { fallback: 250, min: 0, max: 30_000 });
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await runHealthProbe(input);
    if (last.ok || attempt === attempts) return { ...last, attempts: attempt };
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { ...last, attempts };
}
