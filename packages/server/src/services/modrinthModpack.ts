import type { ModpackLoader, ModpackSearchHit, ModpackSearchResult, ModpackVersionEntry } from "@blockpilot/shared";
import { HttpError, badRequest } from "../lib/errors.js";
import { sortVersionsDesc, versionAtLeast } from "../lib/version.js";
import { mr, type MrProject, type MrVersion } from "./modrinth.js";
import { FORGE_MIN_MC } from "./create/loaders/forge.js";
import { NEOFORGE_MIN_MC } from "./create/loaders/neoforge.js";

/**
 * Modrinth 모드팩 검색·버전. 시그니처는 바꾸지 말 것 (routes/create.ts 의 inspect 가 getModpackVersionFile 을 import)
 * - BlockPilot 이 서버로 만들 수 있는 로더(Fabric·Forge·NeoForge)의 팩만
 * - 버전은 .mrpack 파일이 있고, 그 로더의 하한 Minecraft 버전 이상인 것만
 */

const SUPPORTED: readonly ModpackLoader[] = ["fabric", "forge", "neoforge"];
/** 로더별 최소 Minecraft 버전 (새 서버 만들기와 같음). Fabric 은 따로 하한이 없어 정식 릴리스 표기면 된다 */
const LOADER_FLOOR: Record<ModpackLoader, string | undefined> = { fabric: undefined, forge: FORGE_MIN_MC, neoforge: NEOFORGE_MIN_MC };
/** 정식 릴리스 표기 (스냅샷 "24w14a"·프리릴리즈 "1.21-pre1" 은 제외) */
const RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;
const ID_RE = /^[\w-]{1,64}$/;
const MAX_GAME_VERSIONS = 8;

interface MrModpackVersion extends MrVersion {
  name?: string;
  date_published?: string;
}

const supportedLoaders = (list: unknown): ModpackLoader[] =>
  SUPPORTED.filter((l) => Array.isArray(list) && list.includes(l));

function assertId(id: string, what: string) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw badRequest(`${what} 정보가 올바르지 않아요.`);
}

export async function searchModpacks(q: string, offset = 0): Promise<ModpackSearchResult> {
  const query = String(q ?? "").trim().slice(0, 100);
  const facets = [["project_type:modpack"], SUPPORTED.map((l) => `categories:${l}`)];
  const qs = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: "20",
    offset: String(Math.max(0, Math.floor(Number(offset) || 0))),
    index: query ? "relevance" : "downloads",
  });
  const r = await mr<{ hits: any[]; total_hits: number }>(`/search?${qs}`);
  const hits: ModpackSearchHit[] = (r.hits ?? []).map((h) => {
    const cats = [...(Array.isArray(h.categories) ? h.categories : []), ...(Array.isArray(h.display_categories) ? h.display_categories : [])];
    const versions: string[] = Array.isArray(h.versions) ? h.versions.map(String) : [];
    return {
      projectId: String(h.project_id),
      slug: String(h.slug ?? h.project_id),
      title: String(h.title ?? ""),
      description: String(h.description ?? ""),
      author: String(h.author ?? ""),
      iconUrl: h.icon_url || undefined,
      downloads: Number(h.downloads) || 0,
      loaders: supportedLoaders(cats),
      gameVersions: sortVersionsDesc(versions, (v) => v).slice(0, MAX_GAME_VERSIONS),
    };
  });
  return { hits, total: Number(r.total_hits) || 0 };
}

/** .mrpack 파일 (primary 우선). 없으면 undefined */
function mrpackFile(v: MrModpackVersion) {
  const packs = (v.files ?? []).filter((f) => /\.mrpack$/i.test(f.filename));
  return packs.find((f) => f.primary) ?? packs[0];
}

function toEntry(v: MrModpackVersion, loaders: ModpackLoader[]): ModpackVersionEntry | null {
  const f = mrpackFile(v);
  if (!f) return null;
  const vt = v.version_type;
  return {
    id: v.id,
    name: v.name || v.version_number,
    versionNumber: v.version_number,
    versionType: vt === "beta" || vt === "alpha" ? vt : "release",
    loaders,
    gameVersions: sortVersionsDesc(v.game_versions ?? [], (g) => g),
    datePublished: v.date_published ?? "",
    file: { filename: f.filename, url: f.url, size: f.size, sha512: f.hashes?.sha512 ?? "" },
  };
}

/** 그 로더로 만들 수 있는 Minecraft 버전이 하나라도 있는 로더만 */
function usableLoaders(v: MrModpackVersion): ModpackLoader[] {
  const games = (v.game_versions ?? []).filter((g) => RELEASE_RE.test(g));
  return supportedLoaders(v.loaders).filter((l) => {
    const floor = LOADER_FLOOR[l];
    return games.some((g) => !floor || versionAtLeast(g, floor));
  });
}

export async function listModpackVersions(projectId: string): Promise<ModpackVersionEntry[]> {
  assertId(projectId, "모드팩");
  const qs = new URLSearchParams({ loaders: JSON.stringify(SUPPORTED), include_changelog: "false" });
  const list = await mr<MrModpackVersion[]>(`/project/${encodeURIComponent(projectId)}/version?${qs}`);
  const out: ModpackVersionEntry[] = [];
  for (const v of Array.isArray(list) ? list : []) {
    const loaders = usableLoaders(v);
    if (!loaders.length) continue;
    const e = toEntry(v, loaders);
    if (e) out.push(e);
  }
  // 최신순 (게시 시각, 같으면 원래 순서)
  return out.sort((a, b) => (b.datePublished > a.datePublished ? 1 : b.datePublished < a.datePublished ? -1 : 0));
}

/**
 * 모드팩 버전의 .mrpack 파일. projectId 를 주면 그 프로젝트의 버전인지도 확인한다
 * (화면이 고른 팩과 다른 팩의 버전 id 를 섞어 보내도 다른 팩을 받지 않게)
 */
export async function getModpackVersionFile(versionId: string, projectId?: string): Promise<ModpackVersionEntry> {
  assertId(versionId, "모드팩 버전");
  const v = await mr<MrModpackVersion>(`/version/${encodeURIComponent(versionId)}`);
  if (projectId !== undefined && v?.project_id && v.project_id !== projectId) {
    throw new HttpError(400, "modpack_mismatch", "고른 모드팩과 버전이 서로 맞지 않아요. 모드팩을 다시 골라 주세요.");
  }
  const e = v && toEntry(v, supportedLoaders(v.loaders));
  if (!e) throw new HttpError(404, "no_mrpack", "이 버전에는 .mrpack 파일이 없어요.");
  return e;
}

// ---------- 모드팩 검사용 도우미 (클라이언트 전용 판별) ----------

const BATCH = 100;

/** 버전 id → 버전 (100개씩). 실패하면 throw (HttpError) */
export async function versionsByIds(ids: string[], signal?: AbortSignal): Promise<Map<string, MrVersion>> {
  const out = new Map<string, MrVersion>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const list = await mr<MrVersion[]>(`/versions?ids=${encodeURIComponent(JSON.stringify(uniq.slice(i, i + BATCH)))}`, { signal });
    for (const v of Array.isArray(list) ? list : []) if (v && typeof v.id === "string") out.set(v.id, v);
  }
  return out;
}

/** sha1 → Modrinth 버전 (100개씩). 실패하면 throw. 모드팩 내보내기도 같이 쓴다 */
export async function versionsBySha1(sha1s: string[], signal?: AbortSignal): Promise<Record<string, MrVersion>> {
  const out: Record<string, MrVersion> = {};
  const uniq = [...new Set(sha1s)];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const hashes = uniq.slice(i, i + BATCH);
    const r = await mr<Record<string, MrVersion>>("/version_files", { method: "POST", body: JSON.stringify({ hashes, algorithm: "sha1" }), signal });
    if (r && typeof r === "object") Object.assign(out, r);
  }
  return out;
}

/** 프로젝트 id → 프로젝트 (100개씩). 실패하면 throw */
export async function projectsByIds(ids: string[], signal?: AbortSignal): Promise<Map<string, MrProject>> {
  const out = new Map<string, MrProject>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const list = await mr<MrProject[]>(`/projects?ids=${encodeURIComponent(JSON.stringify(uniq.slice(i, i + BATCH)))}`, { signal });
    for (const p of Array.isArray(list) ? list : []) if (p && typeof p.id === "string") out.set(p.id, p);
  }
  return out;
}
