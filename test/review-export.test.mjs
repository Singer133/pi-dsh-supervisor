import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  capEvents,
  commandShape,
  exportSessions,
  pathShape,
  redact,
  safeArguments,
  sanitizeEvent,
} from "../src/review-export.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-export-"));
}

const secrets = {
  bearer: ["Bearer ", "super-secret-bearer-value-123456"].join(""),
  github: ["ghp_", "abcdefghijklmnopqrstuvwxyz1234567890"].join(""),
  jwt: ["eyJ", "abcdefghijklmnopqrstuvwxyz1234567890", ".eyJ", "abcdefghijklmnopqrstuvwxyz", ".abcdefghijklmnopqrstuvwxyz123456"].join(""),
  aws: ["AKIA", "1234567890ABCDEF"].join(""),
  email: ["person", "@example.com"].join(""),
  base64: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVlaQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVla",
};

test("redact removes credential, URL, cookie, path, domain and identifier forms", () => {
  const input = String.raw`${secrets.bearer}
${secrets.github}
${secrets.jwt}
${secrets.aws}
https://service.example.test/api?access_token=URLENCODED%2Esecret&x=1
Cookie: session=private-cookie-value
"C:\fixture\private\secret.txt"
\\server\share\private-file.txt
person@example.com api.internal ${secrets.base64}`;
  const output = redact(input);

  for (const value of Object.values(secrets)) assert.equal(output.includes(value), false, value);
  assert.equal(output.includes("URLENCODED%2Esecret"), false);
  assert.equal(output.includes("private-cookie-value"), false);
  assert.equal(output.includes("C:\\fixture"), false);
  assert.equal(output.includes("api.internal"), false);
  assert.match(output, /<REDACTED/);
  assert.match(output, /<PATH>|<UNC_PATH>/);
  assert.match(output, /<EMAIL>/);
});

test("external argument shapes never include command or text payloads", () => {
  const args = {
    command: "curl https://example.test/?token=inline-secret",
    path: "C:\\fixture\\project\\file.txt",
    prompt: "private requirement with person@example.com",
    nested: { content: "do not export" },
  };
  const external = safeArguments(args, "external");
  const internal = safeArguments(args, "internal");
  const externalText = JSON.stringify(external);

  assert.equal(externalText.includes("inline-secret"), false);
  assert.equal(externalText.includes("Jane Doe"), false);
  assert.equal(externalText.includes("private requirement"), false);
  assert.equal("preview" in external.fields.command, false);
  assert.equal("preview" in internal.fields.command, true);
  assert.equal(external.fields.path.category, "windows_absolute");
  assert.equal(external.fields.command.kind, "command");
  assert.equal(external.fields.command.hasCredentialLikeSyntax, true);
});

test("external event sanitization drops IDs, timestamps and text while retaining diagnostics", () => {
  const assistant = sanitizeEvent({
    type: "message",
    id: "message-secret-id",
    parentId: "parent-secret-id",
    timestamp: "2026-08-15T00:00:00.000Z",
    message: {
      role: "assistant",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      content: [
        { type: "text", text: "private assistant conclusion" },
        { type: "toolCall", name: "bash", arguments: { command: "echo private-command" } },
      ],
    },
  }, 900, "external", 7);
  const toolError = sanitizeEvent({
    type: "message",
    id: "error-secret-id",
    timestamp: "2026-08-15T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "MISSING_CREDENTIAL: private-key-value" }],
    },
  }, 900, "external", 8);
  const output = JSON.stringify({ assistant, toolError });

  for (const value of ["message-secret-id", "parent-secret-id", "2026-08-15T00:00:00.000Z", "private assistant conclusion", "private-command", "private-key-value"]) {
    assert.equal(output.includes(value), false, value);
  }
  assert.equal(assistant.id, undefined);
  assert.equal(assistant.message.content[0].chars, 28);
  assert.equal(assistant.message.content[1].arguments.fields.command.kind, "command");
  assert.deepEqual(toolError.message.content.error, { category: "credential", signature: "missing_credential" });
});

test("capEvents reserves head, tail and bounded important quota", () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    type: index === 250 ? "message" : "message",
    message: index === 250
      ? { role: "toolResult", content: { isError: true } }
      : { role: "assistant", content: [] },
    sequence: index,
  }));
  const capped = capEvents(events, 100);
  const sequences = capped.events.map((event) => event.sequence);

  assert.equal(capped.events.length, 100);
  assert.equal(capped.omitted, 400);
  assert.equal(sequences[0], 0);
  assert.equal(sequences.at(-1), 499);
  assert.equal(sequences.includes(250), true);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(sequences.some((value) => value > 100 && value < 200), true);
});

test("repro mode records review requirement but no source filename or note", async () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "one.jsonl"), `${JSON.stringify({ type: "session", id: "secret-id" })}\n`);

  const index = await exportSessions({
    source,
    output,
    mode: "repro",
    reproNote: "private bug reproduction note",
    maxText: 900,
    maxEvents: 100,
    sessions: ["one.jsonl=fixture-one"],
  });
  const trace = JSON.parse(fs.readFileSync(path.join(output, "fixture-one.json"), "utf8"));
  const text = fs.readFileSync(path.join(output, "index.json"), "utf8") + JSON.stringify(trace);

  assert.equal(index.mode, "repro");
  assert.equal(trace.source.reviewRequired, true);
  assert.equal(trace.source.noteChars, 29);
  assert.equal("file" in trace.source, false);
  assert.equal("sha256Prefix" in trace.source, false);
  assert.equal(text.includes("private bug reproduction note"), false);
});

test("path and command shapes expose only bounded diagnostics", () => {
  assert.deepEqual(pathShape("\\\\server\\share\\file.txt").category, "unc_path");
  assert.deepEqual(pathShape("relative/project/file.lua").extension, ".lua");
  assert.equal(commandShape("pwsh -NoProfile -Command \"Write-Output secret\"").executable, "pwsh");
  assert.equal(commandShape("totally-private-command --token=secret").executable, "other");
});
