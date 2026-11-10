import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AutostartBackend, AutostartSpec } from "./types.js";
import { AUTOSTART_FLAG } from "./types.js";
import { AutostartError, run } from "./exec.js";

/**
 * Linux: systemd 사용자 유닛 (~/.config/systemd/user/blockpilot.service). systemd 가 없으면(Alpine·WSL 등) XDG 자동 시작 항목.
 * 로그인(사용자 세션)할 때 켜진다. 화면 없는 서버에서 부팅만으로 켜려면 `loginctl enable-linger` 가 필요하다.
 */

export const UNIT = "blockpilot.service";
export const unitPath = (home = os.homedir()) => path.join(home, ".config", "systemd", "user", UNIT);
export const desktopPath = (home = os.homedir()) => path.join(home, ".config", "autostart", "blockpilot.desktop");

/** systemd 의 따옴표 규칙: 공백·특수문자는 큰따옴표로, 안의 역슬래시·따옴표는 이스케이프 */
const sdq = (s: string) => (/^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

export function unitFor(spec: AutostartSpec): string {
  const env = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `Environment=${sdq(`${k}=${v}`)}`);
  return [
    "# BlockPilot 이 만든 로그인 항목. 대시보드 첫 화면의 자동 실행 토글로 끄면 지워져요.",
    "[Unit]",
    "Description=BlockPilot (Minecraft server dashboard)",
    "",
    "[Service]",
    `ExecStart=${sdq(spec.exe)} ${AUTOSTART_FLAG}`,
    `WorkingDirectory=${sdq(spec.home)}`,
    ...env,
    "Restart=on-failure",
    "RestartSec=5",
    // 정상 종료(stop 명령으로 월드 저장 후)에 시간을 준다
    "TimeoutStopSec=90",
    "KillMode=mixed",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * .desktop 의 Exec 는 두 단계로 이스케이프한다: 먼저 따옴표 안 규칙(\ " $ 앞에 \), 그 다음 문자열 규칙(\ 를 \\ 로).
 * 그래서 역슬래시 하나는 \\\\, 따옴표는 \\", $ 는 \\$ 가 된다
 */
const dq = (s: string) => `"${s.replace(/\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/\$/g, "\\\\$")}"`;


export function desktopFor(spec: AutostartSpec): string {
  const envArgs = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => dq(`${k}=${v}`))
    .join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=BlockPilot",
    "Comment=Minecraft server dashboard (BlockPilot 이 만든 로그인 항목)",
    `Exec=env ${envArgs} ${dq(spec.exe)} ${AUTOSTART_FLAG}`,
    `Path=${spec.home}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function exeFromUnit(body: string): string | undefined {
  const m = body.match(/^ExecStart=(?:"((?:[^"\\]|\\.)*)"|(\S+))/m);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
}

/** Exec 줄을 토큰으로 나눠(두 단계 이스케이프 되돌리며) --autostart 바로 앞 토큰(실행 파일)을 돌려준다 */
export function exeFromDesktop(body: string): string | undefined {
  const line = body.match(/^Exec=(.*)$/m)?.[1];
  if (!line) return undefined;
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      i++;
      continue;
    }
    if (line[i] === '"') {
      i++;
      let t = "";
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && line[i + 1] === "\\") {
          // 문자열 단계의 "\\" 는 따옴표 단계의 역슬래시 하나: 뒤에 오는 \ " $ 를 그대로 넣는다 (\ 는 다시 문자열 단계로 두 글자)
          if (line[i + 2] === "\\" && line[i + 3] === "\\") {
            t += "\\";
            i += 4;
          } else {
            t += line[i + 2] ?? "";
            i += 3;
          }
        } else if (line[i] === "\\") {
          t += line[i + 1] ?? "";
          i += 2;
        } else {
          t += line[i];
          i++;
        }
      }
      i++;
      tokens.push(t);
    } else {
      let j = line.indexOf(" ", i);
      if (j < 0) j = line.length;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  const k = tokens.indexOf(AUTOSTART_FLAG);
  return k > 0 ? tokens[k - 1] : undefined;
}

async function hasSystemdUser(): Promise<boolean> {
  const r = await run("systemctl", ["--user", "show-environment"], 8000);
  return r.code === 0;
}

export const linuxAutostart: AutostartBackend = {
  method: "systemd",
  methodLabel: "systemd 사용자 서비스",
  hint: "로그인(사용자 세션)할 때 켜져요. 화면 없는 서버에서 부팅만으로 켜려면 `loginctl enable-linger $USER` 를 한 번 실행하세요.",
  async status() {
    const unit = await fsp.readFile(unitPath(), "utf8").catch(() => null);
    if (unit !== null) return { enabled: true, registeredExe: exeFromUnit(unit), method: "systemd" as const };
    const desk = await fsp.readFile(desktopPath(), "utf8").catch(() => null);
    if (desk !== null) return { enabled: true, registeredExe: exeFromDesktop(desk), method: "xdg" as const };
    return { enabled: false };
  },
  async enable(spec) {
    await fsp.mkdir(spec.home, { recursive: true });
    if (await hasSystemdUser()) {
      const file = unitPath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, unitFor(spec), { mode: 0o600 });
      await run("systemctl", ["--user", "daemon-reload"]);
      const r = await run("systemctl", ["--user", "enable", UNIT]);
      if (r.code !== 0) {
        await fsp.rm(file, { force: true });
        throw new AutostartError("systemd 사용자 서비스를 등록하지 못했어요.", `systemctl --user enable (code ${r.code})\n${(r.stderr || r.stdout).trim()}`);
      }
      return;
    }
    // systemd 가 없으면 데스크톱 환경의 자동 시작 항목으로. 데스크톱도 없는(SSH 전용) 환경이면 실행해 줄 주체가 없다
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.XDG_CURRENT_DESKTOP) {
      throw new AutostartError("이 환경에서는 로그인 자동 실행을 등록할 수 없어요.", "systemd 사용자 세션도, 데스크톱 환경도 없어요. 화면 없는 서버라면 systemd 가 있는 배포판에서 `loginctl enable-linger $USER` 를 켠 뒤 다시 시도하거나, 직접 서비스로 등록해 주세요.");
    }
    const file = desktopPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, desktopFor(spec), { mode: 0o600 });
  },
  async disable() {
    // 실행 중인 서비스는 멈추지 않는다 (disable 만). 다음 로그인부터 안 켜진다
    if (await fsp.stat(unitPath()).then(() => true, () => false)) {
      await run("systemctl", ["--user", "disable", UNIT]);
      await fsp.rm(unitPath(), { force: true });
      await run("systemctl", ["--user", "daemon-reload"]);
    }
    await fsp.rm(desktopPath(), { force: true });
  },
};
