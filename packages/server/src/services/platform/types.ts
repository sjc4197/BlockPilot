import type { ChildProcess, SpawnOptions } from "node:child_process";

/**
 * OS 마다 다른 부분을 모아 둔 인터페이스.
 * 나머지 코드는 process.platform 을 직접 보지 않고 이것만 쓴다.
 */

export type OsId = "macos" | "linux" | "windows";

export interface LaunchCommand {
  cmd: string;
  args: string[];
}

export interface PlatformWords {
  /** "이 Mac" / "이 PC" / "이 컴퓨터" */
  thisComputer: string;
  /** "Finder" / "파일 탐색기" / "파일 관리자" */
  fileManager: string;
  /** 단축키 표시: "⌘" / "Ctrl" */
  modKey: string;
}

export interface Shortcut {
  label: string;
  path: string;
  kind: "home" | "folder" | "drive";
}

export interface StartScript {
  name: string;
  body: string;
  /** POSIX 실행 권한 */
  mode?: number;
}

export interface Platform {
  id: OsId;

  // ---------- 서버 실행 ----------
  /** 이 OS 에서 실행할 수 있는 시작 스크립트 (우선순위 순) */
  startScripts: string[];
  /** 다른 OS 용 시작 스크립트. 이것만 있으면 "다른 OS 에서 만든 스크립트"라고 알리고 jar 를 직접 실행 */
  foreignScripts: string[];
  scriptCommand(script: string): LaunchCommand;
  /** 서버를 별도 프로세스 그룹으로 (터미널 Ctrl+C 가 서버로 바로 가지 않게) */
  spawnOptions(): SpawnOptions;
  /** 자식 프로세스에 더할 환경 변수 */
  childEnv(): Record<string, string>;
  /** 자식 프로세스까지 종료. force=false 면 정상 종료 요청, true 면 강제 */
  killTree(child: ChildProcess, force: boolean): void;
  /** 서버 출력 한 줄(바이트)을 문자열로 */
  decode(line: Buffer): string;

  // ---------- Java ----------
  javaExe: string;
  /** 시스템에서 major 버전 JDK 를 찾아볼 JAVA_HOME 후보들 (PATH 의 java 는 공통으로 따로 본다) */
  javaHomeCandidates(major: number): Promise<string[]>;
  /** Adoptium API 의 os 값, 압축 형식, 풀린 폴더 안에서 java 실행 파일 상대 경로 후보 */
  jdk(): { os: string; archive: "tar.gz" | "zip"; javaRel: string[] };

  // ---------- 새 서버의 시작 스크립트 ----------
  startScriptFor(javaPath: string, minMb: number, maxMb: number): StartScript;
  /** 시작 스크립트에 고정된 java 절대 경로 (BlockPilot 이 만든 스크립트) */
  pinnedJava(scriptBody: string): string | undefined;

  // ---------- 경로 ----------
  /** 경로 비교용 정규화 (Windows 는 대소문자 무시) */
  pathKey(p: string): string;
  /** 서버 폴더로 쓰거나 지우면 안 되는 위치 */
  isForbidden(p: string): boolean;
  /** 폴더가 '비었다'고 볼 때 무시하는 OS 메타 파일 */
  ignorable: Set<string>;
  /** 폴더 찾기에서 숨길 이름 */
  isHiddenEntry(name: string): boolean;
  folderShortcuts(): Promise<Shortcut[]>;
  /** 안내 문구에 쓰는 전체 경로 예시 */
  pathExample: string;

  words: PlatformWords;
}
