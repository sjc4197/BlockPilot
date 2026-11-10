import type { LoaderProvider } from "./types.js";
import { listMojangReleases, type McRelease } from "./mojang.js";
import { installWithInstaller, installerSizeMb } from "./forgeLike.js";
import { fetchJson } from "../download.js";
import { CreateError } from "../errors.js";
import { cached, TEN_MIN } from "../sources.js";
import { sortVersionsDesc, versionAtLeast } from "../../../lib/version.js";

/**
 * Forge (files.minecraftforge.net · maven.minecraftforge.net).
 * 버전 표기는 Forge 그대로 "{mc}-{forge}" (예 1.21.1-52.1.21) — 설치기 경로와 libraries/ 폴더 이름이 이것이다.
 */

const META = "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const PROMOS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
/** 1.17 이하는 설치 결과물이 단일 jar 라 구조가 다르고 Java 8·16 이 필요하다 */
export const FORGE_MIN_MC = "1.18";

/** { "1.21.1": ["1.21.1-52.0.1", …] } (각 배열은 오름차순) */
export type ForgeMetadata = Record<string, string[]>;
/** { promos: { "1.21.1-recommended": "52.1.20", "1.21.1-latest": "52.1.21" } } — 값은 forge 부분만 */
export interface ForgePromotions {
  promos: Record<string, string>;
}

export function forgeReleases(releases: McRelease[], meta: ForgeMetadata): McRelease[] {
  return releases.filter((r) => meta[r.id]?.length && versionAtLeast(r.id, FORGE_MIN_MC));
}

/** 최신순 목록과 추천(recommended → latest → 가장 새 것) */
export function forgeVersions(mc: string, meta: ForgeMetadata, promos: ForgePromotions): { versions: { version: string; stable: boolean }[]; recommended?: string } {
  const list = sortVersionsDesc(meta[mc] ?? [], (v) => v.slice(mc.length + 1));
  const versions = list.map((version) => ({ version, stable: true }));
  const promo = promos.promos[`${mc}-recommended`] ?? promos.promos[`${mc}-latest`];
  const recommended = (promo && list.find((v) => v === `${mc}-${promo}`)) || list[0];
  return { versions, recommended };
}

const metadata = (signal?: AbortSignal) => cached("forge:meta", TEN_MIN, () => fetchJson<ForgeMetadata>(META, { signal }));
/** 추천 정보는 없어도 되는 부가 정보라 못 받으면 빈 값으로 (실패는 캐시하지 않는다) */
const promotions = (signal?: AbortSignal) => cached("forge:promos", TEN_MIN, () => fetchJson<ForgePromotions>(PROMOS, { signal })).catch(() => ({ promos: {} }) as ForgePromotions);

const installerUrl = (v: string) => `${MAVEN}/${v}/forge-${v}-installer.jar`;

export const forge: LoaderProvider = {
  info: {
    id: "forge",
    label: "Forge",
    summary: "가장 오래된 모드 생태계. 대형 모드팩 대부분이 여기 있어요",
    minMc: FORGE_MIN_MC,
    hasVersions: true,
    versionLabel: "Forge 버전",
  },
  async listReleases(signal) {
    return cached("forge:releases", TEN_MIN, async () => {
      const [releases, meta] = await Promise.all([listMojangReleases(signal), metadata(signal)]);
      return forgeReleases(releases, meta);
    });
  },
  async listVersions(mc, signal) {
    const [meta, promos] = await Promise.all([metadata(signal), promotions(signal)]);
    return forgeVersions(mc, meta, promos);
  },
  javaMajor: async (_mc, mojangMajor) => mojangMajor,
  async downloadEstimate(_mc, loaderVersion, _serverJarBytes, signal) {
    const mb = loaderVersion ? await installerSizeMb(installerUrl(loaderVersion), signal) : undefined;
    return { mb: mb ?? 9, note: "설치기가 Minecraft 서버와 라이브러리(수백 MB)를 더 받아요" };
  },
  async assertVersion(mc, loaderVersion, signal) {
    const meta = await metadata(signal);
    if (!meta[mc]?.includes(loaderVersion)) throw new CreateError("not_found", `Forge ${loaderVersion} 는 Minecraft ${mc} 용이 아니에요.`, "목록에서 다른 버전을 골라 주세요.");
  },
  install(ctx) {
    const v = ctx.loaderVersion;
    return installWithInstaller(ctx, {
      label: "Forge",
      url: installerUrl(v),
      fileName: `forge-${v}-installer.jar`,
      serverFlag: "--installServer",
      argsDir: `libraries/net/minecraftforge/forge/${v}`,
    });
  },
};
