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
}, { additionalProperties: false });

function assertOptionalAbsolute(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
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
        traceDir,
        signal,
        onUpdate: (update) => onUpdate?.({ content: [{ type: "text", text: update.text }] }),
      });
      const summary = result.summary;
      if (summary.errors.length > 0 || summary.turnEnd?.kind === "error") {
        throw new Error(`DSH debug turn failed: ${redact(JSON.stringify(summary.errors.at(-1) ?? summary.turnEnd), 1200)}`);
      }
      if (!summary.assistantText) throw new Error("DSH debug session returned no assistant text");
      const { assistantText: _assistantText, ...details } = summary;
      return {
        content: [{ type: "text", text: summary.assistantText }],
        details: {
          route: "dsh-web-debug",
          sessionId: result.sessionId,
          elapsedMs: result.elapsedMs,
          ...details,
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
    async execute() {
      const result = await runHealthWithRetry();
      if (!result.ok) throw new Error(`DSH smoke failed after ${result.attempts} attempt(s): ${result.diagnostic}`);
      return {
        content: [{ type: "text", text: `DSH smoke passed (${result.attempts} fresh process probe${result.attempts === 1 ? "" : "s"}).` }],
        details: { route: "dsh-health", attempts: result.attempts, output: redact(result.stdout, 500) },
      };
    },
  });
}
