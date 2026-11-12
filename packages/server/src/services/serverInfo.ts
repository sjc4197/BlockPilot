import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ServerLoader, ServerSummary } from "@blockpilot/shared";
import { badRequest } from "../lib/errors.js";
import { platform } from "./platform/index.js";
import { sortVersionsDesc } from "../lib/version.js";

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

  const paper = files.find((f) => /^paper-.*\.jar$/.test(f));
  const purpur = files.find((f) => /^purpur-.*\.jar$/.test(f));
  // 로더 폴더는 "그 로더의 자기 라이브러리" 폴더로 본다. libraries/net/neoforged 만 보면 안 된다:
  // Paper 도 첫 실행 때 리매핑 도구(net.neoforged.art)를 libraries/net/neoforged/ 에 받아 둔다.
  const neoDir = path.join(dir, "libraries/net/neoforged/neoforge");
  const forgeDir = path.join(dir, "libraries/net/minecraftforge/forge");

  if (has("fabric-server-launch.jar") || has(".fabric")) {
    loader = "fabric";
    launchJar = has("fabric-server-launch.jar") ? "fabric-server-launch.jar" : files.find((f) => /^fabric-server.*\.jar$/.test(f));
    // versions/<mc>/server-<mc>.jar
    const versions = await fs.readdir(path.join(dir, "versions")).catch(() => [] as string[]);
    if (versions.length) mcVersion = newest(versions);
    const loaderDir = await fs.readdir(path.join(dir, "libraries/net/fabricmc/fabric-loader")).catch(() => [] as string[]);
    if (loaderDir.length) loaderVersion = newest(loaderDir);
  } else if (paper || purpur) {
    loader = "paper";
    launchJar = paper ?? purpur;
    // paper-1.21.1-133.jar → Minecraft 1.21.1, 빌드 133
    const m = launchJar!.match(/-(\d+\.\d+(?:\.\d+)?)(?:-(\d+))?\.jar$/);
    mcVersion = m?.[1];
    loaderVersion = m?.[2];
  } else if (await exists(neoDir)) {
    loader = "neoforge";
    loaderVersion = newest(await fs.readdir(neoDir).catch(() => [] as string[]));
    mcVersion = loaderVersion ? neoForgeToMc(loaderVersion) : undefined;
  } else if (await exists(forgeDir)) {
    loader = "forge";
    loaderVersion = newest(await fs.readdir(forgeDir).catch(() => [] as string[]));
    mcVersion = loaderVersion?.split("-")[0];
  } else {
    const anyJar = files.find((f) => /^(server|minecraft_server.*)\.jar$/.test(f)) ?? files.find((f) => f.endsWith(".jar"));
    if (anyJar) {
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
  // 시작 스크립트 이름은 대소문자 무시로 찾는다 (Windows 는 Start.bat 도 같은 파일)
  const findName = (n: string) => files.find((f) => f.toLowerCase() === n.toLowerCase());
  const startScript = platform.startScripts.map(findName).find(Boolean);
  return {
    loader,
    loaderVersion,
    mcVersion,
    launchJar,
    hasStartScript: !!startScript,
    startScript,
    foreignScript: startScript ? undefined : platform.foreignScripts.map(findName).find(Boolean),
    eulaAccepted: /^\s*eula\s*=\s*true/im.test(eula),
  };
}

/** 폴더 이름 중 가장 높은 버전 (숫자 비교. "0.16.10" 이 "0.16.9" 뒤에 오게) */
function newest(names: string[]): string | undefined {
  const real = names.filter((n) => !n.startsWith("."));
  return sortVersionsDesc(real, (n) => n)[0];
}

/**
 * NeoForge 버전 → Minecraft 버전.
 * 1.20.2 이후: "21.1.265" → 1.21.1, "21.0.167" → 1.21. 연도 버전: "26.3.0.102" → 26.3, "26.1.2.126" → 26.1.2
 */
export function neoForgeToMc(v: string): string | undefined {
  const core = v.split("-")[0].split(".");
  if (!core.every((p) => /^\d+$/.test(p))) return undefined;
  if (core.length === 3) {
    const [minor, patch] = core;
    if (Number(minor) < 20) return undefined;
    return patch === "0" ? `1.${minor}` : `1.${minor}.${patch}`;
  }
  if (core.length === 4) {
    const [year, minor, patch] = core;
    return patch === "0" ? `${year}.${minor}` : `${year}.${minor}.${patch}`;
  }
  return undefined;
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
  const file = path.join(dir, platform.startScripts[0]);
  const script = await fs.readFile(file, "utf8").catch(() => "");
  const pinned = platform.pinnedJava(script);
  if (pinned) {
    const mtime = await fs.stat(file).then((s) => s.mtimeMs, () => 0);
    const v = await pinnedJavaVersion(pinned, mtime);
    if (v) return v;
  }
  return getJavaVersion();
}

/**
 * 고정된 Java 의 버전. 대시보드가 5초마다 묻는데 매번 java 프로세스를 띄우면 아까우니
 * (java 경로, 스크립트 수정 시각) 별로 한동안 기억해 둔다. 실패(없는 경로)도 기억해 같은 실패를 반복하지 않는다.
 */
const PINNED_JAVA_TTL_MS = 10 * 60_000;
const PINNED_JAVA_CACHE_MAX = 64;
const pinnedJavaCache = new Map<string, { version: string | undefined; at: number }>();

function pinnedJavaVersion(javaPath: string, scriptMtime: number): Promise<string | undefined> {
  const key = `${javaPath}\0${scriptMtime}`;
  const hit = pinnedJavaCache.get(key);
  if (hit && Date.now() - hit.at < PINNED_JAVA_TTL_MS) return Promise.resolve(hit.version);
  return new Promise((resolve) => {
    execFile(javaPath, ["-version"], { timeout: 10_000 }, (err, _o, stderr) => {
      const version = err ? undefined : String(stderr).match(/version "([^"]+)"/)?.[1];
      pinnedJavaCache.delete(key);
      if (pinnedJavaCache.size >= PINNED_JAVA_CACHE_MAX) pinnedJavaCache.delete(pinnedJavaCache.keys().next().value!);
      pinnedJavaCache.set(key, { version, at: Date.now() });
      resolve(version);
    });
  });
}

/** 테스트 전용 */
export function __clearPinnedJavaCacheForTests() {
  pinnedJavaCache.clear();
}

// ---------- 모드팩 표시 (.blockpilot-modpack.json) ----------

/** 새 서버 만들기가 모드팩으로 만들 때 남기는 파일 (services/create/modpack.ts 의 MODPACK_MARKER 와 같음) */
const MODPACK_MARKER_FILE = ".blockpilot-modpack.json";
const MARKER_MAX_BYTES = 1024 * 1024;
const markerCache = new Map<string, { mtimeMs: number; size: number; value: ServerSummary["modpack"] }>();

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const id = (v: unknown): string | undefined => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : undefined);

/** 모드팩으로 만든 서버면 그 팩 이름·버전. 아니거나 파일이 이상하면 undefined (바뀌지 않았으면 캐시) */
export async function readModpackMarker(dir: string): Promise<ServerSummary["modpack"]> {
  const file = path.join(dir, MODPACK_MARKER_FILE);
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile() || st.size > MARKER_MAX_BYTES) {
    markerCache.delete(file);
    return undefined;
  }
  const hit = markerCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value: ServerSummary["modpack"];
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const name = str(raw?.name);
    const versionId = str(raw?.versionId, 100);
    if (name && versionId !== undefined) {
      value = { name, versionId };
      const projectId = id(raw.projectId);
      const modrinthVersionId = id(raw.modrinthVersionId);
      if (projectId) value.projectId = projectId;
      if (modrinthVersionId) value.modrinthVersionId = modrinthVersionId;
    }
  } catch {
    value = undefined;
  }
  markerCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}
