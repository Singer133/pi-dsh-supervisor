#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPath = /(?:[A-Za-z]:[\\/](?:Users|AgentData|DST_Mods)|[\\/]home[\\/][^<\s]+|127\.0\.0\.1:\d+)/i;
const forbiddenSecret = /(?:ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [^-]+ PRIVATE KEY-----)/i;
const forbiddenFiles = /(?:\.credentials|\.env(?:\.|$)|\.jsonl$|cookies?|local state|browser-profile|attachments?)/i;
const ignoredDirectories = new Set([".git", "node_modules", "coverage"]);
const failures = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile()) {
      if (forbiddenFiles.test(entry.name)) failures.push(`${path.relative(root, target)}: forbidden file name`);
      const text = fs.readFileSync(target, "utf8");
      if (forbiddenPath.test(text)) failures.push(`${path.relative(root, target)}: host-specific path or loopback address`);
      if (forbiddenSecret.test(text)) failures.push(`${path.relative(root, target)}: secret-shaped value`);
    }
  }
}

walk(root);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("public scan: PASS");
