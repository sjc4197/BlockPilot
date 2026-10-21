import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ServerLoader } from "@blockpilot/shared";
import { badRequest } from "../lib/errors.js";
import { platform } from "./platform/index.js";

export interface DetectedServer {
  loader: ServerLoader;
  loaderVersion?: string;
  mcVersion?: string;
  /** 직접 java 로 띄울 때 쓸 jar (start.sh 없을 때) */
  launchJar?: string;
  hasStartScript: boolean;
  /** 이 OS 에서 실행할 시작 스크립트 (start.sh / run.sh / start.bat …) */
  startScript?: string;
  /** 다른 OS 용 시작 스크립트만 있을 때 그 이름 */
  foreignScript?: string;
  eulaAccepted: boolean;
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 폴더가 마인크래프트 서버처럼 보이는지 확인. 아니면 400. */
export async function validateServerDir(dir: string) {
  const resolved = path.resolve(dir);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw badRequest("폴더가 존재하지 않습니다.");
  }
  if (!stat.isDirectory()) throw badRequest("폴더 경로가 아닙니다.");
  const markers = ["server.properties", "eula.txt", "fabric-server-launch.jar", "server.jar", "start.sh", "run.sh", "start.bat", "run.bat", "mods", "world"];
  const found = await Promise.all(markers.map((m) => exists(path.join(resolved, m))));
  if (!found.some(Boolean)) {
    throw badRequest("마인크래프트 서버 폴더로 보이지 않습니다 (server.properties, eula.txt, 서버 jar 등이 없음).");
  }
  return resolved;
}

export async function detectServer(dir: string): Promise<DetectedServer> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const has = (f: string) => files.includes(f);

  let loader: ServerLoader = "unknown";
  let loaderVersion: string | undefined;
  let mcVersion: string | undefined;
  let launchJar: string | undefined;

  if (has("fabric-server-launch.jar") || has(".fabric")) {
    loader = "fabric";
    launchJar = has("fabric-server-launch.jar") ? "fabric-server-launch.jar" : files.find((f) => /^fabric-server.*\.jar$/.test(f));
    // versions/<mc>/server-<mc>.jar
    const versions = await fs.readdir(path.join(dir, "versions")).catch(() => [] as string[]);
    if (versions.length) mcVersion = versions.sort().at(-1);
    const loaderDir = await fs.readdir(path.join(dir, "libraries/net/fabricmc/fabric-loader")).catch(() => [] as string[]);
    if (loaderDir.length) loaderVersion = loaderDir.sort().at(-1);
  } else if (await exists(path.join(dir, "libraries/net/neoforged"))) {
    loader = "neoforge";
    const v = await fs.readdir(path.join(dir, "libraries/net/neoforged/neoforge")).catch(() => [] as string[]);
    loaderVersion = v.sort().at(-1);
  } else if (await exists(path.join(dir, "libraries/net/minecraftforge/forge"))) {
    loader = "forge";
    const v = await fs.readdir(path.join(dir, "libraries/net/minecraftforge/forge")).catch(() => [] as string[]);
    loaderVersion = v.sort().at(-1);
    mcVersion = loaderVersion?.split("-")[0];
  } else {
    const paper = files.find((f) => /^paper-.*\.jar$/.test(f));
    const purpur = files.find((f) => /^purpur-.*\.jar$/.test(f));
    const anyJar = paper ?? purpur ?? files.find((f) => /^(server|minecraft_server.*)\.jar$/.test(f)) ?? files.find((f) => f.endsWith(".jar"));
    if (paper || purpur) {
      loader = "paper";
      mcVersion = (paper ?? purpur)!.match(/-(\d+\.\d+(?:\.\d+)?)/)?.[1];
    } else if (anyJar) {
      loader = "vanilla";
      mcVersion = anyJar.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
    }
    launchJar = anyJar;
  }

  // 로그 첫 줄 "Loading Minecraft 1.21.1 with Fabric Loader 0.19.5" 로 보강
  if (!mcVersion || !loaderVersion) {
    const log = await fs.readFile(path.join(dir, "logs/latest.log"), "utf8").catch(() => "");
    const m = log.match(/Loading Minecraft (\S+) with Fabric Loader (\S+)/);
    if (m) {
      mcVersion ??= m[1];
      loaderVersion ??= m[2];
    }
    const vm = log.match(/Starting minecraft server version (\S+)/);
    if (vm) mcVersion ??= vm[1];
  }

  const eula = await fs.readFile(path.join(dir, "eula.txt"), "utf8").catch(() => "");
  const startScript = platform.startScripts.find(has);
  return {
    loader,
    loaderVersion,
    mcVersion,
    launchJar,
    hasStartScript: !!startScript,
    startScript,
    foreignScript: startScript ? undefined : platform.foreignScripts.find(has),
    eulaAccepted: /^\s*eula\s*=\s*true/im.test(eula),
  };
}

let javaVersionCache: string | undefined | null = null;
export function getJavaVersion(): Promise<string | undefined> {
  if (javaVersionCache !== null) return Promise.resolve(javaVersionCache);
  return new Promise((resolve) => {
    execFile("java", ["-version"], (err, _stdout, stderr) => {
      if (err) {
        javaVersionCache = undefined;
        return resolve(undefined);
      }
      const m = String(stderr).match(/version "([^"]+)"/);
      javaVersionCache = m?.[1];
      resolve(javaVersionCache);
    });
  });
}

/**
 * 서버가 실제로 쓰는 Java 버전.
 * start.sh 에 java 절대 경로가 적혀 있으면(새 서버 만들기로 만든 서버) 그 Java 를, 아니면 시스템 java 를 본다.
 */
export async function getServerJavaVersion(dir: string): Promise<string | undefined> {
  const name = platform.startScripts[0];
  const script = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
  const pinned = platform.pinnedJava(script);
  if (pinned) {
    const v = await new Promise<string | undefined>((resolve) => {
      execFile(pinned, ["-version"], { timeout: 10_000 }, (err, _o, stderr) => resolve(err ? undefined : String(stderr).match(/version "([^"]+)"/)?.[1]));
    });
    if (v) return v;
  }
  return getJavaVersion();
}
