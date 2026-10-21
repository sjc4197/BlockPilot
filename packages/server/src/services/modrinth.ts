import fsp from "node:fs/promises";
import path from "node:path";
import type { ModUpdate, ModrinthHit, ModrinthInstallResult, ModrinthSearchResult } from "@blockpilot/shared";
import { HttpError } from "../lib/errors.js";
import { downloadFile, hashFile } from "./create/download.js";
import { modsDirName } from "./mods.js";

/**
 * Modrinth 모드·플러그인 검색, 설치, 업데이트.
 * - 이 서버의 로더와 마인크래프트 버전에 맞는 것만
 * - 받은 파일은 Modrinth 가 알려 준 sha512 로 검증 (어긋나면 남기지 않음)
 * - 필수 의존 모드도 같이, 이미 있는 건 건너뜀
 * - 바꾼 jar 는 .blockpilot-backup/ 에 보관해 되돌릴 수 있게
 */
const API = () => process.env.BLOCKPILOT_MODRINTH_URL ?? "https://api.modrinth.com/v2";
const UA = { "user-agent": "sjc4197/BlockPilot/0.1 (github.com/sjc4197/BlockPilot)" };
const PLUGIN_LOADERS = ["paper", "spigot", "bukkit", "purpur", "folia"];

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** 테스트용 */
export function setModrinthFetch(f: Fetch) {
  fetchImpl = f;
}

async function mr<T>(p: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(API() + p, { ...init, headers: { ...UA, ...(init?.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, "modrinth_unreachable", "Modrinth 에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (res.status === 429) throw new HttpError(503, "modrinth_rate_limited", "Modrinth 가 잠시 요청을 막았어요. 1분쯤 뒤에 다시 해 주세요.");
  if (!res.ok) throw new HttpError(502, "modrinth_error", `Modrinth 오류 (${res.status})`);
  return (await res.json()) as T;
}

export interface Target {
  dir: string;
  loader?: string;
  mcVersion?: string;
}

/** 서버 로더 → Modrinth 로더 목록, 프로젝트 종류 */
export function modrinthTarget(loader?: string): { loaders: string[]; type: "mod" | "plugin" } | null {
  if (loader === "fabric" || loader === "forge" || loader === "neoforge") return { loaders: [loader], type: "mod" };
  if (loader === "paper") return { loaders: PLUGIN_LOADERS, type: "plugin" };
  return null;
}

interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: string;
  loaders: string[];
  game_versions: string[];
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha1: string; sha512: string } }[];
  dependencies: { project_id?: string; version_id?: string; dependency_type: string }[];
}
interface MrProject {
  id: string;
  title: string;
  client_side: string;
  server_side: string;
}

const modsDir = (t: Target) => path.join(t.dir, modsDirName(t.loader));

/** 설치된 jar 들의 sha1 → 파일 이름 */
async function installedHashes(t: Target): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await fsp.readdir(modsDir(t)).catch(() => [] as string[])) {
    if (!/\.jar(\.disabled)?$/.test(f)) continue;
    out.set(await hashFile(path.join(modsDir(t), f), "sha1"), f);
  }
  return out;
}

/** sha1 → 그 jar 의 Modrinth 버전 (모르는 파일은 빠짐) */
async function identify(hashes: string[]): Promise<Record<string, MrVersion>> {
  if (!hashes.length) return {};
  return mr<Record<string, MrVersion>>("/version_files", { method: "POST", body: JSON.stringify({ hashes, algorithm: "sha1" }) });
}

export async function search(t: Target, query: string, offset = 0): Promise<ModrinthSearchResult> {
  const mt = modrinthTarget(t.loader);
  if (!mt || !t.mcVersion) return { supported: false, reason: "바닐라 서버이거나 로더를 알 수 없어서 Modrinth 에서 찾을 수 없어요.", hits: [], total: 0 };
  const facets = [mt.loaders.map((l) => `categories:${l}`), [`versions:${t.mcVersion}`], [`project_type:${mt.type}`]];
  const qs = new URLSearchParams({ query, facets: JSON.stringify(facets), limit: "20", offset: String(offset), index: query ? "relevance" : "downloads" });
  const r = await mr<{ hits: any[]; total_hits: number }>(`/search?${qs}`);
  const have = new Set(Object.values(await identify([...(await installedHashes(t)).keys()]).catch(() => ({}))).map((v) => v.project_id));
  const hits: ModrinthHit[] = r.hits.map((h) => ({
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    iconUrl: h.icon_url || undefined,
    downloads: h.downloads,
    serverSide: h.server_side,
    clientSide: h.client_side,
    installed: have.has(h.project_id),
  }));
  return { supported: true, loader: t.loader, mcVersion: t.mcVersion, hits, total: r.total_hits };
}

/** 이 서버에 맞는 가장 새 버전 (정식 → 베타 → 알파 순으로) */
async function bestVersion(projectId: string, t: Target): Promise<MrVersion | null> {
  const mt = modrinthTarget(t.loader)!;
  const qs = new URLSearchParams({ loaders: JSON.stringify(mt.loaders), game_versions: JSON.stringify([t.mcVersion]) });
  const list = await mr<MrVersion[]>(`/project/${encodeURIComponent(projectId)}/version?${qs}`);
  return list.find((v) => v.version_type === "release") ?? list.find((v) => v.version_type === "beta") ?? list[0] ?? null;
}

const safeName = (f: string) => {
  const base = path.basename(f);
  if (!/^[\w.+\-\[\]() ]+\.jar$/.test(base)) throw new HttpError(502, "bad_filename", `Modrinth 파일 이름이 이상해서 받지 않았어요: ${base}`);
  return base;
};

async function fetchJar(v: MrVersion, t: Target, file = v.files.find((f) => f.primary) ?? v.files[0], overwrite = false) {
  if (!file) throw new HttpError(502, "no_file", "이 버전에는 받을 파일이 없어요.");
  if (!/^https:\/\/cdn\.modrinth\.com\//.test(file.url) && !process.env.BLOCKPILOT_MODRINTH_URL) throw new HttpError(502, "bad_url", "Modrinth 가 아닌 곳의 파일이라 받지 않았어요.");
  const name = safeName(file.filename);
  if (!overwrite && (await fsp.stat(path.join(modsDir(t), name)).catch(() => null))) throw new HttpError(409, "exists", `같은 이름의 파일(${name})이 이미 있어요.`);
  await downloadFile({ url: file.url, dest: path.join(modsDir(t), name), hash: { algo: "sha512", expected: file.hashes.sha512 }, expectedSize: file.size, retries: 2 });
  return name;
}

export async function install(t: Target, projectId: string, opts: { allowClientOnly?: boolean } = {}): Promise<ModrinthInstallResult> {
  if (!modrinthTarget(t.loader) || !t.mcVersion) throw new HttpError(400, "unsupported", "이 서버에는 Modrinth 로 설치할 수 없어요.");
  await fsp.mkdir(modsDir(t), { recursive: true });
  const have = new Set(Object.values(await identify([...(await installedHashes(t)).keys()])).map((v) => v.project_id));
  const result: ModrinthInstallResult = { installed: [], skipped: [] };
  const seen = new Set<string>();

  const walk = async (pid: string, versionId: string | undefined, dependency: boolean, depth: number) => {
    if (seen.has(pid) || depth > 5) return;
    seen.add(pid);
    const project = await mr<MrProject>(`/project/${encodeURIComponent(pid)}`);
    if (have.has(pid)) {
      result.skipped.push({ title: project.title, reason: "이미 설치돼 있어요" });
      return;
    }
    if (!dependency && project.server_side === "unsupported" && !opts.allowClientOnly) {
      throw new HttpError(400, "client_only", `${project.title} 은(는) 클라이언트 전용이라 서버에는 필요 없어요. 그래도 설치하려면 한 번 더 확인해 주세요.`);
    }
    if (dependency && project.server_side === "unsupported") {
      result.skipped.push({ title: project.title, reason: "클라이언트 전용이라 서버에는 넣지 않았어요" });
      return;
    }
    const v = versionId ? await mr<MrVersion>(`/version/${encodeURIComponent(versionId)}`) : await bestVersion(pid, t);
    if (!v) {
      if (dependency) result.skipped.push({ title: project.title, reason: `${t.mcVersion} 용 버전이 없어요` });
      else throw new HttpError(404, "no_version", `${project.title} 에는 ${t.mcVersion} ${t.loader} 용 버전이 없어요.`);
      return;
    }
    const file = await fetchJar(v, t);
    result.installed.push({ title: project.title, file, version: v.version_number, dependency });
    for (const d of v.dependencies) if (d.dependency_type === "required" && d.project_id) await walk(d.project_id, d.version_id, true, depth + 1);
  };
  await walk(projectId, undefined, false, 0);
  return result;
}

// ---------- 업데이트 ----------

export async function findUpdates(t: Target): Promise<ModUpdate[]> {
  const mt = modrinthTarget(t.loader);
  if (!mt || !t.mcVersion) return [];
  const files = await installedHashes(t);
  if (!files.size) return [];
  const hashes = [...files.keys()];
  const current = await identify(hashes);
  const latest = await mr<Record<string, MrVersion>>("/version_files/update", { method: "POST", body: JSON.stringify({ hashes, algorithm: "sha1", loaders: mt.loaders, game_versions: [t.mcVersion] }) });
  const ids = [...new Set(Object.values(current).map((v) => v.project_id))];
  const projects = ids.length ? await mr<MrProject[]>(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`) : [];
  const title = new Map(projects.map((p) => [p.id, p.title]));
  const out: ModUpdate[] = [];
  for (const h of hashes) {
    const cur = current[h];
    const next = latest[h];
    if (!cur || !next || next.id === cur.id) continue;
    out.push({ file: files.get(h)!, projectId: cur.project_id, title: title.get(cur.project_id) ?? cur.project_id, current: cur.version_number, latest: next.version_number, latestVersionId: next.id });
  }
  return out;
}

/** 파일들을 최신 버전으로. 이전 jar 는 .blockpilot-backup/mods-<시각>/ 로 옮겨 둔다. 꺼져 있던 모드는 꺼진 채로 */
export async function applyUpdates(t: Target, files: string[]): Promise<{ updated: { file: string; to: string }[]; backupDir: string }> {
  const ups = (await findUpdates(t)).filter((u) => files.includes(u.file));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(t.dir, ".blockpilot-backup", `mods-${stamp}`);
  const updated: { file: string; to: string }[] = [];
  for (const u of ups) {
    const v = await mr<MrVersion>(`/version/${encodeURIComponent(u.latestVersionId)}`);
    // 받기 전에 먼저 보관해 둔다 (새 파일 이름이 같아도 이전 jar 를 잃지 않게)
    await fsp.mkdir(backupDir, { recursive: true });
    const old = path.join(modsDir(t), u.file);
    await fsp.copyFile(old, path.join(backupDir, u.file));
    const newName = await fetchJar(v, t, undefined, true);
    const disabled = u.file.endsWith(".disabled");
    const finalName = disabled ? `${newName}.disabled` : newName;
    if (disabled) await fsp.rename(path.join(modsDir(t), newName), path.join(modsDir(t), finalName));
    if (finalName !== u.file) await fsp.rm(old, { force: true });
    updated.push({ file: u.file, to: finalName });
  }
  return { updated, backupDir: path.relative(t.dir, backupDir) };
}
