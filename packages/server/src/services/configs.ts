import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { ConfigFileEntry, ConfigFileContent, ConfigValidationResult } from "@blockpilot/shared";
import { resolveInside } from "../lib/safePath.js";
import { writeFileAtomic } from "../lib/atomicWrite.js";
import { notFound, badRequest } from "../lib/errors.js";

/**
 * 서버 폴더 안의 텍스트 설정 파일 탐색/편집.
 * 모드 설정(config/), 데이터팩 설정, 플러그인 설정(plugins/)을 대상으로 한다.
 */

const ROOTS = ["config", "plugins", "defaultconfigs", "kubejs"];
const ROOT_FILES = ["bukkit.yml", "spigot.yml", "paper.yml", "server.properties"];
const TEXT_EXT: Record<string, ConfigFileEntry["format"]> = {
  ".toml": "toml",
  ".json": "json",
  ".json5": "json5",
  ".jsonc": "json5",
  ".properties": "properties",
  ".cfg": "properties",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".txt": "text",
  ".snbt": "text",
  ".conf": "text",
  ".ini": "text",
  ".js": "text",
  ".mcmeta": "json",
};
const MAX_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 2000;

export async function listConfigFiles(serverDir: string): Promise<ConfigFileEntry[]> {
  const out: ConfigFileEntry[] = [];
  for (const f of ROOT_FILES) {
    const e = await statEntry(serverDir, f);
    if (e) out.push(e);
  }
  for (const root of ROOTS) {
    await walk(serverDir, root, out);
    if (out.length >= MAX_FILES) break;
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(serverDir: string, rel: string, out: ConfigFileEntry[]) {
  const abs = path.join(serverDir, rel);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= MAX_FILES) return;
    const childRel = path.posix.join(rel, ent.name);
    if (ent.isDirectory()) {
      // 플러그인 데이터 폴더 안의 대용량 캐시 등은 건너뜀
      if (/^(cache|logs|data|backups?)$/i.test(ent.name)) continue;
      await walk(serverDir, childRel, out);
    } else if (ent.isFile()) {
      const e = await statEntry(serverDir, childRel);
      if (e) out.push(e);
    }
  }
}

async function statEntry(serverDir: string, rel: string): Promise<ConfigFileEntry | null> {
  const format = formatOf(rel);
  if (!format) return null;
  try {
    const st = await fs.stat(path.join(serverDir, rel));
    if (!st.isFile() || st.size > MAX_SIZE) return null;
    return { path: rel, sizeBytes: st.size, mtime: st.mtime.toISOString(), format };
  } catch {
    return null;
  }
}

function formatOf(rel: string): ConfigFileEntry["format"] | null {
  return TEXT_EXT[path.extname(rel).toLowerCase()] ?? null;
}

export async function readConfigFile(serverDir: string, rel: string): Promise<ConfigFileContent> {
  const abs = resolveInside(serverDir, rel);
  const entry = await statEntry(serverDir, rel);
  if (!entry) throw notFound("파일을 찾을 수 없거나 편집할 수 없는 형식입니다.");
  const content = await fs.readFile(abs, "utf8");
  return { ...entry, content };
}

export async function writeConfigFile(serverDir: string, rel: string, content: string): Promise<ConfigValidationResult> {
  const abs = resolveInside(serverDir, rel);
  const format = formatOf(rel);
  if (!format) throw badRequest("편집할 수 없는 파일 형식입니다.");
  const v = validate(format, content);
  if (!v.ok) throw badRequest(`문법 오류${v.line ? ` (${v.line}행)` : ""}: ${v.message}`);
  await fs.access(abs).catch(() => {
    throw notFound("파일이 존재하지 않습니다.");
  });
  await writeFileAtomic(abs, content);
  return v;
}

export function validate(format: ConfigFileEntry["format"], content: string): ConfigValidationResult {
  try {
    switch (format) {
      case "toml":
        parseToml(content);
        break;
      case "json":
        JSON.parse(content);
        break;
      case "yaml":
        parseYaml(content);
        break;
      case "json5":
      case "properties":
      case "text":
        break;
    }
    return { ok: true };
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    const line = e?.line ?? e?.linePos?.[0]?.line ?? lineFromJsonError(content, msg);
    return { ok: false, message: msg.split("\n")[0], line };
  }
}

function lineFromJsonError(content: string, msg: string): number | undefined {
  const m = msg.match(/position (\d+)/);
  if (!m) return undefined;
  return content.slice(0, Number(m[1])).split("\n").length;
}
