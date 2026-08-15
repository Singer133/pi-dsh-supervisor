import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redact } from "./review-export.mjs";
import { runHealthWithRetry } from "./dsh-health.mjs";
import { runDshDebug } from "./dsh-debug.mjs";
import { runDshTask, summarizeTaskResult } from "./dsh-runner.mjs";

const taskParameters = Type.Object({
  task: Type.String({ description: "Independent task for a fresh DSH headless child" }),
  workspace: Type.Optional(Type.String({ description: "Absolute workspace path; defaults to the current Pi workspace" })),
  dshHome: Type.Optional(Type.String({ description: "Optional absolute DSH_HOME override" })),
}, { additionalProperties: false });

const smokeParameters = Type.Object({}, { additionalProperties: false });

const debugParameters = Type.Object({
  task: Type.String({ description: "Task for a fresh DSH Web/API session" }),
  workspace: Type.Optional(Type.String({ description: "Absolute workspace path; defaults to the current Pi workspace" })),
  dshHome: Type.Optional(Type.String({ description: "Optional absolute DSH_HOME override" })),
  agentPreset: Type.Optional(Type.String({ description: "DSH preset, for example dst-fast or dst-orchestrator" })),
  provider: Type.Optional(Type.String({ description: "DSH provider; must be paired with model" })),
  model: Type.Optional(Type.String({ description: "DSH model; must be paired with provider" })),
  reasoningEffort: Type.Optional(Type.String({ description: "Provider reasoning effort, for example max" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1800000 })),
  saveTrace: Type.Optional(Type.Boolean({ description: "Write a structural local debug summary; never writes raw messages or reasoning" })),
  traceDir: Type.Optional(Type.String({ description: "Optional absolute directory for the structural debug summary" })),
  includeReasoningFingerprint: Type.Optional(Type.Boolean({ description: "Opt in to a short derived reasoning fingerprint; chars/lines are always reported" })),
  lockTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
}, { additionalProperties: false });

function assertOptionalAbsolute(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

function capArray<T>(items: T[], max: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}

function publicDiagnostics(summary: {
  selection: unknown;
  eventTypes: string[];
  eventTypesTruncated?: boolean;
  headerTools: string[];
  toolCalls: unknown[];
  toolCallCount?: number;
  toolCallsTruncated?: boolean;
  toolResultCount: number;
  toolErrorCount: number;
  reasoningChunks: unknown[];
  reasoningChunksTruncated?: boolean;
  reasoningTotalChars: number;
  turnEnd: unknown;
  errors: unknown[];
}): Record<string, unknown> {
  const eventTypes = capArray(summary.eventTypes, 64);
  const headerTools = capArray(summary.headerTools, 96);
  const toolCalls = capArray(summary.toolCalls, 64);
  const reasoningChunks = capArray(summary.reasoningChunks, 64);
  return {
    selection: summary.selection,
    eventTypes: eventTypes.items,
    eventTypesTruncated: Boolean(summary.eventTypesTruncated || eventTypes.truncated),
    headerTools: headerTools.items,
    headerToolsTruncated: headerTools.truncated,
    toolCalls: toolCalls.items,
    toolCallCount: summary.toolCallCount ?? summary.toolCalls.length,
    toolCallsTruncated: Boolean(summary.toolCallsTruncated || toolCalls.truncated),
    toolResultCount: summary.toolResultCount,
    toolErrorCount: summary.toolErrorCount,
    reasoningChunks: reasoningChunks.items,
    reasoningChunksTruncated: Boolean(summary.reasoningChunksTruncated || reasoningChunks.truncated),
    reasoningTotalChars: summary.reasoningTotalChars,
    turnEnd: summary.turnEnd,
    errors: summary.errors.slice(0, 8),
  };
}

function debugContent(summary: { assistantText: string }, diagnostics: Record<string, unknown>): string {
  const body = [
    "DSH result:",
    summary.assistantText,
    "",
    "DSH structural diagnostics:",
    JSON.stringify(diagnostics, null, 2),
  ].join("\n");
  return body.length <= 48_000 ? body : `${body.slice(0, 47_940)}\n...[diagnostics truncated]`;
}

export default function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dsh_call",
    label: "DSH Call",
    description: "Run one bounded task in a fresh, isolated DSH headless child. Same-workspace calls are serialized. This never resumes or restarts the user's Web DSH session.",
    parameters: taskParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workspace = assertOptionalAbsolute(params.workspace, "workspace") ?? ctx.cwd;
      const dshHome = assertOptionalAbsolute(params.dshHome, "dshHome");
      onUpdate?.({ content: [{ type: "text", text: "Starting isolated DSH child..." }] });
      const result = await runDshTask(
        { task: params.task, workspace, dshHome },
        { signal },
      );
      const summary = summarizeTaskResult(result);
      if (!summary.ok) {
        throw new Error(`DSH child failed: ${redact(summary.diagnostic, 1200)}`);
      }
      if (!summary.output) throw new Error("DSH child returned no assistant text");
      return {
        content: [{ type: "text", text: summary.output }],
        details: {
          route: "dsh-headless",
          workspaceCategory: "workspace",
          exitCode: summary.code,
          truncated: summary.truncated,
        },
      };
    },
  });

  pi.registerTool({
    name: "dsh_debug",
    label: "DSH Debug",
    description: "Run one fresh isolated DSH Web/API session and return structural diagnostics: selected preset/model, event types, tools, tool errors, turn result, and reasoning chunk lengths/fingerprints. It never resumes or restarts the user's Web session and never exports raw reasoning or tool output.",
    parameters: debugParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const workspace = assertOptionalAbsolute(params.workspace, "workspace") ?? ctx.cwd;
      const dshHome = assertOptionalAbsolute(params.dshHome, "dshHome");
      const traceDir = assertOptionalAbsolute(params.traceDir, "traceDir");
      const result = await runDshDebug({
        task: params.task,
        workspace,
        dshHome,
        agentPreset: params.agentPreset,
        provider: params.provider,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        timeoutMs: params.timeoutMs,
        saveTrace: params.saveTrace ?? false,
        includeReasoningFingerprint: params.includeReasoningFingerprint ?? false,
        lockTimeoutSeconds: params.lockTimeoutSeconds ?? 60,
        traceDir,
        signal,
        onUpdate: (update) => onUpdate?.({ content: [{ type: "text", text: update.text }] }),
      });
      const summary = result.summary;
      if (summary.errors.length > 0 || summary.turnEnd?.kind === "error") {
        throw new Error(`DSH debug turn failed (${summary.turnEnd?.kind ?? "error"})`);
      }
      if (!summary.assistantText) throw new Error("DSH debug session returned no assistant text");
      const diagnostics = publicDiagnostics(summary);
      return {
        content: [{ type: "text", text: debugContent(summary, diagnostics) }],
        details: {
          route: "dsh-web-debug",
          sessionId: result.sessionId,
          elapsedMs: result.elapsedMs,
          ...diagnostics,
          trace: result.trace,
        },
      };
    },
  });

  pi.registerTool({
    name: "dsh_smoke",
    label: "DSH Smoke",
    description: "Run a no-model DSH startup/configuration probe. It may retry with a fresh child; it never replays a user task or restarts Web DSH.",
    parameters: smokeParameters,
    async execute(_toolCallId, _params, signal) {
      const result = await runHealthWithRetry({ signal });
      if (!result.ok) throw new Error(`DSH smoke failed after ${result.attempts} attempt(s): ${result.diagnostic}`);
      return {
        content: [{ type: "text", text: `DSH smoke passed (${result.attempts} fresh process probe${result.attempts === 1 ? "" : "s"}).` }],
        details: { route: "dsh-health", attempts: result.attempts, output: redact(result.stdout, 500) },
      };
    },
  });
}
