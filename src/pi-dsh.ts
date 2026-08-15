import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redact } from "./review-export.mjs";
import { runHealthWithRetry } from "./dsh-health.mjs";
import { runDshTask, summarizeTaskResult } from "./dsh-runner.mjs";

const taskParameters = Type.Object({
  task: Type.String({ description: "Independent task for a fresh DSH headless child" }),
  workspace: Type.Optional(Type.String({ description: "Absolute workspace path; defaults to the current Pi workspace" })),
  dshHome: Type.Optional(Type.String({ description: "Optional absolute DSH_HOME override" })),
}, { additionalProperties: false });

const smokeParameters = Type.Object({}, { additionalProperties: false });

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
