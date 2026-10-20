import { fetchJson, fetchText } from "./download.js";
import { CreateError } from "./errors.js";

/**
 * 공식 배포처 클라이언트. 모든 다운로드 항목에 해시를 함께 돌려준다.
 * - Mojang: 버전 목록, 버전별 server.jar(sha1) 와 필요한 Java major
 * - Fabric meta / maven: 지원 버전, 로더, 설치기(sha256), 서버 라이브러리 목록(sha256)
 * - Adoptium: Temurin JDK(sha256)
 */

const MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META = "https://meta.fabricmc.net/v2";
const ADOPTIUM = "https://api.adoptium.net/v3";

// ---------- 짧은 캐시 (목록을 여러 번 열 때 매번 받지 않도록) ----------

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const TEN_MIN = 10 * 60_000;

// ---------- Mojang ----------

interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; sha1: string; releaseTime: string }[];
}

export interface McRelease {
  id: string;
  releaseTime: string;
  url: string;
  sha1: string;
}

/** Mojang 정식 릴리스 중 Fabric 이 안정 버전으로 지원하는 것만 (최신순) */
export function intersectReleases(manifest: MojangManifest, fabricGames: { version: string; stable: boolean }[]): McRelease[] {
  const fabricStable = new Set(fabricGames.filter((g) => g.stable).map((g) => g.version));
  return manifest.versions
    .filter((v) => v.type === "release" && fabricStable.has(v.id))
    .map(({ id, releaseTime, url, sha1 }) => ({ id, releaseTime, url, sha1 }));
}

export async function listReleases(signal?: AbortSignal): Promise<McRelease[]> {
  return cached("releases", TEN_MIN, async () => {
    const [manifest, games] = await Promise.all([
      fetchJson<MojangManifest>(MOJANG_MANIFEST, { signal }),
      fetchJson<{ version: string; stable: boolean }[]>(`${FABRIC_META}/versions/game`, { signal }),
    ]);
    return intersectReleases(manifest, games);
  });
}

export interface VersionInfo {
  id: string;
  javaMajor: number;
  server: { url: string; sha1: string; size: number };
}

/** 버전 JSON 은 매니페스트에 적힌 sha1 로 검증한 뒤 읽는다 */
export async function getVersionInfo(id: string, signal?: AbortSignal): Promise<VersionInfo> {
  return cached(`version:${id}`, TEN_MIN, async () => {
    const rel = (await listReleases(signal)).find((r) => r.id === id);
    if (!rel) throw new CreateError("not_found", `Minecraft ${id} 는 Fabric 정식 지원 버전이 아니에요.`, "목록에 있는 버전을 골라 주세요.");
    const json = await fetchJson<{ javaVersion?: { majorVersion: number }; downloads?: { server?: { url: string; sha1: string; size: number } } }>(rel.url, { sha1: rel.sha1, signal });
    const server = json.downloads?.server;
    if (!server) throw new CreateError("not_found", `Minecraft ${id} 는 서버 파일을 배포하지 않아요.`, "다른 버전을 골라 주세요.");
    return { id, javaMajor: json.javaVersion?.majorVersion ?? 21, server };
  });
}

// ---------- Fabric ----------

export interface LoaderVersion {
  version: string;
  stable: boolean;
}

export async function listLoaders(mc: string, signal?: AbortSignal): Promise<LoaderVersion[]> {
  return cached(`loaders:${mc}`, TEN_MIN, async () => {
    const list = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`, { signal });
    return list.map((x) => ({ version: x.loader.version, stable: x.loader.stable }));
  });
}

export interface InstallerInfo {
  version: string;
  url: string;
  sha256: string;
}

/** 최신 안정판 설치기. 해시는 maven 의 .sha256 파일에서 */
export async function getLatestInstaller(signal?: AbortSignal): Promise<InstallerInfo> {
  return cached("installer", TEN_MIN, async () => {
    const list = await fetchJson<{ url: string; version: string; stable: boolean }[]>(`${FABRIC_META}/versions/installer`, { signal });
    const stable = list.find((i) => i.stable) ?? list[0];
    if (!stable) throw new CreateError("not_found", "Fabric 설치기 정보를 찾지 못했어요.", "잠시 후 다시 시도해 주세요.");
    const sha256 = (await fetchText(`${stable.url}.sha256`, { signal })).trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new CreateError("http_error", "Fabric 설치기의 해시를 읽지 못했어요.", "잠시 후 다시 시도해 주세요.", `${stable.url}.sha256`);
    return { version: stable.version, url: stable.url, sha256 };
  });
}

export interface ServerLibrary {
  name: string;
  url: string;
  sha256: string;
  size?: number;
  /** libraries/ 아래 상대 경로 */
  path: string;
}

/**
 * 서버 실행에 필요한 Fabric 라이브러리 목록과 sha256 (설치 후 대조용).
 * 프로필에 해시가 없는 항목(intermediary, fabric-loader 등)은 그 라이브러리의 maven 저장소가 배포하는 .sha256 을 쓴다.
 */
export async function getServerLibraries(mc: string, loader: string, signal?: AbortSignal): Promise<ServerLibrary[]> {
  const profile = await fetchJson<{ libraries: { name: string; url: string; sha256?: string; size?: number }[] }>(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/server/json`,
    { signal },
  );
  return Promise.all(
    profile.libraries.map(async (l) => {
      const libPath = mavenPath(l.name);
      let sha256 = l.sha256;
      if (!sha256) {
        const repo = l.url.endsWith("/") ? l.url : `${l.url}/`;
        const text = await fetchText(`${repo}${libPath}.sha256`, { signal }).catch(() => "");
        sha256 = text.trim().split(/\s+/)[0];
      }
      if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
        throw new CreateError("hash_mismatch", `라이브러리 ${l.name} 의 공식 해시를 찾지 못했어요.`, "검증할 수 없는 파일은 설치하지 않아요. 다른 로더 버전을 골라 주세요.");
      }
      return { name: l.name, url: l.url, sha256: sha256.toLowerCase(), size: l.size, path: libPath };
    }),
  );
}

/** "group:artifact:version[:classifier]" → "group/path/artifact/version/artifact-version[-classifier].jar" */
export function mavenPath(coord: string): string {
  const [group, artifact, version, classifier] = coord.split(":");
  if (!group || !artifact || !version) throw new Error(`잘못된 maven 좌표: ${coord}`);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  return [...group.split("."), artifact, version, file].join("/");
}

// ---------- Adoptium (Temurin JDK) ----------

export type Arch = "aarch64" | "x64";

export interface JdkPackage {
  /** 예: 21.0.12+101.0.LTS */
  semver: string;
  name: string;
  link: string;
  sha256: string;
  size: number;
}

export async function getJdkPackage(major: number, arch: Arch, signal?: AbortSignal): Promise<JdkPackage> {
  return cached(`jdk:${major}:${arch}`, TEN_MIN, async () => {
    const url = `${ADOPTIUM}/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jdk&os=mac&vendor=eclipse`;
    const list = await fetchJson<{ version: { semver: string }; binary: { package: { name: string; link: string; checksum: string; size: number } } }[]>(url, { signal });
    const pkg = list[0]?.binary?.package;
    if (!pkg) throw new CreateError("not_found", `Java ${major} 를 내려받을 수 있는 배포판을 찾지 못했어요.`, "다른 Minecraft 버전을 고르거나, Java 를 직접 설치한 뒤 다시 시도해 주세요.", url);
    return { semver: list[0].version.semver, name: pkg.name, link: pkg.link, sha256: pkg.checksum, size: pkg.size };
  });
}
