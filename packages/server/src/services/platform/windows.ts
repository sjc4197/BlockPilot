import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Platform, Shortcut } from "./types.js";
import { subdirs } from "./posix.js";

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const cp949 = new TextDecoder("euc-kr");

/** 한국어 Windows 콘솔 출력은 CP949 일 수 있다. UTF-8 로 읽어 보고 깨지면 CP949 로 */
export function decodeWindows(b: Buffer): string {
  try {
    return utf8Strict.decode(b);
  } catch {
    return cp949.decode(b);
  }
}

/** 폴더 이름으로 쓸 수 없는 Windows 예약 이름 */
export const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const key = (p: string) => path.win32.resolve(p).replace(/\\+$/, "").toLowerCase();

function forbiddenList(): string[] {
  const env = process.env;
  const sys = env.SystemRoot ?? "C:\\Windows";
  const drive = sys.slice(0, 2);
  // 환경 변수가 비어 있어도 기본 위치는 막는다
  return [
    sys,
    env.ProgramFiles ?? `${drive}\\Program Files`,
    env["ProgramFiles(x86)"] ?? `${drive}\\Program Files (x86)`,
    env.ProgramW6432,
    env.ProgramData ?? `${drive}\\ProgramData`,
    `${drive}\\Users`,
    `${drive}\\Users\\Public`,
    `${drive}\\Recovery`,
    `${drive}\\PerfLogs`,
  ]
    .filter((x): x is string => !!x)
    .map(key);
}

/** OneDrive 로 옮겨진 바탕 화면·문서까지 고려해 실제 있는 위치 */
function firstExisting(...candidates: (string | undefined)[]) {
  return candidates.find((c): c is string => !!c && existsSync(c));
}

export const windows: Platform = {
  id: "windows",

  startScripts: ["start.bat", "run.bat", "start.cmd"],
  foreignScripts: ["start.sh", "run.sh"],
  // 스크립트 이름이 cmd 내장 명령(START 등)으로 읽히지 않도록 .\ 를 붙인 경로를 따옴표로 감싸 넘긴다.
  // /s 가 바깥 따옴표 한 쌍을 벗기므로 Node 의 shell 실행과 같은 모양.
  scriptCommand: (script) => ({ cmd: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"".\\${script}""`], verbatim: true }),
  // detached 는 쓰지 않는다: Windows 에서 detached 는 콘솔 없이(DETACHED_PROCESS) 띄워서, cmd 가 실행한 java 가
  // 새 콘솔을 따로 받아 출력이 BlockPilot 으로 오지 않는다 (CI 에서 출력 0줄로 10분 시간 초과).
  // windowsHide 만 쓰면 창 없는 자기 콘솔(CREATE_NO_WINDOW)을 받아 java 도 그 콘솔과 파이프를 물려받고,
  // BlockPilot 창의 Ctrl+C 도 서버로 바로 가지 않는다.
  spawnOptions: () => ({ windowsHide: true }),
  childEnv: () => {
    // Java 출력을 UTF-8 로 (JDK 19+: stdout.encoding, 그 이전: sun.stdout.encoding)
    const utf8Out = "-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8";
    const prev = process.env.JAVA_TOOL_OPTIONS;
    // BLOCKPILOT=1 이면 BlockPilot 이 만든 start.bat 이 끝에서 pause 하지 않는다
    return { BLOCKPILOT: "1", JAVA_TOOL_OPTIONS: prev ? `${prev} ${utf8Out}` : utf8Out };
  },
  killTree(child: ChildProcess) {
    if (child.pid === undefined) return;
    // Windows 콘솔 프로그램에는 "부드럽게 끝내라"는 신호가 없다. 서버의 정상 종료는 이미 stdin 의 stop 으로 시도했으므로
    // 여기서는 바로 강제 종료(/F)한다. cmd.exe 만 죽이면 java 가 남으니 /T 로 자식까지
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  },
  decode: decodeWindows,

  javaExe: "java.exe",
  async javaHomeCandidates() {
    const env = process.env;
    const home = os.homedir();
    const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]
      .filter((x): x is string => !!x)
      .flatMap((pf) => ["Eclipse Adoptium", "Java", "Microsoft", "Zulu", "BellSoft", "Amazon Corretto", "Semeru"].map((v) => path.join(pf, v)));
    if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"));
    roots.push(path.join(home, ".jdks"));
    const found: string[] = env.JAVA_HOME ? [env.JAVA_HOME] : [];
    for (const r of roots) for (const d of await subdirs(r)) found.push(path.join(r, d));
    return [...new Set(found)];
  },
  jdk: () => ({ os: "windows", archive: "zip", javaRel: ["bin/java.exe"] }),

  startScriptFor(javaPath, minMb, maxMb) {
    return {
      name: "start.bat",
      // cmd 는 CRLF 를 기대한다. chcp 65001 로 이후 줄을 UTF-8 로 읽게 해서 한글 사용자 폴더 경로가 깨지지 않게
      body: [
        "@echo off",
        "chcp 65001 >nul",
        "rem Created by BlockPilot. Change -Xms (start) and -Xmx (max) to adjust memory.",
        'cd /d "%~dp0"',
        `"${javaPath}" -Xms${minMb}M -Xmx${maxMb}M -jar fabric-server-launch.jar nogui`,
        "rem When started by double-click, keep the window open if the server stopped with an error.",
        "if not defined BLOCKPILOT if errorlevel 1 pause",
        "",
      ].join("\r\n"),
    };
  },
  pinnedJava: (body) => body.match(/^\s*"([A-Za-z]:\\[^"]+\\bin\\java\.exe)"/im)?.[1],

  pathKey: key,
  isForbidden(p) {
    // "D:" 처럼 드라이브 문자만 쓴 것도 드라이브 루트로 본다 (resolve 하면 그 드라이브의 현재 폴더가 돼 버림)
    if (/^[a-z]:[\\/]?$/i.test(p.trim())) return true;
    const k = key(p);
    if (/^[a-z]:$/.test(k)) return true; // 드라이브 루트
    if (path.win32.basename(k).match(RESERVED_NAMES)) return true;
    return forbiddenList().includes(k);
  },
  ignorable: new Set(["desktop.ini", "Thumbs.db", "ehthumbs.db"]),
  isHiddenEntry: (name) =>
    name.startsWith(".") || name.startsWith("$") || ["System Volume Information", "Recovery", "PerfLogs", "Config.Msi", "AppData", "Application Data", "Local Settings", "NTUSER.DAT"].includes(name),
  async folderShortcuts() {
    const home = os.homedir();
    const one = process.env.OneDrive;
    const list: Shortcut[] = [{ label: "홈", path: home, kind: "home" }];
    const desktop = firstExisting(one && path.join(one, "Desktop"), one && path.join(one, "바탕 화면"), path.join(home, "Desktop"));
    if (desktop) list.push({ label: desktop.startsWith(one ?? "\0") ? "바탕 화면 (OneDrive)" : "바탕 화면", path: desktop, kind: "folder" });
    const docs = firstExisting(one && path.join(one, "Documents"), one && path.join(one, "문서"), path.join(home, "Documents"));
    if (docs) list.push({ label: "문서", path: docs, kind: "folder" });
    const mc = path.join(home, "Minecraft", "servers");
    if (existsSync(mc)) list.push({ label: "Minecraft 서버", path: mc, kind: "folder" });
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      if (existsSync(root)) list.push({ label: `${letter}: 드라이브`, path: root, kind: "drive" });
    }
    return list;
  },
  pathExample: "C:\\Minecraft\\servers\\survival",

  words: { thisComputer: "이 PC", fileManager: "파일 탐색기", modKey: "Ctrl" },
};
