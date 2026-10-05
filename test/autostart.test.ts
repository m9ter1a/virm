// Autostart: what gets written for each system, and the pid and log files
// virm uses when it runs without a terminal. Nothing here registers anything.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTransient, macPlist, startArgs, systemdUnit, windowsLauncher, windowsRunValue, xdgDesktop, type LaunchSpec } from "../src/autostart.js";
import { isRunning, logToFile, readPid, stopBackground, writePid } from "../src/background.js";

const win: LaunchSpec = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  bin: "C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\node_modules\\@m9ter1a\\virm\\dist\\bin.js",
  dataDir: "C:\\Users\\Ann Lee\\AppData\\Local\\virm\\Data",
  logFile: "C:\\Users\\Ann Lee\\AppData\\Local\\virm\\Data\\virm.log",
};
const unix: LaunchSpec = {
  node: "/usr/local/bin/node",
  bin: "/usr/local/lib/node_modules/@m9ter1a/virm/dist/bin.js",
  dataDir: "/home/ann/My Data/100% virm",
  logFile: "/home/ann/My Data/100% virm/virm.log",
};

describe("what autostart writes", () => {
  it("starts the same command everywhere: start, no browser, log to a file", () => {
    expect(startArgs(unix)).toEqual([unix.bin, "start", "--no-open", "--log-file", unix.logFile]);
  });

  it("Windows: a hidden WshShell.Run with every path quoted, so spaces survive", () => {
    const js = windowsLauncher(win);
    expect(js).toContain(
      'shell.Run("\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" \\"C:\\\\Users\\\\Ann Lee\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@m9ter1a\\\\virm\\\\dist\\\\bin.js\\" start --no-open --log-file \\"C:\\\\Users\\\\Ann Lee\\\\AppData\\\\Local\\\\virm\\\\Data\\\\virm.log\\"", 0, false);',
    );
    expect(js).not.toContain("VIRM_HOME");
    expect(windowsLauncher({ ...win, virmHome: "D:\\virm" })).toContain('shell.Environment("PROCESS")("VIRM_HOME") = "D:\\\\virm";');
    expect(windowsRunValue("C:\\Windows\\System32\\wscript.exe", "C:\\Data\\autostart.js")).toBe(
      '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Data\\autostart.js"',
    );
  });

  it("macOS: a LaunchAgent that starts at login and restarts after a crash", () => {
    const plist = macPlist({ ...unix, virmHome: "/Users/ann/<virm> & co" });
    expect(plist).toContain("<string>io.github.m9ter1a.virm</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<string>/Users/ann/&lt;virm&gt; &amp; co</string>");
  });

  it("Linux: a systemd unit with every argument quoted and % doubled", () => {
    const unit = systemdUnit(unix);
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/usr/local/lib/node_modules/@m9ter1a/virm/dist/bin.js" "start" "--no-open" "--log-file" "/home/ann/My Data/100%% virm/virm.log"',
    );
    expect(unit).toContain("WantedBy=default.target");
    expect(xdgDesktop(unix)).toContain('Exec="/usr/local/bin/node"');
  });

  it("refuses a copy run through npx, which npx deletes later", () => {
    expect(isTransient("C:\\Users\\ann\\AppData\\Local\\npm-cache\\_npx\\a1b2\\node_modules\\@m9ter1a\\virm\\dist\\bin.js")).toBe(true);
    expect(isTransient("/home/ann/.npm/_npx/a1b2/node_modules/@m9ter1a/virm/dist/bin.js")).toBe(true);
    expect(isTransient(win.bin)).toBe(false);
  });
});

describe("running without a terminal", () => {
  it("keeps a pid file for virm stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "virm-"));
    writePid(dir, 4599);
    expect(readPid(dir)).toMatchObject({ pid: process.pid, port: 4599 });
  });

  it("says nothing runs when nothing answers, and cleans a stale pid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "virm-"));
    expect(await isRunning(1)).toBe(false);
    writeFileSync(join(dir, "virm.pid"), JSON.stringify({ pid: 2 ** 22 + 7, port: 1, startedAt: "" }));
    expect(await stopBackground(dir, 1)).toBe("not-running");
    expect(readPid(dir)).toBeNull();
  });

  it("copies what virm prints into the log file, with the date", async () => {
    const dir = mkdtempSync(join(tmpdir(), "virm-"));
    const file = join(dir, "virm.log");
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      logToFile(file);
      console.log("12:00:00  search %s: %d items", "lockfile", 100);
      await new Promise((r) => setTimeout(r, 50));
      expect(readFileSync(file, "utf8")).toMatch(/^\d{4}-\d\d-\d\d 12:00:00 {2}search lockfile: 100 items\n$/);
    } finally {
      Object.assign(console, original);
    }
  });
});
