import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BLOCKPILOT_HOME } from "../../config/store.js";
import { downloadFile } from "./download.js";
import { CreateError } from "./errors.js";
import { getJdkPackage, type Arch } from "./sources.js";
import { platform } from "../platform/index.js";
import { extractZipTo } from "../../lib/zip.js";

/**
 * Java 찾기와 앱 전용 JDK 캐시.
 * 시스템에는 아무것도 설치하지 않는다. 받은 JDK 는 ~/.blockpilot/runtimes/ 아래에만 둔다.
 */

export const RUNTIMES_DIR = path.join(BLOCKPILOT_HOME, "runtimes");
const MARKER = ".blockpilot-runtime.json";

export interface JavaRuntime {
  /** bin/java 절대 경로 */
  path: string;
  version: string;
  major: number;
  source: "system" | "cached" | "downloaded";
}

interface RuntimeMarker {
  major: number;
  arch: Arch;
  semver: string;
  sha256: string;
  javaPath: string;
  installedAt: string;
}

export function currentArch(): Arch | null {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x64";
  return null;
}

/** `java -version` 출력에서 major 버전. "1.8.0_392" → 8, "21.0.12.1" → 21, "25" → 25 */
export function parseJavaVersion(output: string): { version: string; major: number } | null {
  const m = output.match(/version "([^"]+)"/);
  if (!m) return null;
  const version = m[1];
  const parts = version.split(/[._+-]/).map((p) => Number(p));
  const major = parts[0] === 1 ? parts[1] : parts[0];
  return Number.isFinite(major) ? { version, major } : null;
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 주어진 java 실행 파일의 버전. 실행이 안 되면 null */
export async function javaVersionOf(javaPath: string): Promise<{ version: string; major: number } | null> {
  try {
    const { stderr, stdout } = await run(javaPath, ["-version"]);
    return parseJavaVersion(stderr + stdout);
  } catch {
    return null;
  }
}

/**
 * 시스템에 정확히 그 major 의 JDK 가 있으면 bin/java 절대 경로를 돌려준다.
 * 1) macOS java_home  2) PATH 의 java (실제 java.home 을 읽어 절대 경로로 고정)
 */
export async function findSystemJava(major: number): Promise<JavaRuntime | null> {
  // 1) OS 별 설치 위치 (macOS java_home, Linux /usr/lib/jvm·SDKMAN, Windows JAVA_HOME·Program Files)
  for (const home of await platform.javaHomeCandidates(major)) {
    const p = path.join(home, "bin", platform.javaExe);
    const v = await javaVersionOf(p);
    if (v?.major === major) return { path: p, ...v, source: "system" };
  }
  // 2) PATH 의 java — 실제 java.home 을 읽어 절대 경로로 고정
  try {
    const { stderr } = await run("java", ["-XshowSettings:properties", "-version"]);
    const v = parseJavaVersion(stderr);
    const home = stderr.match(/^\s*java\.home = (.+)$/m)?.[1]?.trim();
    if (v?.major === major && home) return { path: path.join(home, "bin", platform.javaExe), ...v, source: "system" };
  } catch {
    /* PATH 에 java 없음 */
  }
  return null;
}

/** 이전에 받아서 해시 검증까지 끝난 JDK 가 캐시에 있으면 */
export async function findCachedRuntime(major: number, arch: Arch): Promise<JavaRuntime | null> {
  let dirs: string[];
  try {
    dirs = await fsp.readdir(RUNTIMES_DIR);
  } catch {
    return null;
  }
  for (const d of dirs.sort().reverse()) {
    if (d.startsWith(".")) continue;
    try {
      const marker = JSON.parse(await fsp.readFile(path.join(RUNTIMES_DIR, d, MARKER), "utf8")) as RuntimeMarker;
      if (marker.major !== major || marker.arch !== arch) continue;
      const v = await javaVersionOf(marker.javaPath);
      if (v?.major === major) return { path: marker.javaPath, ...v, source: "cached" };
    } catch {
      /* 표식이 없거나 깨진 폴더는 무시 */
    }
  }
  return null;
}

/**
 * Temurin JDK 를 받아 해시를 검증하고 RUNTIMES_DIR 에 푼다.
 * 작업은 .tmp-* 폴더에서 하고, 다 끝난 뒤에만 최종 폴더로 옮기므로 중간에 실패해도 반쯤 풀린 JDK 가 남지 않는다.
 */
export async function installRuntime(
  major: number,
  arch: Arch,
  opts: { onProgress?: (done: number, total?: number) => void; signal?: AbortSignal; onTempDir?: (dir: string) => void } = {},
): Promise<JavaRuntime> {
  const jdk = platform.jdk();
  const pkg = await getJdkPackage(major, arch, jdk.os, opts.signal);
  await fsp.mkdir(RUNTIMES_DIR, { recursive: true });
  const tmp = path.join(RUNTIMES_DIR, `.tmp-${randomUUID().slice(0, 8)}`);
  opts.onTempDir?.(tmp);
  await fsp.mkdir(tmp, { recursive: true });
  try {
    const archive = path.join(tmp, pkg.name);
    await downloadFile({ url: pkg.link, dest: archive, hash: { algo: "sha256", expected: pkg.sha256 }, expectedSize: pkg.size, onProgress: opts.onProgress, signal: opts.signal, idleTimeoutMs: 60_000 });

    const extractDir = path.join(tmp, "x");
    await fsp.mkdir(extractDir);
    try {
      if (jdk.archive === "zip") await extractZipTo(archive, extractDir);
      else await run("tar", ["-xzf", archive, "-C", extractDir], 5 * 60_000);
    } catch (e) {
      throw new CreateError("java_failed", "받은 Java 압축 파일을 풀지 못했어요.", "디스크 공간을 확인한 뒤 다시 시도해 주세요.", String((e as { stderr?: string }).stderr ?? e));
    }
    await fsp.rm(archive, { force: true });

    const [top] = (await fsp.readdir(extractDir)).filter((n) => !n.startsWith("."));
    if (!top) throw new CreateError("java_failed", "받은 Java 압축 파일이 비어 있어요.", "다시 시도해 주세요.");
    let rel: string | undefined;
    for (const cand of jdk.javaRel) if (await exists(path.join(extractDir, top, ...cand.split("/")))) rel = path.join(...cand.split("/"));
    if (!rel) throw new CreateError("java_failed", "받은 Java 안에서 실행 파일을 찾지 못했어요.", "다시 시도해 주세요.", jdk.javaRel.join(", "));

    const finalName = `temurin-${pkg.semver.replace(/[^0-9A-Za-z.+_-]/g, "")}-${arch}`;
    const finalDir = path.join(RUNTIMES_DIR, finalName);
    if (await exists(finalDir)) await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(path.join(extractDir, top), finalDir);

    const javaPath = path.join(finalDir, rel);
    const v = await javaVersionOf(javaPath);
    if (v?.major !== major) {
      await fsp.rm(finalDir, { recursive: true, force: true });
      throw new CreateError("java_failed", `받은 Java 가 실행되지 않아요 (기대 버전 ${major}).`, "다시 시도해 주세요.", javaPath);
    }
    const marker: RuntimeMarker = { major, arch, semver: pkg.semver, sha256: pkg.sha256, javaPath, installedAt: new Date().toISOString() };
    await fsp.writeFile(path.join(finalDir, MARKER), JSON.stringify(marker, null, 2));
    return { path: javaPath, ...v, source: "downloaded" };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
