import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  closeAgentWindow,
  closeSurface,
  createSurface,
  focusAgentWindow,
  getAgentWindowId,
  pollForExit,
  sendCommand,
  surfaceExists,
  ROOT_OWNER_ENV,
} from "../pi-extension/subagents/tmux.ts";

const execFileAsync = promisify(execFile);
const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const parentPane = process.env.TMUX_PANE!;
const parentWindow = tmux("display-message", "-p", "-t", parentPane, "#{window_id}");
// Keep repeated or overlapping test runs from reusing a window left by an
// earlier run that used the parent pane as its owner.
const testOwner = `tmux-window-test-${process.pid}-${Date.now()}`;
process.env[ROOT_OWNER_ENV] = testOwner;

after(() => {
  try { closeAgentWindow(); } catch {}
});

test("creates, closes, and reopens a detached owned window without stealing focus", async () => {
  const first = createSurface("first", process.cwd());
  assert.ok(first.startsWith("%"));
  assert.equal(tmux("display-message", "-p", "#{window_id}"), parentWindow);

  const agentWindow = getAgentWindowId();
  assert.ok(agentWindow?.startsWith("@"));
  assert.notEqual(agentWindow, parentWindow);

  const owner = tmux("show-options", "-wqv", "-t", agentWindow!, "@pi_subagents_owner");
  assert.equal(owner, testOwner);
  assert.equal(tmux("display-message", "-p", "-t", agentWindow!, "#{window_name}"), "pi-agents");
  assert.equal(tmux("show-options", "-wqv", "-t", agentWindow!, "automatic-rename"), "off");
  assert.equal(tmux("show-options", "-wqv", "-t", agentWindow!, "allow-rename"), "off");

  const second = createSurface("second", process.cwd());
  assert.notEqual(second, first);
  assert.equal(tmux("display-message", "-p", "-t", second, "#{window_id}"), agentWindow);
  assert.equal(tmux("display-message", "-p", "#{window_id}"), parentWindow);

  sendCommand(first, "printf WINDOW_TEST_OK");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(tmux("capture-pane", "-p", "-t", first), /WINDOW_TEST_OK/);

  closeSurface(second);
  assert.equal(surfaceExists(second), false);
  closeSurface(first);
  assert.equal(surfaceExists(first), false, "the final pane closes with the owned agent window");
  assert.equal(getAgentWindowId(), null);

  const reopened = createSurface("reopened", process.cwd());
  assert.notEqual(reopened, first);
  assert.notEqual(getAgentWindowId(), agentWindow);
  assert.equal(focusAgentWindow(reopened), true);
  assert.equal(tmux("display-message", "-p", "#{pane_id}"), reopened);
});

test("uses the propagated root owner for nested surfaces", async () => {
  const rootOwner = `root-owner-${process.pid}`;
  const modulePath = new URL("../pi-extension/subagents/tmux.ts", import.meta.url).pathname;
  const createScript = [
    `import { createSurface } from ${JSON.stringify(modulePath)};`,
    "process.stdout.write(createSurface('nested', process.cwd()));",
  ].join(" ");
  const childEnv = { ...process.env, [ROOT_OWNER_ENV]: rootOwner };
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", createScript],
    { env: childEnv },
  );
  const surface = stdout.trim();
  const window = tmux("display-message", "-p", "-t", surface, "#{window_id}");
  assert.ok(window.startsWith("@"));
  assert.equal(tmux("show-options", "-wqv", "-t", window, "@pi_subagents_owner"), rootOwner);

  const closeScript = [
    `import { closeSurface } from ${JSON.stringify(modulePath)};`,
    `closeSurface(${JSON.stringify(surface)});`,
  ].join(" ");
  await execFileAsync(process.execPath, ["--input-type=module", "-e", closeScript], { env: childEnv });
  assert.equal(surfaceExists(surface), false);
});

test("serializes concurrent claims of the root window", async () => {
  const rootOwner = `race-owner-${process.pid}`;
  const modulePath = new URL("../pi-extension/subagents/tmux.ts", import.meta.url).pathname;
  const script = [
    `import { createSurface } from ${JSON.stringify(modulePath)};`,
    "process.stdout.write(createSurface('race', process.cwd()));",
  ].join(" ");
  const childEnv = { ...process.env, [ROOT_OWNER_ENV]: rootOwner };
  const children = Array.from({ length: 8 }, () =>
    execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env: childEnv }),
  );
  let surfaces: string[] = [];

  try {
    const results = await Promise.all(children);
    surfaces = results.map(({ stdout }) => stdout.trim()).filter(Boolean);
    assert.equal(surfaces.length, 8);
    const session = tmux("display-message", "-p", "-t", parentPane, "#{session_id}");
    const rows = tmux("list-windows", "-t", session, "-F", "#{window_id}\t#{@pi_subagents_owner}")
      .split("\n")
      .filter((row) => row.split("\t")[1] === rootOwner);
    assert.equal(rows.length, 1, "all concurrent creators must claim one owned window");
  } finally {
    const cleanupScript = [
      `import { closeSurface, closeAgentWindow } from ${JSON.stringify(modulePath)};`,
      `for (const surface of ${JSON.stringify(surfaces)}) closeSurface(surface);`,
      "closeAgentWindow();",
    ].join(" ");
    try {
      await execFileAsync(process.execPath, ["--input-type=module", "-e", cleanupScript], { env: childEnv });
    } catch {}
  }
  const remaining = tmux("list-windows", "-t", tmux("display-message", "-p", "-t", parentPane, "#{session_id}"), "-F", "#{@pi_subagents_owner}")
    .split("\n")
    .filter((owner) => owner === rootOwner);
  assert.equal(remaining.length, 0);
});

test("ignores stale completion sentinels from earlier runs", async () => {
  const surface = createSurface("sentinel", process.cwd());
  sendCommand(surface, "echo __SUBAGENT_DONE_old_0__");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const started = Date.now();
  const controller = new AbortController();
  const resultPromise = pollForExit(surface, controller.signal, {
    interval: 25,
    sentinelToken: "fresh",
  });
  setTimeout(() => sendCommand(surface, "echo __SUBAGENT_DONE_fresh_7__"), 150);

  const result = await resultPromise;
  assert.ok(Date.now() - started >= 125, "the stale sentinel must not complete the new run");
  assert.equal(result.exitCode, 7);
  closeSurface(surface);
});
