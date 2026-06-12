#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REAPER = path.join(__dirname, "reaper.sh");

function makeFakeApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-repl-reaper-test-"));
  fs.mkdirSync(path.join(appDir, "resources"));
  // The fake node_repl just sleeps; what matters is that /proc/<pid>/cmdline
  // starts with <app-dir>/resources/node_repl, like the real helper.
  const nodeReplBin = path.join(appDir, "resources", "node_repl");
  fs.copyFileSync("/bin/sleep", nodeReplBin);
  fs.chmodSync(nodeReplBin, 0o755);
  return { appDir, nodeReplBin };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runReaperOnce(appDir) {
  const result = spawnSync("bash", [REAPER, appDir, "once"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_NODE_REPL_REAPER_KILL_GRACE: "1" },
  });
  assert.equal(result.status, 0, `reaper failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function waitForExit(pid, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!pidAlive(pid)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`pid ${pid} still alive`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

test("reaps a node_repl whose parent is not a live codex app-server", async () => {
  const { appDir, nodeReplBin } = makeFakeApp();
  const leaked = spawn(nodeReplBin, ["300"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => leaked.once("spawn", resolve));
    const output = runReaperOnce(appDir);
    assert.match(output, new RegExp(`reaping leaked node_repl pid=${leaked.pid}\\b`));
    await waitForExit(leaked.pid);
  } finally {
    try { leaked.kill("SIGKILL"); } catch {}
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("leaves a node_repl with a live codex app-server parent alone", async () => {
  const { appDir, nodeReplBin } = makeFakeApp();
  // Fake app-server: an executable named codex run with an app-server arg,
  // so the parent's /proc cmdline matches "*codex*app-server*". It spawns
  // the helper and stays alive holding it.
  const fakeCodex = path.join(appDir, "codex");
  fs.writeFileSync(fakeCodex, `#!/bin/bash\n"${nodeReplBin}" 300 &\necho "child=$!"\nwait\n`);
  fs.chmodSync(fakeCodex, 0o755);
  const appServer = spawn(fakeCodex, ["app-server"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const childPid = await new Promise((resolve, reject) => {
      let buffer = "";
      appServer.stdout.on("data", (chunk) => {
        buffer += chunk;
        const match = buffer.match(/child=(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      appServer.once("exit", () => reject(new Error("fake app-server exited early")));
    });
    assert.ok(pidAlive(childPid));

    const output = runReaperOnce(appDir);
    assert.doesNotMatch(output, new RegExp(`pid=${childPid}\\b`));
    assert.ok(pidAlive(childPid), "protected node_repl was killed");

    // Once the app-server dies, the same helper becomes leaked and is reaped.
    appServer.kill("SIGKILL");
    await waitForExit(appServer.pid);
    runReaperOnce(appDir);
    await waitForExit(childPid);
  } finally {
    try { appServer.kill("SIGKILL"); } catch {}
    spawnSync("pkill", ["-9", "-f", nodeReplBin]);
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
