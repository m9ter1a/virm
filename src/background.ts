// Running without a terminal: a log file instead of the screen, a pid file so
// `virm stop` knows what to stop, and a way to ask whether virm is up.
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";

const MAX_LOG_BYTES = 5_000_000;

/** Copy everything virm prints into a file, keeping one older file when it grows past 5 MB. */
export function logToFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {}
  const out = createWriteStream(path, { flags: "a" });
  out.on("error", () => {});
  const day = () => new Date().toISOString().slice(0, 10);
  for (const k of ["log", "warn", "error"] as const) {
    const original = console[k].bind(console);
    console[k] = (...args: unknown[]) => {
      out.write(`${day()} ${format(...args)}\n`);
      try {
        original(...args);
      } catch {
        // No console in the background: the file is enough.
      }
    };
  }
}

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export const pidPath = (dataDir: string) => join(dataDir, "virm.pid");

export function writePid(dataDir: string, port: number): void {
  writeFileSync(pidPath(dataDir), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  // Only our own file: a second copy that failed to start must not delete the first one's.
  process.once("exit", () => {
    try {
      if ((readPid(dataDir)?.pid ?? 0) === process.pid) rmSync(pidPath(dataDir), { force: true });
    } catch {}
  });
}

export function readPid(dataDir: string): PidInfo | null {
  try {
    return JSON.parse(readFileSync(pidPath(dataDir), "utf8")) as PidInfo;
  } catch {
    return null;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether a virm inbox answers on this port. */
export async function isRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return check();
}

export type StopResult = "stopped" | "not-running" | "in-terminal";

/** Stop the background virm. One started in a terminal is left to its Ctrl+C. */
export async function stopBackground(dataDir: string, port: number): Promise<StopResult> {
  const info = readPid(dataDir);
  if (!info || !alive(info.pid)) {
    rmSync(pidPath(dataDir), { force: true });
    return (await isRunning(port)) ? "in-terminal" : "not-running";
  }
  process.kill(info.pid);
  await waitUntil(async () => !alive(info.pid), 5000);
  rmSync(pidPath(dataDir), { force: true });
  return "stopped";
}
