import type { AutostartBackend, AutostartSpec } from "./types.js";
import { AUTOSTART_FLAG } from "./types.js";
import { AutostartError, run } from "./exec.js";

/**
 * Windows: 현재 사용자 레지스트리 Run 키 (관리자 권한 불필요).
 * 값은 cmd 한 줄: 환경 변수를 set 한 뒤 최소화된 창으로 blockpilot.exe 를 띄운다.
 */

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const VALUE_NAME = "BlockPilot";

export function runValueFor(spec: AutostartSpec): string {
  const sets = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `set "${k}=${v}" && `)
    .join("");
  // start 의 첫 따옴표 인자는 창 제목이라 빈 제목("")을 넣어야 뒤의 경로가 명령으로 읽힌다
  return `cmd.exe /d /c "${sets}start "" /min "${spec.exe}" ${AUTOSTART_FLAG}"`;
}

/** reg query 출력에서 값 → 실행 파일 경로 */
export function exeFromRunValue(value: string): string | undefined {
  return value.match(/start "" \/min "([^"]+)"/)?.[1] ?? value.match(/^"([^"]+\.exe)"/)?.[1];
}

export function parseRegQuery(output: string): string | undefined {
  // "    BlockPilot    REG_SZ    cmd.exe /d /c ..." (앞 공백·탭, 구분은 공백 여러 개)
  const m = output.match(new RegExp(`^\\s*${VALUE_NAME}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, "m"));
  return m?.[1].trim();
}

export const windowsAutostart: AutostartBackend = {
  method: "registry",
  methodLabel: "Windows 시작 프로그램 (레지스트리 Run)",
  hint: "로그인하면 최소화된 창으로 켜져요. 그 창을 닫으면 켜 둔 서버에 stop 을 보내고 BlockPilot 이 꺼져요 (저장이 끝나기 전에 끊길 수 있어요).",
  async status() {
    const r = await run("reg", ["query", RUN_KEY, "/v", VALUE_NAME]);
    if (r.code !== 0) return { enabled: false };
    const value = parseRegQuery(r.stdout);
    return value ? { enabled: true, registeredExe: exeFromRunValue(value) } : { enabled: false };
  },
  async enable(spec) {
    const r = await run("reg", ["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", runValueFor(spec), "/f"]);
    if (r.code !== 0) throw new AutostartError("Windows 시작 프로그램에 등록하지 못했어요.", `reg add (code ${r.code})\n${(r.stderr || r.stdout).trim()}`);
  },
  async disable() {
    await run("reg", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
  },
};
