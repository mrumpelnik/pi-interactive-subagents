import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUBAGENT_TMUX_LAYOUT = "tiled";
const WINDOW_NAME = "pi-agents";
const WINDOW_OWNER_OPTION = "@pi_subagents_owner";
const PANE_OWNER_OPTION = "@pi_subagent_owned";
const commandAvailability = new Map<string, boolean>();
let cachedWindowId: string | null = null;
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

function hasCommand(command: string): boolean {
  const cached = commandAvailability.get(command);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {}
  commandAvailability.set(command, available);
  return available;
}

export function muxSocketPath(): string | null {
  const raw = process.env.TMUX?.split(",", 1)[0]?.trim();
  return raw && raw.startsWith("/") ? raw : null;
}

export function isTmuxAvailable(): boolean {
  return !!muxSocketPath() && !!process.env.TMUX_PANE && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" }).trim();
}

function parentPane(): string {
  requireTmux();
  return process.env.TMUX_PANE!;
}

function ownerToken(): string {
  return parentPane();
}

export function surfaceExists(pane: string): boolean {
  try {
    return tmux(["display-message", "-p", "-t", pane, "#{pane_id}"]) === pane;
  } catch {
    return false;
  }
}

function windowExists(window: string): boolean {
  try {
    return tmux(["display-message", "-p", "-t", window, "#{window_id}"]) === window;
  } catch {
    return false;
  }
}

function findOwnedWindow(): string | null {
  requireTmux();
  const sessionId = tmux(["display-message", "-p", "-t", parentPane(), "#{session_id}"]);
  const rows = tmux([
    "list-windows",
    "-t",
    sessionId,
    "-F",
    `#{window_id}\t#{${WINDOW_OWNER_OPTION}}`,
  ]);
  for (const row of rows.split("\n")) {
    const [windowId, owner] = row.split("\t");
    if (windowId?.startsWith("@") && owner === ownerToken()) return windowId;
  }
  return null;
}

function resolveOwnedWindow(): string | null {
  if (cachedWindowId && windowExists(cachedWindowId)) {
    const owner = tmux(["show-options", "-wqv", "-t", cachedWindowId, WINDOW_OWNER_OPTION]);
    if (owner === ownerToken()) return cachedWindowId;
  }
  cachedWindowId = findOwnedWindow();
  return cachedWindowId;
}

function markPane(pane: string): void {
  tmux(["set-option", "-pq", "-t", pane, PANE_OWNER_OPTION, ownerToken()]);
}

function createAgentWindow(cwd: string): { window: string; pane: string } {
  const parentWindow = tmux(["display-message", "-p", "-t", parentPane(), "#{window_id}"]);
  const output = tmux([
    "new-window", "-d", "-a", "-t", parentWindow, "-n", WINDOW_NAME, "-c", cwd,
    "-P", "-F", "#{window_id}\t#{pane_id}",
  ]);
  const [window, pane] = output.split("\t");
  if (!window?.startsWith("@") || !pane?.startsWith("%")) {
    throw new Error(`Unexpected tmux new-window output: ${output}`);
  }
  tmux(["set-option", "-wq", "-t", window, WINDOW_OWNER_OPTION, ownerToken()]);
  // Keep a stable title for this owned window only. The user's global tmux
  // automatic-rename and allow-rename settings remain unchanged.
  tmux(["set-option", "-wq", "-t", window, "automatic-rename", "off"]);
  tmux(["set-option", "-wq", "-t", window, "allow-rename", "off"]);
  tmux(["rename-window", "-t", window, WINDOW_NAME]);
  markPane(pane);
  cachedWindowId = window;
  return { window, pane };
}

function rebalanceSurfaces(windowHint?: string): void {
  const window = windowHint ?? resolveOwnedWindow();
  if (!window) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      tmux(["select-layout", "-t", window, SUBAGENT_TMUX_LAYOUT]);
    } catch {}
  }, 120);
}

export function createSurface(name: string, cwd = process.cwd()): string {
  void name;
  requireTmux();
  const window = resolveOwnedWindow();
  if (!window) return createAgentWindow(cwd).pane;

  const pane = tmux([
    "split-window", "-d", "-t", window, "-h", "-c", cwd,
    "-P", "-F", "#{pane_id}",
  ]);
  if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
  markPane(pane);
  rebalanceSurfaces(window);
  return pane;
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void direction;
  void fromSurface;
  return createSurface(name);
}

export function sendCommand(surface: string, command: string): void {
  requireTmux();
  tmux(["send-keys", "-t", surface, "-l", command]);
  tmux(["send-keys", "-t", surface, "Enter"]);
}

export function sendInterrupt(surface: string): void {
  requireTmux();
  tmux(["send-keys", "-t", surface, "Escape"]);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath = options?.scriptPath ?? join(
    tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
  );
  mkdirSync(dirname(scriptPath), { recursive: true });
  const parts = ["#!/bin/bash"];
  if (options?.scriptPreamble) parts.push(options.scriptPreamble.trimEnd());
  parts.push(command);
  writeFileSync(scriptPath, `${parts.join("\n")}\n`, { mode: 0o755 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return tmux(["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`]);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux", ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

export function closeSurface(surface: string): void {
  requireTmux();
  if (!surfaceExists(surface)) return;
  const window = tmux(["display-message", "-p", "-t", surface, "#{window_id}"]);
  const owner = tmux(["show-options", "-pqv", "-t", surface, PANE_OWNER_OPTION]);
  if (owner !== ownerToken()) return;
  const paneCount = Number(tmux(["display-message", "-p", "-t", window, "#{window_panes}"]));
  if (paneCount <= 1) {
    const windowOwner = tmux(["show-options", "-wqv", "-t", window, WINDOW_OWNER_OPTION]);
    if (windowOwner !== ownerToken()) return;
    if (rebalanceTimer) {
      clearTimeout(rebalanceTimer);
      rebalanceTimer = null;
    }
    tmux(["kill-window", "-t", window]);
    if (cachedWindowId === window) cachedWindowId = null;
  } else {
    tmux(["kill-pane", "-t", surface]);
    rebalanceSurfaces(window);
  }
}

export function focusAgentWindow(surface?: string): boolean {
  requireTmux();
  const target = surface && surfaceExists(surface) ? surface : resolveOwnedWindow();
  if (!target) return false;
  tmux(["select-window", "-t", target]);
  if (surface && surfaceExists(surface)) tmux(["select-pane", "-t", surface]);
  return true;
}

export function closeAgentWindow(): boolean {
  requireTmux();
  const window = resolveOwnedWindow();
  if (!window) return false;
  if (rebalanceTimer) {
    clearTimeout(rebalanceTimer);
    rebalanceTimer = null;
  }
  tmux(["kill-window", "-t", window]);
  cachedWindowId = null;
  return true;
}

export function getAgentWindowId(): string | null {
  return resolveOwnedWindow();
}

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage = typeof data.errorMessage === "string" && data.errorMessage.trim()
      ? data.errorMessage
      : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    sentinelToken?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }
    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }
    if (!surfaceExists(surface)) {
      return { reason: "error", exitCode: 1, errorMessage: "The subagent pane was closed." };
    }
    try {
      const screen = await readScreenAsync(surface, 5);
      const token = options.sentinelToken?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = token
        ? new RegExp(`__SUBAGENT_DONE_${token}_(\\d+)__`)
        : /__SUBAGENT_DONE_(\d+)__/;
      const match = screen.match(pattern);
      if (match) return { reason: "sentinel", exitCode: Number.parseInt(match[1], 10) };
    } catch {}
    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
