import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./process-tree.mjs";

export const DEFAULT_DEBUG_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const MAX_DEBUG_TIMEOUT_MS = MAX_TIMEOUT_MS;
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_ASSISTANT_CHARS = 32_000;
const MAX_EVENT_TYPES = 128;
const MAX_HEADER_TOOLS = 256;
const MAX_TOOL_CALLS = 128;
const MAX_REASONING_CHUNKS = 128;
const MAX_HISTORY_MESSAGES = 512;
const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOST = ["127", "0", "0", "1"].join(".");
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WINDOWS_WEB_RUNNER = join(PACKAGE_ROOT, "scripts", "run-dsh-web.ps1");

export class DshDebugError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DshDebugError";
    this.details = {
      phase: safeToken(details.phase, "unknown"),
      category: safeToken(details.category, "internal"),
      ...(details.method ? { method: safeToken(details.method, "unknown") } : {}),
      ...(Number.isInteger(details.httpStatus) ? { httpStatus: details.httpStatus } : {}),
      ...(details.code ? { code: safeToken(details.code, "unknown") } : {}),
    };
  }
}

function safeToken(value, fallback = undefined) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:/-]{0,63}$/.test(normalized) ? normalized : fallback;
}

function safeLabel(value, max = 128) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 12)}...[cut]`;
}

function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function safeTurnReason(reason) {
  const safe = { kind: safeToken(reason?.kind, "unknown") };
  const code = safeToken(reason?.code);
  const category = safeToken(reason?.category);
  if (code) safe.code = code;
  if (category) safe.category = category;
  if (typeof reason?.retryable === "boolean") safe.retryable = reason.retryable;
  return safe;
}

function safeSelection(selection = {}) {
  return Object.fromEntries(Object.entries({
    agentPreset: safeLabel(selection.agentPreset),
    provider: safeLabel(selection.provider),
    model: safeLabel(selection.model),
    reasoningEffort: safeLabel(selection.reasoningEffort),
  }).filter(([, value]) => value !== undefined));
}

function boundedText(value, max = MAX_ASSISTANT_CHARS) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 32)}\n...[truncated ${text.length - max + 32} chars]`;
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new DshDebugError(`DSH debug ${label} is invalid`, { phase: "validate", category: "invalid_argument" });
  return value;
}

function resolveDshHome(input) {
  const value = input?.trim() || process.env.DSH_HOME?.trim();
  if (!value) throw new DshDebugError("DSH_HOME is required for DSH debug", { phase: "validate", category: "missing_config" });
  return requireAbsolute(value, "DSH_HOME");
}

function boundedInteger(value, fallback, max) {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function eventData(event) {
  return event?.data ?? {};
}

function eventMessage(event) {
  return eventData(event).message ?? {};
}

function textFromBlock(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  return "";
}

function contentText(content, types = undefined) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => !types || types.includes(block?.type))
    .map(textFromBlock)
    .join("");
}

function extractToolNames(event) {
  const data = eventData(event);
  const header = data.header ?? data.request?.header ?? data.request ?? {};
  const tools = header.tools ?? data.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => typeof tool === "string" ? tool : tool?.name ?? tool?.function?.name ?? "?")
    .map((name) => safeLabel(name, 96))
    .filter(Boolean);
}

function resetReasoningRow(row) {
  row.chars = 0;
  row.lines = 0;
  row.hasText = false;
  row.hash = row.includeHash ? createHash("sha256") : undefined;
}

function addReasoningText(row, text) {
  if (!text) return;
  row.chars += text.length;
  if (!row.hasText) row.lines = 1;
  row.lines += (text.match(/\r?\n/g) ?? []).length;
  row.hasText = true;
  row.hash?.update(text);
}

class EventAccumulator {
  constructor(selection = {}, { includeReasoningFingerprint = false } = {}) {
    this.selection = safeSelection(selection);
    this.includeReasoningFingerprint = includeReasoningFingerprint === true;
    this.seenSequences = new Set();
    this.eventCount = 0;
    this.eventTypes = new Map();
    this.headerTools = new Set();
    this.toolCalls = [];
    this.toolCallCount = 0;
    this.toolResultCount = 0;
    this.toolErrorCount = 0;
    this.reasoning = new Map();
    this.reasoningTotalChars = 0;
    this.errors = [];
    this.turnEnd = null;
    this.turnEnded = false;
    this.assistantText = "";
  }

  ingest(event) {
    if (!event || typeof event !== "object") return false;
    if (event.seq !== undefined && event.seq !== null) {
      const sequence = String(event.seq);
      if (this.seenSequences.has(sequence)) return false;
      this.seenSequences.add(sequence);
      if (this.seenSequences.size > 4096) this.seenSequences.delete(this.seenSequences.values().next().value);
    }

    const type = safeToken(event.type, "unknown");
    this.eventCount += 1;
    this.eventTypes.set(type, (this.eventTypes.get(type) ?? 0) + 1);
    const data = eventData(event);
    const message = eventMessage(event);

    if (type === "request/header") {
      for (const name of extractToolNames(event)) {
        if (this.headerTools.size < MAX_HEADER_TOOLS) this.headerTools.add(name);
      }
    }

    if (type === "assistant/chunk") {
      const chunk = data.chunk ?? {};
      if (chunk.type === "reasoning-delta" || chunk.type === "thinking-delta") {
        this.ingestReasoning(data, String(chunk.text ?? ""), "delta");
      }
    } else if (type === "assistant/message") {
      const reasoning = contentText(message.content, ["reasoning", "thinking"]);
      if (reasoning) this.ingestReasoning(data, reasoning, "final");
      const text = contentText(message.content, ["text"]);
      if (text) this.assistantText = boundedText(text);
    }

    if (type === "tool/call") {
      this.toolCallCount += 1;
      if (this.toolCalls.length < MAX_TOOL_CALLS) {
        this.toolCalls.push({
          turn: safeInteger(data.turn),
          step: safeInteger(data.step),
          name: safeLabel(data.name ?? data.tool, 96) ?? "unknown",
        });
      }
    }

    if (type === "tool/result") {
      this.toolResultCount += 1;
      if (Boolean(data.error || message.isError)) this.toolErrorCount += 1;
    }

    if (type === "turn/end") {
      const reason = safeTurnReason(data.reason);
      this.turnEnd = reason;
      this.turnEnded = true;
      if (reason.kind === "error") this.errors.push(reason);
    }
    return true;
  }

  ingestReasoning(data, text, source) {
    const key = `${safeInteger(data.turn) ?? "?"}:${safeInteger(data.step) ?? "?"}`;
    let row = this.reasoning.get(key);
    if (!row) {
      row = { turn: safeInteger(data.turn), step: safeInteger(data.step), source: null, includeHash: this.includeReasoningFingerprint };
      resetReasoningRow(row);
      this.reasoning.set(key, row);
    }
    if (source === "delta") {
      if (row.source !== "delta") {
        this.reasoningTotalChars -= row.chars;
        resetReasoningRow(row);
      }
      row.source = "delta";
      addReasoningText(row, text);
      this.reasoningTotalChars += text.length;
    } else if (row.source === null) {
      row.source = "final";
      addReasoningText(row, text);
      this.reasoningTotalChars += text.length;
    }
  }

  summary() {
    const reasoningChunks = [...this.reasoning.values()].slice(0, MAX_REASONING_CHUNKS).map((row) => {
      const result = { turn: row.turn, step: row.step, chars: row.chars, lines: row.lines };
      if (row.includeHash && row.hash) result.sha256 = row.hash.digest("hex").slice(0, 16);
      return result;
    });
    const eventTypes = [...this.eventTypes.keys()].slice(0, MAX_EVENT_TYPES);
    return {
      eventCount: this.eventCount,
      eventTypes,
      eventTypesTruncated: this.eventTypes.size > eventTypes.length,
      headerTools: [...this.headerTools],
      headerToolCount: this.headerTools.size,
      toolCalls: this.toolCalls,
      toolCallCount: this.toolCallCount,
      toolCallsTruncated: this.toolCallCount > this.toolCalls.length,
      toolResultCount: this.toolResultCount,
      toolErrorCount: this.toolErrorCount,
      reasoningChunks,
      reasoningChunksTruncated: this.reasoning.size > reasoningChunks.length,
      reasoningTotalChars: this.reasoningTotalChars,
      turnEnd: this.turnEnd,
      errors: this.errors.slice(0, 16),
      assistantText: this.assistantText,
      selection: this.selection,
    };
  }
}

export function summarizeEvents(events, selection = {}, options = {}) {
  const accumulator = new EventAccumulator(selection, options);
  for (const event of events ?? []) accumulator.ingest(event);
  return accumulator.summary();
}

function safeRpcCode(value) {
  return safeToken(value, "rpc_failure");
}

async function checkSignal(signal) {
  if (signal?.aborted) throw new DshDebugError("DSH debug operation was cancelled or timed out", { phase: "cancel", category: "aborted" });
}

function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DshDebugError("DSH debug operation was cancelled or timed out", { phase: "wait", category: "aborted" }));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function copyIfPresent(source, target, options = undefined) {
  if (existsSync(source)) await cp(source, target, options);
}

async function prepareIsolatedHome(sourceHome, token, signal) {
  const home = join(dirname(sourceHome), `pi-dsh-debug-${process.pid}-${token}`);
  const profile = join(home, "profiles", "web");
  const sourceProfile = join(sourceHome, "profiles", "web");
  try {
    await checkSignal(signal);
    await mkdir(profile, { recursive: true });
    await copyIfPresent(join(sourceHome, "settings.yaml"), join(home, "settings.yaml"));
    await checkSignal(signal);
    await copyIfPresent(join(sourceHome, "cordis.patch.yml"), join(home, "cordis.patch.yml"));
    await copyIfPresent(join(sourceHome, ".agent-presets"), join(home, ".agent-presets"), { recursive: true });
    for (const name of ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
      await checkSignal(signal);
      await copyIfPresent(join(sourceProfile, name), join(profile, name));
    }
    const sourceModules = join(sourceProfile, "node_modules");
    if (existsSync(sourceModules)) await symlink(sourceModules, join(profile, "node_modules"), "junction");
    const fallbackModules = join(sourceHome, "profiles", "node_modules");
    if (existsSync(fallbackModules)) await symlink(fallbackModules, join(home, "profiles", "node_modules"), "junction");
    await checkSignal(signal);
    return home;
  } catch (error) {
    await removeIsolatedHome(home);
    throw error;
  }
}

async function removeIsolatedHome(home) {
  if (!home) return;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 5) await waitMs(100);
    }
  }
}

async function allocatePort(signal) {
  await checkSignal(signal);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await checkSignal(signal);
  return port;
}

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

async function waitHttp(baseUrl, child, state, signal) {
  let lastStatus = "unavailable";
  while (true) {
    await checkSignal(signal);
    if (state.error) throw new DshDebugError("DSH Web process failed to start", { phase: "startup", category: "spawn_failed" });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new DshDebugError("DSH Web process exited during startup", { phase: "startup", category: "process_exit" });
    }
    try {
      const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
      const response = await fetch(`${baseUrl}/`, { signal: fetchSignal });
      if (response.ok) return;
      lastStatus = `http_${response.status}`;
    } catch {
      await checkSignal(signal);
    }
    await waitMs(250, signal).catch(() => checkSignal(signal));
    if (lastStatus === "http_500") throw new DshDebugError("DSH Web readiness failed", { phase: "startup", category: "http_failure" });
  }
}

export async function rpc(baseUrl, method, payload, signal) {
  await checkSignal(signal);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload }),
      signal,
    });
  } catch {
    throw new DshDebugError(`DSH RPC ${safeToken(method, "unknown")} failed`, { phase: "rpc", category: signal?.aborted ? "aborted" : "network", method });
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RPC_BODY_BYTES) {
    throw new DshDebugError(`DSH RPC ${safeToken(method, "unknown")} response was too large`, { phase: "rpc", category: "response_too_large", method, httpStatus: response.status });
  }
  let body;
  try {
    body = await response.text();
  } catch {
    throw new DshDebugError(`DSH RPC ${safeToken(method, "unknown")} returned invalid data`, { phase: "rpc", category: "invalid_response", method, httpStatus: response.status });
  }
  if (body.length > MAX_RPC_BODY_BYTES) {
    throw new DshDebugError(`DSH RPC ${safeToken(method, "unknown")} response was too large`, { phase: "rpc", category: "response_too_large", method, httpStatus: response.status });
  }
  let full;
  try {
    full = JSON.parse(body);
  } catch {
    throw new DshDebugError(`DSH RPC ${safeToken(method, "unknown")} returned invalid data`, { phase: "rpc", category: "invalid_response", method, httpStatus: response.status });
  }
  if (!response.ok || !full?.result?.ok) {
    throw new DshDebugError(`DSH RPC ${safeToken(method, "unknown")} failed`, {
      phase: "rpc",
      category: "rpc_failure",
      method,
      httpStatus: response.status,
      code: safeRpcCode(full?.result?.error?.code),
    });
  }
  return full.result.value;
}

function openMux(baseUrl, onFrame, signal) {
  if (typeof WebSocket !== "function") throw new DshDebugError("Node WebSocket is unavailable", { phase: "mux", category: "unsupported_runtime" });
  let ws;
  try {
    ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/events.mux`);
  } catch {
    throw new DshDebugError("DSH event mux could not be created", { phase: "mux", category: "connect_failure" });
  }
  let settled = false;
  let onAbort;
  const ready = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      finish(resolve);
    };
    const onError = () => finish(reject, new DshDebugError("DSH event mux connection failed", { phase: "mux", category: "connect_failure" }));
    onAbort = () => {
      try { ws.close(); } catch {}
      finish(reject, new DshDebugError("DSH event mux connection was cancelled", { phase: "mux", category: "aborted" }));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)).payload;
      onFrame(payload);
    } catch {}
  });
  return {
    ready,
    close() {
      signal?.removeEventListener("abort", onAbort);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

async function connectMux(baseUrl, onFrame, child, state, signal) {
  let lastError = "connect_failure";
  while (true) {
    await checkSignal(signal);
    if (state.error || child.exitCode !== null || child.signalCode !== null) {
      throw new DshDebugError("DSH Web exited before event mux", { phase: "mux", category: "process_exit" });
    }
    const candidate = openMux(baseUrl, onFrame, signal);
    try {
      await candidate.ready;
      return candidate;
    } catch (error) {
      candidate.close();
      lastError = error instanceof DshDebugError ? error.details.category : "connect_failure";
      await waitMs(250, signal);
      if (lastError === "unsupported_runtime") throw error;
    }
  }
}

function waitForTurn(accumulator, timeoutMs, signal) {
  if (accumulator.turnEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let interval;
    let timer;
    const finish = (fn, value) => {
      clearInterval(interval);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new DshDebugError("DSH debug turn was cancelled or timed out", { phase: "turn", category: "aborted" }));
    const check = () => {
      if (accumulator.turnEnded) finish(resolve);
    };
    interval = setInterval(check, 100);
    timer = setTimeout(() => finish(reject, new DshDebugError("DSH debug turn timed out", { phase: "turn", category: "timeout" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

async function writeDebugTrace(traceDir, summary) {
  const { assistantText: _assistantText, ...safeSummary } = summary;
  const filename = `dsh-debug-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const tracePath = join(traceDir, filename);
  await mkdir(traceDir, { recursive: true });
  await writeFile(tracePath, `${JSON.stringify({ schemaVersion: 1, kind: "dsh-debug-summary", ...safeSummary }, null, 2)}\n`, "utf8");
  return { tracePath };
}

function normalizeFailure(error, phase, externalSignal, deadlineSignal) {
  if (externalSignal?.aborted) return new DshDebugError("DSH debug call was cancelled", { phase, category: "cancelled" });
  if (deadlineSignal?.aborted) return new DshDebugError("DSH debug call timed out", { phase, category: "timeout" });
  if (error instanceof DshDebugError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return new DshDebugError("DSH debug operation was aborted", { phase, category: "aborted" });
  return new DshDebugError("DSH debug operation failed", { phase, category: "internal" });
}

export async function runDshDebug({
  task,
  workspace,
  agentPreset,
  provider,
  model,
  reasoningEffort,
  dshHome,
  dshCommand = process.env.PI_DSH_COMMAND?.trim() || "dsh",
  launcherPath = WINDOWS_WEB_RUNNER,
  traceDir,
  saveTrace = false,
  includeReasoningFingerprint = false,
  timeoutMs = DEFAULT_DEBUG_TIMEOUT_MS,
  lockTimeoutSeconds = 60,
  signal,
  onUpdate,
} = {}) {
  if (typeof task !== "string" || task.trim() === "") throw new DshDebugError("DSH debug task is empty", { phase: "validate", category: "invalid_argument" });
  requireAbsolute(workspace, "workspace");
  requireAbsolute(launcherPath, "DSH debug launcher");
  const hasProvider = typeof provider === "string" && provider.trim().length > 0;
  const hasModel = typeof model === "string" && model.trim().length > 0;
  if ((provider !== undefined || model !== undefined) && (!hasProvider || !hasModel)) throw new DshDebugError("DSH debug provider and model must be paired", { phase: "validate", category: "invalid_argument" });
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || reasoningEffort.trim().length === 0 || !hasProvider || !hasModel)) throw new DshDebugError("DSH debug reasoningEffort requires provider and model", { phase: "validate", category: "invalid_argument" });
  if (agentPreset !== undefined && (typeof agentPreset !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(agentPreset))) throw new DshDebugError("DSH debug agentPreset is invalid", { phase: "validate", category: "invalid_argument" });
  if (!Number.isInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 0 || lockTimeoutSeconds > 86_400) throw new DshDebugError("DSH debug lockTimeoutSeconds is invalid", { phase: "validate", category: "invalid_argument" });

  const timeout = boundedInteger(timeoutMs, DEFAULT_DEBUG_TIMEOUT_MS, MAX_DEBUG_TIMEOUT_MS);
  const externalSignal = signal;
  if (externalSignal?.aborted) throw new DshDebugError("DSH debug call was cancelled", { phase: "validate", category: "cancelled" });
  const deadlineSignal = AbortSignal.timeout(timeout);
  const workSignal = externalSignal ? AbortSignal.any([externalSignal, deadlineSignal]) : deadlineSignal;
  const sourceHome = resolveDshHome(dshHome);
  const resolvedTraceDir = traceDir === undefined ? join(dirname(sourceHome), "dsh-debug-traces") : requireAbsolute(traceDir, "traceDir");
  const selection = { agentPreset, provider, model, reasoningEffort };
  let isolatedHome;
  let child;
  let mux;
  let sessionId;
  let cancelled = false;
  let phase = "prepare";
  const started = Date.now();
  const deadlineAt = started + timeout;
  const accumulator = new EventAccumulator(selection, { includeReasoningFingerprint });
  const childState = { error: null };

  const remaining = () => {
    const value = deadlineAt - Date.now();
    if (value <= 0) throw new DshDebugError("DSH debug call timed out", { phase, category: "timeout" });
    return value;
  };

  const onFrame = (frame) => {
    if (frame?.type !== "session/event") return;
    if (sessionId && frame.sessionId !== sessionId) return;
    const event = frame.event;
    accumulator.ingest(event);
    if (event?.type === "step/start") onUpdate?.({ type: "step", text: `DSH step ${safeInteger(eventData(event).step) ?? "?"} started` });
    if (event?.type === "tool/call") onUpdate?.({ type: "tool", text: `DSH tool: ${safeLabel(eventData(event).name, 96) ?? "?"}` });
    if (event?.type === "turn/end") onUpdate?.({ type: "turn-end", text: `DSH turn ended: ${safeToken(eventData(event).reason?.kind, "unknown")}` });
  };

  const cancelActive = async () => {
    if (!sessionId || cancelled || !child || child.exitCode !== null) return;
    cancelled = true;
    try {
      await rpc(`http://${LOOPBACK_HOST}:${childState.port}`, "session.cancel", { sessionId }, AbortSignal.timeout(2000));
    } catch {}
  };

  try {
    await checkSignal(workSignal);
    isolatedHome = await prepareIsolatedHome(sourceHome, randomUUID().replaceAll("-", ""), workSignal);
    await checkSignal(workSignal);
    const port = await allocatePort(workSignal);
    childState.port = port;
    const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
    child = spawn("pwsh", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
      "-DshHome", isolatedHome,
      "-LockDshHome", sourceHome,
      "-Workspace", workspace,
      "-LockTimeoutSeconds", String(lockTimeoutSeconds),
      "-DshCommand", dshCommand,
      "-Profile", "web",
      "-Port", String(port),
    ], { cwd: isolatedHome, env: { ...process.env, DSH_HOME: isolatedHome }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.once("error", (error) => { childState.error = error; });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    onUpdate?.({ type: "startup", text: "Starting isolated DSH debug server..." });

    phase = "startup";
    await waitHttp(baseUrl, child, childState, workSignal);
    phase = "mux";
    mux = await connectMux(baseUrl, onFrame, child, childState, workSignal);
    phase = "session_create";
    const createPayload = { cwd: workspace, ...(agentPreset ? { agentPreset } : {}) };
    const created = await rpc(baseUrl, "session.create", createPayload, workSignal);
    sessionId = created.sessionId;
    onUpdate?.({ type: "session", text: "DSH session created" });
    if (provider) {
      phase = "model_select";
      await rpc(baseUrl, "session.selectModel", { sessionId, provider, model, reasoningEffort }, workSignal);
    }
    phase = "prompt";
    const turn = waitForTurn(accumulator, remaining(), workSignal);
    const observedTurn = turn.then(
      () => ({ completed: true, error: undefined }),
      (error) => ({ completed: false, error }),
    );
    await rpc(baseUrl, "session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: task }] }, workSignal);
    phase = "turn";
    const turnResult = await observedTurn;
    if (!turnResult.completed) throw turnResult.error;
    phase = "history";
    const history = await rpc(baseUrl, "session.history", { sessionId, maxMessages: MAX_HISTORY_MESSAGES }, workSignal);
    for (const entry of history?.events ?? []) accumulator.ingest(entry?.event ?? entry);
    const summary = accumulator.summary();
    const trace = saveTrace ? await writeDebugTrace(resolvedTraceDir, summary) : undefined;
    return { sessionId, elapsedMs: Date.now() - started, summary, trace };
  } catch (error) {
    await cancelActive();
    throw normalizeFailure(error, phase, externalSignal, deadlineSignal);
  } finally {
    mux?.close();
    killProcessTree(child);
    await removeIsolatedHome(isolatedHome);
  }
}
