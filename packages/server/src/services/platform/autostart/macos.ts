import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AutostartBackend, AutostartSpec } from "./types.js";
import { AUTOSTART_FLAG } from "./types.js";
import { AutostartError, run } from "./exec.js";

/**
 * macOS: 사용자 LaunchAgent (~/Library/LaunchAgents/com.blockpilot.app.plist).
 * - RunAtLoad: 로그인하면 켜진다. bootstrap 하는 순간에도 한 번 켜지는데, 이미 BlockPilot 이 떠 있으면 그 인스턴스는 바로 종료(0)한다
 * - KeepAlive SuccessfulExit=false: 비정상 종료(크래시)일 때만 다시 띄운다. 정상 종료는 그대로 둔다
 */

export const LABEL = "com.blockpilot.app";

export const plistPath = (home = os.homedir()) => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function plistFor(spec: AutostartSpec): string {
  const envEntries = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  // plist 안 경로는 항상 POSIX (테스트가 Windows 러너에서도 돈다)
  const log = path.posix.join(spec.home.split(path.sep).join("/"), "logs", "autostart.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <!-- BlockPilot 이 만든 로그인 항목. 대시보드 첫 화면의 자동 실행 토글로 끄면 지워져요. -->",
    "    <key>Label</key>",
    `    <string>${LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    `      <string>${xml(spec.exe)}</string>`,
    `      <string>${AUTOSTART_FLAG}</string>`,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <dict>",
    "      <key>SuccessfulExit</key>",
    "      <false/>",
    "    </dict>",
    // 로그아웃·종료 때 launchd 가 SIGKILL 하기 전에 마크 서버가 월드를 저장하고 끝낼 시간 (stop 30s + 종료 요청 10s + 여유)
    "    <key>ExitTimeOut</key>",
    "    <integer>90</integer>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    envEntries,
    "    </dict>",
    "    <key>WorkingDirectory</key>",
    `    <string>${xml(spec.home)}</string>`,
    "    <key>StandardOutPath</key>",
    `    <string>${xml(log)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xml(log)}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** plist 의 ProgramArguments 첫 항목 */
export function exeFromPlist(body: string): string | undefined {
  const m = body.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/);
  if (!m) return undefined;
  return m[1].replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export const macosAutostart: AutostartBackend = {
  method: "launchd",
  methodLabel: "macOS 로그인 항목 (launchd)",
  hint: "로그인하면 터미널 창 없이 조용히 켜져요. 켜진 BlockPilot 을 끄려면 터미널에서 `pkill -TERM -x blockpilot` (켜 둔 서버는 저장 후 꺼져요).",
  async status() {
    const body = await fsp.readFile(plistPath(), "utf8").catch(() => null);
    if (body === null) return { enabled: false };
    return { enabled: true, registeredExe: exeFromPlist(body) };
  },
  async enable(spec, { selfAutostarted }) {
    const file = plistPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.mkdir(path.join(spec.home, "logs"), { recursive: true });
    // 토큰이 들어갈 수 있어 나만 읽기
    await fsp.rm(file, { force: true });
    await fsp.writeFile(file, plistFor(spec), { mode: 0o600 });
    // 지금 프로세스가 바로 그 launchd 작업이면 이미 로드돼 있다. bootout 은 자기 자신(과 켜 둔 마크 서버)을 죽이므로 파일만 새로 쓴다
    if (selfAutostarted) return;
    let r = await run("launchctl", ["bootstrap", domain(), file]);
    // launchctl 은 오류 번호를 종료 코드로 돌려준다: 5 = 이미 로드됨(I/O error), 37 = 이미 진행 중, 125 = 비활성화된 항목
    if (r.code === 5 || r.code === 37 || r.code === 125) {
      await run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
      await run("launchctl", ["enable", `${domain()}/${LABEL}`]);
      r = await run("launchctl", ["bootstrap", domain(), file]);
    }
    if (r.code !== 0) {
      await fsp.rm(file, { force: true });
      throw new AutostartError("macOS 로그인 항목을 등록하지 못했어요.", `launchctl bootstrap (code ${r.code})\n${(r.stderr || r.stdout).trim()}`);
    }
  },
  async disable({ selfAutostarted }) {
    await fsp.rm(plistPath(), { force: true });
    // 지금 프로세스가 launchd 가 띄운 것이면 bootout 이 자기 자신(과 켜 둔 마크 서버)을 죽이므로 파일만 지운다
    if (!selfAutostarted) await run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  },
};
