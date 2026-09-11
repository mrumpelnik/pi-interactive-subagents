import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  closeAgentWindow,
  closeSurface,
  createSurface,
  focusAgentWindow,
  getAgentWindowId,
  pollForExit,
  sendCommand,
  surfaceExists,
} from "../pi-extension/subagents/tmux.ts";

const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const parentPane = process.env.TMUX_PANE!;
const parentWindow = tmux("display-message", "-p", "-t", parentPane, "#{window_id}");

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
  assert.equal(owner, parentPane);
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
