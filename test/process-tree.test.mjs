import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execProcessTree } from "../src/process-tree.mjs";

test("execProcessTree captures a normal result", async () => {
  const result = await execProcessTree(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.killed, false);
});

test("execProcessTree marks a hanging child as timed out", async () => {
  const result = await execProcessTree(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 100 });
  assert.equal(result.killed, true);
  assert.equal(result.timedOut, true);
});

test("execProcessTree cancels a whole descendant tree", async () => {
  const marker = join(tmpdir(), `pi-dsh-public-tree-${process.pid}-${Date.now()}.txt`);
  try {
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 1200);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`;
    const controller = new AbortController();
    const promise = execProcessTree(process.execPath, ["-e", parent], { signal: controller.signal, timeout: 5000 });
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    assert.equal(result.killed, true);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(marker, { force: true });
  }
});
