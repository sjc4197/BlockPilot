import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import type { LaunchSpec, ProcessInfo } from "./types.js";

/** macOS·Linux 가 함께 쓰는 부분 */

/** 별도 프로세스 그룹으로 띄운다: 터미널 Ctrl+C 가 서버에 바로 가지 않고, 종료할 때 그룹째(스크립트 + java) 보낼 수 있다 */
export const posixSpawnOptions = () => ({ detached: true });

export function posixKillTree(child: ChildProcess, force: boolean) {
  const sig = force ? "SIGKILL" : "SIGTERM";
  if (child.pid === undefined) return;
  try {
    // 음수 pid = 프로세스 그룹 전체 (detached 로 띄웠으므로 그룹 id = 자식 pid)
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* 이미 종료 */
    }
  }
}

/**
 * ps 로 프로세스 시작 시각과 실행 파일 이름을 한 번에 읽는다.
 * lstart 는 "Wed Nov 12 10:11:12 2025" 꼴(토큰 5개), 그 뒤가 comm (macOS 는 전체 경로라 공백이 섞일 수 있어 나머지를 통째로).
 * ps 가 없거나 프로세스를 못 보면 둘 다 null.
 */
export function posixProcessInfo(pid: number): Promise<ProcessInfo> {
  const unknown: ProcessInfo = { startedAt: null, name: null };
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(unknown);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-o", "comm=", "-p", String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } }, (err, out) => {
      if (err) return resolve(unknown);
      const tokens = String(out).trim().split(/\s+/);
      if (tokens.length < 5) return resolve(unknown);
      const d = new Date(tokens.slice(0, 5).join(" "));
      resolve({ startedAt: Number.isNaN(d.getTime()) ? null : d, name: tokens.slice(5).join(" ") || null });
    });
  });
}

export const utf8 = (b: Buffer) => b.toString("utf8");

/** start.sh 의 `exec "/절대/경로/bin/java" …` */
export function posixPinnedJava(body: string) {
  return body.match(/^\s*exec\s+"(\/[^"]+\/bin\/java)"/m)?.[1];
}

/** 시작 스크립트의 java 뒤에 붙는 인자. 설치기 인자 파일은 POSIX 경로 그대로 */
export function posixLaunchArgs(launch: LaunchSpec): string {
  return launch.kind === "jar" ? `-jar ${shellQuote(launch.jar)} nogui` : `@${shellQuote(`${launch.dir}/unix_args.txt`)} nogui`;
}

/** 공백·특수문자가 없으면 그대로, 있으면 큰따옴표로 감싼다 */
function shellQuote(s: string) {
  return /^[A-Za-z0-9_./@+:=-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function posixStartScript(javaPath: string, minMb: number, maxMb: number, launch: LaunchSpec) {
  const q = javaPath.replace(/(["\\$`])/g, "\\$1");
  return {
    name: "start.sh",
    mode: 0o755,
    body: [
      "#!/bin/sh",
      "# BlockPilot 이 만든 시작 스크립트",
      "# 메모리를 바꾸려면 -Xms(시작 메모리)와 -Xmx(최대 메모리) 값을 고치세요.",
      ...(launch.kind === "argsFile" ? ["# 설치기가 만든 run.sh 와 user_jvm_args.txt 는 쓰지 않아요. BlockPilot 은 이 파일로 켜요."] : []),
      'cd "$(dirname "$0")"',
      `exec "${q}" -Xms${minMb}M -Xmx${maxMb}M ${posixLaunchArgs(launch)}`,
      "",
    ].join("\n"),
  };
}

/** bash 가 있으면 bash, 없으면 sh (Alpine 등). 사용자가 만든 start.sh 는 bash 문법일 수 있어 bash 를 먼저 쓴다 */
let shell: string | null = null;
export function posixShell(): string {
  if (shell) return shell;
  shell = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"].find((s) => existsSync(s)) ?? "/bin/sh";
  return shell;
}

/** 폴더 안의 하위 폴더 이름들 (없으면 빈 배열) */
export async function subdirs(dir: string): Promise<string[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const st = await fsp.stat(`${dir}/${n}`).catch(() => null);
    if (st?.isDirectory()) out.push(n);
  }
  return out;
}

export const posixHidden = (name: string) => name.startsWith(".");
