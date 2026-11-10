import type { LoaderProvider } from "./types.js";
import { listMojangReleases, type McRelease } from "./mojang.js";
import { installWithInstaller, installerSizeMb } from "./forgeLike.js";
import { fetchJson } from "../download.js";
import { CreateError } from "../errors.js";
import { cached, TEN_MIN } from "../sources.js";
import { sortVersionsDesc, versionAtLeast } from "../../../lib/version.js";

/**
 * NeoForge (maven.neoforged.net).
 * 버전 규칙: Minecraft 1.X.Y → X.Y.*  (1.21 → 21.0.*, 1.21.1 → 21.1.*), 연도 버전 26.X[.Y] → 26.X.Y.* (26.3 → 26.3.0.*).
 * "-beta" 는 비안정. NeoForge 는 안정판 없이 beta 만 배포하는 Minecraft 버전이 많아, 안정이 없으면 beta 를 보여 준다.
 */

const API = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
/** net.neoforged:neoforge 좌표는 1.20.2 부터. 그 전(1.20.1)은 Forge 포크 좌표라 다루지 않는다 */
export const NEOFORGE_MIN_MC = "1.20.2";

const VALID = /^\d+\.\d+\.\d+(\.\d+)?(-beta)?$/;

/** Minecraft 버전 → NeoForge 버전 접두사 ("21.1." / "26.3.0."). 지원 범위 밖이면 null */
export function mcToNeoPrefix(mc: string): string | null {
  const parts = mc.split(".");
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  if (parts[0] === "1") {
    if (parts.length < 2 || parts.length > 3) return null;
    return `${parts[1]}.${parts[2] ?? "0"}.`;
  }
  if (parts.length === 2 || parts.length === 3) return `${parts[0]}.${parts[1]}.${parts[2] ?? "0"}.`;
  return null;
}

/** v 가 mc 용 NeoForge 버전 표기인가 (안정 또는 -beta). "21.1.265" 는 1.21.1 용, 1.21.11(21.11.) 과는 섞이지 않는다 */
export function isNeoVersionFor(mc: string, v: string): boolean {
  const prefix = mcToNeoPrefix(mc);
  return !!prefix && VALID.test(v) && v.startsWith(prefix) && /^\d+(-beta)?$/.test(v.slice(prefix.length));
}

/** mc 에 맞는 NeoForge 버전들 (최신순). 안정이 하나라도 있으면 안정만, 없으면 beta 전부 */
export function neoVersions(mc: string, all: string[]): { versions: { version: string; stable: boolean }[]; recommended?: string } {
  if (!mcToNeoPrefix(mc)) return { versions: [] };
  const mine = all.filter((v) => isNeoVersionFor(mc, v));
  const stable = mine.filter((v) => !v.endsWith("-beta"));
  const chosen = sortVersionsDesc(stable.length ? stable : mine, (v) => v);
  return { versions: chosen.map((version) => ({ version, stable: !version.endsWith("-beta") })), recommended: chosen[0] };
}

export function neoReleases(releases: McRelease[], all: string[]): McRelease[] {
  return releases.filter((r) => versionAtLeast(r.id, NEOFORGE_MIN_MC) && neoVersions(r.id, all).versions.length > 0);
}

const allVersions = (signal?: AbortSignal) => cached("neoforge:versions", TEN_MIN, async () => (await fetchJson<{ versions: string[] }>(API, { signal })).versions);
const installerUrl = (v: string) => `${MAVEN}/${v}/neoforge-${v}-installer.jar`;

export const neoforge: LoaderProvider = {
  info: {
    id: "neoforge",
    label: "NeoForge",
    summary: "Forge 에서 갈라져 나온 현대판 모드 로더. 1.20.2 이상",
    minMc: NEOFORGE_MIN_MC,
    hasVersions: true,
    versionLabel: "NeoForge 버전",
  },
  async listReleases(signal) {
    return cached("neoforge:releases", TEN_MIN, async () => {
      const [releases, all] = await Promise.all([listMojangReleases(signal), allVersions(signal)]);
      return neoReleases(releases, all);
    });
  },
  async listVersions(mc, signal) {
    return neoVersions(mc, await allVersions(signal));
  },
  javaMajor: async (_mc, mojangMajor) => mojangMajor,
  async downloadEstimate(_mc, loaderVersion, _serverJarBytes, signal) {
    const mb = loaderVersion ? await installerSizeMb(installerUrl(loaderVersion), signal) : undefined;
    return { mb: mb ?? 7, note: "설치기가 Minecraft 서버와 라이브러리(수백 MB)를 더 받아요" };
  },
  async assertVersion(mc, loaderVersion, signal) {
    // 배포처 목록에 있는 정상 표기(안정 또는 -beta)이고 이 mc 의 접두사와 맞아야 한다. alpha·snapshot 표기는 거부
    if (!isNeoVersionFor(mc, loaderVersion) || !(await allVersions(signal)).includes(loaderVersion)) {
      throw new CreateError("not_found", `NeoForge ${loaderVersion} 는 Minecraft ${mc} 용이 아니에요.`, "목록에서 다른 버전을 골라 주세요.");
    }
  },
  install(ctx) {
    const v = ctx.loaderVersion;
    return installWithInstaller(ctx, {
      label: "NeoForge",
      url: installerUrl(v),
      fileName: `neoforge-${v}-installer.jar`,
      serverFlag: "--install-server",
      argsDir: `libraries/net/neoforged/neoforge/${v}`,
    });
  },
};
