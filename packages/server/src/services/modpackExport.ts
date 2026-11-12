import fs from "node:fs/promises";
import path from "node:path";
import yazl from "yazl";
import { MrpackIndex, type MrpackFile } from "@blockpilot/shared";
import { badRequest } from "../lib/errors.js";
import { detectServer } from "./serverInfo.js";
import { listMods } from "./mods.js";
import { hashFile } from "./create/download.js";
import type { MrProject, MrVersion } from "./modrinth.js";
import { projectsByIds, versionsBySha1 } from "./modrinthModpack.js";

/**
 * 서버의 모드 구성을 Modrinth 모드팩(.mrpack)으로 내보낸다. 친구는 Modrinth App·Prism 에서 "파일에서 추가" 로 같은 구성을 받는다.
 * - Modrinth 에 있는 jar 는 다운로드 주소만 적고(files), 없는 jar 는 팩 안에 직접 넣는다(overrides)
 * - 서버 전용 jar 는 server-overrides/, 클라이언트 전용 jar 는 client-overrides/ 로
 * - Modrinth 에 연결이 안 되면 전부 직접 넣고 offline=true (라우트가 x-blockpilot-note 헤더로 알린다)
 * - 설정(config/)은 고를 때만, 비밀처럼 보이는 파일(이름이나 내용에 토큰·비밀번호·웹훅 등)·큰 파일은 빼고. 뺀 파일은 README.txt 에 적는다
 * - world/·logs/·백업은 절대 넣지 않는다
 */

const CONFIG_MAX_BYTES = 1024 * 1024;
const SECRET_RE = /token|secret|webhook|password/i;
/** 설정 파일 내용에서 비밀처럼 보이는 것: 키=값, 디스코드 웹훅·봇 토큰, DB 접속 문자열 */
const SECRET_CONTENT_RES = [
  // 값은 6자 이상 (JSON·TOML 의 , ; { } [ ] 는 값에 넣지 않아 "token": false, 같은 설정은 걸리지 않게)
  /(token|secret|password|passwd|webhook|api[_-]?key)["']?\s*[=:]\s*["']?[^\s"',;{}[\]]{6,}/i,
  /discord(app)?\.com\/api\/webhooks\//i,
  /[MN][\w-]{23,}\.[\w-]{6}\.[\w-]{27,}/,
  /jdbc:/i,
];

/** 설정 파일 내용에 비밀처럼 보이는 것이 있는지 */
export function looksSecret(text: string): boolean {
  return SECRET_CONTENT_RES.some((re) => re.test(text));
}
/** config/ 를 훑을 때 넘지 않을 항목 수 (이상한 폴더에서 끝없이 돌지 않게) */
const CONFIG_MAX_ENTRIES = 5000;

export interface MrpackExportResult {
  stream: NodeJS.ReadableStream;
  fileName: string;
  stats: { modrinth: number; bundled: number; serverOnly: number };
  /** Modrinth 에 연결하지 못해 전부 직접 넣었음 */
  offline: boolean;
  /** 팩의 versionId (YYYY.MM.DD-HHmm) — ASCII 파일 이름에 쓴다 */
  versionId: string;
  /** 비밀이 들어 있는 것 같아 뺀 설정 파일 (config/ 기준 경로) */
  excluded: string[];
}

type EnvValue = "required" | "optional" | "unsupported";
const envValue = (s: string | undefined): EnvValue => (s === "optional" || s === "unsupported" ? s : "required");

const pad = (n: number) => String(n).padStart(2, "0");
/** YYYY.MM.DD-HHmm (현지 시각) */
export function exportVersionId(d = new Date()) {
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 프로젝트 id → 클라이언트/서버 필요 여부. 실패하면 빈 맵 (모르면 required 로 둔다) */
async function projectSides(ids: string[]): Promise<Map<string, MrProject>> {
  return projectsByIds(ids).catch(() => new Map<string, MrProject>());
}

/**
 * config/ 아래 넣을 파일 (상대 경로, / 구분). 링크·큰 파일은 빼고,
 * 이름이나 내용이 비밀처럼 보이는 파일은 excluded 로 (README 에 적는다)
 */
async function configFiles(dir: string): Promise<{ files: string[]; excluded: string[] }> {
  const root = path.join(dir, "config");
  const files: string[] = [];
  const excluded: string[] = [];
  let seen = 0;
  const walk = async (rel: string) => {
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > CONFIG_MAX_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SECRET_RE.test(e.name)) {
        excluded.push(e.isDirectory() ? `${r}/` : r);
        continue;
      }
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        const full = path.join(root, r);
        const st = await fs.lstat(full).catch(() => null);
        if (!st?.isFile() || st.size > CONFIG_MAX_BYTES) continue;
        const text = await fs.readFile(full, "utf8").catch(() => null);
        if (text === null) continue;
        if (looksSecret(text)) excluded.push(r);
        else files.push(r);
      }
    }
  };
  await walk("");
  return { files, excluded };
}

const LOADER_LABEL = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" } as const;

export async function buildMrpack(opts: { dir: string; name: string; includeConfig?: boolean }): Promise<MrpackExportResult> {
  const { dir, includeConfig = false } = opts;
  const info = await detectServer(dir);
  const loader = info.loader;
  if (loader !== "fabric" && loader !== "forge" && loader !== "neoforge") throw badRequest("모드팩으로 내보낼 수 있는 서버는 Fabric·Forge·NeoForge 뿐이에요.");
  const mc = info.mcVersion;
  // Forge 는 "{mc}-{forge}" 로 적혀 있다. .mrpack 은 forge 부분만
  const loaderVersion = loader === "forge" && mc && info.loaderVersion?.startsWith(`${mc}-`) ? info.loaderVersion.slice(mc.length + 1) : info.loaderVersion;
  if (!mc || !loaderVersion) throw badRequest("서버 폴더에서 Minecraft·로더 버전을 알아내지 못했어요. 서버를 한 번 켠 뒤 다시 시도해 주세요.");

  const modsDir = path.join(dir, "mods");
  const mods = (await listMods(dir, mc, loader)).filter((m) => m.enabled);
  // 하나씩 (모드가 수백 개여도 파일을 한꺼번에 열지 않게)
  const jars: { mod: (typeof mods)[number]; full: string; sha1: string; sha512: string; size: number }[] = [];
  for (const m of mods) {
    const full = path.join(modsDir, m.file);
    const [sha1, sha512, st] = await Promise.all([hashFile(full, "sha1"), hashFile(full, "sha512"), fs.stat(full)]);
    jars.push({ mod: m, full, sha1, sha512, size: st.size });
  }

  let offline = false;
  let known: Record<string, MrVersion> = {};
  if (jars.length) {
    try {
      known = await versionsBySha1(jars.map((j) => j.sha1));
    } catch {
      offline = true;
      known = {};
    }
  }
  const sides = offline ? new Map<string, MrProject>() : await projectSides([...new Set(Object.values(known).map((v) => v.project_id))]);

  const files: MrpackFile[] = [];
  const bundled: { full: string; entry: string }[] = [];
  let serverOnly = 0;
  for (const j of jars) {
    const v = known[j.sha1];
    const url = v?.files?.find((f) => f.hashes?.sha1 === j.sha1)?.url;
    if (v && url) {
      const p = sides.get(v.project_id);
      files.push({
        path: `mods/${j.mod.file}`,
        hashes: { sha1: j.sha1, sha512: j.sha512 },
        env: { client: envValue(p?.client_side), server: envValue(p?.server_side) },
        downloads: [url],
        fileSize: j.size,
      });
      continue;
    }
    const env = j.mod.environment;
    const folder = env === "server" ? "server-overrides" : env === "client" ? "client-overrides" : "overrides";
    if (env === "server") serverOnly++;
    bundled.push({ full: j.full, entry: `${folder}/mods/${j.mod.file}` });
  }

  const versionId = exportVersionId();
  const index = MrpackIndex.parse({
    formatVersion: 1,
    game: "minecraft",
    versionId,
    name: opts.name || "BlockPilot 서버",
    summary: `BlockPilot 에서 내보낸 서버 모드 구성이에요 (Minecraft ${mc}, ${LOADER_LABEL[loader]} ${loaderVersion}).`,
    files,
    dependencies: { minecraft: mc, [loader === "fabric" ? "fabric-loader" : loader]: loaderVersion },
  });

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(index, null, 2), "utf8"), "modrinth.index.json");
  for (const b of bundled) zip.addFile(b.full, b.entry);
  let excluded: string[] = [];
  if (includeConfig) {
    const cfg = await configFiles(dir);
    excluded = cfg.excluded;
    for (const rel of cfg.files) zip.addFile(path.join(dir, "config", ...rel.split("/")), `overrides/config/${rel}`);
  }
  const readme = [
    `${index.name} 모드팩 (Minecraft ${mc}, ${LOADER_LABEL[loader]})`,
    `Modrinth App 이나 Prism Launcher 에서 "파일에서 추가"(Import from file)로 이 .mrpack 파일을 고르면 같은 모드 구성이 설치돼요.`,
    `설치한 뒤 그 프로필로 게임을 켜서 서버에 접속하면 돼요.`,
    ...(excluded.length
      ? ["", `토큰·비밀번호·웹훅 같은 비밀이 들어 있는 것 같아 넣지 않은 설정 파일 (${excluded.length}개):`, ...excluded.map((r) => `  - config/${r}`), "필요하면 서버 주인에게 따로 받아 주세요."]
      : []),
  ].join("\n");
  zip.addBuffer(Buffer.from(readme + "\n", "utf8"), "README.txt");
  zip.end();

  const safe = index.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "modpack";
  return {
    stream: zip.outputStream,
    fileName: `${safe}-${versionId}.mrpack`,
    stats: { modrinth: files.length, bundled: bundled.length, serverOnly },
    offline,
    versionId,
    excluded,
  };
}
