import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

function appendTail(current, chunk, maxBytes) {
  const next = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  if (next.length <= maxBytes) return { value: next.toString("utf8"), truncated: false };
  return {
    value: next.subarray(next.length - maxBytes).toString("utf8"),
    truncated: true,
  };
}

/**
 * Run one external process without a shell and terminate its whole tree on
 * cancellation or timeout. The returned stdout/stderr are bounded tails.
 */
export function execProcessTree(command, args = [], options = {}) {
  const {
    cwd,
    env,
    signal,
    timeout = 0,
    maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  } = options;

  return new Promise((resolveResult) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let killed = false;
    let timedOut = false;
    let timeoutTriggered = false;
    let timeoutId;
    let forceKillId;

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (forceKillId !== undefined) clearTimeout(forceKillId);
      signal?.removeEventListener("abort", terminate);
    };

    const settle = (code, processSignal = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult({
        stdout,
        stderr,
        code: code ?? 1,
        signal: processSignal,
        killed,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const killDirect = (signalName) => {
      try {
        child?.kill(signalName);
      } catch {
        // The process may have exited between the tree probe and the kill.
      }
    };

    const terminate = () => {
      if (settled || killed) return;
      // Avoid handing a recycled Windows PID to taskkill.
      if (child?.exitCode !== null || child?.signalCode !== null) return;
      killed = true;
      timedOut = timeoutTriggered;
      const pid = child?.pid;

      if (process.platform === "win32" && Number.isInteger(pid) && pid > 0) {
        try {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("error", () => killDirect("SIGKILL"));
          killer.once("close", (code) => {
            if (code !== 0 && !settled) killDirect("SIGKILL");
          });
        } catch {
          killDirect("SIGKILL");
        }
        forceKillId = setTimeout(() => killDirect("SIGKILL"), 5000);
        return;
      }

      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          killDirect("SIGTERM");
        }
        forceKillId = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            killDirect("SIGKILL");
          }
        }, 5000);
        return;
      }

      killDirect("SIGKILL");
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      stderr = String(error);
      settle(1);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      const result = appendTail(stdout, chunk, maxStdoutBytes);
      stdout = result.value;
      stdoutTruncated ||= result.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const result = appendTail(stderr, chunk, maxStderrBytes);
      stderr = result.value;
      stderrTruncated ||= result.truncated;
    });
    child.once("error", (error) => {
      if (!settled) {
        stderr = `${stderr}${String(error)}`;
        settle(1);
      }
    });
    child.once("close", (code, processSignal) => settle(code, processSignal));

    if (signal !== undefined) {
      signal.addEventListener("abort", terminate, { once: true });
      if (signal.aborted) terminate();
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        terminate();
      }, timeout);
    }
  });
}

export function cleanOutput(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

export function boundedDiagnostic(result) {
  const detail = cleanOutput(result?.stderr) || cleanOutput(result?.stdout);
  if (!detail) return `exit code ${result?.code ?? "unknown"}`;
  return detail.slice(-2000);
}
