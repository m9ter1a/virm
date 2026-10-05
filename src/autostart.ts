// virm autostart: start virm when the user logs in, without a window.
//   Windows  a Run entry in the user's registry starts wscript, which starts
//            node with its window hidden (no admin rights needed);
//   macOS    a LaunchAgent;
//   Linux    a systemd user service, or an XDG autostart entry without systemd.
// The file contents are pure functions below; the commands that install them
// are at the bottom.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LaunchSpec {
  /** The node executable running virm now. */
  node: string;
  /** virm's own entry point. */
  bin: string;
  dataDir: string;
  logFile: string;
  /** Carried over when set, so the background copy uses the same data. */
  virmHome?: string;
}

export function launchSpec(dataDir: string): LaunchSpec {
  return {
    node: process.execPath,
    bin: fileURLToPath(new URL("./bin.js", import.meta.url)),
    dataDir,
    logFile: join(dataDir, "virm.log"),
    virmHome: process.env.VIRM_HOME || undefined,
  };
}

export const startArgs = (s: LaunchSpec) => [s.bin, "start", "--no-open", "--log-file", s.logFile];

/** npx runs packages from a cache that gets cleaned: autostart pointed there would break later. */
export const isTransient = (bin: string) => /[\\/]_npx[\\/]/.test(bin);

// ---------------------------------------------------------------- file contents

export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_RUN_NAME = "virm";
export const MAC_LABEL = "io.github.m9ter1a.virm";

const winQuote = (s: string) => `"${s}"`;

/** JScript for wscript: WshShell.Run with window style 0 starts node hidden. */
export function windowsLauncher(s: LaunchSpec): string {
  const command = [s.node, ...startArgs(s)].map((a) => (a.startsWith("--") || /^[a-z]+$/.test(a) ? a : winQuote(a))).join(" ");
  return [
    "// Started by Windows at login, from the Run entry \"virm\". Starts virm without a window.",
    "// Remove with: virm autostart off",
    'var shell = new ActiveXObject("WScript.Shell");',
    ...(s.virmHome ? [`shell.Environment("PROCESS")("VIRM_HOME") = ${JSON.stringify(s.virmHome)};`] : []),
    `shell.Run(${JSON.stringify(command)}, 0, false);`,
    "",
  ].join("\r\n");
}

export const windowsRunValue = (wscript: string, launcher: string) => `${winQuote(wscript)} //B //Nologo ${winQuote(launcher)}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function macPlist(s: LaunchSpec): string {
  const args = [s.node, ...startArgs(s)].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = s.virmHome
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>VIRM_HOME</key>\n    <string>${xml(s.virmHome)}</string>\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

/** systemd splits ExecStart on spaces: quote each argument, and double % and backslashes. */
const unitArg = (a: string) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(s: LaunchSpec): string {
  return [
    "[Unit]",
    "Description=virm: watch Reddit, sort with a decision model",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[s.node, ...startArgs(s)].map(unitArg).join(" ")}`,
    ...(s.virmHome ? [`Environment=${unitArg(`VIRM_HOME=${s.virmHome}`)}`] : []),
    "Restart=on-failure",
    "RestartSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const desktopArg = (a: string) => `"${a.replace(/(["`$\\])/g, "\\$1")}"`;

export function xdgDesktop(s: LaunchSpec): string {
  const exec = [s.node, ...startArgs(s)].map(desktopArg).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=virm",
    "Comment=Watch Reddit, sort with a decision model",
    `Exec=${s.virmHome ? `env ${desktopArg(`VIRM_HOME=${s.virmHome}`)} ` : ""}${exec}`,
    "X-GNOME-Autostart-enabled=true",
    "NoDisplay=true",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- installing

export interface AutostartState {
  on: boolean;
  /** Where it is set up, in words. */
  where: string;
  /** launchd (RunAtLoad) and systemd (enable --now) start it on the spot; the others do not. */
  startedNow?: boolean;
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString();
const tryRun = (cmd: string, args: string[]) => {
  try {
    run(cmd, args);
    return true;
  } catch {
    return false;
  }
};

const wscriptPath = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
const windowsLauncherPath = (dataDir: string) => join(dataDir, "autostart.js");
const macPlistPath = () => join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", "virm.service");
const desktopPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "virm.desktop");
const hasSystemd = () => tryRun("systemctl", ["--user", "show-environment"]);

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Set virm to start at login. Does not start it: the caller decides. */
export function enableAutostart(s: LaunchSpec): AutostartState {
  if (process.platform === "win32") {
    const launcher = windowsLauncherPath(s.dataDir);
    write(launcher, windowsLauncher(s));
    run("reg", ["add", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_NAME, "/t", "REG_SZ", "/d", windowsRunValue(wscriptPath(), launcher), "/f"]);
    return { on: true, where: `Windows startup (registry Run entry "${WINDOWS_RUN_NAME}")` };
  }
  if (process.platform === "darwin") {
    const plist = macPlistPath();
    write(plist, macPlist(s));
    const uid = String(process.getuid?.() ?? "");
    tryRun("launchctl", ["bootout", `gui/${uid}/${MAC_LABEL}`]);
    // RunAtLoad starts it now as well.
    if (!tryRun("launchctl", ["bootstrap", `gui/${uid}`, plist])) run("launchctl", ["load", "-w", plist]);
    return { on: true, where: `a LaunchAgent (${plist})`, startedNow: true };
  }
  if (hasSystemd()) {
    write(unitPath(), systemdUnit(s));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "virm.service"]);
    return { on: true, where: `a systemd user service (${unitPath()})`, startedNow: true };
  }
  write(desktopPath(), xdgDesktop(s));
  return { on: true, where: `desktop autostart (${desktopPath()})` };
}

export function disableAutostart(dataDir: string): AutostartState {
  if (process.platform === "win32") {
    tryRun("reg", ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_NAME, "/f"]);
    rmSync(windowsLauncherPath(dataDir), { force: true });
    return { on: false, where: "Windows startup" };
  }
  if (process.platform === "darwin") {
    tryRun("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${MAC_LABEL}`]) || tryRun("launchctl", ["unload", "-w", macPlistPath()]);
    rmSync(macPlistPath(), { force: true });
    return { on: false, where: "LaunchAgents" };
  }
  if (existsSync(unitPath())) {
    tryRun("systemctl", ["--user", "disable", "--now", "virm.service"]);
    rmSync(unitPath(), { force: true });
    tryRun("systemctl", ["--user", "daemon-reload"]);
  }
  rmSync(desktopPath(), { force: true });
  return { on: false, where: "autostart" };
}

export function autostartState(dataDir: string): AutostartState {
  if (process.platform === "win32") {
    const on = tryRun("reg", ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_NAME]) && existsSync(windowsLauncherPath(dataDir));
    return { on, where: "Windows startup" };
  }
  if (process.platform === "darwin") return { on: existsSync(macPlistPath()), where: "a LaunchAgent" };
  if (existsSync(unitPath())) return { on: true, where: "a systemd user service" };
  return { on: existsSync(desktopPath()), where: "desktop autostart" };
}

/** Start virm in the background now, the way login will: hidden, logging to a file. */
export function startInBackground(s: LaunchSpec): void {
  const env = s.virmHome ? { ...process.env, VIRM_HOME: s.virmHome } : process.env;
  if (process.platform === "win32") {
    // Through the same launcher as at login, so this also proves the launcher works.
    spawn(wscriptPath(), ["//B", "//Nologo", windowsLauncherPath(s.dataDir)], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
    return;
  }
  spawn(s.node, startArgs(s), { detached: true, stdio: "ignore", env }).unref();
}
