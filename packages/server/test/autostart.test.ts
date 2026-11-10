import { describe, it, expect } from "vitest";
import { plistFor, exeFromPlist, LABEL } from "../src/services/platform/autostart/macos.js";
import { unitFor, desktopFor, exeFromUnit, exeFromDesktop } from "../src/services/platform/autostart/linux.js";
import { runValueFor, exeFromRunValue, parseRegQuery } from "../src/services/platform/autostart/windows.js";
import { passthroughEnv } from "../src/services/platform/autostart/index.js";

const spec = { exe: "/Users/서 준/Downloads/block pilot/blockpilot", env: { BLOCKPILOT_AUTOSTARTED: "1", BLOCKPILOT_NO_BROWSER: "1", BLOCKPILOT_PORT: "4801" }, home: "/Users/서 준/.blockpilot" };

describe("macOS LaunchAgent plist", () => {
  const body = plistFor({ ...spec, exe: '/Users/me/a "b" & <c>/blockpilot' });
  it("runs the executable with --autostart at login, restarts only after a crash, passes env, logs to the app folder", () => {
    expect(body).toContain(`<string>${LABEL}</string>`);
    expect(body).toContain("<string>/Users/me/a &quot;b&quot; &amp; &lt;c&gt;/blockpilot</string>\n      <string>--autostart</string>");
    expect(body).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(body).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(body).toContain("<key>BLOCKPILOT_PORT</key>\n      <string>4801</string>");
    expect(body).toContain("<string>/Users/서 준/.blockpilot/logs/autostart.log</string>");
  });
  it("reads the executable back, un-escaped", () => {
    expect(exeFromPlist(body)).toBe('/Users/me/a "b" & <c>/blockpilot');
    expect(exeFromPlist("<plist></plist>")).toBeUndefined();
  });
});

describe("Linux systemd unit and XDG desktop entry", () => {
  it("quotes paths with spaces for systemd and round-trips the executable", () => {
    const unit = unitFor(spec);
    expect(unit).toContain('ExecStart="/Users/서 준/Downloads/block pilot/blockpilot" --autostart');
    expect(unit).toContain("Environment=BLOCKPILOT_PORT=4801");
    expect(unitFor({ ...spec, env: { X: "a b" } })).toContain('Environment="X=a b"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
    expect(exeFromUnit(unit)).toBe(spec.exe);
    expect(exeFromUnit(unitFor({ ...spec, exe: "/opt/blockpilot" }))).toBe("/opt/blockpilot");
  });
  it("writes a Terminal=false desktop entry that sets env through `env` and round-trips", () => {
    const desk = desktopFor(spec);
    expect(desk).toContain('Exec=env "BLOCKPILOT_AUTOSTARTED=1" "BLOCKPILOT_NO_BROWSER=1" "BLOCKPILOT_PORT=4801" "/Users/서 준/Downloads/block pilot/blockpilot" --autostart');
    expect(desk).toContain("Terminal=false");
    expect(exeFromDesktop(desk)).toBe(spec.exe);
    // 역슬래시·따옴표·$ 는 두 단계 이스케이프를 거쳐도 되돌아와야 한다
    const odd = { ...spec, exe: '/opt/we"ird\\$dir/blockpilot' };
    expect(desktopFor(odd)).toContain('"/opt/we\\\\"ird\\\\\\\\\\\\$dir/blockpilot" --autostart');
    expect(exeFromDesktop(desktopFor(odd))).toBe(odd.exe);
  });
});

describe("Windows Run key value", () => {
  const exe = "C:\\Users\\서 준\\Downloads\\block pilot\\blockpilot.exe";
  it("sets env in cmd, then starts the exe minimized with --autostart", () => {
    const v = runValueFor({ ...spec, exe });
    expect(v).toBe('cmd.exe /d /c "set "BLOCKPILOT_AUTOSTARTED=1" && set "BLOCKPILOT_NO_BROWSER=1" && set "BLOCKPILOT_PORT=4801" && start "" /min "C:\\Users\\서 준\\Downloads\\block pilot\\blockpilot.exe" --autostart"');
    expect(exeFromRunValue(v)).toBe(exe);
  });
  it("parses reg query output", () => {
    const out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    BlockPilot    REG_SZ    cmd.exe /d /c \"start \"\" /min \"C:\\bp\\blockpilot.exe\" --autostart\"\r\n\r\n";
    const value = parseRegQuery(out);
    expect(value).toBe('cmd.exe /d /c "start "" /min "C:\\bp\\blockpilot.exe" --autostart"');
    expect(exeFromRunValue(value!)).toBe("C:\\bp\\blockpilot.exe");
    expect(parseRegQuery("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
  });
});

describe("passthroughEnv", () => {
  it("marks the instance as autostarted, never opens a browser, and copies only BlockPilot settings that are set", () => {
    expect(passthroughEnv({ PATH: "/opt/homebrew/bin:/bin", BLOCKPILOT_PORT: "4801", BLOCKPILOT_TOKEN: "t", BLOCKPILOT_HOST: "", HOME: "/x" })).toEqual({
      BLOCKPILOT_AUTOSTARTED: "1",
      BLOCKPILOT_NO_BROWSER: "1",
      LOG_LEVEL: "warn",
      BLOCKPILOT_PORT: "4801",
      BLOCKPILOT_TOKEN: "t",
      PATH: "/opt/homebrew/bin:/bin",
    });
    expect(passthroughEnv({ LOG_LEVEL: "debug", JAVA_HOME: "/jdk" })).toMatchObject({ LOG_LEVEL: "debug", JAVA_HOME: "/jdk" });
  });
});
