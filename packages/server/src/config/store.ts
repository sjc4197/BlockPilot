import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_BACKUP_SETTINGS, type BackupSettings, type RegisteredServer } from "@blockpilot/shared";
import { notFound } from "../lib/errors.js";

interface ServerSettings {
  backup: BackupSettings;
}

interface ConfigFile {
  servers: RegisteredServer[];
  settings?: Record<string, ServerSettings>;
  auth?: { token?: string };
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

// ---------- 인증 ----------

export async function getAuthToken(): Promise<string | null> {
  return (await load()).auth?.token ?? null;
}

export async function setAuthToken(token: string | null) {
  const cfg = await load();
  await save({ ...cfg, auth: token ? { token } : undefined });
}
