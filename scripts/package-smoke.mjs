#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const windowsNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npm = process.platform === "win32" && existsSync(windowsNpmCli)
  ? { command: process.execPath, args: [windowsNpmCli] }
  : { command: "npm", args: [] };
const temp = mkdtempSync(join(tmpdir(), "pi-dsh-package-"));

function run(command, args, cwd, { shell = false } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true, shell });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

try {
  const packed = execFileSync(npm.command, [...npm.args, "pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const metadata = JSON.parse(packed)[0];
  if (!metadata?.filename) throw new Error("npm pack did not return an archive filename");
  const extracted = join(temp, "package");
  run("tar", ["-xzf", metadata.filename, "-C", "."], temp);
  const packageRoot = join(temp, "package");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (!packageJson.keywords?.includes("pi-package")) throw new Error("package manifest is missing the pi-package keyword");
  if (!packageJson.pi?.extensions?.includes("./src/pi-dsh.ts")) throw new Error("package manifest is missing the Pi extension entry");
  if (!existsSync(join(packageRoot, "src", "pi-dsh.ts"))) throw new Error("packed Pi extension is missing");
  run(npm.command, [...npm.args, "run", "test:node"], packageRoot);
  run(npm.command, [...npm.args, "run", "test:public"], packageRoot);
  if (process.platform === "win32") run(npm.command, [...npm.args, "run", "test:powershell"], packageRoot);
  console.log(`package smoke: PASS (${metadata.files.length} files; extracted=${extracted})`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
