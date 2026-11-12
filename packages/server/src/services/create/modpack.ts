import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { CREATE_LOADER_LABEL, MrpackIndex, displayLoaderVersion, type CreateModpackRef, type CreateServerInput, type ModpackLoader, type ModpackMarker, type ModpackSummary, type MrpackFile } from "@blockpilot/shared";
import { extractZipPrefixTo, forEachZipEntry, listZipEntries, readZipEntries, readZipEntriesFromBuffer, type ExtractAction, type ZipEntryInfo } from "../../lib/zip.js";
import { versionAtLeast } from "../../lib/version.js";
import { parseProperties, serializeProperties, toRecord, writePropertiesChanges } from "../properties.js";
import { projectsByIds, versionsByIds, versionsBySha1 } from "../modrinthModpack.js";
import type { MrVersion } from "../modrinth.js";
import { downloadFile } from "./download.js";
import { CreateError, toCreateError } from "./errors.js";
import { FORGE_MIN_MC } from "./loaders/forge.js";
import { NEOFORGE_MIN_MC } from "./loaders/neoforge.js";
import type { LoaderProvider } from "./loaders/types.js";
import type { CreateJob } from "./job.js";

/**
 * Modrinth 모드팩(.mrpack) 읽기·검사·설치.
 * .mrpack 은 zip 이다: modrinth.index.json(받을 파일 목록과 sha512) + overrides/ · server-overrides/ · client-overrides/ 폴더.
 * - 받을 파일은 허용한 주소(Modrinth CDN·GitHub·GitLab)에서만, sha512 가 맞을 때만 서버 폴더에 둔다 (넘겨지는 주소도 확인)
 * - 경로는 서버 폴더 밖을 가리킬 수 없고, zip 안의 심볼릭 링크는 풀지 않는다
 * - 서버에 필요 없는 것(클라이언트 전용 모드·리소스팩·셰이더·게임 옵션)과 client-overrides/ 는 넣지 않는다.
 *   클라이언트 전용 판별은 팩 표시(env) + Modrinth 의 버전 환경 + 팩에 든 jar 의 모드 정보로, 검사할 때 한 번만 하고
 *   그 결정(ModpackPlan)을 보관해 두었다가 만들 때 그대로 쓴다 (만들 때 Modrinth 에 다시 묻지 않음)
 * - 서버 보안·실행 파일(eula.txt·ops.json·시작 스크립트·libraries/ 등)은 팩 것을 쓰지 않고,
 *   팩의 server.properties 는 위험한 값(online-mode·rcon 등)을 뺀 뒤 합친다
 */

const MB = 1024 * 1024;
const INDEX_NAME = "modrinth.index.json";
const MAX_INDEX_BYTES = 10 * MB;
const MAX_INDEX_FILES = 5000;
/** 압축 폭탄 대비: 항목 수·풀었을 때 크기 상한 */
const MAX_ZIP_ENTRIES = 20_000;
const MAX_UNCOMPRESSED_BYTES = 2048 * MB;
const DOWNLOAD_WORKERS = 4;
/** 팩에 든 jar 의 모드 정보를 읽을 크기 상한 (더 크면 읽지 않고 그대로 둔다) */
const JAR_SCAN_MAX_BYTES = 64 * MB;
/** index 의 fileSize 보다 이만큼 더 오면 멈춘다 */
const DOWNLOAD_SLACK_BYTES = 64 * 1024;
/** Windows 에서 서버 폴더 경로와 합쳐도 260자를 넘지 않게 */
const MAX_REL_PATH = 200;
export const MODPACK_MARKER = ".blockpilot-modpack.json";
const OVERRIDE_PREFIXES = ["overrides/", "server-overrides/"] as const;
type OverridePrefix = (typeof OVERRIDE_PREFIXES)[number];

// ---------- 허용 주소 ----------

/** Modrinth 스펙이 허용하는 배포 주소 (https 만) */
export const MODPACK_ALLOWED_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];
/** GitHub 이 실제 파일을 내주는 곳 (github.com 의 릴리스 주소가 여기로 넘겨진다) */
const GITHUB_ASSET_HOSTS = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const GITHUB_HOSTS = ["github.com", "raw.githubusercontent.com", ...GITHUB_ASSET_HOSTS];

/** 테스트용 추가 주소 (BLOCKPILOT_MODPACK_EXTRA_HOSTS=127.0.0.1:1234,…). 이 주소들만 http 도 허용 */
function extraHosts(): string[] {
  return (process.env.BLOCKPILOT_MODPACK_EXTRA_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function allowedHosts(): string[] {
  return [...MODPACK_ALLOWED_HOSTS, ...extraHosts()];
}

const parseUrl = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

export function isAllowedDownload(url: string): boolean {
  const u = parseUrl(url);
  if (!u || u.username || u.password) return false;
  if (u.protocol === "https:" && !u.port && MODPACK_ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return true;
  return (u.protocol === "https:" || u.protocol === "http:") && extraHosts().includes(u.host.toLowerCase());
}

/** 받는 중에 넘겨지는(리다이렉트) 주소 확인: 허용 주소이거나, GitHub 에서 GitHub 파일 저장소로 넘어가는 경우만 */
export function isAllowedRedirect(next: string, from: string): boolean {
  if (isAllowedDownload(next)) return true;
  const u = parseUrl(next);
  const f = parseUrl(from);
  if (!u || !f || u.username || u.password || u.protocol !== "https:" || u.port) return false;
  return GITHUB_HOSTS.includes(f.hostname.toLowerCase()) && GITHUB_ASSET_HOSTS.includes(u.hostname.toLowerCase());
}

const hostOf = (url: string) => parseUrl(url)?.host ?? url;

// ---------- 경로 검사 ----------

const unsafePath = (rel: string, why: string) =>
  new CreateError("modpack_invalid", "모드팩 안에 안전하지 않은 파일 경로가 있어요.", "이 팩은 서버 폴더 밖이나 이상한 위치에 파일을 쓰려고 해요. 다른 팩을 고르거나 팩 제작자에게 알려 주세요.", `${why}: ${JSON.stringify(rel)}`);

/** Windows 가 장치 이름으로 쓰는 이름 (확장자가 붙어도 파일을 만들 수 없다) */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 서버 폴더 밖·절대 경로·이상한 조각만 막는 기본 검사 (쓰지 않고 건너뛸 항목에도 한다) */
function checkRelPathBasic(rel: string): void {
  if (!rel) throw unsafePath(rel, "빈 경로");
  if (rel.includes("\\")) throw unsafePath(rel, "역슬래시");
  if (/[\x00-\x1f\x7f]/.test(rel)) throw unsafePath(rel, "제어 문자");
  if (rel.startsWith("/")) throw unsafePath(rel, "절대 경로");
  if (/^[a-zA-Z]:/.test(rel)) throw unsafePath(rel, "드라이브 문자");
  // Windows 에서 ':' 는 대체 데이터 스트림(ADS) 이 된다
  if (rel.includes(":")) throw unsafePath(rel, "콜론");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw unsafePath(rel, "빈 칸·'.'·'..' 경로 조각");
  }
}

/** 팩 안의 상대 경로(POSIX "/" 구분)가 어느 OS 에서든 안전하게 쓸 수 있는지. 아니면 modpack_invalid */
export function checkRelPath(rel: string): void {
  checkRelPathBasic(rel);
  for (const seg of rel.split("/")) {
    if (WINDOWS_RESERVED.test(seg)) throw unsafePath(rel, `Windows 에서 쓸 수 없는 이름 '${seg}'`);
    if (/[. ]$/.test(seg)) throw unsafePath(rel, `'.' 이나 빈칸으로 끝나는 이름 '${seg}' (Windows 에서 다른 파일이 돼요)`);
  }
  if (rel.length > MAX_REL_PATH) {
    throw new CreateError(
      "modpack_invalid",
      "모드팩 안에 경로가 너무 긴 파일이 있어요.",
      `Windows 에서 문제가 생기지 않게 서버 폴더 안 경로는 ${MAX_REL_PATH}자까지만 받아요. 팩 제작자에게 알려 주세요.`,
      `${rel.length}자: ${rel}`,
    );
  }
}

/** target 아래의 절대 경로. 팩의 경로가 위험하거나 target 밖을 가리키면 modpack_invalid */
export function safeRelPath(target: string, rel: string): string {
  checkRelPath(rel);
  const root = path.resolve(target);
  const abs = path.resolve(root, ...rel.split("/"));
  if (abs === root || !abs.startsWith(root + path.sep)) throw unsafePath(rel, "서버 폴더 밖");
  return abs;
}

// ---------- 넣지 않을 파일 (경로로 정해지는 것) ----------

export type SkipKind = "client" | "nonserver" | "host-optional" | "protected";
export type SkipSource = "index" | "overrides" | "server-overrides";

export interface SkippedFile {
  /** 서버 폴더 기준 경로 */
  path: string;
  /** 화면·마커에 보여 줄 이유 */
  reason: string;
  /** client: 클라이언트 전용 모드, nonserver: 리소스팩·셰이더·옵션처럼 서버가 안 쓰는 것, host-optional: 허용되지 않은 주소의 선택 파일, protected: 서버 보안·실행 파일 */
  kind: SkipKind;
  from: SkipSource;
}

const NONSERVER_DIRS: Record<string, string> = { resourcepacks: "리소스팩", shaderpacks: "셰이더팩", screenshots: "스크린샷" };
const NONSERVER_FILES: Record<string, string> = { "options.txt": "게임 옵션", "optionsof.txt": "OptiFine 옵션", "optionsshaders.txt": "셰이더 옵션", "servers.dat": "멀티플레이 서버 목록" };
const PROTECTED_FILES = new Set(["eula.txt", "ops.json", "whitelist.json", "banned-players.json", "banned-ips.json", "usercache.json", "user_jvm_args.txt"]);
const PROTECTED_DIRS = new Set(["libraries", "versions"]);
const PROTECTED_REASON = "서버 보안·실행 파일이라 팩 것을 쓰지 않음";

/** 경로만 보고 정하는 건너뛰기 (index 파일과 overrides 항목 모두). 폴더는 끝의 / 없이 */
export function pathSkip(rel: string): { kind: SkipKind; reason: string } | null {
  const segs = rel.split("/");
  const top = segs[0].toLowerCase();
  if (segs.some((s) => s.toLowerCase().startsWith(".blockpilot"))) return { kind: "protected", reason: PROTECTED_REASON };
  if (segs.length === 1 && (PROTECTED_FILES.has(top) || /^(start|run)(\..*)?$/.test(top) || top.endsWith(".jar"))) return { kind: "protected", reason: PROTECTED_REASON };
  if (PROTECTED_DIRS.has(top)) return { kind: "protected", reason: PROTECTED_REASON };
  if (NONSERVER_DIRS[top]) return { kind: "nonserver", reason: `${NONSERVER_DIRS[top]} (서버에 필요 없음)` };
  if (segs.length === 1 && NONSERVER_FILES[top]) return { kind: "nonserver", reason: `${NONSERVER_FILES[top]} 파일 (서버에 필요 없음)` };
  return null;
}

const isRootProps = (rel: string) => rel.toLowerCase() === "server.properties";

// ---------- server.properties ----------

/** 팩이 바꾸면 안 되는 키: 정품 인증·원격 관리·외부 노출 */
export function isDangerousProperty(key: string): boolean {
  const k = key.toLowerCase();
  return ["online-mode", "enable-rcon", "enable-query", "query.port", "server-ip", "enable-jmx-monitoring"].includes(k) || k.startsWith("rcon.") || k.startsWith("management-server-");
}

/** 팩의 server.properties 에서 위험한 키(와 서버 폴더 밖을 가리키는 level-name)를 뺀다 */
export function sanitizePackProperties(text: string): { record: Record<string, string>; text: string; dropped: string[] } {
  const dropped: string[] = [];
  const lines = parseProperties(text.replace(/^﻿/, "")).filter((l) => {
    if (l.kind !== "entry") return true;
    let bad = isDangerousProperty(l.key);
    if (!bad && l.key === "level-name" && l.value) {
      try {
        checkRelPath(l.value);
        bad = !!pathSkip(l.value);
      } catch {
        bad = true;
      }
    }
    if (bad) dropped.push(l.key);
    return !bad;
  });
  return { record: toRecord(lines), text: serializeProperties(lines), dropped: [...new Set(dropped)] };
}

const droppedWarning = (keys: string[]) => `팩 설정에서 안전하지 않은 값(${keys.slice(0, 3).join(", ")}${keys.length > 3 ? " 등" : ""})은 빼고 넣었어요.`;

// ---------- index 읽기 ----------

const invalidPack = (detail?: string) =>
  new CreateError("modpack_invalid", `모드팩 안의 ${INDEX_NAME} 을 읽지 못했어요.`, "Modrinth 형식(.mrpack) 파일인지 확인해 주세요. CurseForge 팩(.zip)은 지원하지 않아요.", detail);

const tooBig = (detail: string) =>
  new CreateError("modpack_invalid", "모드팩 압축 파일이 비정상적으로 커요.", "압축을 풀면 너무 크거나 파일이 너무 많은 팩은 받지 않아요. 다른 팩을 골라 주세요.", detail);

interface Scanned {
  index: MrpackIndex;
  entries: ZipEntryInfo[];
}

/** zip 목록 확인(압축 폭탄·같은 이름 항목·CurseForge 판별) 뒤 modrinth.index.json 만 읽는다 */
async function scan(file: string): Promise<Scanned> {
  let listing: Awaited<ReturnType<typeof listZipEntries>>;
  try {
    listing = await listZipEntries(file, MAX_ZIP_ENTRIES);
  } catch (e) {
    throw invalidPack(`zip 을 열지 못했어요: ${(e as Error)?.message ?? e}`);
  }
  if (listing.entryCount > MAX_ZIP_ENTRIES) throw tooBig(`항목 ${listing.entryCount}개 (최대 ${MAX_ZIP_ENTRIES}개)`);
  const entries = listing.entries;
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > MAX_UNCOMPRESSED_BYTES) throw tooBig(`풀었을 때 ${Math.round(total / MB)}MB (최대 ${MAX_UNCOMPRESSED_BYTES / MB}MB)`);

  // 같은 이름(대소문자 무시) 항목이 두 번 있으면 어느 것을 읽을지 애매하다 (index 를 바꿔치기하는 수법)
  const names = new Set<string>();
  for (const e of entries) {
    const key = e.name.replace(/\/$/, "").toLowerCase();
    if (names.has(key)) throw new CreateError("modpack_invalid", "모드팩 압축 파일에 같은 이름의 항목이 두 번 들어 있어요.", "손상됐거나 변조된 팩일 수 있어요. 다른 팩을 골라 주세요.", e.name);
    names.add(key);
  }

  const idx = entries.find((e) => e.name === INDEX_NAME);
  if (!idx) {
    if (entries.some((e) => e.name === "manifest.json")) {
      throw new CreateError(
        "modpack_unsupported",
        "CurseForge 모드팩(.zip)은 아직 서버로 만들 수 없어요.",
        "Modrinth 에서 같은 팩의 .mrpack 파일을 찾아 주세요. 없다면 서버를 만든 뒤 모드 화면에서 모드를 하나씩 넣어 주세요.",
        "manifest.json 은 있지만 modrinth.index.json 이 없어요 (CurseForge 형식)",
      );
    }
    throw invalidPack(`${INDEX_NAME} 이 zip 안에 없어요`);
  }
  if (idx.size > MAX_INDEX_BYTES) throw invalidPack(`${INDEX_NAME} 이 너무 커요 (${Math.round(idx.size / MB)}MB)`);

  let raw: unknown;
  try {
    const buf = (await readZipEntries(file, [INDEX_NAME], { maxBytes: MAX_INDEX_BYTES })).get(INDEX_NAME);
    if (!buf) throw new Error("빈 항목");
    raw = JSON.parse(buf.toString("utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw invalidPack(`JSON 을 읽지 못했어요: ${(e as Error)?.message ?? e}`);
  }
  const fv = (raw as { formatVersion?: unknown })?.formatVersion;
  if (fv !== undefined && fv !== 1) {
    throw new CreateError("modpack_unsupported", `BlockPilot 이 아직 모르는 모드팩 형식이에요 (formatVersion ${String(fv)}).`, "BlockPilot 을 업데이트하거나, 같은 팩의 다른 버전을 골라 주세요.");
  }
  const parsed = MrpackIndex.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidPack(`${issue.path.join(".") || "(최상위)"}: ${issue.message}`);
  }
  if (parsed.data.files.length > MAX_INDEX_FILES) throw invalidPack(`파일 ${parsed.data.files.length}개 (최대 ${MAX_INDEX_FILES}개)`);
  return { index: parsed.data, entries };
}

/** .mrpack 에서 modrinth.index.json 만 읽어 검증한다 */
export async function readIndex(file: string): Promise<MrpackIndex> {
  return (await scan(file)).index;
}

// ---------- 로더 ----------

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** index.dependencies → BlockPilot 로더·Minecraft·로더 버전 (Forge 는 "{mc}-{forge}" 표기) */
export function resolveLoader(index: MrpackIndex): { loader: ModpackLoader; mc: string; loaderVersion: string } {
  const d = index.dependencies;
  const mc = d.minecraft;
  if (d["quilt-loader"]) {
    throw new CreateError("modpack_unsupported", "Quilt 로더 모드팩은 아직 서버로 만들 수 없어요.", "같은 모드들을 Fabric 용으로 모은 팩을 찾거나, Fabric 서버를 만든 뒤 모드 화면에서 하나씩 넣어 주세요.", `quilt-loader ${d["quilt-loader"]}`);
  }
  const keys = (["fabric-loader", "forge", "neoforge"] as const).filter((k) => d[k]);
  if (keys.length === 0) {
    throw new CreateError("modpack_unsupported", "모드 로더가 정해지지 않은 모드팩이에요.", "Fabric·Forge·NeoForge 모드팩만 서버로 만들 수 있어요. 다른 팩을 골라 주세요.");
  }
  if (keys.length > 1) {
    throw new CreateError("modpack_invalid", "모드팩에 모드 로더가 여러 개 적혀 있어요.", "로더가 하나인 팩만 서버로 만들 수 있어요. 팩 제작자에게 알려 주세요.", keys.map((k) => `${k} ${d[k]}`).join(", "));
  }
  if (!/^\d+(\.\d+){1,2}$/.test(mc)) {
    throw new CreateError("modpack_unsupported", `Minecraft ${mc} 는 정식 버전이 아니라 서버로 만들 수 없어요.`, "스냅샷·테스트 버전용 팩은 지원하지 않아요. 같은 팩의 정식 버전용을 골라 주세요.");
  }
  const key = keys[0];
  const raw = d[key]!;
  if (!SAFE_VERSION.test(raw) || raw.includes("..")) throw new CreateError("modpack_invalid", "모드팩의 로더 버전 표기가 올바르지 않아요.", "팩 제작자에게 알려 주세요.", `${key}: ${JSON.stringify(raw)}`);

  if (key === "fabric-loader") return { loader: "fabric", mc, loaderVersion: raw };
  if (key === "forge") {
    if (!versionAtLeast(mc, FORGE_MIN_MC)) {
      throw new CreateError("modpack_unsupported", `Forge 모드팩은 Minecraft ${FORGE_MIN_MC} 이상만 서버로 만들 수 있어요 (이 팩은 ${mc}).`, `${FORGE_MIN_MC} 보다 오래된 Forge 는 설치 방식과 필요한 Java 가 달라 아직 지원하지 않아요. 같은 팩의 더 새 버전을 골라 주세요.`);
    }
    return { loader: "forge", mc, loaderVersion: raw.startsWith(`${mc}-`) ? raw : `${mc}-${raw}` };
  }
  if (!versionAtLeast(mc, NEOFORGE_MIN_MC)) {
    throw new CreateError("modpack_unsupported", `NeoForge 모드팩은 Minecraft ${NEOFORGE_MIN_MC} 이상만 서버로 만들 수 있어요 (이 팩은 ${mc}).`, "1.20.1 용 NeoForge 는 Forge 와 같은 옛 방식이라 지원하지 않아요. 같은 팩의 더 새 버전을 골라 주세요.");
  }
  return { loader: "neoforge", mc, loaderVersion: raw };
}

// ---------- 클라이언트 전용 판별 (검사 때 한 번, 결과를 보관) ----------

/**
 * 검사 때 정한 "넣지 않을 것" 중 네트워크·jar 내용으로 정한 부분. 보관소(StoredUpload)에 같이 두고 만들 때 그대로 쓴다.
 * 경로 규칙(pathSkip)·팩 표시(env)·허용 주소는 언제든 같은 결과라 다시 계산한다.
 */
export interface ModpackPlan {
  /** index 파일 경로 → 이유 (Modrinth 가 클라이언트 전용이라고 한 것) */
  clientFiles: Record<string, string>;
  /** overrides 의 zip 항목 이름 → 이유 (Modrinth 나 jar 의 모드 정보가 클라이언트 전용이라고 한 것) */
  clientEntries: Record<string, string>;
  /** Modrinth 에 연결하지 못해 Modrinth 기준 판별을 못 함 */
  envUnchecked: boolean;
}

export const emptyPlan = (): ModpackPlan => ({ clientFiles: {}, clientEntries: {}, envUnchecked: false });

/** 서버에서 돌지 않는 Modrinth 버전 환경 */
const CLIENT_ENVS: Record<string, string> = { client_only: "클라이언트 전용 (Modrinth)", singleplayer_only: "싱글플레이 전용 (Modrinth)" };
const CDN_VERSION_RE = /^https:\/\/cdn\.modrinth\.com\/data\/([A-Za-z0-9]{8})\/versions\/([A-Za-z0-9]{8})\//;
const BUNDLED_JAR_RE = /^mods\/[^/]+\.jar$/i;

/** Modrinth CDN 주소에서 버전 id */
export function cdnVersionId(urls: string[]): string | undefined {
  for (const u of urls) {
    const m = CDN_VERSION_RE.exec(u);
    if (m) return m[2];
  }
  return undefined;
}

/**
 * Forge·NeoForge mods.toml 이 클라이언트 전용인지. 보수적으로: 모든 [[mods]] 의 minecraft/forge/neoforge 의존성이
 * 하나 이상 있고 전부 side="CLIENT" 일 때만 true. 조금이라도 애매하면 false (넣는다)
 */
export function modsTomlClientOnly(toml: string): boolean {
  const blocks: { header: string; body: string[] }[] = [];
  let cur: { header: string; body: string[] } | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (h) {
      cur = { header: h[1].replace(/["']/g, ""), body: [] };
      blocks.push(cur);
    } else if (cur) cur.body.push(line);
  }
  const value = (b: { body: string[] }, key: string) => {
    for (const l of b.body) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`).exec(l);
      if (m) return m[1];
    }
    return undefined;
  };
  const mods = blocks.filter((b) => b.header === "mods");
  if (!mods.length) return false;
  for (const m of mods) {
    const id = value(m, "modId");
    if (!id) return false;
    const core = blocks.filter((b) => b.header === `dependencies.${id}` && ["minecraft", "forge", "neoforge"].includes((value(b, "modId") ?? "").toLowerCase()));
    if (!core.length || !core.every((b) => (value(b, "side") ?? "").toUpperCase() === "CLIENT")) return false;
  }
  return true;
}

/** jar 의 모드 정보가 클라이언트 전용이라고 하는지 (fabric.mod.json environment=client, mods.toml 전부 side=CLIENT) */
export async function jarClientOnly(jar: Buffer): Promise<boolean> {
  let meta: Map<string, Buffer>;
  try {
    meta = await readZipEntriesFromBuffer(jar, ["fabric.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"], { maxBytes: 4 * MB });
  } catch {
    return false;
  }
  const fabric = meta.get("fabric.mod.json");
  if (fabric) {
    try {
      return (JSON.parse(fabric.toString("utf8").replace(/^﻿/, "")) as { environment?: unknown })?.environment === "client";
    } catch {
      return false;
    }
  }
  const toml = meta.get("META-INF/neoforge.mods.toml") ?? meta.get("META-INF/mods.toml");
  return toml ? modsTomlClientOnly(toml.toString("utf8")) : false;
}

const isAbort = (e: unknown, signal?: AbortSignal) => !!signal?.aborted || (e as { name?: string })?.name === "AbortError";

/**
 * 클라이언트 전용 판별.
 * 1) index 파일: Modrinth CDN 주소의 버전 id 로 /versions 를 한꺼번에 묻고 environment 가 client_only·singleplayer_only 면 뺀다
 *    (environment 가 없는 옛 응답이면 /projects 의 server_side = unsupported 로)
 * 2) 팩에 든 jar(overrides/mods·server-overrides/mods): sha1 로 /version_files 에 묻고 같은 규칙 + jar 의 모드 정보
 * Modrinth 에 연결하지 못하면 실패하지 않고 envUnchecked (jar 의 모드 정보로는 그래도 거른다)
 */
async function buildPlan(file: string, index: MrpackIndex, entries: ZipEntryInfo[], opts: { network: boolean; signal?: AbortSignal }): Promise<ModpackPlan> {
  const plan = emptyPlan();

  // index 의 후보: 경로 규칙·팩 표시로 이미 빠지지 않는 것
  const candidates: { path: string; vid: string }[] = [];
  for (const f of index.files) {
    if (pathSkip(f.path) || isRootProps(f.path) || f.env?.server === "unsupported") continue;
    const vid = cdnVersionId(f.downloads);
    if (vid) candidates.push({ path: f.path, vid });
  }

  // 팩에 든 jar: 하나씩 읽어 sha1 과 모드 정보
  const jarNames = new Set<string>();
  for (const e of entries) {
    if (e.dir || e.symlink) continue;
    const prefix = OVERRIDE_PREFIXES.find((p) => e.name.startsWith(p));
    if (!prefix) continue;
    const rel = e.name.slice(prefix.length);
    if (BUNDLED_JAR_RE.test(rel) && e.size <= JAR_SCAN_MAX_BYTES) jarNames.add(e.name);
  }
  const jarSha1 = new Map<string, string>();
  if (jarNames.size) {
    try {
      await forEachZipEntry(
        file,
        (name, size) => jarNames.has(name) && size <= JAR_SCAN_MAX_BYTES,
        async (name, data) => {
          if (opts.signal?.aborted) throw new CreateError("cancelled", "검사를 멈췄어요.");
          jarSha1.set(name, createHash("sha1").update(data).digest("hex"));
          if (await jarClientOnly(data)) plan.clientEntries[name] = "클라이언트 전용 (모드 정보)";
        },
      );
    } catch (e) {
      if (e instanceof CreateError) throw e;
      throw new CreateError("modpack_invalid", "모드팩 안의 모드 파일을 읽지 못했어요.", "팩 파일이 손상됐을 수 있어요. 다시 받아 보거나 다른 팩을 골라 주세요.", (e as Error)?.message ?? String(e));
    }
  }

  if (!opts.network || (!candidates.length && !jarSha1.size)) return plan;
  try {
    const byId = candidates.length ? await versionsByIds(candidates.map((c) => c.vid), opts.signal) : new Map<string, MrVersion>();
    const toAsk = [...jarSha1].filter(([name]) => !plan.clientEntries[name]);
    const byHash = toAsk.length ? await versionsBySha1(toAsk.map(([, h]) => h), opts.signal) : {};
    // environment 가 없는 버전은 프로젝트의 server_side 로
    const found: MrVersion[] = [...byId.values(), ...Object.values(byHash)];
    const noEnv = [...new Set(found.filter((v) => typeof v?.environment !== "string" && v?.project_id).map((v) => v.project_id))];
    const projects = noEnv.length ? await projectsByIds(noEnv, opts.signal) : new Map();
    const reasonOf = (v: MrVersion | undefined): string | undefined => {
      if (!v) return undefined;
      if (typeof v.environment === "string") return CLIENT_ENVS[v.environment];
      return projects.get(v.project_id)?.server_side === "unsupported" ? "클라이언트 전용 (Modrinth)" : undefined;
    };
    for (const c of candidates) {
      const why = reasonOf(byId.get(c.vid));
      if (why) plan.clientFiles[c.path] = why;
    }
    for (const [name, h] of toAsk) {
      const why = reasonOf(byHash[h]);
      if (why) plan.clientEntries[name] = why;
    }
  } catch (e) {
    if (isAbort(e, opts.signal)) throw new CreateError("cancelled", "검사를 멈췄어요.");
    // 판별을 못 했을 뿐 팩은 만들 수 있다. 팩 표시·jar 정보 기준으로만 거른다 (위의 결과 반영은 모든 요청이 끝난 뒤라 섞이지 않음)
    plan.envUnchecked = true;
  }
  return plan;
}

// ---------- 받을 파일·풀 항목 고르기 ----------

export interface ServerFileSelection {
  /** 받을 파일과 고른 주소 */
  files: { file: MrpackFile; url: string }[];
  /** 받지 않는 파일과 이유 */
  skipped: SkippedFile[];
  /** 서버에 꼭 필요한데 허용 주소가 없어 받을 수 없는 파일 */
  blocked: { path: string; host: string }[];
}

/** index 의 파일 중 서버에 받을 것. plan 이 있으면 검사 때 정한 클라이언트 전용 판별도 따른다 */
export function selectServerFiles(index: MrpackIndex, plan?: ModpackPlan): ServerFileSelection {
  const out: ServerFileSelection = { files: [], skipped: [], blocked: [] };
  const skip = (p: string, kind: SkipKind, reason: string) => out.skipped.push({ path: p, reason, kind, from: "index" });
  for (const file of index.files) {
    const byPath = pathSkip(file.path);
    if (byPath) {
      skip(file.path, byPath.kind, byPath.reason);
      continue;
    }
    // 팩 index 의 server.properties 는 내용을 거를 수 없어 넣지 않는다 (overrides 의 것은 걸러서 합침)
    if (isRootProps(file.path)) {
      skip(file.path, "protected", PROTECTED_REASON);
      continue;
    }
    if (file.env?.server === "unsupported") {
      skip(file.path, "client", "클라이언트 전용 (팩 표시)");
      continue;
    }
    const decided = plan?.clientFiles[file.path];
    if (decided) {
      skip(file.path, "client", decided);
      continue;
    }
    const url = file.downloads.find(isAllowedDownload);
    if (url) {
      out.files.push({ file, url });
      continue;
    }
    const host = hostOf(file.downloads[0] ?? "");
    if (file.env?.server === "optional") skip(file.path, "host-optional", `허용되지 않은 주소 (${host})`);
    else out.blocked.push({ path: file.path, host });
  }
  return out;
}

/** 서버에 꼭 필요한 파일을 받을 수 없으면 modpack_blocked_host */
export function assertNoBlocked(sel: ServerFileSelection): void {
  if (!sel.blocked.length) return;
  throw new CreateError(
    "modpack_blocked_host",
    `서버에 꼭 필요한 파일 ${sel.blocked.length}개가 허용되지 않은 주소에 있어 받을 수 없어요.`,
    "이 모드는 서버에 꼭 필요해서 건너뛸 수 없어요. 팩 제작자에게 Modrinth 에 올린 버전을 요청하거나, 서버를 만든 뒤 모드 화면에서 직접 넣어 주세요.",
    sel.blocked.map((b) => `${b.path} (${b.host})`).join("\n"),
  );
}

const overrideSource = (prefix: OverridePrefix): SkipSource => (prefix === "overrides/" ? "overrides" : "server-overrides");

/** overrides 항목(prefix 를 뗀 경로)을 어떻게 할지: server.properties 는 걸러서 합치려고 capture */
function overrideAction(rel: string, entryName: string, plan: ModpackPlan | undefined): { action: ExtractAction; kind?: SkipKind; reason?: string } {
  const byPath = pathSkip(rel);
  if (byPath) return { action: "skip", ...byPath };
  if (isRootProps(rel)) return { action: "capture" };
  const decided = plan?.clientEntries[entryName];
  if (decided) return { action: "skip", kind: "client", reason: decided };
  return { action: "write" };
}

interface OverridePlan {
  /** 풀 파일 (server.properties 포함) */
  kept: { entry: ZipEntryInfo; prefix: OverridePrefix; rel: string }[];
  skipped: SkippedFile[];
  /** server.properties 항목 이름 (overrides → server-overrides 순) */
  props: string[];
}

function planOverrides(entries: ZipEntryInfo[], plan: ModpackPlan | undefined): OverridePlan {
  const out: OverridePlan = { kept: [], skipped: [], props: [] };
  for (const prefix of OVERRIDE_PREFIXES) {
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue;
      const rel = e.name.slice(prefix.length).replace(/\/$/, "");
      if (!rel) continue;
      if (e.symlink) throw new CreateError("modpack_invalid", "모드팩 안에 심볼릭 링크가 있어요.", "링크는 서버 폴더 밖을 가리킬 수 있어 풀지 않아요. 다른 팩을 골라 주세요.", e.name);
      checkRelPathBasic(rel);
      const a = overrideAction(rel, e.name, plan);
      if (a.action === "skip") {
        if (!e.dir) out.skipped.push({ path: rel, reason: a.reason!, kind: a.kind!, from: overrideSource(prefix) });
        continue;
      }
      checkRelPath(rel);
      if (e.dir) continue;
      if (a.action === "capture") out.props.push(e.name);
      out.kept.push({ entry: e, prefix, rel });
    }
  }
  return out;
}

/** 마커·화면용: 폴더째 빠지는 것(셰이더팩 파일 수백 개 등)은 폴더 하나로 묶는다 */
export function summarizeSkipped(skipped: SkippedFile[]): { path: string; reason: string }[] {
  const out: { path: string; reason: string; count?: number }[] = [];
  const groups = new Map<string, { path: string; reason: string; count: number }>();
  for (const s of skipped) {
    const segs = s.path.split("/");
    if (s.kind === "nonserver" && segs.length > 1) {
      const key = `${segs[0].toLowerCase()}|${s.reason}`;
      const g = groups.get(key);
      if (g) g.count++;
      else {
        const ng = { path: `${segs[0]}/`, reason: s.reason, count: 1 };
        groups.set(key, ng);
        out.push(ng);
      }
      continue;
    }
    out.push({ path: s.path, reason: s.from === "index" ? s.reason : `${s.reason} · 팩에 들어 있던 파일` });
  }
  return out.map((o) => (o.count === undefined ? { path: o.path, reason: o.reason } : { path: o.path, reason: `${o.reason} · 파일 ${o.count}개` }));
}

// ---------- 검사 ----------

/** 팩 크기로 계산한 최대 메모리 추천값 (MB). 이 컴퓨터 메모리의 75% 로 자르기 전 */
export function idealMaxMb(serverModCount: number, totalBytes: number): number {
  let mb = serverModCount >= 200 ? 8192 : serverModCount >= 100 ? 6144 : serverModCount >= 40 ? 4096 : 3072;
  if (totalBytes > 1024 * MB) mb += 1024;
  return mb;
}

/** 팩 크기로 계산한 최대 메모리 추천값 (MB, 이 컴퓨터 메모리의 75% 이하, 2GB 이상) */
export function suggestMaxMb(serverModCount: number, totalBytes: number, totalMemMb: number): number {
  const cap = Math.floor((totalMemMb * 0.75) / 512) * 512;
  return Math.max(2048, Math.min(idealMaxMb(serverModCount, totalBytes), cap));
}

const listNames = (paths: string[], max = 5) => paths.slice(0, max).map((p) => path.posix.basename(p)).join(", ") + (paths.length > max ? ` 외 ${paths.length - max}개` : "");

export interface ModpackAnalysis {
  summary: ModpackSummary;
  plan: ModpackPlan;
}

export interface AnalyzeOptions {
  /** 검사 때 정해 둔 판별 (있으면 Modrinth 에 다시 묻지 않는다) */
  plan?: ModpackPlan;
  /** false 면 Modrinth 에 묻지 않는다 (팩 표시·jar 정보만) */
  network?: boolean;
  signal?: AbortSignal;
}

/** .mrpack 을 열어 서버로 만들 수 있는지 확인하고, 화면에 보여 줄 요약과 넣지 않을 것의 판별을 만든다 (아무것도 받지 않음) */
export async function analyzeMrpack(file: string, totalMemMb: number, opts: AnalyzeOptions = {}): Promise<ModpackAnalysis> {
  const { index, entries } = await scan(file);
  const { loader, mc, loaderVersion } = resolveLoader(index);

  const seen = new Set<string>();
  for (const f of index.files) {
    checkRelPathBasic(f.path);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new CreateError("modpack_invalid", "모드팩에 같은 경로의 파일이 두 번 들어 있어요.", "팩 제작자에게 알려 주세요.", f.path);
    seen.add(key);
  }
  // 심볼릭 링크·이상한 경로는 Modrinth 에 묻기 전에 거른다
  planOverrides(entries, undefined);

  const plan = opts.plan ?? (await buildPlan(file, index, entries, { network: opts.network !== false, signal: opts.signal }));
  const sel = selectServerFiles(index, plan);
  for (const f of sel.files) checkRelPath(f.file.path);
  const ov = planOverrides(entries, plan);

  // 팩의 server.properties 에 위험한 값이 있는지 (만들 때 빼고 합친다)
  let dropped: string[] = [];
  if (ov.props.length) {
    const bufs = await readZipEntries(file, ov.props, { maxBytes: 2 * MB }).catch(() => new Map<string, Buffer>());
    dropped = [...new Set([...bufs.values()].flatMap((b) => sanitizePackProperties(b.toString("utf8")).dropped))];
  }

  const totalBytes = sel.files.reduce((n, f) => n + f.file.fileSize, 0);
  const modKeys = new Set<string>();
  for (const f of sel.files) if (/^mods\/[^/]+\.jar$/i.test(f.file.path)) modKeys.add(f.file.path.toLowerCase());
  for (const k of ov.kept) if (BUNDLED_JAR_RE.test(k.rel)) modKeys.add(k.rel.toLowerCase());

  const skipped = [...sel.skipped, ...ov.skipped];
  const optionalBlocked = skipped.filter((s) => s.kind === "host-optional");
  const protectedFiles = skipped.filter((s) => s.kind === "protected");
  const warnings: string[] = [];
  if (sel.blocked.length) {
    warnings.push(`서버에 꼭 필요한 파일 ${sel.blocked.length}개가 허용되지 않은 주소에 있어 이 팩으로는 서버를 만들 수 없어요: ${sel.blocked.slice(0, 5).map((b) => `${path.posix.basename(b.path)} (${b.host})`).join(", ")}${sel.blocked.length > 5 ? ` 외 ${sel.blocked.length - 5}개` : ""}`);
  }
  if (optionalBlocked.length) warnings.push(`선택 파일 ${optionalBlocked.length}개는 허용되지 않은 주소에 있어 받지 않아요: ${listNames(optionalBlocked.map((s) => s.path))}`);
  if (plan.envUnchecked) warnings.push("Modrinth 에 연결하지 못해 클라이언트 전용 모드를 거르지 못했어요. 서버가 켜지지 않으면 모드 화면에서 클라이언트 전용 모드를 꺼 주세요.");
  if (protectedFiles.length) warnings.push(`팩에 든 서버 보안·실행 파일 ${protectedFiles.length}개는 넣지 않아요: ${listNames(protectedFiles.map((s) => s.path))}`);
  if (dropped.length) warnings.push(droppedWarning(dropped));

  const summary: ModpackSummary = {
    name: index.name,
    summary: index.summary,
    versionId: index.versionId,
    mc,
    loader,
    loaderVersion,
    fileCount: index.files.length,
    serverFileCount: sel.files.length,
    totalBytes,
    overrideCount: ov.kept.length,
    suggestedMaxMb: suggestMaxMb(modKeys.size, totalBytes, totalMemMb),
    idealMaxMb: idealMaxMb(modKeys.size, totalBytes),
    clientOnlyCount: skipped.filter((s) => s.kind === "client" || s.kind === "nonserver").length,
    blockedCount: sel.blocked.length,
    warnings,
  };
  return { summary, plan };
}

/** inspectMrpack 이 만든 요약 → 그때의 판별 (rememberSummary 가 보관소에 같이 둔다) */
const plans = new WeakMap<ModpackSummary, ModpackPlan>();
export const planFor = (summary: ModpackSummary): ModpackPlan | undefined => plans.get(summary);

/** .mrpack 을 열어 서버로 만들 수 있는지 확인하고 화면에 보여 줄 요약을 만든다 (판별은 planFor(요약) 으로) */
export async function inspectMrpack(file: string, totalMemMb: number, opts: AnalyzeOptions = {}): Promise<ModpackSummary> {
  const { summary, plan } = await analyzeMrpack(file, totalMemMb, opts);
  plans.set(summary, plan);
  return summary;
}

/**
 * 팩이 정한 로더 버전을 실제로 설치할 수 있는지 미리 확인한다 (만들기 중간에 실패하지 않게).
 * 그 버전이 없으면 modpack_unsupported, 확인할 수 없으면(네트워크) 경고만 더한다
 */
export async function precheckLoader(summary: ModpackSummary, provider: Pick<LoaderProvider, "assertVersion">, signal?: AbortSignal): Promise<void> {
  try {
    await provider.assertVersion(summary.mc, summary.loaderVersion, signal);
  } catch (e) {
    const ce = toCreateError(e);
    const label = `${CREATE_LOADER_LABEL[summary.loader]} ${displayLoaderVersion(summary.loader, summary.mc, summary.loaderVersion)}`;
    if (ce.code === "not_found" || ce.code === "invalid_setting") {
      throw new CreateError("modpack_unsupported", `이 팩이 쓰는 ${label} 을(를) 설치할 수 없어요.`, "로더 배포처에 그 버전이 없어요. 같은 팩의 다른 버전을 골라 주세요.", ce.message);
    }
    if (ce.code === "cancelled" || signal?.aborted) throw ce;
    summary.warnings.push(`${label} 을(를) 설치할 수 있는지 미리 확인하지 못했어요. 만들 때 다시 확인해요.`);
  }
}

/** 만들기 입력의 로더·버전이 검사 결과와 같은지 (화면은 요약의 값을 그대로 보낸다) */
export function assertMatchesInput(summary: ModpackSummary, input: Pick<CreateServerInput, "loader" | "mcVersion" | "loaderVersion">): void {
  const diffs: string[] = [];
  if (summary.loader !== input.loader) diffs.push(`로더 ${input.loader} ≠ ${summary.loader}`);
  if (summary.mc !== input.mcVersion) diffs.push(`Minecraft ${input.mcVersion} ≠ ${summary.mc}`);
  if (summary.loaderVersion !== input.loaderVersion) diffs.push(`로더 버전 ${input.loaderVersion} ≠ ${summary.loaderVersion}`);
  if (diffs.length) throw new CreateError("invalid_setting", "고른 서버 종류·버전이 모드팩과 달라요.", "모드팩을 다시 골라 주세요. 모드팩 서버는 팩이 정한 로더와 버전으로만 만들 수 있어요.", diffs.join("\n"));
}

/** 단계 메모용: "팩 이름 · Fabric 0.16.5 · 모드 N개" */
export function describeSummary(s: ModpackSummary): string {
  return `${s.name} · ${CREATE_LOADER_LABEL[s.loader]} ${displayLoaderVersion(s.loader, s.mc, s.loaderVersion)} · 모드 ${s.serverFileCount}개`;
}

// ---------- 설치 ----------

/**
 * 로더 설치가 끝난 서버 폴더에 팩의 파일을 받고(sha512 확인) overrides/ → server-overrides/ 순서로 푼다.
 * plan 은 검사 때 정한 판별 (없으면 Modrinth 에 묻지 않고 팩 표시·jar 정보로만 거른다).
 * 팩의 server.properties 는 위험한 값을 빼고 합친다. 마지막에 .blockpilot-modpack.json 을 남긴다.
 * 실패하면 예외 — 정리는 작업(CreateJob)이 한다.
 */
export async function installModpack(job: CreateJob, target: string, mrpackFile: string, summary: ModpackSummary, ref: CreateModpackRef, plan?: ModpackPlan): Promise<void> {
  job.startStep("modpack-install", "받을 파일 확인 중");
  const { index, entries } = await scan(mrpackFile);
  const decided = plan ?? (await buildPlan(mrpackFile, index, entries, { network: false, signal: job.signal }));
  const sel = selectServerFiles(index, decided);
  assertNoBlocked(sel);
  const items = sel.files.map(({ file, url }) => ({ file, url, dest: safeRelPath(target, file.path) }));

  await downloadAll(job, items);
  job.clearProgress("modpack-install");
  job.throwIfCancelled();

  job.note("modpack-install", "팩의 설정 파일(overrides) 넣는 중");
  let overrides = 0;
  const skipped: SkippedFile[] = [...sel.skipped];
  const props: Buffer[] = [];
  for (const prefix of OVERRIDE_PREFIXES) {
    try {
      overrides += await extractZipPrefixTo(mrpackFile, prefix, target, {
        checkName: checkRelPath,
        filter: (rel, entryName, dir) => {
          const a = overrideAction(rel, entryName, decided);
          if (a.action === "skip" && !dir) skipped.push({ path: rel, reason: a.reason!, kind: a.kind!, from: overrideSource(prefix) });
          return a.action;
        },
        onCapture: (_rel, data) => props.push(data),
      });
    } catch (e) {
      if (e instanceof CreateError) throw e;
      throw new CreateError("modpack_invalid", "모드팩의 설정 파일(overrides)을 풀지 못했어요.", "팩 파일이 손상됐거나 안전하지 않은 항목이 있어요. 다른 팩을 골라 주세요.", (e as Error)?.message ?? String(e));
    }
    job.throwIfCancelled();
  }

  // 팩의 server.properties: 위험한 값(online-mode·rcon 등)을 빼고 합친다 (server-overrides 가 나중이라 이긴다)
  const dropped = new Set<string>();
  for (const buf of props) {
    const clean = sanitizePackProperties(buf.toString("utf8"));
    clean.dropped.forEach((k) => dropped.add(k));
    await writePropertiesChanges(target, clean.record);
  }
  if (dropped.size) job.appendLog(droppedWarning([...dropped]));

  const marker: ModpackMarker = {
    name: summary.name,
    versionId: summary.versionId,
    source: ref.source,
    projectId: ref.projectId,
    modrinthVersionId: ref.versionId,
    installedAt: new Date().toISOString(),
    serverFileCount: items.length,
    skipped: summarizeSkipped(skipped),
  };
  await fsp.writeFile(path.join(target, MODPACK_MARKER), JSON.stringify(marker, null, 2));
  const notServer = skipped.filter((s) => s.kind === "client" || s.kind === "nonserver").length;
  job.finishStep("modpack-install", `모드 ${items.length}개 받음 · overrides ${overrides}개 · 서버에 필요 없는 파일 ${notServer}개 뺌${skipped.length > notServer ? ` · 그 밖에 건너뜀 ${skipped.length - notServer}개` : ""}`);
}

/** 4개씩 동시에 받는다. 하나라도 실패하면 나머지를 멈추고 첫 오류를 던진다 */
async function downloadAll(job: CreateJob, items: { file: MrpackFile; url: string; dest: string }[]): Promise<void> {
  const n = items.length;
  if (!n) return;
  const total = items.reduce((s, it) => s + it.file.fileSize, 0);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  job.signal.addEventListener("abort", onAbort, { once: true });
  const inflight = new Map<number, number>();
  let doneBytes = 0;
  let next = 0;
  let firstErr: unknown;
  const report = () => {
    let sum = doneBytes;
    for (const b of inflight.values()) sum += b;
    job.progress("modpack-install", sum, total);
  };
  report();

  const worker = async () => {
    while (firstErr === undefined) {
      job.throwIfCancelled();
      const i = next++;
      if (i >= n) return;
      const it = items[i];
      job.note("modpack-install", `${i + 1}/${n} · ${path.posix.basename(it.file.path)}`);
      const r = await downloadFile({
        url: it.url,
        dest: it.dest,
        hash: { algo: "sha512", expected: it.file.hashes.sha512 },
        expectedSize: it.file.fileSize,
        // index 가 알려 준 크기보다 많이 오면 멈추고, 넘겨지는 주소도 허용한 곳만
        maxBytes: it.file.fileSize > 0 ? it.file.fileSize + DOWNLOAD_SLACK_BYTES : 512 * MB,
        allowRedirect: isAllowedRedirect,
        signal: ctrl.signal,
        onProgress: (d) => {
          inflight.set(i, d);
          report();
        },
      });
      inflight.delete(i);
      doneBytes += r.bytes;
      report();
    }
  };

  try {
    await Promise.allSettled(
      Array.from({ length: Math.min(DOWNLOAD_WORKERS, n) }, () =>
        worker().catch((e) => {
          if (firstErr === undefined) firstErr = e;
          ctrl.abort();
        }),
      ),
    );
  } finally {
    job.signal.removeEventListener("abort", onAbort);
  }
  if (job.signal.aborted) throw new CreateError("cancelled", "만들기를 취소했어요.");
  if (firstErr !== undefined) throw firstErr;
}

// ---------- 데이터팩 ----------

/**
 * 팩이 서버 폴더 맨 위 datapacks/ 에 둔 데이터팩(.zip·폴더)을 월드의 datapacks/ 로 옮긴다 (첫 실행 전에 — 월드를 만들 때 켜지게).
 * @returns 옮긴 수와, 옮기지 못했을 때의 경고
 */
export async function moveDatapacks(target: string, levelName: string): Promise<{ moved: number; warning?: string }> {
  const src = path.join(target, "datapacks");
  const names = await fsp.readdir(src).catch(() => [] as string[]);
  const packs = names.filter((n) => !n.startsWith(".") && n.toLowerCase() !== "desktop.ini");
  if (!packs.length) return { moved: 0 };
  let levelDir: string;
  try {
    if (!levelName || pathSkip(levelName)) throw new Error("bad");
    levelDir = safeRelPath(target, levelName);
  } catch {
    return { moved: 0, warning: `월드 이름(level-name)을 알 수 없어 팩의 데이터팩 ${packs.length}개를 월드에 넣지 못했어요. 서버 폴더의 datapacks 폴더에 그대로 있어요.` };
  }
  const dest = path.join(levelDir, "datapacks");
  await fsp.mkdir(dest, { recursive: true });
  let moved = 0;
  for (const n of packs) {
    const to = path.join(dest, n);
    await fsp.rm(to, { recursive: true, force: true });
    await fsp.rename(path.join(src, n), to);
    moved++;
  }
  await fsp.rmdir(src).catch(() => {});
  return { moved };
}
