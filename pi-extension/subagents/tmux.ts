import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUBAGENT_TMUX_LAYOUT = "tiled";
const WINDOW_NAME = "pi-agents";
const WINDOW_OWNER_OPTION = "@pi_subagents_owner";
const PANE_OWNER_OPTION = "@pi_subagent_owned";
/** Propagated through child shells so every descendant shares its root window. */
export const ROOT_OWNER_ENV = "PI_SUBAGENT_ROOT_OWNER";
const WINDOW_LOCK_TIMEOUT_MS = 10_000;
const WINDOW_LOCK_RETRY_MS = 10;
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

/**
 * Return the root owner for this subagent tree. The first process derives it
 * from its own pane; descendants receive the value in ROOT_OWNER_ENV and must
 * not substitute their own (nested) pane id.
 */
function ownerToken(): string {
  return process.env[ROOT_OWNER_ENV]?.trim() || parentPane();
}

/** The owner token to put in a child launch environment. */
export function muxOwnerToken(): string {
  requireTmux();
  return ownerToken();
}

function sleepSync(milliseconds: number): void {
  // createSurface is intentionally synchronous. Atomics.wait gives us a
  // bounded sleep without spawning a shell while another process owns the
  // lock.
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(blocker, 0, 0, milliseconds);
}

function windowLockPath(): string {
  const key = createHash("sha256")
    .update(`${muxSocketPath() ?? ""}\0${ownerToken()}`)
    .digest("hex");
  return join(tmpdir(), "pi-subagents-tmux-locks", `${key}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but cannot be signalled by us.
    return error?.code === "EPERM";
  }
}

/**
 * Reap a lock left by a process that died in the critical section. Rename is
 * used instead of remove so an arriving process never removes a lock that was
 * freshly acquired after our stale check.
 */
function reapStaleWindowLock(lockPath: string): boolean {
  let pid: number;
  try {
    const owner = readFileSync(join(lockPath, "owner"), "utf8").trim();
    pid = Number.parseInt(owner.split("-", 1)[0] ?? "", 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0 || processIsAlive(pid)) return false;

  const stalePath = `${lockPath}.stale-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(lockPath, stalePath);
    // A different process may have released the old lock and acquired this
    // path between our read and rename. Never delete that live replacement.
    let movedPid = 0;
    try {
      const movedOwner = readFileSync(join(stalePath, "owner"), "utf8").trim();
      movedPid = Number.parseInt(movedOwner.split("-", 1)[0] ?? "", 10);
    } catch {}
    if (movedPid <= 0 || processIsAlive(movedPid)) {
      try { renameSync(stalePath, lockPath); } catch {}
      return false;
    }
    rmSync(stalePath, { recursive: true, force: true });
    return true;
  } catch {
    // Another waiter may have reaped or released it first.
    return false;
  }
}

/**
 * Serialize owned-window discovery and creation across all Pi processes in a
 * root tree. resolveOwnedWindow() followed by new-window is otherwise a
 * classic check/create race when sibling or nested Pi processes start at once.
 */
function withWindowLock<T>(operation: () => T): T {
  requireTmux();
  const lockPath = windowLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });

  const lockOwner = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const started = Date.now();
  for (;;) {
    let acquired = false;
    try {
      mkdirSync(lockPath);
      acquired = true;
      writeFileSync(join(lockPath, "owner"), `${lockOwner}\n`, { flag: "wx" });
      break;
    } catch (error: any) {
      if (acquired) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
      if (reapStaleWindowLock(lockPath)) continue;
      if (Date.now() - started >= WINDOW_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for the pi-agents tmux window lock");
      }
      sleepSync(WINDOW_LOCK_RETRY_MS);
    }
  }

  try {
    return operation();
  } finally {
    // A stale-lock reaper can move this directory while a PID is being
    // recycled. Only remove the directory if its ownership marker is still
    // ours; never delete a replacement lock acquired by another process.
    try {
      if (readFileSync(join(lockPath, "owner"), "utf8").trim() === lockOwner) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {}
  }
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
  return withWindowLock(() => {
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
  });
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
  withWindowLock(() => {
    // Re-check after acquiring the lock: a concurrent creator or cleaner may
    // have changed the pane topology since the caller first observed it.
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
  });
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
  return withWindowLock(() => {
    const window = resolveOwnedWindow();
    if (!window) return false;
    if (rebalanceTimer) {
      clearTimeout(rebalanceTimer);
      rebalanceTimer = null;
    }
    tmux(["kill-window", "-t", window]);
    cachedWindowId = null;
    return true;
  });
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
    sentinelToken?: string;
    onTick?: (elapsed: number) => void;
    /** Test seams for deterministic sidecar/sentinel polling coverage. */
    surfaceExists?: (surface: string) => boolean;
    readScreenAsync?: (surface: string, lines?: number) => Promise<string>;
  },
): Promise<PollResult> {
  const isSurfacePresent = options.surfaceExists ?? surfaceExists;
  const readScreen = options.readScreenAsync ?? readScreenAsync;
  const start = Date.now();
  // `.exit` is metadata written while the child is still running its graceful
  // shutdown handlers. Keep it in memory, but wait for the shell sentinel (or
  // pane exit) before declaring completion and deleting the sidecar.
  let sidecarResult: PollResult | undefined;
  let sidecarFile: string | undefined;
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");
    if (options.sessionFile) {
      sidecarFile = `${options.sessionFile}.exit`;
      if (!sidecarResult) {
        try {
          if (existsSync(sidecarFile)) {
            sidecarResult = interpretExitSidecar(JSON.parse(readFileSync(sidecarFile, "utf8")));
          }
        } catch {
          // The sidecar may be in the middle of being written; retry it.
        }
      }
    }
    if (!isSurfacePresent(surface)) {
      if (sidecarResult) {
        if (sidecarFile) rmSync(sidecarFile, { force: true });
        return sidecarResult;
      }
      return { reason: "error", exitCode: 1, errorMessage: "The subagent pane was closed." };
    }
    try {
      const screen = await readScreen(surface, 5);
      const token = options.sentinelToken?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = token
        ? new RegExp(`__SUBAGENT_DONE_${token}_(\\d+)__`)
        : /__SUBAGENT_DONE_(\d+)__/;
      const match = screen.match(pattern);
      if (match) {
        if (sidecarFile) rmSync(sidecarFile, { force: true });
        return sidecarResult ?? { reason: "sentinel", exitCode: Number.parseInt(match[1], 10) };
      }
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
