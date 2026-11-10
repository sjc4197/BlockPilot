import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_AUTOMATION, DEFAULT_BACKUP_SETTINGS, type AutomationSettings, type BackupSettings, type P2pApprovedPeer, type P2pBlockedPeer, type RegisteredServer } from "@blockpilot/shared";
import { notFound } from "../lib/errors.js";

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

interface ConfigFile {
  servers: RegisteredServer[];
  settings?: Record<string, ServerSettings>;
  auth?: { token?: string };
  /** 친구 서버에 접속(참가 모드): 내 키페어와 마지막 초대 (비밀) */
  p2pJoin?: JoinSettings;
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

let cache: ConfigFile | null = null;

async function load(): Promise<ConfigFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    cache = JSON.parse(raw) as ConfigFile;
  } catch {
    cache = { servers: [] };
  }
  return cache;
}

async function save(cfg: ConfigFile) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  cache = cfg;
}

export async function listServers(): Promise<RegisteredServer[]> {
  return (await load()).servers;
}

export async function getServer(id: string): Promise<RegisteredServer> {
  const s = (await load()).servers.find((x) => x.id === id);
  if (!s) throw notFound("등록되지 않은 서버입니다.");
  return s;
}

export async function addServer(input: { path: string; name: string }): Promise<RegisteredServer> {
  const cfg = await load();
  const existing = cfg.servers.find((s) => s.path === input.path);
  if (existing) return existing;
  const server: RegisteredServer = {
    id: randomUUID().slice(0, 8),
    name: input.name,
    path: input.path,
    createdAt: new Date().toISOString(),
  };
  await save({ ...cfg, servers: [...cfg.servers, server] });
  return server;
}

export async function renameServer(id: string, name: string) {
  const cfg = await load();
  await save({ ...cfg, servers: cfg.servers.map((s) => (s.id === id ? { ...s, name } : s)) });
}

export async function removeServer(id: string) {
  const cfg = await load();
  const settings = { ...cfg.settings };
  delete settings[id];
  await save({ ...cfg, servers: cfg.servers.filter((s) => s.id !== id), settings });
}

// ---------- 서버별 설정 ----------

export async function getBackupSettings(id: string): Promise<BackupSettings> {
  const cfg = await load();
  return { ...DEFAULT_BACKUP_SETTINGS, ...cfg.settings?.[id]?.backup };
}

export async function setBackupSettings(id: string, backup: BackupSettings) {
  const cfg = await load();
  await save({ ...cfg, settings: { ...cfg.settings, [id]: { ...cfg.settings?.[id], backup } } });
}

export async function getAutomation(id: string): Promise<AutomationSettings> {
  const a = (await load()).settings?.[id]?.automation ?? {};
  const d = DEFAULT_AUTOMATION;
  return {
    discord: { ...d.discord, ...a.discord, events: { ...d.discord.events, ...a.discord?.events } },
    autoRestart: { ...d.autoRestart, ...a.autoRestart },
    scheduledRestart: { ...d.scheduledRestart, ...a.scheduledRestart },
  };
}

export async function setAutomation(id: string, automation: AutomationSettings) {
  const cfg = await load();
  await save({ ...cfg, settings: { ...cfg.settings, [id]: { ...cfg.settings?.[id], automation } } });
}

export async function getP2p(id: string): Promise<P2pSettings> {
  const p = (await load()).settings?.[id]?.p2p;
  return { ...DEFAULT_P2P, ...p, approved: p?.approved ?? [], blocked: p?.blocked ?? [] };
}

export async function setP2p(id: string, p2p: P2pSettings) {
  const cfg = await load();
  await save({ ...cfg, settings: { ...cfg.settings, [id]: { ...cfg.settings?.[id], p2p } } });
}

export async function getJoinSettings(): Promise<JoinSettings> {
  return (await load()).p2pJoin ?? {};
}

export async function setJoinSettings(p2pJoin: JoinSettings) {
  const cfg = await load();
  await save({ ...cfg, p2pJoin });
}

// ---------- 인증 ----------

export async function getAuthToken(): Promise<string | null> {
  return (await load()).auth?.token ?? null;
}

export async function setAuthToken(token: string | null) {
  const cfg = await load();
  await save({ ...cfg, auth: token ? { token } : undefined });
}
