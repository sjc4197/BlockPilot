import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";

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

export const utf8 = (b: Buffer) => b.toString("utf8");

/** start.sh 의 `exec "/절대/경로/bin/java" …` */
export function posixPinnedJava(body: string) {
  return body.match(/^\s*exec\s+"(\/[^"]+\/bin\/java)"/m)?.[1];
}

export function posixStartScript(javaPath: string, minMb: number, maxMb: number) {
  const q = javaPath.replace(/(["\\$`])/g, "\\$1");
  return {
    name: "start.sh",
    mode: 0o755,
    body: [
      "#!/bin/sh",
      "# BlockPilot 이 만든 시작 스크립트",
      "# 메모리를 바꾸려면 -Xms(시작 메모리)와 -Xmx(최대 메모리) 값을 고치세요.",
      'cd "$(dirname "$0")"',
      `exec "${q}" -Xms${minMb}M -Xmx${maxMb}M -jar fabric-server-launch.jar nogui`,
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
