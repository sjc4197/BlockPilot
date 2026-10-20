import fs from "node:fs/promises";
import path from "node:path";
import type { ModInfo, ModDependency } from "@blockpilot/shared";
import { readZipEntries, readZipEntriesFromBuffer } from "../lib/zip.js";
import { assertPlainFilename } from "../lib/safePath.js";
import { notFound, badRequest } from "../lib/errors.js";

const DISABLED_SUFFIX = ".disabled";

/** 로더/게임이 제공하는 가상 모드 id. 의존성 검사에서 항상 충족으로 본다. */
const PROVIDED_BY_ENV = new Set(["minecraft", "java", "fabricloader", "fabric-loader", "forge", "neoforge"]);

interface ParsedJar {
  loader: ModInfo["loader"];
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  authors: string[];
  environment?: ModInfo["environment"];
  depends: { id: string; version: string }[];
  /** 이 jar가 제공하는 모든 id (자기 id + provides + 중첩 jar의 id) */
  provides: Map<string, string>;
  iconDataUrl?: string;
}

export async function listMods(serverDir: string, mcVersion?: string): Promise<ModInfo[]> {
  const modsDir = path.join(serverDir, "mods");
  let files: string[];
  try {
    files = await fs.readdir(modsDir);
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const jars = files.filter((f) => f.endsWith(".jar") || f.endsWith(".jar" + DISABLED_SUFFIX)).sort();

  const parsed = await Promise.all(
    jars.map(async (file) => {
      const full = path.join(modsDir, file);
      const stat = await fs.stat(full);
      let meta: ParsedJar;
      try {
        meta = await parseJar(full);
      } catch {
        meta = { loader: "unknown", authors: [], depends: [], provides: new Map() };
      }
      return { file, enabled: !file.endsWith(DISABLED_SUFFIX), sizeBytes: stat.size, meta };
    }),
  );

  // 활성 모드가 제공하는 id → 버전
  const available = new Map<string, string>();
  for (const p of parsed) {
    if (!p.enabled) continue;
    for (const [id, v] of p.meta.provides) available.set(id, v);
  }
  if (mcVersion) available.set("minecraft", mcVersion);

  return parsed.map(({ file, enabled, sizeBytes, meta }) => {
    const depends: ModDependency[] = meta.depends.map((d) => ({
      id: d.id,
      version: d.version,
      satisfied: checkDependency(d, available),
    }));
    return {
      file,
      enabled,
      sizeBytes,
      loader: meta.loader,
      id: meta.id,
      name: meta.name,
      version: meta.version,
      description: meta.description,
      authors: meta.authors,
      environment: meta.environment,
      depends,
      iconDataUrl: meta.iconDataUrl,
      missingDeps: depends.filter((d) => d.satisfied === false).map((d) => d.id),
    };
  });
}

export async function setModEnabled(serverDir: string, file: string, enabled: boolean) {
  assertPlainFilename(file);
  const modsDir = path.join(serverDir, "mods");
  const from = path.join(modsDir, file);
  const base = file.endsWith(DISABLED_SUFFIX) ? file.slice(0, -DISABLED_SUFFIX.length) : file;
  const to = path.join(modsDir, enabled ? base : base + DISABLED_SUFFIX);
  if (from === to) return path.basename(to);
  try {
    await fs.rename(from, to);
  } catch (e: any) {
    if (e.code === "ENOENT") throw notFound("모드 파일을 찾을 수 없습니다.");
    throw e;
  }
  return path.basename(to);
}

export async function deleteMod(serverDir: string, file: string) {
  assertPlainFilename(file);
  const full = path.join(serverDir, "mods", file);
  try {
    await fs.rm(full);
  } catch (e: any) {
    if (e.code === "ENOENT") throw notFound("모드 파일을 찾을 수 없습니다.");
    throw e;
  }
}

export async function saveUploadedMod(serverDir: string, filename: string, data: Buffer) {
  assertPlainFilename(filename);
  if (!filename.endsWith(".jar")) throw badRequest(".jar 파일만 업로드할 수 있습니다.");
  const modsDir = path.join(serverDir, "mods");
  await fs.mkdir(modsDir, { recursive: true });
  await fs.writeFile(path.join(modsDir, filename), data);
}

// ---------- jar 파싱 ----------

const WANTED = ["fabric.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"];

async function parseJar(file: string): Promise<ParsedJar> {
  const entries = await readZipEntries(file, WANTED);
  const fabric = entries.get("fabric.mod.json");
  if (fabric) return parseFabric(fabric, file);
  const neo = entries.get("META-INF/neoforge.mods.toml");
  if (neo) return parseForgeToml(neo, "neoforge");
  const forge = entries.get("META-INF/mods.toml");
  if (forge) return parseForgeToml(forge, "forge");
  return { loader: "unknown", authors: [], depends: [], provides: new Map() };
}

async function parseFabric(buf: Buffer, jarPath: string): Promise<ParsedJar> {
  const json = JSON.parse(buf.toString("utf8"));
  const id: string | undefined = json.id;
  const version: string = String(json.version ?? "");
  const provides = new Map<string, string>();
  if (id) provides.set(id, version);
  for (const p of json.provides ?? []) provides.set(String(p), version);

  // 중첩 jar(Fabric API 모듈 등)가 제공하는 id까지 수집
  const nested: string[] = (json.jars ?? []).map((j: any) => j.file).filter(Boolean);
  if (nested.length) {
    try {
      const inner = await readZipEntries(jarPath, nested);
      for (const [, nb] of inner) {
        try {
          const e = await readZipEntriesFromBuffer(nb, ["fabric.mod.json"]);
          const nj = e.get("fabric.mod.json");
          if (!nj) continue;
          const njson = JSON.parse(nj.toString("utf8"));
          if (njson.id) provides.set(njson.id, String(njson.version ?? ""));
          for (const p of njson.provides ?? []) provides.set(String(p), String(njson.version ?? ""));
        } catch {
          /* 깨진 중첩 jar는 무시 */
        }
      }
    } catch {
      /* ignore */
    }
  }

  let iconDataUrl: string | undefined;
  const iconPath = typeof json.icon === "string" ? json.icon : undefined;
  if (iconPath) {
    try {
      const ic = await readZipEntries(jarPath, [iconPath]);
      const b = ic.get(iconPath);
      if (b && b.length < 200 * 1024) iconDataUrl = `data:image/png;base64,${b.toString("base64")}`;
    } catch {
      /* ignore */
    }
  }

  const authors = (json.authors ?? []).map((a: any) => (typeof a === "string" ? a : a?.name)).filter(Boolean);
  const depends = Object.entries(json.depends ?? {}).map(([k, v]) => ({
    id: k,
    version: Array.isArray(v) ? v.join(" || ") : String(v),
  }));

  return {
    loader: "fabric",
    id,
    name: json.name ?? id,
    version,
    description: json.description,
    authors,
    environment: json.environment ?? "*",
    depends,
    provides,
    iconDataUrl,
  };
}

/** mods.toml 최소 파서: [[mods]] 첫 항목과 [[dependencies.<modId>]]만 읽는다 */
function parseForgeToml(buf: Buffer, loader: "forge" | "neoforge"): ParsedJar {
  const text = buf.toString("utf8");
  const sections = text.split(/^\s*\[\[/m).slice(1);
  const kv = (block: string) => {
    const o: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) o[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'''([\s\S]*)'''$/, "$1");
    }
    return o;
  };
  const modBlock = sections.find((s) => s.startsWith("mods]]"));
  const mod = modBlock ? kv(modBlock) : {};
  const id = mod.modId;
  const depends = sections
    .filter((s) => s.startsWith("dependencies."))
    .map(kv)
    .filter((d) => d.mandatory !== "false" && d.type !== "optional")
    .map((d) => ({ id: d.modId, version: d.versionRange ?? "*" }))
    .filter((d) => d.id);
  const provides = new Map<string, string>();
  if (id) provides.set(id, mod.version ?? "");
  return {
    loader,
    id,
    name: mod.displayName ?? id,
    version: mod.version,
    description: mod.description,
    authors: mod.authors ? [mod.authors] : [],
    environment: "*",
    depends,
    provides,
  };
}

// ---------- 버전 범위 검사 ----------

function checkDependency(dep: { id: string; version: string }, available: Map<string, string>): boolean | null {
  if (PROVIDED_BY_ENV.has(dep.id) && !available.has(dep.id)) return true;
  const have = available.get(dep.id);
  if (have === undefined) return false;
  return satisfies(have, dep.version);
}

/**
 * Fabric 스타일 버전 범위. 예: "*", ">=0.116.4+1.21.1", "~1.21.1", "^5.1.0", ">=1.0 <2.0", "1.x", "a || b"
 * 판단 불가면 null.
 */
export function satisfies(version: string, range: string): boolean | null {
  const r = range.trim();
  if (!r || r === "*") return true;
  const alternatives = r.split("||").map((s) => s.trim());
  const results = alternatives.map((alt) => satisfiesAll(version, alt));
  if (results.some((x) => x === true)) return true;
  if (results.every((x) => x === false)) return false;
  return null;
}

function satisfiesAll(version: string, constraints: string): boolean | null {
  const parts = constraints.split(/[\s,]+/).filter(Boolean);
  const v = parseVersion(version);
  if (!v) return null;
  let result: boolean | null = true;
  for (const c of parts) {
    const r = satisfiesOne(v, c);
    if (r === false) return false;
    if (r === null) result = null;
  }
  return result;
}

function satisfiesOne(v: number[], c: string): boolean | null {
  const m = c.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
  if (!m) return null;
  const op = m[1] ?? "=";
  const raw = m[2];
  // "1.21.x" / "1.x" 형태
  if (/\.x$/i.test(raw) || /\.\*$/.test(raw)) {
    const prefix = parseVersion(raw.replace(/\.(x|\*)$/i, ""));
    if (!prefix) return null;
    return prefix.every((n, i) => v[i] === n);
  }
  const t = parseVersion(raw);
  if (!t) return null;
  const cmp = compare(v, t);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    case "~": {
      // 마지막 지정 자리까지 같고 그 이상
      const upper = [...t];
      const idx = Math.max(0, upper.length - 2);
      upper[idx] += 1;
      upper.length = idx + 1;
      return cmp >= 0 && compare(v, upper) < 0;
    }
    case "^": {
      const idx = t.findIndex((n) => n !== 0);
      const i = idx < 0 ? 0 : idx;
      const upper = t.slice(0, i + 1);
      upper[i] += 1;
      return cmp >= 0 && compare(v, upper) < 0;
    }
  }
  return null;
}

/** "1.21.1", "0.116.15+1.21.1", "5.1.3-beta" → [1,21,1] (빌드/프리릴리즈 정보 제거) */
export function parseVersion(s: string): number[] | null {
  const core = s.trim().replace(/^v/i, "").split("+")[0].split("-")[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split(".").map(Number);
}

function compare(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
