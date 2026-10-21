import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Platform, Shortcut } from "./types.js";
import { posixHidden, posixKillTree, posixPinnedJava, posixShell, posixSpawnOptions, posixStartScript, utf8 } from "./posix.js";

const FORBIDDEN = ["/", "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/var", "/private", "/Applications", "/Users", "/Volumes", "/opt", "/cores", "/dev"];

export const macos: Platform = {
  id: "macos",

  startScripts: ["start.sh", "run.sh"],
  foreignScripts: ["start.bat", "run.bat", "start.cmd"],
  scriptCommand: (script) => ({ cmd: posixShell(), args: [script] }),
  spawnOptions: posixSpawnOptions,
  childEnv: () => ({}),
  killTree: posixKillTree,
  decode: utf8,

  javaExe: "java",
  javaHomeCandidates: (major) =>
    new Promise((resolve) => {
      execFile("/usr/libexec/java_home", ["-v", String(major)], { timeout: 10_000 }, (err, stdout) => resolve(err ? [] : [String(stdout).trim()].filter(Boolean)));
    }),
  jdk: () => ({ os: "mac", archive: "tar.gz", javaRel: ["Contents/Home/bin/java", "bin/java"] }),

  startScriptFor: posixStartScript,
  pinnedJava: posixPinnedJava,

  // POSIX 경로 규칙은 어느 OS 에서 평가해도 POSIX 로 (테스트·원격 경로 대비)
  pathKey: (p) => path.posix.resolve(p),
  isForbidden: (p) => FORBIDDEN.includes(path.posix.resolve(p)),
  ignorable: new Set([".DS_Store", "._.DS_Store", ".localized"]),
  isHiddenEntry: posixHidden,
  async folderShortcuts() {
    const home = os.homedir();
    const list: Shortcut[] = [
      { label: "홈", path: home, kind: "home" },
      { label: "데스크탑", path: path.join(home, "Desktop"), kind: "folder" },
      { label: "문서", path: path.join(home, "Documents"), kind: "folder" },
      { label: "Minecraft 서버", path: path.join(home, "Minecraft", "servers"), kind: "folder" },
    ];
    for (const v of await fsp.readdir("/Volumes").catch(() => [] as string[])) {
      if (!v.startsWith(".") && v !== "Macintosh HD") list.push({ label: v, path: path.join("/Volumes", v), kind: "drive" });
    }
    return list;
  },
  pathExample: "/Users/me/minecraft/servers/survival",

  words: { thisComputer: "이 Mac", fileManager: "Finder", modKey: "⌘" },
};
