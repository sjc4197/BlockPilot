import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RegisteredServer } from "@blockpilot/shared";
import { notFound } from "../lib/errors.js";

interface ConfigFile {
  servers: RegisteredServer[];
}

const CONFIG_DIR = process.env.BLOCKPILOT_HOME ?? path.join(os.homedir(), ".blockpilot");
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
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
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

export async function removeServer(id: string) {
  const cfg = await load();
  await save({ ...cfg, servers: cfg.servers.filter((s) => s.id !== id) });
}
