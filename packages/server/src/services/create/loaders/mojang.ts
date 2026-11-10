import { fetchJson } from "../download.js";
import { CreateError } from "../errors.js";
import { cached, TEN_MIN } from "../sources.js";

/** Mojang 공식 버전 정보. 모든 로더가 여기서 정식 버전 목록과 필요한 Java 를 읽는다 */

const MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

export interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; sha1: string; releaseTime: string }[];
}

export interface McRelease {
  id: string;
  releaseTime: string;
  url: string;
  sha1: string;
}

/** Mojang 정식 릴리스 (매니페스트 순서 = 최신순) */
export async function listMojangReleases(signal?: AbortSignal): Promise<McRelease[]> {
  return cached("mojang:releases", TEN_MIN, async () => {
    const manifest = await fetchJson<MojangManifest>(MOJANG_MANIFEST, { signal });
    return releasesOf(manifest);
  });
}

export function releasesOf(manifest: MojangManifest): McRelease[] {
  return manifest.versions.filter((v) => v.type === "release").map(({ id, releaseTime, url, sha1 }) => ({ id, releaseTime, url, sha1 }));
}

export interface VersionInfo {
  id: string;
  javaMajor: number;
  server: { url: string; sha1: string; size: number };
}

/** 버전 JSON 은 매니페스트에 적힌 sha1 로 검증한 뒤 읽는다 */
export async function getVersionInfo(id: string, signal?: AbortSignal): Promise<VersionInfo> {
  return cached(`mojang:version:${id}`, TEN_MIN, async () => {
    const rel = (await listMojangReleases(signal)).find((r) => r.id === id);
    if (!rel) throw new CreateError("not_found", `Minecraft ${id} 는 정식 버전이 아니에요.`, "목록에 있는 버전을 골라 주세요.");
    const json = await fetchJson<{ javaVersion?: { majorVersion: number }; downloads?: { server?: { url: string; sha1: string; size: number } } }>(rel.url, { sha1: rel.sha1, signal });
    const server = json.downloads?.server;
    if (!server) throw new CreateError("not_found", `Minecraft ${id} 는 서버 파일을 배포하지 않아요.`, "다른 버전을 골라 주세요.");
    return { id, javaMajor: json.javaVersion?.majorVersion ?? 21, server };
  });
}
