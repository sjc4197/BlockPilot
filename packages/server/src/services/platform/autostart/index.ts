import fsp from "node:fs/promises";
import type { AutostartInfo } from "@blockpilot/shared";
import type { AutostartBackend } from "./types.js";
import { AUTOSTART_FLAG } from "./types.js";
import { macosAutostart } from "./macos.js";
import { linuxAutostart } from "./linux.js";
import { windowsAutostart } from "./windows.js";
import { AutostartError } from "./exec.js";
import { platform } from "../index.js";
import { BLOCKPILOT_HOME } from "../../../config/store.js";
import { isSingleExecutable } from "../../../lib/appInfo.js";
import { samePath } from "../../../lib/paths.js";

export { AUTOSTART_FLAG } from "./types.js";
export { AutostartError } from "./exec.js";

const backends: Record<string, AutostartBackend> = { macos: macosAutostart, linux: linuxAutostart, windows: windowsAutostart };
export const backend: AutostartBackend = backends[platform.id] ?? linuxAutostart;

/** 지금 프로세스가 로그인 항목으로 켜진 것인지 (인자 또는 환경 변수) */
export const isAutostarted = () => process.argv.includes(AUTOSTART_FLAG) || process.env.BLOCKPILOT_AUTOSTARTED === "1";

/** 자동 실행 인스턴스에 그대로 넘길 환경 변수 (지금 켠 것과 같은 포트·주소·토큰·앱 폴더로) */
export function passthroughEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // 요청 로그(info)가 자동 실행 로그 파일을 끝없이 키우므로 사용자가 따로 정하지 않았으면 warn
  const out: Record<string, string> = { BLOCKPILOT_AUTOSTARTED: "1", BLOCKPILOT_NO_BROWSER: "1", LOG_LEVEL: env.LOG_LEVEL || "warn" };
  for (const k of ["BLOCKPILOT_PORT", "BLOCKPILOT_HOST", "BLOCKPILOT_TOKEN", "BLOCKPILOT_HOME"]) {
    if (env[k]) out[k] = env[k]!;
  }
  // launchd·systemd 는 로그인 셸의 PATH 를 주지 않는다 (/usr/bin:/bin …). Homebrew·SDKMAN 의 java 를 지금처럼 찾게 PATH 를 그대로 넘긴다
  if (env.PATH) out.PATH = env.PATH;
  if (env.JAVA_HOME) out.JAVA_HOME = env.JAVA_HOME;
  return out;
}

const METHOD_LABEL: Record<string, string> = { launchd: "macOS 로그인 항목 (launchd)", systemd: "systemd 사용자 서비스", xdg: "데스크톱 자동 시작 항목 (.desktop)", registry: "Windows 시작 프로그램 (레지스트리 Run)" };

export async function autostartInfo(): Promise<AutostartInfo> {
  const single = await isSingleExecutable();
  const exePath = single ? process.execPath : undefined;
  const base: AutostartInfo = {
    supported: single,
    method: backend.method,
    methodLabel: backend.methodLabel,
    enabled: false,
    exePath,
    autostarted: isAutostarted(),
    hint: backend.hint,
  };
  if (!single) base.reason = "릴리스에서 받은 실행 파일(blockpilot)로 켰을 때만 등록할 수 있어요. npm start 로 켠 개발용 실행은 등록할 실행 파일이 없어요.";
  const st = await backend.status().catch(() => ({ enabled: false }) as Awaited<ReturnType<AutostartBackend["status"]>>);
  base.enabled = st.enabled;
  base.registeredExe = st.registeredExe;
  if (st.method) {
    base.method = st.method;
    base.methodLabel = METHOD_LABEL[st.method] ?? base.methodLabel;
  }
  if (st.enabled && st.registeredExe) {
    base.exeMissing = !(await fsp.stat(st.registeredExe).then(() => true, () => false));
    if (exePath && !samePath(st.registeredExe, exePath)) base.stale = true;
  }
  return base;
}

export async function setAutostart(enabled: boolean): Promise<AutostartInfo> {
  if (enabled) {
    if (!(await isSingleExecutable())) throw new AutostartError("릴리스에서 받은 실행 파일로 켰을 때만 자동 실행을 등록할 수 있어요.");
    await backend.enable({ exe: process.execPath, env: passthroughEnv(), home: BLOCKPILOT_HOME }, { selfAutostarted: isAutostarted() });
  } else {
    await backend.disable({ selfAutostarted: isAutostarted() });
  }
  return autostartInfo();
}
