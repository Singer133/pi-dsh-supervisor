#!/usr/bin/env node
/**
 * Export compact Pi session traces for review.
 *
 * The default is the fail-closed `external` mode: it keeps structure and
 * diagnostics but never copies user/assistant text, commands, paths, IDs or
 * raw error text. `internal` is for a private review branch only. `repro`
 * emits one external-safe trace and marks it for manual fixture review.
 *
 * Example:
 *   node export-pi-review-sessions.mjs \
 *     --mode external \
 *     --source <PI_SESSION_ROOT> \
 *     --output docs/pi-review/sessions \
 *     --session <file.jsonl>=pi-bootstrap
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MODES = new Set(["external", "internal", "repro"]);
export const DEFAULT_MAX_TEXT = 1200;
export const DEFAULT_MAX_EVENTS = 1000;
const DEFAULT_MAX_ERROR = 500;
const SCHEMA_VERSION = 2;
const LOCAL_USER_NAME = /^[A-Za-z0-9._-]+$/.test(process.env.PI_REVIEW_USER_NAME ?? "")
  ? process.env.PI_REVIEW_USER_NAME
  : "";
const PRIVATE_DOMAIN_PATTERN = /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9-]+\.)+(?:internal|intra|local|lan|corp)(?![A-Za-z0-9_.-])/gi;
const SECRET_QUERY_PATTERN = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|key)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*["']?[^,\s"'}]+/gi;
const SECRET_LIKE_PATTERN = /(bearer\s+|-----BEGIN |\b(?:sk|rk)-|\b(?:ghp|gho|ghs|ghr|github_pat)_|\beyJ[A-Za-z0-9_-]+\.|\bAKIA[0-9A-Z]{16}\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]|[?&](?:token|key|secret|password)=)/i;
const PATH_KEYS = new Set(["path", "file", "cwd", "workspace", "runnerPath", "source", "output", "root"]);
const COMMAND_KEYS = new Set(["command", "cmd", "script"]);
const TEXT_KEYS = new Set(["task", "prompt", "query", "question", "project", "intent"]);
const KNOWN_EXECUTABLES = new Set([
  "bash", "cmd", "curl", "find", "git", "grep", "node", "npm", "npx", "pwsh", "python", "rg", "sed", "sort", "tar", "where",
]);

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node export-pi-review-sessions.mjs --source DIR --output DIR --session FILE=LABEL [--mode external|internal|repro] [--repro-note TEXT] [--max-text N] [--max-events N]");
  process.exit(2);
}

function nextArg(argv, index, name) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) usage(`${name} requires a value`);
  return argv[index + 1];
}

export function parseArgs(argv) {
  const args = { sessions: [], mode: "external", maxText: DEFAULT_MAX_TEXT, maxEvents: DEFAULT_MAX_EVENTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") args.source = nextArg(argv, index++, arg);
    else if (arg === "--output") args.output = nextArg(argv, index++, arg);
    else if (arg === "--session") args.sessions.push(nextArg(argv, index++, arg));
    else if (arg === "--mode") args.mode = nextArg(argv, index++, arg);
    else if (arg === "--repro-note") args.reproNote = nextArg(argv, index++, arg);
    else if (arg === "--max-text") args.maxText = Number(nextArg(argv, index++, arg));
    else if (arg === "--max-events") args.maxEvents = Number(nextArg(argv, index++, arg));
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`unknown argument: ${arg}`);
  }
  if (!args.source) usage("--source is required");
  if (!args.output) usage("--output is required");
  if (args.sessions.length === 0) usage("at least one --session FILE=LABEL is required");
  if (!MODES.has(args.mode)) usage(`--mode must be one of ${[...MODES].join(", ")}`);
  if (args.mode === "repro" && args.sessions.length !== 1) usage("repro mode accepts exactly one --session");
  if (!Number.isInteger(args.maxText) || args.maxText < 80 || args.maxText > 10000) {
    usage("--max-text must be an integer between 80 and 10000");
  }
  if (!Number.isInteger(args.maxEvents) || args.maxEvents < 100 || args.maxEvents > 10000) {
    usage("--max-events must be an integer between 100 and 10000");
  }
  if (args.mode === "repro" && !args.reproNote) usage("repro mode requires --repro-note");
  return args;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 24))} ...[truncated ${text.length - max} chars]`;
}

function replaceQuotedPaths(text) {
  return text
    .replace(/(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|(?:\/(?:Users?|home|mnt)\/))[^"']*\1/g, "<PATH>")
    .replace(/(?<![A-Za-z0-9])(?:\\\\)(?:[^\\/\s]+[\\/])+[^\s,;`"']+/g, "<UNC_PATH>")
    .replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/])[^\s,;`"']+/g, "<PATH>")
    .replace(/(?<![A-Za-z0-9])\/(?:Users?|home|mnt)\/[^\s,;`"']+/gi, "<PATH>");
}

export function redact(value, max = Number.POSITIVE_INFINITY) {
  let text = String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

  // Redact credential-bearing syntax before generic path and long-value rules.
  text = text
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, "$1<REDACTED>")
    .replace(SECRET_QUERY_PATTERN, "$1<REDACTED>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <REDACTED>")
    .replace(/(-----BEGIN [^-]+-----)[\s\S]*?(-----END [^-]+-----)/g, "$1<REDACTED>$2")
    .replace(/\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_\-]{12,}\b/gi, "<REDACTED_GITHUB_TOKEN>")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gi, "<REDACTED_KEY>")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<REDACTED_JWT>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<REDACTED_AWS_KEY>")
    .replace(SECRET_ASSIGNMENT_PATTERN, (match) => `${match.split(/[:=]/, 1)[0]}=<REDACTED>`)
    .replace(PRIVATE_DOMAIN_PATTERN, "<PRIVATE_DOMAIN>");

  text = replaceQuotedPaths(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<EMAIL>")
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[^\s`"']+/g, "<PATH>")
    .replace(/(?<![A-Za-z0-9])\/(?:d|c|mnt|home|Users?)[^\s`"']+/gi, "<PATH>")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "<LONG_VALUE>")
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/g, "<LONG_VALUE>");

  if (LOCAL_USER_NAME) text = text.replace(new RegExp(LOCAL_USER_NAME, "gi"), "<USER>");
  return truncate(text, max);
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function lineCount(value) {
  return String(value ?? "").length === 0 ? 0 : String(value).split(/\r?\n/).length;
}

function extensionOf(value) {
  const withoutQuery = String(value ?? "").split(/[?#]/, 1)[0];
  const extension = path.extname(withoutQuery).toLowerCase();
  return extension.length <= 16 ? extension : "";
}

export function pathShape(value) {
  const text = String(value ?? "");
  let category = "value";
  if (/^\\\\/.test(text)) category = "unc_path";
  else if (/^[A-Za-z]:[\\/]/.test(text)) category = "windows_absolute";
  else if (/^\/(?:Users?|home|mnt)\//i.test(text)) category = "posix_absolute";
  else if (/^(?:~[\\/]|\.\.?(?:[\\/]|$))/.test(text)) category = "relative_or_home";
  else if (/[\\/]/.test(text)) category = "relative_path";
  else if (text) category = "filename";
  return { kind: "path", category, extension: extensionOf(text) || undefined, chars: text.length };
}

function firstToken(value) {
  const match = String(value ?? "").trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:["']([^"']+)["']|(\S+))/);
  return match?.[1] ?? match?.[2] ?? "";
}

export function commandShape(value, mode = "external", maxText = DEFAULT_MAX_TEXT) {
  const text = String(value ?? "");
  const token = path.basename(firstToken(text).replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
  const executable = KNOWN_EXECUTABLES.has(token) ? token : token ? "other" : "unknown";
  const shape = {
    kind: "command",
    chars: text.length,
    lines: lineCount(text),
    executable,
    hasCredentialLikeSyntax: SECRET_LIKE_PATTERN.test(text),
    hasPathLikeSyntax: /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users?|home|mnt)\/)/i.test(text),
  };
  if (mode === "internal") shape.preview = redact(text, maxText);
  return shape;
}

function valueShape(key, value, mode, maxText) {
  if (PATH_KEYS.has(key)) return pathShape(value);
  if (COMMAND_KEYS.has(key)) return commandShape(value, mode, maxText);
  if (TEXT_KEYS.has(key)) {
    const shape = { kind: "text", chars: String(value ?? "").length, lines: lineCount(value) };
    if (mode === "internal") shape.preview = redact(value, maxText);
    return shape;
  }
  if (typeof value === "string") {
    const shape = { kind: "string", chars: value.length };
    if (mode === "internal" && key !== "content") shape.preview = redact(value, maxText);
    return shape;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { kind: value === null ? "null" : typeof value };
  }
  if (Array.isArray(value)) return { kind: "array", items: value.length };
  if (value && typeof value === "object") return { kind: "object", keys: Object.keys(value).sort() };
  return { kind: "unknown" };
}

export function safeArguments(args, mode = "external", maxText = DEFAULT_MAX_TEXT) {
  let parsed = args;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = { raw: parsed };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { keys: [], value: valueShape("value", parsed, mode, maxText) };
  }
  const keys = Object.keys(parsed).sort();
  return {
    keys,
    fields: Object.fromEntries(keys.map((key) => [key, valueShape(key, parsed[key], mode, maxText)])),
  };
}

export function classifyError(errorText) {
  const text = String(errorText ?? "");
  if (!text) return { category: "none", signature: "none" };
  const rules = [
    ["credential", "missing_credential", /MISSING_CREDENTIAL|missing credential|API key|api key/i],
    ["timeout", "timeout", /timed out after|Command timed out|ETIMEDOUT/i],
    ["aborted", "aborted", /\baborted\b|AbortError/i],
    ["validation", "tool_schema_validation", /Validation failed for tool|schema validation/i],
    ["permission", "permission_denied", /permission denied|access is denied|not authorized/i],
    ["not_found", "missing_path_or_dependency", /ENOENT|No such file|Cannot find module|not found/i],
    ["encoding", "python_console_encoding", /Unicode(?:Encode|Decode)Error/i],
    ["syntax", "shell_syntax", /unexpected EOF|syntax error|parse error/i],
    ["network", "network_failure", /ECONNREFUSED|ENOTFOUND|fetch failed|network/i],
    ["edit", "edit_anchor_mismatch", /Could not find the exact text|occurrences of edits\[/i],
  ];
  for (const [category, signature, pattern] of rules) if (pattern.test(text)) return { category, signature };
  return { category: "other", signature: "unclassified" };
}

function summarizeBlocks(content, role, toolName, maxText, mode) {
  if (role === "toolResult") {
    const raw = textFromContent(content);
    const result = {
      kind: "toolResult",
      toolName: toolName || "unknown",
      isError: false,
      chars: raw.length,
    };
    if (mode === "internal" && raw) result.preview = redact(raw, maxText);
    return result;
  }

  if (!Array.isArray(content)) {
    const raw = textFromContent(content);
    if (!raw) return [];
    const result = { kind: "text", chars: raw.length };
    if (mode === "internal") result.text = redact(raw, maxText);
    return [result];
  }

  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      const result = { kind: "text", chars: part.length };
      if (mode === "internal") result.text = redact(part, maxText);
      blocks.push(result);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const type = part.type || "unknown";
    if (type === "thinking" || type === "reasoning") {
      const raw = typeof part.thinking === "string" ? part.thinking : textFromContent(part.content);
      blocks.push({ kind: "thinking", chars: raw.length });
    } else if (type === "text" || typeof part.text === "string") {
      const raw = String(part.text ?? "");
      const result = { kind: "text", chars: raw.length };
      if (mode === "internal") result.text = redact(raw, maxText);
      blocks.push(result);
    } else if (type === "toolCall" || type === "tool_call") {
      blocks.push({
        kind: "toolCall",
        name: part.name || part.toolName || "unknown",
        arguments: safeArguments(part.arguments, mode, maxText),
      });
    } else {
      blocks.push({ kind: type, keys: Object.keys(part).sort() });
    }
  }
  return blocks;
}

function baseEvent(event, sequence, mode) {
  const base = { sequence, type: event.type || "unknown" };
  if (mode === "internal") {
    base.id = event.id;
    base.parentId = event.parentId;
    base.timestamp = event.timestamp;
  }
  return base;
}

export function sanitizeEvent(event, maxText, mode = "external", sequence = 0) {
  const base = baseEvent(event, sequence, mode);
  if (event.type === "session") {
    return {
      ...base,
      version: event.version,
      cwdCategory: "workspace",
      originalKeys: Object.keys(event).sort(),
    };
  }
  if (event.type === "model_change") return { ...base, provider: event.provider, modelId: event.modelId };
  if (event.type === "thinking_level_change") return { ...base, thinkingLevel: event.thinkingLevel };
  if (event.type === "message") {
    const message = event.message || {};
    const role = message.role || "unknown";
    const result = {
      ...base,
      message: {
        role,
        provider: message.provider,
        model: message.model,
        api: message.api,
        stopReason: message.stopReason,
        rawStopReason: message.rawStopReason,
        toolName: message.toolName,
        isError: Boolean(message.isError),
      },
    };
    if (role === "toolResult") {
      const raw = textFromContent(message.content);
      result.message.content = {
        kind: "toolResult",
        toolName: message.toolName || "unknown",
        isError: Boolean(message.isError),
        chars: raw.length,
        error: message.isError ? classifyError(raw) : { category: "none", signature: "none" },
      };
      if (mode === "internal" && message.isError) result.message.content.errorPreview = redact(raw.split(/\r?\n/, 1)[0], DEFAULT_MAX_ERROR);
    } else {
      result.message.content = summarizeBlocks(message.content, role, message.toolName, maxText, mode);
    }
    return result;
  }
  if (event.type === "compaction") {
    return {
      ...base,
      originalKeys: Object.keys(event).sort(),
      summaryChars: typeof event.summary === "string" ? event.summary.length : undefined,
    };
  }
  if (event.type === "session_info") return { ...base, keys: Object.keys(event).sort() };
  return { ...base, keys: Object.keys(event).sort() };
}

function chooseEvenly(indices, count, selected) {
  if (count <= 0 || indices.length === 0) return;
  if (count >= indices.length) {
    for (const index of indices) selected.add(index);
    return;
  }
  if (count === 1) {
    selected.add(indices[Math.floor((indices.length - 1) / 2)]);
    return;
  }
  for (let offset = 0; offset < count; offset += 1) {
    selected.add(indices[Math.floor((offset * (indices.length - 1)) / (count - 1))]);
  }
}

/**
 * Keep a bounded trace while reserving space for head, tail, important errors,
 * and uniform context. Important events intentionally receive a quota rather
 * than an unlimited first pass, so they cannot crowd out the final result.
 */
export function capEvents(events, maxEvents) {
  if (events.length <= maxEvents) return { events, omitted: 0 };
  const selected = new Set();
  const all = events.map((_, index) => index);
  const important = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type !== "message" || event.message?.role === "user" || (event.message?.role === "toolResult" && event.message?.content?.isError === true))
    .map(({ index }) => index);

  selected.add(0);
  selected.add(events.length - 1);
  const headSlots = Math.min(40, Math.max(1, Math.floor(maxEvents * 0.15)));
  const tailSlots = Math.min(40, Math.max(1, Math.floor(maxEvents * 0.15)));
  chooseEvenly(all.slice(0, Math.min(all.length, Math.max(1, Math.floor(all.length * 0.2)))), headSlots, selected);
  chooseEvenly(all.slice(Math.max(0, all.length - Math.max(1, Math.floor(all.length * 0.2)))), tailSlots, selected);

  const importantSlots = Math.min(
    Math.max(1, Math.floor(maxEvents * 0.35)),
    Math.max(0, maxEvents - selected.size),
  );
  chooseEvenly(important.filter((index) => !selected.has(index)), importantSlots, selected);

  const remaining = maxEvents - selected.size;
  chooseEvenly(all.filter((index) => !selected.has(index)), remaining, selected);
  if (selected.size < maxEvents) {
    for (const index of all) {
      if (selected.size >= maxEvents) break;
      selected.add(index);
    }
  }

  const chosen = [...selected].sort((left, right) => left - right).slice(0, maxEvents).map((index) => events[index]);
  return { events: chosen, omitted: events.length - chosen.length };
}

function parseSessionSpec(spec) {
  const separator = spec.lastIndexOf("=");
  if (separator <= 0 || separator === spec.length - 1) throw new Error(`invalid --session spec: ${spec}`);
  const file = spec.slice(0, separator);
  const label = spec.slice(separator + 1);
  if (path.basename(file) !== file || !file.endsWith(".jsonl")) throw new Error(`session must be a JSONL basename, not a path: ${file}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error(`invalid session label: ${label}`);
  return { file, label };
}

function sourceProvenance(mode, label, file, stat, inputPath, reproNote) {
  if (mode === "internal") {
    return {
      label,
      file,
      root: "<PI_SESSION_ROOT>",
      bytes: stat.size,
      sha256Prefix: stableHash(fs.readFileSync(inputPath)),
    };
  }
  if (mode === "repro") {
    return {
      label,
      root: "<PI_SESSION_ROOT>",
      reviewRequired: true,
      noteChars: String(reproNote ?? "").length,
    };
  }
  return { label };
}

async function exportOne(sourceDir, outputDir, spec, options) {
  const { file, label } = parseSessionSpec(spec);
  const inputPath = path.join(sourceDir, file);
  const stat = fs.statSync(inputPath);
  const events = [];
  let invalidLines = 0;
  const input = readline.createInterface({ input: fs.createReadStream(inputPath, { encoding: "utf8" }), crlfDelay: Infinity });
  let sequence = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      events.push(sanitizeEvent(JSON.parse(line), options.maxText, options.mode, sequence));
      sequence += 1;
    } catch {
      invalidLines += 1;
    }
  }

  const capped = capEvents(events, options.maxEvents);
  const output = {
    schemaVersion: SCHEMA_VERSION,
    kind: "pi-review-session-trace",
    mode: options.mode,
    source: sourceProvenance(options.mode, label, file, stat, inputPath, options.reproNote),
    policy: {
      rawTranscript: false,
      thinkingText: false,
      successfulToolOutput: false,
      redactedPathsAndCredentials: true,
      textPayloads: options.mode === "internal" ? "redacted-previews" : "excluded",
      commandPayloads: options.mode === "internal" ? "redacted-previews" : "shape-only",
      identifiers: options.mode === "internal" ? "preserved-for-private-review" : "excluded",
      maxTextPreviewChars: options.mode === "internal" ? options.maxText : 0,
      maxEvents: options.maxEvents,
      manualReviewRequired: options.mode === "repro",
    },
    eventStats: { total: events.length, included: capped.events.length, omitted: capped.omitted },
    events: capped.events,
    invalidLines,
  };
  const outputPath = path.join(outputDir, `${label}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return {
    ...sourceProvenance(options.mode, label, file, stat, inputPath, options.reproNote),
    output: path.basename(outputPath),
    events: events.length,
    includedEvents: capped.events.length,
    omittedEvents: capped.omitted,
    invalidLines,
  };
}

export async function exportSessions(options) {
  const sourceDir = path.resolve(options.source);
  const outputDir = path.resolve(options.output);
  fs.mkdirSync(outputDir, { recursive: true });
  const exported = [];
  for (const spec of options.sessions) exported.push(await exportOne(sourceDir, outputDir, spec, options));
  const index = {
    schemaVersion: SCHEMA_VERSION,
    kind: "pi-review-session-index",
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    sourceRoot: "<PI_SESSION_ROOT>",
    policy: {
      description: options.mode === "external"
        ? "External-safe structural traces; no raw text, command, path, identifier or error payload."
        : options.mode === "repro"
          ? "One external-safe trace for a manually reviewed reproduction fixture."
          : "Private review traces with redacted text previews; do not publish.",
      rawTranscript: false,
      thinkingText: false,
      successfulToolOutput: false,
      redactedPathsAndCredentials: true,
      maxTextPreviewChars: options.mode === "internal" ? options.maxText : 0,
      maxEventsPerTrace: options.maxEvents,
      manualReviewRequired: options.mode === "repro",
    },
    sessions: exported,
  };
  fs.writeFileSync(path.join(outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  const index = await exportSessions(args);
  console.log(JSON.stringify(index, null, 2));
}
