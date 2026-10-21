import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Platform, Shortcut } from "./types.js";
import { posixHidden, posixKillTree, posixPinnedJava, posixShell, posixSpawnOptions, posixStartScript, subdirs, utf8 } from "./posix.js";

const FORBIDDEN = [
  "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/media", "/mnt", "/opt",
  "/proc", "/root", "/run", "/sbin", "/snap", "/srv", "/sys", "/tmp", "/usr", "/var",
];

/** musl(Alpine) 이면 Alpine 용 JDK 를 받아야 한다 */
export function isMusl(): boolean {
  if (existsSync("/etc/alpine-release")) return true;
  const report = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } };
  return !report.header?.glibcVersionRuntime;
}

export const linux: Platform = {
  id: "linux",

  startScripts: ["start.sh", "run.sh"],
  foreignScripts: ["start.bat", "run.bat", "start.cmd"],
  scriptCommand: (script) => ({ cmd: posixShell(), args: [script] }),
  spawnOptions: posixSpawnOptions,
  childEnv: () => ({}),
  killTree: posixKillTree,
  decode: utf8,

  javaExe: "java",
  async javaHomeCandidates(major) {
    const home = os.homedir();
    const roots = ["/usr/lib/jvm", "/usr/java", "/opt/java", "/usr/local/java", path.join(home, ".sdkman", "candidates", "java"), path.join(home, ".jdks")];
    const found: string[] = [];
    for (const r of roots) for (const d of await subdirs(r)) found.push(path.join(r, d));
    // 이름에 major 가 들어간 것(java-21-openjdk, temurin-21 …)을 먼저 확인
    const m = new RegExp(`(^|[^0-9])${major}([^0-9]|$)`);
    return found.sort((a, b) => Number(m.test(path.basename(b))) - Number(m.test(path.basename(a))));
  },
  jdk: () => ({ os: isMusl() ? "alpine-linux" : "linux", archive: "tar.gz", javaRel: ["bin/java"] }),

  startScriptFor: posixStartScript,
  pinnedJava: posixPinnedJava,

  // POSIX 경로 규칙은 어느 OS 에서 평가해도 POSIX 로 (테스트·원격 경로 대비)
  pathKey: (p) => path.posix.resolve(p),
  isForbidden: (p) => FORBIDDEN.includes(path.posix.resolve(p)),
  ignorable: new Set([".directory"]),
  isHiddenEntry: posixHidden,
  async folderShortcuts() {
    const home = os.homedir();
    const list: Shortcut[] = [{ label: "홈", path: home, kind: "home" }];
    for (const p of [path.join(home, "Minecraft", "servers"), path.join(home, "minecraft"), "/srv", "/opt"]) {
      if (existsSync(p)) list.push({ label: p.startsWith(home) ? `~${p.slice(home.length)}` : p, path: p, kind: "folder" });
    }
    for (const base of ["/mnt", path.join("/media", os.userInfo().username), "/run/media/" + os.userInfo().username]) {
      for (const d of await subdirs(base)) list.push({ label: d, path: path.join(base, d), kind: "drive" });
    }
    return list.filter((s, i) => list.findIndex((x) => x.path === s.path) === i).filter((s) => s.kind !== "folder" || existsSync(s.path));
  },
  pathExample: "/home/me/minecraft/survival",

  words: { thisComputer: "이 컴퓨터", fileManager: "파일 관리자", modKey: "Ctrl" },
};

