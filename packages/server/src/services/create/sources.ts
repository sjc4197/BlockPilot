import { fetchJson } from "./download.js";
import { CreateError } from "./errors.js";

/**
 * 배포처 공통: 짧은 캐시, maven 경로, Adoptium(Temurin JDK).
 * 로더별 배포처(Mojang·Fabric·Paper·Forge·NeoForge)는 loaders/ 아래에 있다.
 */

// ---------- 짧은 캐시 (목록을 여러 번 열 때 매번 받지 않도록) ----------

const cache = new Map<string, { at: number; value: unknown }>();
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const TEN_MIN = 10 * 60_000;

/** "group:artifact:version[:classifier]" → "group/path/artifact/version/artifact-version[-classifier].jar" */
export function mavenPath(coord: string): string {
  const [group, artifact, version, classifier] = coord.split(":");
  if (!group || !artifact || !version) throw new Error(`잘못된 maven 좌표: ${coord}`);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  return [...group.split("."), artifact, version, file].join("/");
}

// ---------- Adoptium (Temurin JDK) ----------

const ADOPTIUM = "https://api.adoptium.net/v3";

export type Arch = "aarch64" | "x64";

export interface JdkPackage {
  /** 예: 21.0.12+101.0.LTS */
  semver: string;
  name: string;
  link: string;
  sha256: string;
  size: number;
}

/** os: Adoptium 의 os 값 (mac, linux, alpine-linux, windows) */
export async function getJdkPackage(major: number, arch: Arch, os: string, signal?: AbortSignal): Promise<JdkPackage> {
  return cached(`jdk:${major}:${arch}:${os}`, TEN_MIN, async () => {
    const url = `${ADOPTIUM}/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jdk&os=${encodeURIComponent(os)}&vendor=eclipse`;
    const list = await fetchJson<{ version: { semver: string }; binary: { package: { name: string; link: string; checksum: string; size: number } } }[]>(url, { signal });
    const pkg = list[0]?.binary?.package;
    if (!pkg) throw new CreateError("not_found", `Java ${major} 를 내려받을 수 있는 배포판을 찾지 못했어요.`, "다른 Minecraft 버전을 고르거나, Java 를 직접 설치한 뒤 다시 시도해 주세요.", url);
    return { semver: list[0].version.semver, name: pkg.name, link: pkg.link, sha256: pkg.checksum, size: pkg.size };
  });
}
