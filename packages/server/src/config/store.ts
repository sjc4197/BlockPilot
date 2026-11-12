import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_AUTOMATION, DEFAULT_BACKUP_SETTINGS, type AutomationSettings, type BackupSettings, type P2pApprovedPeer, type P2pBlockedPeer, type RegisteredServer } from "@blockpilot/shared";
import { notFound } from "../lib/errors.js";
import { writeFileAtomic } from "../lib/atomicWrite.js";
import { retryFs } from "../lib/retry.js";
import { CURRENT_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, configFileSchema } from "./schema.js";

interface ServerSettings {
  backup?: BackupSettings;
  /** 디스코드 알림·자동 재시작·예약 재시작. 웹훅 주소가 들어 있어 이 파일은 나만 읽기(600) */
  automation?: Partial<AutomationSettings>;
  /** 포트포워딩 없는 친구 초대. 호스트 키페어·시크릿이 들어 있다 (비밀) */
  p2p?: P2pSettings;
}

export interface P2pSettings {
  enabled: boolean;
  /** hex */
  keyPair?: { publicKey: string; secretKey: string };
  /** hex, 초대코드의 시크릿 */
  secret?: string;
  approved: P2pApprovedPeer[];
  blocked: P2pBlockedPeer[];
}

export const DEFAULT_P2P: P2pSettings = { enabled: false, approved: [], blocked: [] };

export interface ConfigFile {
  /** 파일 모양 버전. 없으면(옛 파일) LEGACY_SCHEMA_VERSION 으로 본다 */
  schemaVersion?: number;
  servers: RegisteredServer[];
  settings?: Record<string, ServerSettings>;
  auth?: { token?: string };
  /** 친구 서버에 접속(참가 모드): 내 키페어와 마지막 초대 (비밀) */
  p2pJoin?: JoinSettings;
  /** 다른 버전이 남긴 키도 지우지 않고 그대로 돌려쓴다 */
  [extra: string]: unknown;
}

export interface JoinSettings {
  /** hex. 호스트가 "같은 사람" 으로 알아보게 유지한다 */
  keyPair?: { publicKey: string; secretKey: string };
  remembered?: { name?: string; inviteCode: string; usedAt: string };
}

/** BlockPilot 이 쓰는 앱 폴더 (설정, 작업 일지, 받아 둔 JDK) */
export const BLOCKPILOT_HOME = process.env.BLOCKPILOT_HOME ?? path.join(os.homedir(), ".blockpilot");
const CONFIG_DIR = BLOCKPILOT_HOME;
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const BAK_PATH = `${CONFIG_PATH}.bak`;
/** 깨진 config.json 은 지우지 않고 이 접두사로 옆에 치워 둔다 (최근 몇 개만). 깨진 .bak 은 `config.json.bak.corrupt-<시각>` */
const CORRUPT_PREFIX = "config.json.corrupt-";
const BAK_CORRUPT_PREFIX = "config.json.bak.corrupt-";
const MAX_CORRUPT_KEPT = 3;
const FILE_MODE = 0o600;

// ---------- 마이그레이션 ----------

export interface ConfigMigration {
  /** 이 변환을 거치면 파일이 되는 버전 */
  version: number;
  up: (cfg: ConfigFile) => ConfigFile;
}

/**
 * 파일의 schemaVersion 보다 큰 version 의 항목을 version 오름차순으로 적용한다.
 * 모양이 바뀌면 CURRENT_SCHEMA_VERSION 을 올리고 여기에 `{ version: 2, up: ... }` 처럼 추가한다. 지금은 1 이 처음이라 비어 있다.
 */
const MIGRATIONS: ConfigMigration[] = [];

/** `migrations` 는 테스트에서 가짜 변환을 끼워 넣기 위한 것. 실제로는 MIGRATIONS 를 쓴다 */
export function migrate(cfg: ConfigFile, migrations: ConfigMigration[] = MIGRATIONS, current = CURRENT_SCHEMA_VERSION): ConfigFile {
  let out = cfg;
  let version = out.schemaVersion ?? LEGACY_SCHEMA_VERSION;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= version) continue;
    out = { ...m.up(out), schemaVersion: m.version };
    version = m.version;
  }
  if (version > current) {
    console.warn(`[config] config.json 이 더 새로운 버전(schemaVersion ${out.schemaVersion})으로 저장돼 있어요. 모르는 항목은 그대로 보존합니다.`);
  }
  return out;
}

// ---------- 읽기 ----------

export interface ConfigRecoveryInfo {
  /** 마지막 로드에서 깨진 config.json 을 치워 둔 경로. 옮기지도 못했으면 config.json 그 자체 */
  corruptFile?: string;
  /** 깨진 파일 대신 config.json.bak 의 내용으로 이어 갔으면 true (빈 설정으로 시작했으면 없음) */
  restoredFromBackup?: boolean;
}

let cache: ConfigFile | null = null;
let loading: Promise<ConfigFile> | null = null;
let recovery: ConfigRecoveryInfo = {};
/**
 * 디스크의 config.json 이 "읽어서 검증까지 통과한 내용" 인지. 저장 때 이 값이 true 일 때만 config.json 을 .bak 으로 복사한다.
 * 깨진 파일을 치우고(또는 못 치우고) 시작한 뒤의 첫 저장이 멀쩡한 .bak 을 빈 설정이나 깨진 파일로 덮어쓰지 않게 하기 위한 것.
 */
let diskTrusted = false;

/**
 * 마지막 로드의 복구 결과. 디버그 번들에 들어가고, 나중에 UI 배너("설정 파일이 깨져 있어 ...") 에서도 쓸 수 있다.
 */
export function configRecoveryInfo(): ConfigRecoveryInfo {
  return { ...recovery };
}

function fresh(): ConfigFile {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, servers: [] };
}

/** 파일 내용을 파싱·검증한다. 깨졌으면 왜 깨졌는지 한 줄 */
function parseConfig(raw: string): { ok: true; cfg: ConfigFile } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `JSON 파싱 실패: ${(e as Error).message}` };
  }
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, reason: `모양이 맞지 않음 (${issue?.path.join(".") || "root"}: ${issue?.message})` };
  }
  return { ok: true, cfg: result.data as ConfigFile };
}

async function readFromDisk(): Promise<ConfigFile> {
  let raw: string;
  try {
    raw = await retryFs(() => fs.readFile(CONFIG_PATH, "utf8"));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      diskTrusted = false;
      return fresh();
    }
    // 권한 문제 등: 빈 설정으로 시작했다가 다음 저장에서 진짜 파일을 덮어쓰면 안 되므로 그대로 실패시킨다
    throw e;
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) return quarantine(parsed.reason);
  diskTrusted = true;
  return migrate(parsed.cfg);
}

/**
 * 깨진 config.json 을 `config.json.corrupt-<시각>` 으로 옮긴 뒤, 한 세대 전 사본(config.json.bak)이 멀쩡하면 그걸로 이어 간다.
 * .bak 도 없거나 깨졌으면(깨진 .bak 은 `config.json.bak.corrupt-<시각>` 으로 보존) 빈 설정으로 시작한다.
 * 어느 쪽이든 디스크의 config.json 이 검증된 내용이 되기 전까지는 diskTrusted=false 라 다음 저장이 .bak 을 덮어쓰지 않는다.
 */
async function quarantine(reason: string): Promise<ConfigFile> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const dest = path.join(CONFIG_DIR, `${CORRUPT_PREFIX}${stamp}`);
  diskTrusted = false;
  let moved = false;
  try {
    await retryFs(() => fs.rename(CONFIG_PATH, dest));
    recovery = { corruptFile: dest };
    moved = true;
  } catch (e) {
    // 옮기지도 못하면 다음 저장이 덮어쓰게 되므로 적어도 경고는 남긴다
    recovery = { corruptFile: CONFIG_PATH };
    console.warn(`[config] 깨진 config.json 을 옮기지 못했어요: ${(e as Error).message}`);
  }
  const restored = await restoreFromBackup(stamp, moved);
  await pruneCorrupt().catch(() => {});
  if (restored) {
    recovery = { ...recovery, restoredFromBackup: true };
    console.warn(`[config] config.json 을 읽을 수 없어요 (${reason}). ${recovery.corruptFile} 에 보관하고 한 세대 전 사본(config.json.bak)으로 이어 갑니다.`);
    return migrate(restored);
  }
  console.warn(`[config] config.json 을 읽을 수 없어요 (${reason}). ${recovery.corruptFile} 에 보관하고 빈 설정으로 시작합니다.`);
  return fresh();
}

/**
 * config.json.bak 이 파싱·검증을 통과하면 그 내용을 돌려준다. 깨진 .bak 은 `config.json.bak.corrupt-<시각>` 으로 치워 둔다.
 * 깨진 config.json 을 치우는 데 성공했으면(`canWrite`) .bak 의 바이트를 그대로 config.json 에 원자적으로 되살려 두고 diskTrusted=true 로 올린다.
 * 못 치웠으면(깨진 파일이 아직 config.json 자리에 있음) 메모리에서만 이어 가고, 다음 저장이 그 자리를 덮어쓰되 .bak 복사는 건너뛴다.
 */
async function restoreFromBackup(stamp: string, canWrite: boolean): Promise<ConfigFile | null> {
  let raw: string;
  try {
    raw = await retryFs(() => fs.readFile(BAK_PATH, "utf8"));
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") console.warn(`[config] config.json.bak 을 읽지 못했어요: ${(e as Error).message}`);
    return null;
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    const dest = path.join(CONFIG_DIR, `${BAK_CORRUPT_PREFIX}${stamp}`);
    await retryFs(() => fs.rename(BAK_PATH, dest)).catch((e) => console.warn(`[config] 깨진 config.json.bak 을 옮기지 못했어요: ${(e as Error).message}`));
    console.warn(`[config] config.json.bak 도 읽을 수 없어요 (${parsed.reason}). ${dest} 에 보관합니다.`);
    return null;
  }
  if (canWrite) {
    try {
      await writeFileAtomic(CONFIG_PATH, raw, { mode: FILE_MODE, backup: false });
      await fs.chmod(CONFIG_PATH, FILE_MODE);
      diskTrusted = true;
    } catch (e) {
      console.warn(`[config] config.json.bak 을 config.json 으로 되살리지 못했어요 (메모리에서만 이어 갑니다): ${(e as Error).message}`);
    }
  }
  return parsed.cfg;
}

async function pruneCorrupt() {
  const all = await fs.readdir(CONFIG_DIR);
  for (const prefix of [CORRUPT_PREFIX, BAK_CORRUPT_PREFIX]) {
    const names = all.filter((n) => n.startsWith(prefix)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - MAX_CORRUPT_KEPT))) await fs.rm(path.join(CONFIG_DIR, n), { force: true });
  }
}

/** 캐시가 있으면 그걸, 없으면 한 번만 디스크에서 읽는다 (동시에 여러 번 불려도 읽기는 한 번) */
async function load(): Promise<ConfigFile> {
  if (cache) return cache;
  if (!loading) {
    loading = readFromDisk()
      .then((cfg) => {
        cache = cfg;
        return cfg;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

// ---------- 쓰기 ----------

/**
 * 이전 파일을 config.json.bak 으로 한 벌 남기고, 임시 파일 → rename 으로 바꿔 끼운다.
 * .bak 복사는 디스크의 config.json 이 검증된 내용일 때(diskTrusted)만 한다: 깨진 파일을 치우고 시작한 뒤의
 * 첫 저장이 "빈 설정" 이나 "못 치운 깨진 파일" 로 마지막 멀쩡한 사본을 지워 버리면 안 되기 때문.
 * 토큰·키페어가 들어 있어 파일은 나만 읽기(600).
 */
async function writeToDisk(cfg: ConfigFile) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  if (diskTrusted) {
    try {
      await fs.copyFile(CONFIG_PATH, BAK_PATH);
      await fs.chmod(BAK_PATH, FILE_MODE);
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") throw e;
    }
  }
  await writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: FILE_MODE, backup: false });
  await fs.chmod(CONFIG_PATH, FILE_MODE);
  diskTrusted = true;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * 모든 변경은 이 한 줄의 약속 사슬을 지난다: 읽기 → fn → 저장 → 캐시 교체.
 * 동시에 들어온 요청이 서로의 변경을 덮어쓰지 않는다. fn 이 받은 객체를 그대로 돌려주면 저장을 건너뛴다.
 */
export function mutate(fn: (cfg: ConfigFile) => ConfigFile | Promise<ConfigFile>): Promise<ConfigFile> {
  const run = chain.then(async () => {
    const cur = await load();
    const next = await fn(cur);
    if (next === cur) return cur;
    const normalized = { ...next, schemaVersion: next.schemaVersion ?? CURRENT_SCHEMA_VERSION };
    await writeToDisk(normalized);
    cache = normalized;
    return normalized;
  });
  // 한 번 실패해도 사슬은 끊기지 않게
  chain = run.catch(() => {});
  return run;
}

/** 테스트 전용: 캐시·복구 정보를 비워 다음 읽기가 디스크를 다시 보게 한다 */
export async function __resetConfigCacheForTests() {
  await chain;
  cache = null;
  loading = null;
  recovery = {};
  diskTrusted = false;
}

// ---------- 서버 목록 ----------

export async function listServers(): Promise<RegisteredServer[]> {
  return (await load()).servers;
}

export async function getServer(id: string): Promise<RegisteredServer> {
  const s = (await load()).servers.find((x) => x.id === id);
  if (!s) throw notFound("등록되지 않은 서버입니다.");
  return s;
}

export async function addServer(input: { path: string; name: string }): Promise<RegisteredServer> {
  let server: RegisteredServer | undefined;
  await mutate((cfg) => {
    const existing = cfg.servers.find((s) => s.path === input.path);
    if (existing) {
      server = existing;
      return cfg;
    }
    server = { id: randomUUID().slice(0, 8), name: input.name, path: input.path, createdAt: new Date().toISOString() };
    return { ...cfg, servers: [...cfg.servers, server] };
  });
  return server!;
}

export async function renameServer(id: string, name: string) {
  await mutate((cfg) => ({ ...cfg, servers: cfg.servers.map((s) => (s.id === id ? { ...s, name } : s)) }));
}

export async function removeServer(id: string) {
  await mutate((cfg) => {
    const settings = { ...cfg.settings };
    delete settings[id];
    return { ...cfg, servers: cfg.servers.filter((s) => s.id !== id), settings };
  });
}

// ---------- 서버별 설정 ----------

function withServerSettings(cfg: ConfigFile, id: string, patch: Partial<ServerSettings>): ConfigFile {
  return { ...cfg, settings: { ...cfg.settings, [id]: { ...cfg.settings?.[id], ...patch } } };
}

export async function getBackupSettings(id: string): Promise<BackupSettings> {
  const cfg = await load();
  return { ...DEFAULT_BACKUP_SETTINGS, ...cfg.settings?.[id]?.backup };
}

export async function setBackupSettings(id: string, backup: BackupSettings) {
  await mutate((cfg) => withServerSettings(cfg, id, { backup }));
}

export async function getAutomation(id: string): Promise<AutomationSettings> {
  const a = (await load()).settings?.[id]?.automation ?? {};
  const d = DEFAULT_AUTOMATION;
  return {
    discord: { ...d.discord, ...a.discord, events: { ...d.discord.events, ...a.discord?.events } },
    autoRestart: { ...d.autoRestart, ...a.autoRestart },
    scheduledRestart: { ...d.scheduledRestart, ...a.scheduledRestart },
    idleShutdown: { ...d.idleShutdown, ...a.idleShutdown },
  };
}

export async function setAutomation(id: string, automation: AutomationSettings) {
  await mutate((cfg) => withServerSettings(cfg, id, { automation }));
}

export async function getP2p(id: string): Promise<P2pSettings> {
  const p = (await load()).settings?.[id]?.p2p;
  return { ...DEFAULT_P2P, ...p, approved: p?.approved ?? [], blocked: p?.blocked ?? [] };
}

export async function setP2p(id: string, p2p: P2pSettings) {
  await mutate((cfg) => withServerSettings(cfg, id, { p2p }));
}

export async function getJoinSettings(): Promise<JoinSettings> {
  return (await load()).p2pJoin ?? {};
}

export async function setJoinSettings(p2pJoin: JoinSettings) {
  await mutate((cfg) => ({ ...cfg, p2pJoin }));
}

// ---------- 인증 ----------

export async function getAuthToken(): Promise<string | null> {
  return (await load()).auth?.token ?? null;
}

export async function setAuthToken(token: string | null) {
  await mutate((cfg) => ({ ...cfg, auth: token ? { token } : undefined }));
}
