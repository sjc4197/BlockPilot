import fsp from "node:fs/promises";
import path from "node:path";
import type { LoaderProvider } from "./types.js";
import { listMojangReleases, type McRelease } from "./mojang.js";
import { downloadServerJar } from "./vanilla.js";
import { downloadFile, fetchJson, fetchText, hashFile } from "../download.js";
import { CreateError } from "../errors.js";
import { cached, mavenPath, TEN_MIN } from "../sources.js";
import { runInstaller } from "../installer.js";

/**
 * Fabric: meta.fabricmc.net 에서 지원 버전·로더·설치기, 설치는 공식 설치기(server 모드).
 * 설치 후 라이브러리를 서버 프로필의 sha256 과 하나씩 대조한다.
 */

const FABRIC_META = "https://meta.fabricmc.net/v2";

interface FabricGame {
  version: string;
  stable: boolean;
}

/** Mojang 정식 릴리스 중 Fabric 이 안정 버전으로 지원하는 것만 (최신순) */
export function intersectReleases(releases: McRelease[], fabricGames: FabricGame[]): McRelease[] {
  const fabricStable = new Set(fabricGames.filter((g) => g.stable).map((g) => g.version));
  return releases.filter((v) => fabricStable.has(v.id));
}

async function listReleases(signal?: AbortSignal): Promise<McRelease[]> {
  return cached("fabric:releases", TEN_MIN, async () => {
    const [releases, games] = await Promise.all([listMojangReleases(signal), fetchJson<FabricGame[]>(`${FABRIC_META}/versions/game`, { signal })]);
    return intersectReleases(releases, games);
  });
}

export interface LoaderVersion {
  version: string;
  stable: boolean;
}

export async function listLoaders(mc: string, signal?: AbortSignal): Promise<LoaderVersion[]> {
  return cached(`fabric:loaders:${mc}`, TEN_MIN, async () => {
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
  return cached("fabric:installer", TEN_MIN, async () => {
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

export const fabric: LoaderProvider = {
  info: {
    id: "fabric",
    label: "Fabric",
    summary: "가벼운 모드 서버. Fabric API 모드 생태계",
    hasVersions: true,
    versionLabel: "Fabric 로더",
  },
  listReleases,
  async listVersions(mc, signal) {
    const versions = await listLoaders(mc, signal);
    return { versions, recommended: versions.find((l) => l.stable)?.version ?? versions[0]?.version };
  },
  javaMajor: async (_mc, mojangMajor) => mojangMajor,
  downloadEstimate: async (_mc, _v, serverJarBytes) => ({ mb: serverJarBytes / 1048576, note: "설치기가 Fabric 라이브러리를 조금 더 받아요" }),
  async assertVersion(mc, loaderVersion, signal) {
    const loaders = await listLoaders(mc, signal);
    if (!loaders.some((l) => l.version === loaderVersion)) {
      throw new CreateError("not_found", `Fabric 로더 ${loaderVersion} 는 Minecraft ${mc} 를 지원하지 않아요.`, "목록에서 다른 로더 버전을 골라 주세요.");
    }
  },
  async install({ job, target, mc, loaderVersion, java, tmp, server }) {
    job.startStep("server-jar", "설치기·라이브러리 정보 확인 중");
    const [installer, libraries] = await Promise.all([getLatestInstaller(job.signal), getServerLibraries(mc, loaderVersion, job.signal)]);
    await downloadServerJar(job, target, server);

    job.startStep("loader", `설치기 ${installer.version}`);
    const installerJar = path.join(tmp, `fabric-installer-${installer.version}.jar`);
    await downloadFile({ url: installer.url, dest: installerJar, hash: { algo: "sha256", expected: installer.sha256 }, signal: job.signal });
    const out = await runInstaller(job, java.path, ["-jar", installerJar, "server", "-dir", target, "-mcversion", mc, "-loader", loaderVersion], tmp, "Fabric");
    if (out.code !== 0) {
      throw new CreateError("installer_failed", "Fabric 설치기가 실패했어요.", "인터넷 연결을 확인한 뒤 다시 시도해 주세요. 계속되면 다른 로더 버전을 골라 보세요.", out.tail);
    }
    if (!(await exists(path.join(target, "fabric-server-launch.jar")))) {
      throw new CreateError("installer_failed", "Fabric 설치기가 실행 파일을 만들지 않았어요.", "다시 시도해 주세요.", out.tail);
    }
    job.note("loader", "라이브러리 해시 확인 중");
    for (const lib of libraries) {
      const file = path.join(target, "libraries", lib.path);
      const digest = await hashFile(file, "sha256").catch(() => null);
      if (digest !== lib.sha256) {
        throw new CreateError(
          "hash_mismatch",
          `Fabric 라이브러리 ${lib.name} 가 공식 해시와 달라요.`,
          "다운로드 중에 파일이 손상됐거나 바뀌었을 수 있어요. 다시 시도해 주세요.",
          `sha256 기대값 ${lib.sha256}\nsha256 실제값 ${digest ?? "(파일 없음)"}\n${lib.path}`,
        );
      }
    }
    job.finishStep("loader", `라이브러리 ${libraries.length}개 sha256 일치`);
    return { kind: "jar", jar: "fabric-server-launch.jar" };
  },
};

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
