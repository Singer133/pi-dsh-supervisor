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

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WINDOWS_WEB_RUNNER = join(PACKAGE_ROOT, "scripts", "run-dsh-web.ps1");
const LOOPBACK_HOST = ["127", "0", "0", "1"].join(".");

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function boundedInteger(value, fallback, max) {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function resolveDshHome(input) {
  const value = input?.trim() || process.env.DSH_HOME?.trim();
  if (!value) throw new Error("DSH_HOME is required for DSH debug");
  return requireAbsolute(value, "DSH_HOME");
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
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => !types || types.includes(block?.type))
    .map(textFromBlock)
    .join("");
}

function sha256Prefix(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function lineCount(value) {
  return value ? value.split(/\r?\n/).filter(Boolean).length : 0;
}

function extractToolNames(event) {
  const data = eventData(event);
  const header = data.header ?? data.request?.header ?? data.request ?? {};
  const tools = header.tools ?? data.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => typeof tool === "string" ? tool : tool?.name ?? tool?.function?.name ?? "?")
    .filter(Boolean);
}

function collectReasoning(events) {
  const byStep = new Map();
  for (const event of events) {
    const data = eventData(event);
    let text = "";
    if (event.type === "assistant/chunk") {
      const chunk = data.chunk ?? {};
      if (chunk.type === "reasoning-delta" || chunk.type === "thinking-delta") text = String(chunk.text ?? "");
    } else if (event.type === "assistant/message") {
      text = contentText(eventMessage(event).content, ["reasoning", "thinking"]);
    }
    if (!text) continue;
    const key = `${data.turn ?? "?"}:${data.step ?? "?"}`;
    byStep.set(key, `${byStep.get(key) ?? ""}${text}`);
  }
  return [...byStep.entries()].map(([key, text]) => {
    const [turn, step] = key.split(":");
    return {
      turn: turn === "?" ? null : Number(turn),
      step: step === "?" ? null : Number(step),
      chars: text.length,
      lines: lineCount(text),
      sha256: sha256Prefix(text),
    };
  });
}

function extractAssistantText(events) {
  const messages = events
    .filter((event) => event.type === "assistant/message")
    .map((event) => contentText(eventMessage(event).content, ["text"]))
    .filter(Boolean);
  return messages.at(-1) ?? "";
}

export function summarizeEvents(events, selection = {}) {
  const reasoningChunks = collectReasoning(events);
  const toolCalls = events
    .filter((event) => event.type === "tool/call")
    .map((event) => ({
      turn: eventData(event).turn ?? null,
      step: eventData(event).step ?? null,
      name: eventData(event).name ?? eventData(event).tool ?? "?",
    }));
  const toolResults = events.filter((event) => event.type === "tool/result");
  const errors = events
    .filter((event) => event.type === "turn/end" && eventData(event).reason?.kind === "error")
    .map((event) => eventData(event).reason);
  const headers = events.filter((event) => event.type === "request/header");
  const headerTools = headers.flatMap(extractToolNames).filter((name, index, all) => all.indexOf(name) === index);
  const ends = events.filter((event) => event.type === "turn/end");
  const lastEnd = ends.at(-1);
  return {
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type))],
    headerTools,
    headerToolCount: headerTools.length,
    toolCalls,
    toolResultCount: toolResults.length,
    toolErrorCount: toolResults.filter((event) => Boolean(eventData(event).error || eventMessage(event).isError)).length,
    reasoningChunks,
    reasoningTotalChars: reasoningChunks.reduce((sum, chunk) => sum + chunk.chars, 0),
    turnEnd: lastEnd ? eventData(lastEnd).reason ?? null : null,
    errors,
    assistantText: extractAssistantText(events),
    selection,
  };
}

function mergeEvents(liveEvents, historyValue) {
  const historyEvents = (historyValue?.events ?? []).map((entry) => entry?.event ?? entry).filter(Boolean);
  const seen = new Set();
  const merged = [];
  for (const event of [...historyEvents, ...liveEvents]) {
    const key = event.seq !== undefined ? `seq:${event.seq}` : `${event.type}:${JSON.stringify(event.data ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function copyIfPresent(source, target, options = undefined) {
  if (existsSync(source)) await cp(source, target, options);
}

async function prepareIsolatedHome(sourceHome, token) {
  const home = join(dirname(sourceHome), `pi-dsh-debug-${process.pid}-${token}`);
  const profile = join(home, "profiles", "web");
  const sourceProfile = join(sourceHome, "profiles", "web");
  try {
    await mkdir(profile, { recursive: true });
    await copyIfPresent(join(sourceHome, "settings.yaml"), join(home, "settings.yaml"));
    await copyIfPresent(join(sourceHome, "cordis.patch.yml"), join(home, "cordis.patch.yml"));
    await copyIfPresent(join(sourceHome, ".agent-presets"), join(home, ".agent-presets"), { recursive: true });
    for (const name of ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
      await copyIfPresent(join(sourceProfile, name), join(profile, name));
    }
    const sourceModules = join(sourceProfile, "node_modules");
    if (existsSync(sourceModules)) await symlink(sourceModules, join(profile, "node_modules"), "junction");
    const fallbackModules = join(sourceHome, "profiles", "node_modules");
    if (existsSync(fallbackModules)) await symlink(fallbackModules, join(home, "profiles", "node_modules"), "junction");
    return home;
  } catch (error) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function boundedAppend(current, chunk, max = 16_000) {
  const text = `${current}${String(chunk)}`;
  return text.length <= max ? text : text.slice(-max);
}

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

async function waitHttp(baseUrl, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH Web exited during startup (${child.exitCode}): ${last}`);
    try {
      const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DSH Web startup timed out: ${last}`);
}

async function rpc(baseUrl, method, payload, signal) {
  const timeout = AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal: requestSignal,
  });
  const full = await response.json();
  if (!response.ok || !full.result?.ok) {
    const error = full.result?.error;
    throw new Error(`${method} failed: ${error?.code ?? error?.message ?? JSON.stringify(full)}`);
  }
  return full.result.value;
}

function openMux(baseUrl, onFrame) {
  if (typeof WebSocket !== "function") throw new Error("Node WebSocket is unavailable; DSH debug requires Node 22+");
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/events.mux`);
  const ready = new Promise((resolve, reject) => {
    const onOpen = () => { ws.removeEventListener("error", onError); resolve(); };
    const onError = () => { ws.removeEventListener("open", onOpen); reject(new Error("DSH event mux WebSocket failed")); };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
  ws.addEventListener("message", (event) => {
    try { onFrame(JSON.parse(typeof event.data === "string" ? event.data : String(event.data)).payload); } catch {}
  });
  return {
    ready,
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

async function connectMux(baseUrl, onFrame, child, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH Web exited before event mux (${child.exitCode})`);
    const candidate = openMux(baseUrl, onFrame);
    try {
      await candidate.ready;
      return candidate;
    } catch (error) {
      candidate.close();
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`DSH event mux WebSocket failed: ${lastError}`);
}

function waitForTurn(events, sessionId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, value) => {
      if (timer) clearInterval(timer);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new Error("DSH debug call was cancelled"));
    const check = () => {
      const hit = events.find((frame) => frame.sessionId === sessionId && frame.event?.type === "turn/end");
      if (hit) finish(resolve, hit.event);
    };
    const deadline = setTimeout(() => finish(reject, new Error(`DSH debug turn timed out after ${timeoutMs}ms`)), timeoutMs);
    timer = setInterval(check, 100);
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

export async function runDshDebug({
  task,
  workspace,
  agentPreset = "dst-fast",
  provider,
  model,
  reasoningEffort,
  dshHome,
  launcherPath = WINDOWS_WEB_RUNNER,
  traceDir,
  saveTrace = false,
  timeoutMs = DEFAULT_DEBUG_TIMEOUT_MS,
  signal,
  onUpdate,
} = {}) {
  if (typeof task !== "string" || task.trim() === "") throw new Error("DSH debug task must not be empty");
  requireAbsolute(workspace, "workspace");
  if ((provider && !model) || (!provider && model)) throw new Error("provider and model must be provided together");
  const timeout = boundedInteger(timeoutMs, DEFAULT_DEBUG_TIMEOUT_MS, MAX_DEBUG_TIMEOUT_MS);
  requireAbsolute(launcherPath, "DSH debug launcher");
  const sourceHome = resolveDshHome(dshHome);
  const resolvedTraceDir = traceDir === undefined ? join(dirname(sourceHome), "dsh-debug-traces") : requireAbsolute(traceDir, "traceDir");
  const isolatedHome = await prepareIsolatedHome(sourceHome, randomUUID().replaceAll("-", ""));
  const port = await allocatePort();
  const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
  const started = Date.now();
  const deadline = started + timeout;
  const child = spawn("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
    "-DshHome", isolatedHome, "-Profile", "web", "-Port", String(port),
  ], { cwd: isolatedHome, env: { ...process.env, DSH_HOME: isolatedHome }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => { diagnostics = boundedAppend(diagnostics, chunk); });
  child.stdout?.on("data", (chunk) => { diagnostics = boundedAppend(diagnostics, chunk); });
  let mux;
  let sessionId;
  let cancelled = false;
  const events = [];
  const onFrame = (frame) => {
    if (frame?.type !== "session/event") return;
    if (sessionId && frame.sessionId !== sessionId) return;
    events.push(frame);
    const event = frame.event;
    if (event?.type === "step/start") onUpdate?.({ type: "step", text: `DSH step ${eventData(event).step ?? "?"} started` });
    if (event?.type === "tool/call") onUpdate?.({ type: "tool", text: `DSH tool: ${eventData(event).name ?? "?"}` });
    if (event?.type === "turn/end") onUpdate?.({ type: "turn-end", text: `DSH turn ended: ${eventData(event).reason?.kind ?? "unknown"}` });
  };
  const cancelActive = async () => {
    if (!sessionId || cancelled) return;
    cancelled = true;
    try { await rpc(baseUrl, "session.cancel", { sessionId }); } catch {}
  };
  const onAbort = () => { void cancelActive(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    onUpdate?.({ type: "startup", text: "Starting isolated DSH debug server..." });
    const remaining = () => Math.max(1000, deadline - Date.now());
    await waitHttp(baseUrl, child, Math.min(remaining(), 120_000));
    mux = await connectMux(baseUrl, onFrame, child, remaining());
    const created = await rpc(baseUrl, "session.create", { cwd: workspace, agentPreset }, signal);
    sessionId = created.sessionId;
    onUpdate?.({ type: "session", text: `DSH session created: ${sessionId}` });
    if (provider) await rpc(baseUrl, "session.selectModel", { sessionId, provider, model, reasoningEffort }, signal);
    const turn = waitForTurn(events, sessionId, remaining(), signal);
    await rpc(baseUrl, "session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: task }] }, signal);
    await turn;
    const history = await rpc(baseUrl, "session.history", { sessionId, maxMessages: 10_000 }, signal);
    const liveSessionEvents = events.filter((frame) => frame.sessionId === sessionId).map((frame) => frame.event).filter(Boolean);
    const sessionEvents = mergeEvents(liveSessionEvents, history);
    const summary = summarizeEvents(sessionEvents, { agentPreset, provider, model, reasoningEffort });
    const trace = saveTrace ? await writeDebugTrace(resolvedTraceDir, summary) : undefined;
    return { sessionId, elapsedMs: Date.now() - started, summary, trace };
  } catch (error) {
    await cancelActive();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${diagnostics ? `; server: ${diagnostics.slice(-1200)}` : ""}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    mux?.close();
    killProcessTree(child);
    await rm(isolatedHome, { recursive: true, force: true });
  }
}
