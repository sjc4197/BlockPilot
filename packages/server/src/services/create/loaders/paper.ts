import path from "node:path";
import type { LoaderProvider } from "./types.js";
import { listMojangReleases, type McRelease } from "./mojang.js";
import { downloadFile, fetchJson } from "../download.js";
import { CreateError } from "../errors.js";
import { cached, TEN_MIN } from "../sources.js";
import { sortVersionsDesc, versionAtLeast } from "../../../lib/version.js";

/**
 * Paper (PaperMC Fill v3 API). 서버 jar 하나만 받으면 되고 sha256 은 API 가 준다.
 * 첫 실행 때 Paper 가 Mojang 서버 파일을 스스로 받아 패치한다 (인터넷 필요).
 * v2 API 는 2026-07 에 종료됐다. Fill 은 소프트웨어 이름·연락처가 든 User-Agent 를 요구한다 (download.ts 가 붙임).
 */

const FILL = "https://fill.papermc.io/v3/projects/paper";
/** Java 17 이 필요한 1.18 부터. 그 아래는 Temurin 배포가 없는 Java 가 필요하다 */
export const PAPER_MIN_MC = "1.18";

interface FillProject {
  versions: Record<string, string[]>;
}
interface FillVersion {
  version: { id: string; java?: { version?: { minimum?: number } } };
  builds: number[];
}
export type FillChannel = "STABLE" | "BETA" | "ALPHA";
export interface FillBuild {
  id: number;
  time: string;
  channel: FillChannel;
  downloads: Record<string, { name: string; url: string; size: number; checksums: { sha256: string } }>;
}

/** Fill 의 계열별 묶음을 평탄화해 Mojang 정식 버전과 교집합 (최신순, 1.18 이상) */
export function paperReleases(releases: McRelease[], project: FillProject): McRelease[] {
  const has = new Set(Object.values(project.versions).flat());
  return releases.filter((r) => has.has(r.id) && versionAtLeast(r.id, PAPER_MIN_MC));
}

/**
 * 보여 줄 빌드: STABLE 이 있으면 STABLE 만, 없으면 BETA (베타 표시). ALPHA(실험 빌드)는 보여 주지 않는다.
 * 새 Minecraft 가 나온 직후엔 BETA·ALPHA 만 있는 기간이 있다 — ALPHA 만 있는 버전은 목록에서 빠진다.
 */
export function pickBuilds(builds: FillBuild[]): { version: string; stable: boolean }[] {
  const by = (c: FillChannel) => builds.filter((b) => b.channel === c && b.downloads["server:default"]);
  const chosen = [by("STABLE"), by("BETA")].find((l) => l.length) ?? [];
  return sortVersionsDesc(chosen, (b) => String(b.id)).map((b) => ({ version: String(b.id), stable: b.channel === "STABLE" }));
}

async function project(signal?: AbortSignal) {
  return cached("paper:project", TEN_MIN, () => fetchJson<FillProject>(FILL, { signal }));
}
async function version(mc: string, signal?: AbortSignal) {
  return cached(`paper:version:${mc}`, TEN_MIN, () => fetchJson<FillVersion>(`${FILL}/versions/${encodeURIComponent(mc)}`, { signal }));
}
async function builds(mc: string, signal?: AbortSignal) {
  return cached(`paper:builds:${mc}`, TEN_MIN, () => fetchJson<FillBuild[]>(`${FILL}/versions/${encodeURIComponent(mc)}/builds`, { signal }));
}

async function findBuild(mc: string, build: string, signal?: AbortSignal) {
  const b = (await builds(mc, signal)).find((x) => String(x.id) === build);
  const dl = b?.downloads["server:default"];
  if (!b || !dl) throw new CreateError("not_found", `Paper 빌드 ${build} 는 Minecraft ${mc} 에 없어요.`, "목록에서 다른 빌드를 골라 주세요.");
  if (!/^[0-9a-f]{64}$/i.test(dl.checksums?.sha256 ?? "")) throw new CreateError("hash_mismatch", `Paper 빌드 ${build} 의 공식 해시를 찾지 못했어요.`, "검증할 수 없는 파일은 설치하지 않아요. 다른 빌드를 골라 주세요.");
  return { build: b, download: dl };
}

export const paper: LoaderProvider = {
  info: {
    id: "paper",
    label: "Paper",
    summary: "플러그인 서버. 친구들은 아무것도 안 깔고 순정 클라이언트로 접속해요",
    minMc: PAPER_MIN_MC,
    hasVersions: true,
    versionLabel: "Paper 빌드",
  },
  async listReleases(signal) {
    return cached("paper:releases", TEN_MIN, async () => {
      const [releases, proj] = await Promise.all([listMojangReleases(signal), project(signal)]);
      const list = paperReleases(releases, proj);
      // 가장 새 버전 둘은 ALPHA 빌드만 있을 수 있다 → 그런 버전은 아직 목록에 올리지 않는다.
      // 빌드 목록을 못 받으면(일시 장애) 버전을 빼지 않고 둔다 — 빼 버리면 10분 캐시 동안 사라진 채로 남는다
      const checked = await Promise.all(list.slice(0, 2).map(async (r) => ((await builds(r.id, signal).then((b) => pickBuilds(b).length > 0, () => true)) ? r : null)));
      return [...checked.filter((r): r is McRelease => !!r), ...list.slice(2)];
    });
  },
  async listVersions(mc, signal) {
    const versions = pickBuilds(await builds(mc, signal));
    return { versions, recommended: versions[0]?.version };
  },
  async javaMajor(mc, mojangMajor, signal) {
    const min = (await version(mc, signal).catch(() => null))?.version.java?.version?.minimum;
    return Math.max(mojangMajor, min ?? 0);
  },
  async downloadEstimate(mc, loaderVersion, _serverJarBytes, signal) {
    const size = loaderVersion ? (await findBuild(mc, loaderVersion, signal).catch(() => null))?.download.size : undefined;
    return { mb: (size ?? 50 * 1048576) / 1048576, note: "첫 실행 때 Paper 가 Minecraft 서버 파일을 더 받아요" };
  },
  async assertVersion(mc, loaderVersion, signal) {
    await findBuild(mc, loaderVersion, signal);
  },
  async install({ job, target, mc, loaderVersion }) {
    job.skipStep("server-jar", "Paper 가 첫 실행 때 Mojang 서버 파일을 직접 받아요");
    job.startStep("loader", `빌드 ${loaderVersion} 정보 확인 중`);
    const { download } = await findBuild(mc, loaderVersion, job.signal);
    job.note("loader", `빌드 ${loaderVersion} · ${(download.size / 1048576).toFixed(1)} MB`);
    // 파일 이름은 그대로 둔다: 폴더만 보고 Paper 와 버전을 알아보는 감지(serverInfo)가 paper-<mc>-<build>.jar 를 본다
    const jar = /^paper-[\w.-]+\.jar$/.test(download.name) ? download.name : `paper-${mc}-${loaderVersion}.jar`;
    await downloadFile({
      url: download.url,
      dest: path.join(target, jar),
      hash: { algo: "sha256", expected: download.checksums.sha256 },
      expectedSize: download.size,
      signal: job.signal,
      onProgress: (d, t) => job.progress("loader", d, t),
    });
    job.finishStep("loader", "sha256 일치");
    return { kind: "jar", jar };
  },
};
