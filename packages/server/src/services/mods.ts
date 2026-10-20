import fs from "node:fs/promises";
import path from "node:path";
import yazl from "yazl";
import { parse as parseYaml } from "yaml";
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

/** Paper/Spigot 은 mods/ 대신 plugins/ 를 쓴다 */
export function modsDirName(loader?: string) {
  return loader === "paper" ? "plugins" : "mods";
}

export async function listMods(serverDir: string, mcVersion?: string, loader?: string): Promise<ModInfo[]> {
  const modsDir = path.join(serverDir, modsDirName(loader));
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

export async function setModEnabled(serverDir: string, file: string, enabled: boolean, loader?: string) {
  assertPlainFilename(file);
  const modsDir = path.join(serverDir, modsDirName(loader));
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

export async function deleteMod(serverDir: string, file: string, loader?: string) {
  assertPlainFilename(file);
  const full = path.join(serverDir, modsDirName(loader), file);
  try {
    await fs.rm(full);
  } catch (e: any) {
    if (e.code === "ENOENT") throw notFound("모드 파일을 찾을 수 없습니다.");
    throw e;
  }
}

export async function saveUploadedMod(serverDir: string, filename: string, data: Buffer, loader?: string) {
  assertPlainFilename(filename);
  if (!filename.endsWith(".jar")) throw badRequest(".jar 파일만 업로드할 수 있습니다.");
  const modsDir = path.join(serverDir, modsDirName(loader));
  await fs.mkdir(modsDir, { recursive: true });
  await fs.writeFile(path.join(modsDir, filename), data);
}

/**
 * 친구들에게 나눠줄 클라이언트용 모드 zip.
 * 활성화된 모드 중 서버 전용(environment=server)을 제외하고 묶는다. Paper 플러그인은 클라이언트에 필요 없으므로 비움.
 */
export async function buildClientModsZip(serverDir: string, mcVersion?: string, loader?: string): Promise<{ stream: NodeJS.ReadableStream; files: string[] }> {
  const mods = loader === "paper" ? [] : await listMods(serverDir, mcVersion, loader);
  const files = mods.filter((m) => m.enabled && m.environment !== "server").map((m) => m.file);
  const zip = new yazl.ZipFile();
  for (const f of files) zip.addFile(path.join(serverDir, modsDirName(loader), f), `mods/${f}`);
  const readme = [
    `BlockPilot 클라이언트 모드팩`,
    `마인크래프트 ${mcVersion ?? ""} / ${loader ?? ""}`,
    ``,
    `1. 런처에 ${loader === "fabric" ? "Fabric Loader" : loader === "neoforge" ? "NeoForge" : loader === "forge" ? "Forge" : "서버와 같은 로더"}를 설치하세요.`,
    `2. mods/ 폴더의 jar 파일을 .minecraft/mods/ 에 넣으세요.`,
    ``,
    ...files.map((f) => `- ${f}`),
  ].join("\n");
  zip.addBuffer(Buffer.from(readme, "utf8"), "README.txt");
  zip.end();
  return { stream: zip.outputStream, files };
}

// ---------- jar 파싱 ----------

const WANTED = ["fabric.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "plugin.yml", "paper-plugin.yml"];

async function parseJar(file: string): Promise<ParsedJar> {
  const entries = await readZipEntries(file, WANTED);
  const fabric = entries.get("fabric.mod.json");
  if (fabric) return parseFabric(fabric, file);
  const neo = entries.get("META-INF/neoforge.mods.toml");
  if (neo) return parseForgeToml(neo, "neoforge");
  const forge = entries.get("META-INF/mods.toml");
  if (forge) return parseForgeToml(forge, "forge");
  const plugin = entries.get("paper-plugin.yml") ?? entries.get("plugin.yml");
  if (plugin) return parsePluginYml(plugin);
  return { loader: "unknown", authors: [], depends: [], provides: new Map() };
}

/** Bukkit/Paper plugin.yml */
function parsePluginYml(buf: Buffer): ParsedJar {
  const y = (parseYaml(buf.toString("utf8")) ?? {}) as Record<string, any>;
  const id = typeof y.name === "string" ? y.name : undefined;
  const version = y.version !== undefined ? String(y.version) : undefined;
  const provides = new Map<string, string>();
  if (id) provides.set(id, version ?? "");
  const authors: string[] = Array.isArray(y.authors) ? y.authors.map(String) : y.author ? [String(y.author)] : [];
  const dependsRaw: string[] = Array.isArray(y.depend) ? y.depend.map(String) : Array.isArray(y.dependencies?.server) ? Object.keys(y.dependencies.server) : [];
  return {
    loader: "paper",
    id,
    name: id,
    version,
    description: typeof y.description === "string" ? y.description : undefined,
    authors,
    environment: "server",
    depends: dependsRaw.map((d) => ({ id: d, version: "*" })),
    provides,
  };
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

function satisfiesOne(v: Version, c: string): boolean | null {
  const m = c.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
  if (!m) return null;
  const op = m[1] ?? "=";
  const raw = m[2];
  // "1.21.x" / "1.x" 형태
  if (/\.x$/i.test(raw) || /\.\*$/.test(raw)) {
    const prefix = parseVersion(raw.replace(/\.(x|\*)$/i, ""));
    if (!prefix) return null;
    return prefix.core.every((n, i) => v.core[i] === n);
  }
  const t = parseVersion(raw);
  if (!t) return null;
  const cmp = compareVersions(v, t);
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
      const upper = [...t.core];
      const idx = Math.max(0, upper.length - 2);
      upper[idx] += 1;
      upper.length = idx + 1;
      return cmp >= 0 && compareVersions(v, { core: upper, pre: null }) < 0;
    }
    case "^": {
      const idx = t.core.findIndex((n) => n !== 0);
      const i = idx < 0 ? 0 : idx;
      const upper = t.core.slice(0, i + 1);
      upper[i] += 1;
      return cmp >= 0 && compareVersions(v, { core: upper, pre: null }) < 0;
    }
  }
  return null;
}

export interface Version {
  core: number[];
  /** 프리릴리즈 식별자. "1.21.1-Fabric-5.1.3" → ["Fabric-5","1","3"]. 없으면 null */
  pre: string[] | null;
}

/**
 * "1.21.1" → core [1,21,1], "0.116.15+1.21.1" → 빌드 메타데이터 제거,
 * "1.21.1-Fabric-5.1.3" → core [1,21,1] + pre ["Fabric-5","1","3"]
 * YUNG 계열처럼 core 가 전부 같고 '-' 뒤에만 실제 버전이 있는 모드가 있어서 프리릴리즈를 버리면 안 된다.
 */
export function parseVersion(s: string): Version | null {
  const noBuild = s.trim().replace(/^v/i, "").split("+")[0];
  const dash = noBuild.indexOf("-");
  const coreStr = dash < 0 ? noBuild : noBuild.slice(0, dash);
  if (!/^\d+(\.\d+)*$/.test(coreStr)) return null;
  const preStr = dash < 0 ? "" : noBuild.slice(dash + 1);
  return { core: coreStr.split(".").map(Number), pre: preStr ? preStr.split(".") : null };
}

/** semver 규칙: core 비교 → 프리릴리즈 없는 쪽이 큼 → 식별자별로 숫자는 수치, 그 외는 문자열 비교 */
export function compareVersions(a: Version, b: Version): number {
  const len = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < len; i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
