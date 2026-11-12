import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import yazl from "yazl";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { CreateServerInput, ModpackMarker, MrpackIndex } from "@blockpilot/shared";
import {
  MODPACK_MARKER,
  allowedHosts,
  analyzeMrpack,
  cdnVersionId,
  checkRelPath,
  inspectMrpack,
  installModpack,
  isAllowedDownload,
  isAllowedRedirect,
  jarClientOnly,
  modsTomlClientOnly,
  pathSkip,
  planFor,
  precheckLoader,
  readIndex,
  resolveLoader,
  safeRelPath,
  sanitizePackProperties,
  selectServerFiles,
  suggestMaxMb,
} from "../src/services/create/modpack.js";
import { readZipEntries } from "../src/lib/zip.js";
import { downloadFile } from "../src/services/create/download.js";
import { getModpackVersionFile } from "../src/services/modrinthModpack.js";
import {
  MAX_PENDING_UPLOADS,
  MAX_STORED_UPLOADS,
  ModpackBusyError,
  ModpackTooLargeError,
  releaseUpload,
  UPLOADS_DIR,
  UPLOAD_TTL_MS,
  __resetUploadsForTests,
  dropUpload,
  getUpload,
  isAllowedPackUrl,
  rememberSummary,
  storeFromUrl,
  storeUpload,
  sweepUploads,
} from "../src/services/create/modpackUpload.js";
import { CreateJob, stepOrder } from "../src/services/create/job.js";
import { CreateError } from "../src/services/create/errors.js";
import { explainServerFailure } from "../src/services/create/pipeline.js";
import { createRoutes } from "../src/routes/create.js";
import { serversRoutes } from "../src/routes/servers.js";
import { readModpackMarker } from "../src/services/serverInfo.js";
import { addServer } from "../src/config/store.js";

// ---------- 고정 데이터 ----------

const JARS: Record<string, Buffer> = {
  "a.jar": Buffer.alloc(64 * 1024, 1),
  "b.jar": Buffer.alloc(32 * 1024, 2),
  "c.jar": Buffer.alloc(16 * 1024, 3),
  "d.jar": Buffer.alloc(8 * 1024, 4),
  "e.jar": Buffer.alloc(4 * 1024, 5),
  "pack.zip": Buffer.alloc(2048, 6),
};
const sha512 = (b: Buffer) => createHash("sha512").update(b).digest("hex");
const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

let server: http.Server;
let base: string;
let hostPort: string;
let root: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = (req.url ?? "").replace(/^\/files\//, "");
    // 리다이렉트: 허용 주소 안 / 허용되지 않은 주소(localhost 는 허용 목록의 127.0.0.1 과 다른 호스트) / 무한
    if (name.startsWith("redir-ok/")) return res.writeHead(302, { location: `/files/${name.slice("redir-ok/".length)}` }).end();
    if (name.startsWith("redir-evil/")) return res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/files/${name.slice("redir-evil/".length)}` }).end();
    if (name === "redir-loop") return res.writeHead(302, { location: "/files/redir-loop" }).end();
    if (name === "slow.jar") {
      res.writeHead(200, { "content-length": 1024 * 1024 });
      res.write(Buffer.alloc(1024)); // 나머지는 보내지 않음
      return;
    }
    const body = JARS[name] ?? PACKS.get(name);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hostPort = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${hostPort}/files`;
  process.env.BLOCKPILOT_MODPACK_EXTRA_HOSTS = hostPort;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mrpack-"));
});

afterAll(async () => {
  delete process.env.BLOCKPILOT_MODPACK_EXTRA_HOSTS;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fsp.rm(root, { recursive: true, force: true });
});

/** 서버가 내려줄 .mrpack (Modrinth 에서 받는 경로 테스트용) */
const PACKS = new Map<string, Buffer>();

const fileEntry = (p: string, jar: string, opts: { env?: MrpackIndex["files"][number]["env"]; downloads?: string[]; sha512?: string } = {}) => ({
  path: p,
  hashes: { sha1: sha1(JARS[jar]), sha512: opts.sha512 ?? sha512(JARS[jar]) },
  ...(opts.env ? { env: opts.env } : {}),
  downloads: opts.downloads ?? [`${base}/${jar}`],
  fileSize: JARS[jar].length,
});

function baseIndex(over: Partial<Record<string, unknown>> = {}) {
  return {
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.2.3",
    name: "테스트 팩",
    summary: "작은 팩",
    files: [
      // 첫 주소는 허용되지 않은 곳 → 두 번째(허용) 주소를 고른다
      fileEntry("mods/a.jar", "a.jar", { downloads: ["https://evil.example.com/a.jar", `${base}/a.jar`] }),
      fileEntry("mods/b.jar", "b.jar", { env: { client: "required", server: "optional" } }),
      fileEntry("mods/client-only.jar", "c.jar", { env: { client: "required", server: "unsupported" } }),
      fileEntry("mods/opt-blocked.jar", "d.jar", { env: { client: "required", server: "optional" }, downloads: ["https://evil.example.com/d.jar"] }),
      fileEntry("resourcepacks/pack.zip", "pack.zip"),
    ],
    dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.5" },
    ...over,
  };
}

interface ZipItem {
  name: string;
  data?: string | Buffer;
  mode?: number;
}

async function zipTo(file: string, items: ZipItem[]) {
  const z = new yazl.ZipFile();
  for (const it of items) {
    if (it.name.endsWith("/")) z.addEmptyDirectory(it.name);
    else z.addBuffer(Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data ?? ""), it.name, it.mode ? { mode: it.mode } : {});
  }
  z.end();
  await pipeline(z.outputStream as unknown as NodeJS.ReadableStream, fs.createWriteStream(file));
  return file;
}

let n = 0;
async function makePack(index: unknown, extra: ZipItem[] = [], raw?: string) {
  const file = path.join(root, `pack-${++n}.mrpack`);
  return zipTo(file, [{ name: "modrinth.index.json", data: raw ?? JSON.stringify(index) }, ...extra]);
}

const OVERRIDES: ZipItem[] = [
  { name: "overrides/config/" },
  { name: "overrides/config/a.txt", data: "base" },
  { name: "overrides/config/only-base.txt", data: "base-only" },
  { name: "server-overrides/config/a.txt", data: "server" },
  { name: "client-overrides/config/client.txt", data: "client" },
  { name: "overrides/server.properties", data: "level-name=packworld\nmotd=from pack\n" },
];

const input = (target: string, modpack = true): CreateServerInput => ({
  path: target,
  name: "pack",
  loader: "fabric",
  mcVersion: "1.21.1",
  loaderVersion: "0.16.5",
  memory: { minMb: 1024, maxMb: 2048 },
  properties: {},
  eulaAccepted: true,
  ...(modpack ? { modpack: { uploadId: "testupload01", source: "upload" as const } } : {}),
});

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const errOf = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as CreateError;

// ---------- index ----------

describe("readIndex", () => {
  it("reads a valid modrinth.index.json", async () => {
    const idx = await readIndex(await makePack(baseIndex()));
    expect(idx.name).toBe("테스트 팩");
    expect(idx.files).toHaveLength(5);
    expect(idx.dependencies["fabric-loader"]).toBe("0.16.5");
  });

  it("rejects an unknown formatVersion", async () => {
    const err = await errOf(readIndex(await makePack(baseIndex({ formatVersion: 2 }))));
    expect(err.code).toBe("modpack_unsupported");
    expect(err.message).toMatch(/formatVersion 2/);
  });

  it("rejects a pack without the index, or with broken JSON, or with a bad schema", async () => {
    const missing = await errOf(readIndex(await zipTo(path.join(root, "noindex.mrpack"), [{ name: "overrides/a.txt", data: "x" }])));
    expect(missing.code).toBe("modpack_invalid");
    expect(missing.message).toMatch(/modrinth\.index\.json 을 읽지 못했어요/);
    expect(missing.hint).toMatch(/CurseForge/);
    const bad = await errOf(readIndex(await makePack(null, [], "{ not json")));
    expect(bad.code).toBe("modpack_invalid");
    expect(bad.detail).toMatch(/JSON/);
    const schema = await errOf(readIndex(await makePack(baseIndex({ game: "terraria" }))));
    expect(schema.code).toBe("modpack_invalid");
    const notZip = path.join(root, "not-a-zip.mrpack");
    await fsp.writeFile(notZip, "hello");
    expect((await errOf(readIndex(notZip))).code).toBe("modpack_invalid");
  });

  it("explains CurseForge packs (manifest.json without index)", async () => {
    const file = await zipTo(path.join(root, "curse.zip"), [{ name: "manifest.json", data: JSON.stringify({ manifestType: "minecraftModpack" }) }]);
    const err = await errOf(readIndex(file));
    expect(err.code).toBe("modpack_unsupported");
    expect(err.message).toMatch(/CurseForge/);
  });
});

// ---------- 로더 ----------

describe("resolveLoader", () => {
  const idx = (deps: Record<string, string>) => ({ ...baseIndex(), dependencies: deps }) as unknown as MrpackIndex;

  it("maps fabric, forge ({mc}-{forge}) and neoforge", () => {
    expect(resolveLoader(idx({ minecraft: "1.21.1", "fabric-loader": "0.16.5" }))).toEqual({ loader: "fabric", mc: "1.21.1", loaderVersion: "0.16.5" });
    expect(resolveLoader(idx({ minecraft: "1.20.1", forge: "47.3.0" }))).toEqual({ loader: "forge", mc: "1.20.1", loaderVersion: "1.20.1-47.3.0" });
    expect(resolveLoader(idx({ minecraft: "1.20.1", forge: "1.20.1-47.3.0" })).loaderVersion).toBe("1.20.1-47.3.0");
    expect(resolveLoader(idx({ minecraft: "1.21.1", neoforge: "21.1.77" }))).toEqual({ loader: "neoforge", mc: "1.21.1", loaderVersion: "21.1.77" });
  });

  it("refuses Quilt with a Korean explanation", () => {
    try {
      resolveLoader(idx({ minecraft: "1.21.1", "quilt-loader": "0.26.0" }));
      expect.unreachable();
    } catch (e) {
      const err = e as CreateError;
      expect(err.code).toBe("modpack_unsupported");
      expect(err.message).toBe("Quilt 로더 모드팩은 아직 서버로 만들 수 없어요.");
      expect(err.hint).toMatch(/Fabric/);
    }
  });

  it("refuses versions below the provider floors, multiple loaders, snapshots and odd versions", () => {
    const code = (deps: Record<string, string>) => {
      try {
        resolveLoader(idx(deps));
        return "ok";
      } catch (e) {
        return (e as CreateError).code;
      }
    };
    expect(code({ minecraft: "1.16.5", forge: "36.2.39" })).toBe("modpack_unsupported");
    expect(code({ minecraft: "1.20.1", neoforge: "47.1.106" })).toBe("modpack_unsupported");
    expect(code({ minecraft: "1.21.1", forge: "52.0.1", neoforge: "21.1.77" })).toBe("modpack_invalid");
    expect(code({ minecraft: "24w14a", "fabric-loader": "0.16.5" })).toBe("modpack_unsupported");
    expect(code({ minecraft: "1.21.1" })).toBe("modpack_unsupported");
    expect(code({ minecraft: "1.21.1", "fabric-loader": "../../evil" })).toBe("modpack_invalid");
  });
});

// ---------- 받을 파일 · 경로 · 주소 ----------

describe("selectServerFiles", () => {
  it("skips client-only and blocked optional files, blocks required ones on other hosts", () => {
    const index = baseIndex() as unknown as MrpackIndex;
    index.files.push(fileEntry("mods/required-blocked.jar", "e.jar", { downloads: ["https://evil.example.com/e.jar"] }) as never);
    const sel = selectServerFiles(index);
    expect(sel.files.map((f) => f.file.path)).toEqual(["mods/a.jar", "mods/b.jar"]);
    expect(sel.files[0].url).toBe(`${base}/a.jar`);
    expect(sel.skipped).toEqual([
      { path: "mods/client-only.jar", reason: "클라이언트 전용 (팩 표시)", kind: "client", from: "index" },
      { path: "mods/opt-blocked.jar", reason: "허용되지 않은 주소 (evil.example.com)", kind: "host-optional", from: "index" },
      { path: "resourcepacks/pack.zip", reason: "리소스팩 (서버에 필요 없음)", kind: "nonserver", from: "index" },
    ]);
    expect(sel.blocked).toEqual([{ path: "mods/required-blocked.jar", host: "evil.example.com" }]);
  });
});

describe("safeRelPath", () => {
  it("accepts normal relative paths inside the server folder", () => {
    expect(safeRelPath(root, "mods/a.jar")).toBe(path.join(root, "mods", "a.jar"));
  });

  it.each(["", "../x.jar", "mods/../../x.jar", "/etc/passwd", "C:/Windows/x.dll", "c:x", "mods\\a.jar", "mods/./a.jar", "mods//a.jar", "mods/a\u0000.jar", "mods/a\n.jar", "mods/a.jar:stream", "..", "."])("rejects %j", (rel) => {
    try {
      safeRelPath(root, rel);
      expect.unreachable();
    } catch (e) {
      expect((e as CreateError).code).toBe("modpack_invalid");
      expect((e as CreateError).detail).toBeTruthy();
    }
  });
});

describe("host allowlist", () => {
  it("allows only https on the Modrinth spec hosts (plus test extras)", () => {
    expect(allowedHosts()).toEqual(expect.arrayContaining(["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com", hostPort]));
    expect(isAllowedDownload("https://cdn.modrinth.com/data/x/a.jar")).toBe(true);
    expect(isAllowedDownload("https://github.com/o/r/releases/download/v1/a.jar")).toBe(true);
    expect(isAllowedDownload("http://cdn.modrinth.com/data/x/a.jar")).toBe(false);
    expect(isAllowedDownload("https://cdn.modrinth.com.evil.com/a.jar")).toBe(false);
    expect(isAllowedDownload("https://evil.com/cdn.modrinth.com/a.jar")).toBe(false);
    expect(isAllowedDownload("https://user:pw@cdn.modrinth.com/a.jar")).toBe(false);
    expect(isAllowedDownload("https://cdn.modrinth.com:8443/a.jar")).toBe(false);
    expect(isAllowedDownload("ftp://cdn.modrinth.com/a.jar")).toBe(false);
    expect(isAllowedDownload("not a url")).toBe(false);
    expect(isAllowedDownload(`${base}/a.jar`)).toBe(true);
    expect(isAllowedDownload("http://127.0.0.1:1/a.jar")).toBe(false);
  });

  it("downloads .mrpack files only from the Modrinth CDN", () => {
    expect(isAllowedPackUrl("https://cdn.modrinth.com/data/abc/versions/def/pack.mrpack")).toBe(true);
    expect(isAllowedPackUrl("https://github.com/o/r/pack.mrpack")).toBe(false);
    expect(isAllowedPackUrl("http://cdn.modrinth.com/pack.mrpack")).toBe(false);
  });
});

// ---------- 검사 ----------

describe("inspectMrpack", () => {
  it("summarises loader, counts, sizes and warnings", async () => {
    const s = await inspectMrpack(await makePack(baseIndex(), OVERRIDES), 16384);
    expect(s).toMatchObject({ name: "테스트 팩", versionId: "1.2.3", mc: "1.21.1", loader: "fabric", loaderVersion: "0.16.5", fileCount: 5, serverFileCount: 2 });
    // 리소스팩은 서버에 필요 없어 받지 않는다
    expect(s.totalBytes).toBe(JARS["a.jar"].length + JARS["b.jar"].length);
    // overrides 3개 + server-overrides 1개 (client-overrides·폴더 항목은 세지 않음)
    expect(s.overrideCount).toBe(4);
    expect(s.suggestedMaxMb).toBe(3072);
    expect(s.idealMaxMb).toBe(3072);
    // 클라이언트 전용 모드 1 + 리소스팩 1
    expect(s.clientOnlyCount).toBe(2);
    expect(s.blockedCount).toBe(0);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/선택 파일 1개.*opt-blocked\.jar/);
  });

  it("warns about required files on other hosts before creating", async () => {
    const index = baseIndex();
    (index.files as unknown[]).push(fileEntry("mods/required-blocked.jar", "e.jar", { downloads: ["https://evil.example.com/e.jar"] }));
    const s = await inspectMrpack(await makePack(index), 16384);
    expect(s.warnings[0]).toMatch(/꼭 필요한 파일 1개.*required-blocked\.jar \(evil\.example\.com\)/);
    expect(s.blockedCount).toBe(1);
  });

  it("rejects unsafe file paths, duplicates and symlinks in overrides", async () => {
    const bad = baseIndex();
    (bad.files as { path: string }[])[0].path = "../outside.jar";
    expect((await errOf(inspectMrpack(await makePack(bad), 16384))).code).toBe("modpack_invalid");
    const dup = baseIndex();
    (dup.files as { path: string }[])[1].path = "MODS/A.jar";
    expect((await errOf(inspectMrpack(await makePack(dup), 16384))).message).toMatch(/두 번/);
    const link = await makePack(baseIndex(), [{ name: "overrides/config/link", data: "/etc/passwd", mode: 0o120777 }]);
    const err = await errOf(inspectMrpack(link, 16384));
    expect(err.code).toBe("modpack_invalid");
    expect(err.message).toMatch(/심볼릭 링크/);
  });
});

describe("suggestMaxMb", () => {
  it("grows with the pack and stays within the machine", () => {
    const GB = 1024 * 1024 * 1024;
    expect(suggestMaxMb(5, 0, 32768)).toBe(3072);
    expect(suggestMaxMb(40, 0, 32768)).toBe(4096);
    expect(suggestMaxMb(100, 0, 32768)).toBe(6144);
    expect(suggestMaxMb(250, 0, 32768)).toBe(8192);
    expect(suggestMaxMb(250, 2 * GB, 32768)).toBe(9216);
    // 8GB 컴퓨터: 75% = 6144 상한
    expect(suggestMaxMb(250, 2 * GB, 8192)).toBe(6144);
    // 아주 작은 컴퓨터라도 2GB 아래로는 추천하지 않는다
    expect(suggestMaxMb(250, 0, 2048)).toBe(2048);
  });
});

// ---------- 설치 ----------

describe("installModpack", () => {
  const ref = { uploadId: "testupload01", source: "modrinth" as const, projectId: "proj1", versionId: "ver1" };

  it("downloads with sha512, applies overrides then server-overrides, ignores client-overrides, writes the marker", async () => {
    const file = await makePack(baseIndex(), OVERRIDES);
    const target = path.join(root, "srv-ok");
    await fsp.mkdir(target);
    const job = new CreateJob(input(target));
    const summary = await inspectMrpack(file, 16384);
    const seen: number[] = [];
    const orig = job.progress.bind(job);
    job.progress = (id, d, t) => {
      if (id === "modpack-install") seen.push(d);
      orig(id, d, t);
    };
    await installModpack(job, target, file, summary, ref);

    expect(await fsp.readFile(path.join(target, "mods", "a.jar"))).toEqual(JARS["a.jar"]);
    expect(await fsp.readFile(path.join(target, "mods", "b.jar"))).toEqual(JARS["b.jar"]);
    expect(await exists(path.join(target, "resourcepacks"))).toBe(false);
    expect(await exists(path.join(target, "mods", "client-only.jar"))).toBe(false);
    expect(await exists(path.join(target, "mods", "opt-blocked.jar"))).toBe(false);
    expect(await fsp.readFile(path.join(target, "config", "a.txt"), "utf8")).toBe("server");
    expect(await fsp.readFile(path.join(target, "config", "only-base.txt"), "utf8")).toBe("base-only");
    expect(await exists(path.join(target, "config", "client.txt"))).toBe(false);
    expect((await walk(target)).some((f) => f.endsWith(".part"))).toBe(false);
    // 팩의 server.properties 는 걸러서 합친다
    expect(await fsp.readFile(path.join(target, "server.properties"), "utf8")).toMatch(/level-name=packworld[\s\S]*motd=from pack/);

    const marker = JSON.parse(await fsp.readFile(path.join(target, MODPACK_MARKER), "utf8")) as ModpackMarker;
    expect(marker).toMatchObject({ name: "테스트 팩", versionId: "1.2.3", source: "modrinth", projectId: "proj1", modrinthVersionId: "ver1", serverFileCount: 2 });
    expect(marker.skipped).toEqual([
      { path: "mods/client-only.jar", reason: "클라이언트 전용 (팩 표시)" },
      { path: "mods/opt-blocked.jar", reason: "허용되지 않은 주소 (evil.example.com)" },
      { path: "resourcepacks/", reason: "리소스팩 (서버에 필요 없음) · 파일 1개" },
    ]);
    expect(Date.parse(marker.installedAt)).toBeGreaterThan(0);

    expect(Math.max(...seen)).toBe(summary.totalBytes);
    const step = job.steps.find((s) => s.id === "modpack-install")!;
    expect(step.state).toBe("done");
    expect(step.note).toBe("모드 2개 받음 · overrides 3개 · 서버에 필요 없는 파일 2개 뺌 · 그 밖에 건너뜀 1개");
  });

  it("fails on a required file from a host outside the allowlist", async () => {
    const index = baseIndex();
    (index.files as unknown[]).push(fileEntry("mods/required-blocked.jar", "e.jar", { downloads: ["https://evil.example.com/e.jar"] }));
    const file = await makePack(index);
    const target = path.join(root, "srv-blocked");
    await fsp.mkdir(target);
    const job = new CreateJob(input(target));
    const err = await errOf(installModpack(job, target, file, await inspectMrpack(file, 16384), ref));
    expect(err.code).toBe("modpack_blocked_host");
    expect(err.detail).toBe("mods/required-blocked.jar (evil.example.com)");
    expect(err.hint).toMatch(/건너뛸 수 없어요/);
    expect(await exists(path.join(target, "mods"))).toBe(false);
  });

  it("rejects a sha512 mismatch and leaves no .part files", async () => {
    const index = baseIndex();
    (index.files as { hashes: { sha512: string } }[])[1].hashes.sha512 = "0".repeat(128);
    const file = await makePack(index);
    const target = path.join(root, "srv-hash");
    await fsp.mkdir(target);
    const job = new CreateJob(input(target));
    const err = await errOf(installModpack(job, target, file, await inspectMrpack(file, 16384), ref));
    expect(err.code).toBe("hash_mismatch");
    expect((await walk(target)).filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(await exists(path.join(target, "mods", "b.jar"))).toBe(false);
  });

  it("rejects symlink entries in overrides", async () => {
    const file = await makePack(baseIndex(), [{ name: "server-overrides/link", data: "../../etc", mode: 0o120777 }]);
    const target = path.join(root, "srv-link");
    await fsp.mkdir(target);
    const job = new CreateJob(input(target));
    // 검사를 거치지 않고 바로 설치를 불러도 푸는 단계에서 막힌다
    const summary = { name: "x", versionId: "1", serverFileCount: 3 } as never;
    const err = await errOf(installModpack(job, target, file, summary, ref));
    expect(err.code).toBe("modpack_invalid");
    expect(err.detail).toMatch(/심볼릭 링크/);
    expect(await exists(path.join(target, "link"))).toBe(false);
  });

  it("stops when the job is cancelled", async () => {
    const index = baseIndex();
    JARS["slow.jar"] = Buffer.alloc(1024 * 1024);
    (index.files as unknown[]).push(fileEntry("mods/slow.jar", "slow.jar"));
    const file = await makePack(index);
    const target = path.join(root, "srv-cancel");
    await fsp.mkdir(target);
    const job = new CreateJob(input(target));
    const p = installModpack(job, target, file, await inspectMrpack(file, 16384), ref);
    setTimeout(() => job.cancel(), 150);
    const err = await errOf(p);
    expect(err.code).toBe("cancelled");
    expect((await walk(target)).filter((f) => f.endsWith(".part"))).toEqual([]);
    delete JARS["slow.jar"];
  });
});

// ---------- 작업 단계 ----------

describe("CreateJob steps", () => {
  it("adds the two modpack steps only for modpack jobs", () => {
    const normal = new CreateJob(input(path.join(root, "n"), false));
    expect(normal.steps.map((s) => s.id)).toEqual(["preflight", "versions", "java", "server-jar", "loader", "config", "first-run", "register"]);
    expect(normal.status().input.modpack).toBeUndefined();
    const pack = new CreateJob(input(path.join(root, "p")));
    expect(pack.steps.map((s) => s.id)).toEqual(["preflight", "modpack-check", "versions", "java", "server-jar", "loader", "modpack-install", "config", "first-run", "register"]);
    expect(pack.steps.find((s) => s.id === "modpack-install")?.label).toBe("모드팩 모드·설정 넣기");
    expect(stepOrder({})).toHaveLength(8);
  });

  it("shows the pack name in the job status", async () => {
    const up = await storeUpload(Readable.from([Buffer.from("x")]), "a.mrpack");
    rememberSummary(up.id, "a.mrpack", { name: "보관된 팩", versionId: "9.9", mc: "1.21.1", loader: "fabric", loaderVersion: "0.16.5", fileCount: 0, serverFileCount: 0, totalBytes: 0, overrideCount: 0, suggestedMaxMb: 3072, idealMaxMb: 3072, clientOnlyCount: 0, blockedCount: 0, warnings: [] });
    const job = new CreateJob({ ...input(path.join(root, "s")), modpack: { uploadId: up.id, source: "upload" } });
    expect(job.status().input.modpack).toEqual({ name: "보관된 팩", versionId: "9.9", source: "upload" });
    await dropUpload(up.id);
  });

  it("adds a modpack hint to missing-dependency failures", () => {
    const log = "Missing or unsupported mandatory dependencies:\n\tMod 'x' requires 'y'";
    expect(explainServerFailure(log).hint).not.toMatch(/모드팩/);
    expect(explainServerFailure(log, { modpack: true }).hint).toMatch(/모드팩/);
  });
});

// ---------- 임시 보관소 ----------

describe("modpack upload store", () => {
  afterEach(async () => {
    vi.useRealTimers();
    __resetUploadsForTests();
    await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
  });

  it("stores a stream, enforcing the size limit while streaming", async () => {
    const ok = await storeUpload(Readable.from([Buffer.alloc(100, 1)]), "../../evil/My Pack.mrpack");
    expect(ok.size).toBe(100);
    expect(ok.fileName).toBe("My Pack.mrpack");
    expect(ok.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(path.dirname(ok.file)).toBe(UPLOADS_DIR);
    expect(getUpload(ok.id)).toBe(ok);

    const err = await errOf(storeUpload(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), "big.mrpack", 100));
    expect(err).toBeInstanceOf(ModpackTooLargeError);
    expect(await fsp.readdir(UPLOADS_DIR)).toEqual([path.basename(ok.file)]);

    await dropUpload(ok.id);
    expect(getUpload(ok.id)).toBeUndefined();
    expect(await exists(ok.file)).toBe(false);
  });

  it("expires after the TTL (unless a job is using it) and keeps at most 5", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await storeUpload(Readable.from([Buffer.from("1")]), "1.mrpack");
    const busy = await storeUpload(Readable.from([Buffer.from("2")]), "2.mrpack");
    busy.busy = true;
    vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 1000);
    expect(getUpload(first.id)).toBeUndefined();
    expect(getUpload(busy.id)).toBe(busy);
    busy.busy = false;

    const ids: string[] = [];
    for (let i = 0; i < MAX_STORED_UPLOADS + 1; i++) {
      vi.setSystemTime(Date.now() + 10);
      ids.push((await storeUpload(Readable.from([Buffer.from(String(i))]), `${i}.mrpack`)).id);
    }
    // 오래된 것부터 밀려나서 최근 5개만 남는다
    expect(ids.slice(1).every((id) => getUpload(id))).toBe(true);
    expect(getUpload(ids[0])).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect((await fsp.readdir(UPLOADS_DIR)).filter((f) => f.endsWith(".mrpack")).length).toBe(MAX_STORED_UPLOADS);
  });

  it("sweeps expired uploads and stale files left by an earlier run", async () => {
    const live = await storeUpload(Readable.from([Buffer.from("live")]), "live.mrpack");
    const stale = path.join(UPLOADS_DIR, "oldoldold123.mrpack");
    const fresh = path.join(UPLOADS_DIR, "newnewnew123.mrpack.part");
    await fsp.writeFile(stale, "x");
    await fsp.writeFile(fresh, "x");
    const old = new Date(Date.now() - UPLOAD_TTL_MS - 60_000);
    await fsp.utimes(stale, old, old);
    await sweepUploads();
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(live.file)).toBe(true);
    await sweepUploads(Date.now() + UPLOAD_TTL_MS + 1000);
    expect(await exists(live.file)).toBe(false);
  });

  it("downloads a Modrinth pack only with a matching sha512", async () => {
    const pack = await fsp.readFile(await makePack(baseIndex()));
    PACKS.set("remote.mrpack", pack);
    const url = `${base}/remote.mrpack`;
    const err = await errOf(storeFromUrl(url, "0".repeat(128), pack.length, "remote.mrpack"));
    expect(err.code).toBe("hash_mismatch");
    const up = await storeFromUrl(url, sha512(pack), pack.length, "remote.mrpack");
    expect(up.size).toBe(pack.length);
    expect((await inspectMrpack(up.file, 16384)).name).toBe("테스트 팩");
    const blocked = await errOf(storeFromUrl("https://evil.example.com/p.mrpack", sha512(pack), pack.length, "p.mrpack"));
    expect(blocked.code).toBe("modpack_blocked_host");
  });
});

// ---------- 라우트 ----------

describe("POST /api/create/modpack/upload", () => {
  afterEach(async () => {
    __resetUploadsForTests();
    await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
  });

  function multipartBody(fileName: string, data: Buffer) {
    const boundary = "----bp" + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  it("stores and inspects an uploaded .mrpack; drops it when the pack is invalid", async () => {
    const app = Fastify();
    await app.register(multipart);
    await app.register(createRoutes);
    const good = multipartBody("pack.mrpack", await fsp.readFile(await makePack(baseIndex(), OVERRIDES)));
    const res = await app.inject({ method: "POST", url: "/api/create/modpack/upload", payload: good.body, headers: good.headers });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ fileName: "pack.mrpack", summary: { name: "테스트 팩", loader: "fabric", serverFileCount: 2, clientOnlyCount: 2 } });
    expect(getUpload(r.uploadId)?.summary?.name).toBe("테스트 팩");
    // 판별을 같이 보관하고, 검사가 끝나면 busy 를 푼다
    expect(getUpload(r.uploadId)?.plan).toEqual({ clientFiles: {}, clientEntries: {}, envUnchecked: false });
    expect(getUpload(r.uploadId)?.busy).toBe(false);
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());

    const bad = multipartBody("bad.mrpack", Buffer.from("not a zip"));
    const res2 = await app.inject({ method: "POST", url: "/api/create/modpack/upload", payload: bad.body, headers: bad.headers });
    expect(res2.statusCode).toBeGreaterThanOrEqual(400);
    expect((await fsp.readdir(UPLOADS_DIR)).filter((f) => f !== path.basename(getUpload(r.uploadId)!.file))).toEqual([]);

    const wrongExt = multipartBody("pack.exe", Buffer.from("x"));
    const res3 = await app.inject({ method: "POST", url: "/api/create/modpack/upload", payload: wrongExt.body, headers: wrongExt.headers });
    expect(res3.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });
});

// ---------- 압축 파일 이상 (같은 이름 항목 · 큰 항목) ----------

/** 메모리에 만든 zip (jar 흉내) */
function zipBuffer(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.isBuffer(c) ? c : Buffer.from(c), n);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
  });
}

describe("zip anomalies", () => {
  it("rejects packs with duplicate entry names (also case-insensitive)", async () => {
    const twoIndexes = await zipTo(path.join(root, "dup-index.mrpack"), [
      { name: "modrinth.index.json", data: JSON.stringify(baseIndex()) },
      { name: "modrinth.index.json", data: JSON.stringify(baseIndex({ name: "바꿔치기" })) },
    ]);
    const err = await errOf(readIndex(twoIndexes));
    expect(err.code).toBe("modpack_invalid");
    expect(err.message).toMatch(/같은 이름의 항목이 두 번/);
    const caseDup = await makePack(baseIndex(), [
      { name: "overrides/config/A.txt", data: "1" },
      { name: "overrides/config/a.txt", data: "2" },
    ]);
    expect((await errOf(inspectMrpack(caseDup, 16384))).message).toMatch(/같은 이름의 항목이 두 번/);
  });

  it("readZipEntries stops at maxBytes and returns only the first match", async () => {
    const file = await zipTo(path.join(root, "big-entry.zip"), [
      { name: "a.txt", data: "first" },
      { name: "big.bin", data: Buffer.alloc(200 * 1024, 7) },
    ]);
    await expect(readZipEntries(file, ["big.bin"], { maxBytes: 100 * 1024 })).rejects.toThrow(/너무 커요/);
    expect((await readZipEntries(file, ["big.bin"], { maxBytes: 300 * 1024 })).get("big.bin")?.length).toBe(200 * 1024);
    // 이름 목록을 다 찾으면 멈춘다 (그 뒤 항목은 읽지 않음)
    const early = await readZipEntries(file, ["a.txt"]);
    expect([...early.keys()]).toEqual(["a.txt"]);
  });
});

// ---------- 받기: 크기 상한 · 리다이렉트 ----------

describe("modpack downloads", () => {
  it("stops a download that is larger than the index says", async () => {
    JARS["big.jar"] = Buffer.alloc(200 * 1024, 9);
    const dest = path.join(root, "dl", "big.jar");
    const err = await errOf(downloadFile({ url: `${base}/big.jar`, dest, hash: { algo: "sha512", expected: sha512(JARS["big.jar"]) }, maxBytes: 1024 }));
    expect(err.code).toBe("http_error");
    expect(err.message).toMatch(/알려진 크기보다 커서/);
    expect(await exists(dest)).toBe(false);
    expect(await exists(dest + ".part")).toBe(false);

    // 설치에서도: index 가 1KB 라고 한 파일이 200KB 로 오면 멈춘다
    const index = baseIndex({ files: [{ ...fileEntry("mods/big.jar", "big.jar"), fileSize: 1024 }] });
    const file = await makePack(index);
    const target = path.join(root, "srv-big");
    await fsp.mkdir(target);
    const e2 = await errOf(installModpack(new CreateJob(input(target)), target, file, await inspectMrpack(file, 16384), { uploadId: "testupload01", source: "upload" }));
    expect(e2.message).toMatch(/알려진 크기보다 커서/);
    delete JARS["big.jar"];
  });

  it("follows redirects only to allowed hosts (at most 5 hops)", async () => {
    const hash = { algo: "sha512" as const, expected: sha512(JARS["a.jar"]) };
    const ok = await downloadFile({ url: `${base}/redir-ok/a.jar`, dest: path.join(root, "dl", "ok.jar"), hash, allowRedirect: isAllowedRedirect });
    expect(ok.bytes).toBe(JARS["a.jar"].length);
    const evil = await errOf(downloadFile({ url: `${base}/redir-evil/a.jar`, dest: path.join(root, "dl", "evil.jar"), hash, allowRedirect: isAllowedRedirect }));
    expect(evil.code).toBe("modpack_blocked_host");
    expect(evil.detail).toMatch(/localhost/);
    expect(await exists(path.join(root, "dl", "evil.jar"))).toBe(false);
    const loop = await errOf(downloadFile({ url: `${base}/redir-loop`, dest: path.join(root, "dl", "loop.jar"), hash, allowRedirect: isAllowedRedirect }));
    expect(loop.message).toMatch(/너무 여러 번/);
    // allowRedirect 를 안 주면 예전처럼 따라간다 (다른 배포처 호출은 그대로)
    expect((await downloadFile({ url: `${base}/redir-evil/a.jar`, dest: path.join(root, "dl", "legacy.jar"), hash })).bytes).toBe(JARS["a.jar"].length);

    // 설치 중 리다이렉트가 허용되지 않은 곳이면 실패
    const file = await makePack(baseIndex({ files: [fileEntry("mods/a.jar", "a.jar", { downloads: [`${base}/redir-evil/a.jar`] })] }));
    const target = path.join(root, "srv-redirect");
    await fsp.mkdir(target);
    const err = await errOf(installModpack(new CreateJob(input(target)), target, file, await inspectMrpack(file, 16384), { uploadId: "testupload01", source: "upload" }));
    expect(err.code).toBe("modpack_blocked_host");
    expect(await exists(path.join(target, "mods", "a.jar"))).toBe(false);
  });

  it("allows GitHub asset hosts only as redirect targets from GitHub", () => {
    expect(isAllowedRedirect("https://objects.githubusercontent.com/x/a.jar", "https://github.com/o/r/releases/download/v1/a.jar")).toBe(true);
    expect(isAllowedRedirect("https://release-assets.githubusercontent.com/x/a.jar", "https://github.com/o/r/releases/download/v1/a.jar")).toBe(true);
    expect(isAllowedRedirect("https://objects.githubusercontent.com/x/a.jar", "https://cdn.modrinth.com/data/a.jar")).toBe(false);
    expect(isAllowedRedirect("http://objects.githubusercontent.com/x/a.jar", "https://github.com/o/r/a.jar")).toBe(false);
    expect(isAllowedRedirect("https://evil.example.com/a.jar", "https://github.com/o/r/a.jar")).toBe(false);
    expect(isAllowedRedirect("https://cdn.modrinth.com/data/a.jar", "https://github.com/o/r/a.jar")).toBe(true);
  });
});

// ---------- 서버 보안 파일 · server.properties ----------

describe("protected files and pack server.properties", () => {
  const PACK_PROPS = "level-name=packworld\nonline-mode=false\nenable-rcon=true\nrcon.password=hunter2\nrcon.port=25575\nserver-ip=0.0.0.0\nmanagement-server-enabled=true\nenable-jmx-monitoring=true\nmotd=from pack\n";

  it("classifies paths: protected files, non-server content", () => {
    for (const p of ["eula.txt", "OPS.json", "whitelist.json", "banned-players.json", "banned-ips.json", "usercache.json", "start.sh", "run.bat", "user_jvm_args.txt", "libraries/x/y.jar", "versions/1.21.1/x.jar", "server.jar", ".blockpilot-modpack.json", "config/.blockpilot-backup/x"]) {
      expect(pathSkip(p)?.kind, p).toBe("protected");
    }
    for (const p of ["resourcepacks/a.zip", "shaderpacks/x/shaders/aux.fsh", "options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat", "screenshots/a.png"]) {
      expect(pathSkip(p)?.kind, p).toBe("nonserver");
    }
    for (const p of ["mods/a.jar", "config/options.txt", "datapacks/a.zip", "config/start.toml", "kubejs/server_scripts/a.js"]) expect(pathSkip(p), p).toBeNull();
  });

  it("drops dangerous server.properties keys and unsafe level names", () => {
    const r = sanitizePackProperties(PACK_PROPS);
    expect(r.record).toEqual({ "level-name": "packworld", motd: "from pack" });
    expect(r.dropped).toEqual(["online-mode", "enable-rcon", "rcon.password", "rcon.port", "server-ip", "management-server-enabled", "enable-jmx-monitoring"]);
    expect(sanitizePackProperties("level-name=../../outside\n").dropped).toEqual(["level-name"]);
    expect(sanitizePackProperties("level-name=libraries\n").dropped).toEqual(["level-name"]);
  });

  it("never installs protected files from overrides or the index, and merges the cleaned properties", async () => {
    const index = baseIndex();
    (index.files as unknown[]).push(fileEntry("ops.json", "e.jar"), fileEntry("libraries/evil.jar", "d.jar"));
    const file = await makePack(index, [
      { name: "overrides/eula.txt", data: "eula=true" },
      { name: "overrides/ops.json", data: "[]" },
      { name: "overrides/start.sh", data: "rm -rf ~" },
      { name: "server-overrides/run.bat", data: "evil" },
      { name: "overrides/user_jvm_args.txt", data: "-Dx" },
      { name: "overrides/libraries/x.jar", data: "x" },
      { name: "overrides/evil.jar", data: "x" },
      { name: "overrides/.blockpilot-modpack.json", data: "{}" },
      { name: "overrides/server.properties", data: PACK_PROPS },
      { name: "server-overrides/server.properties", data: "motd=server pack\nenable-query=true\n" },
      { name: "overrides/datapacks/dp.zip", data: "dp" },
    ]);
    const s = await inspectMrpack(file, 16384);
    expect(s.warnings.some((w) => /보안·실행 파일 10개/.test(w))).toBe(true);
    expect(s.warnings).toContain("팩 설정에서 안전하지 않은 값(online-mode, enable-rcon, rcon.password 등)은 빼고 넣었어요.");

    const target = path.join(root, "srv-protected");
    await fsp.mkdir(target);
    await installModpack(new CreateJob(input(target)), target, file, s, { uploadId: "testupload01", source: "upload" }, planFor(s));
    for (const f of ["eula.txt", "ops.json", "start.sh", "run.bat", "user_jvm_args.txt", "libraries", "evil.jar"]) expect(await exists(path.join(target, f)), f).toBe(false);
    expect(await exists(path.join(target, "datapacks", "dp.zip"))).toBe(true);
    const props = await fsp.readFile(path.join(target, "server.properties"), "utf8");
    expect(props).toMatch(/level-name=packworld/);
    expect(props).toMatch(/motd=server pack/);
    expect(props).not.toMatch(/online-mode|rcon|server-ip|enable-query|management-server|jmx/);
    const marker = JSON.parse(await fsp.readFile(path.join(target, MODPACK_MARKER), "utf8")) as ModpackMarker;
    expect(marker.name).toBe("테스트 팩");
    expect(marker.skipped.filter((x) => /보안·실행 파일/.test(x.reason)).map((x) => x.path).sort()).toEqual([".blockpilot-modpack.json", "eula.txt", "evil.jar", "libraries/evil.jar", "libraries/x.jar", "ops.json", "ops.json", "run.bat", "start.sh", "user_jvm_args.txt"].sort());
  });
});

// ---------- Windows 경로 ----------

describe("checkRelPath (Windows edge cases)", () => {
  it.each(["mods/CON", "mods/aux.jar", "config/nul.txt", "config/Com1.json", "LPT9.txt", "config/a.", "config/a ", "config /a.txt"])("rejects %j", (rel) => {
    const err = (() => {
      try {
        checkRelPath(rel);
      } catch (e) {
        return e as CreateError;
      }
    })();
    expect(err?.code).toBe("modpack_invalid");
    expect(err?.detail).toMatch(/Windows/);
  });

  it("rejects paths longer than 200 characters with a clear message", () => {
    const long = `config/${"a".repeat(195)}.txt`;
    try {
      checkRelPath(long);
      expect.unreachable();
    } catch (e) {
      expect((e as CreateError).message).toBe("모드팩 안에 경로가 너무 긴 파일이 있어요.");
      expect((e as CreateError).hint).toMatch(/200자/);
    }
    expect(() => checkRelPath("config/console.json")).not.toThrow();
    expect(() => checkRelPath("config/com10.txt")).not.toThrow();
  });

  it("does not reject Windows-reserved names inside content that is skipped anyway", async () => {
    const file = await makePack(baseIndex(), [{ name: "overrides/shaderpacks/pack/shaders/aux.fsh", data: "x" }]);
    const s = await inspectMrpack(file, 16384);
    expect(s.clientOnlyCount).toBe(3);
    const bad = await makePack(baseIndex(), [{ name: "overrides/config/aux.json", data: "x" }]);
    expect((await errOf(inspectMrpack(bad, 16384))).code).toBe("modpack_invalid");
  });
});

// ---------- 클라이언트 전용 판별 (가짜 Modrinth) ----------

describe("client-only detection", () => {
  let mrServer: http.Server;
  let mrMode: "ok" | "down" | "noenv" = "ok";
  const mrCalls: string[] = [];
  const FABRIC_CLIENT = { "fabric.mod.json": JSON.stringify({ id: "pf", version: "1", environment: "client" }) };
  const FORGE_CLIENT = {
    "META-INF/mods.toml": [
      'modLoader="javafml"',
      "[[mods]]",
      'modId="presencefootsteps"',
      "[[dependencies.presencefootsteps]]",
      '    modId="forge"',
      '    side="CLIENT"',
      "[[dependencies.presencefootsteps]]",
      '    modId="minecraft"',
      '    side="CLIENT"',
    ].join("\n"),
  };
  const FORGE_BOTH = { "META-INF/mods.toml": FORGE_CLIENT["META-INF/mods.toml"].replace(/side="CLIENT"\n(?=\[\[dependencies)/, 'side="BOTH"\n') };
  let jars: Record<string, Buffer> = {};
  const cdn = (vid: string, name: string) => `https://cdn.modrinth.com/data/PROJ${vid.slice(0, 4)}/versions/${vid}/${name}`;
  const ENV: Record<string, string | undefined> = { CLIENT01: "client_only", SERVER01: "server_only", OPTSRV01: "client_only_server_optional", SPONLY01: "singleplayer_only", UNKNWN01: "unknown", NOENV001: undefined };

  beforeAll(async () => {
    jars = {
      fabricClient: await zipBuffer(FABRIC_CLIENT),
      forgeClient: await zipBuffer(FORGE_CLIENT),
      forgeBoth: await zipBuffer(FORGE_BOTH),
      mrClient: await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "zoom", version: "1", environment: "*" }) }),
      serverJar: await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "srv", version: "1", environment: "server" }) }),
    };
    mrServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const u = new URL(req.url!, "http://x");
        mrCalls.push(u.pathname);
        if (mrMode === "down") return res.writeHead(500).end();
        const send = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
        const ver = (id: string) => ({ id, project_id: `PROJ${id.slice(0, 4)}`, version_number: "1", files: [], ...(mrMode === "noenv" || ENV[id] === undefined ? {} : { environment: ENV[id] }) });
        if (u.pathname === "/versions") return send((JSON.parse(u.searchParams.get("ids")!) as string[]).filter((id) => id in ENV).map(ver));
        if (u.pathname === "/version_files") {
          const { hashes } = JSON.parse(body) as { hashes: string[] };
          return send(Object.fromEntries(hashes.filter((h) => h === sha1(jars.mrClient)).map((h) => [h, ver("CLIENT01")])));
        }
        if (u.pathname === "/projects") {
          const ids = JSON.parse(u.searchParams.get("ids")!) as string[];
          return send(ids.map((id) => ({ id, title: id, client_side: "required", server_side: id === "PROJCLIE" || id === "PROJNOEN" ? "unsupported" : "required" })));
        }
        if (u.pathname.startsWith("/version/")) return send({ id: "V1", project_id: "OTHERPRJ", version_number: "1", loaders: ["fabric"], game_versions: ["1.21.1"], files: [] });
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => mrServer.listen(0, "127.0.0.1", r));
    process.env.BLOCKPILOT_MODRINTH_URL = `http://127.0.0.1:${(mrServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.BLOCKPILOT_MODRINTH_URL;
    await new Promise((r) => mrServer.close(r));
  });
  afterEach(() => {
    mrMode = "ok";
    mrCalls.length = 0;
  });

  async function clientPack() {
    const index = baseIndex({
      files: [
        fileEntry("mods/a.jar", "a.jar"),
        // Modrinth CDN 주소의 버전 id 로 환경을 묻는다 (받지는 않으니 주소는 진짜 CDN 모양이면 됨)
        fileEntry("mods/client.jar", "b.jar", { downloads: [cdn("CLIENT01", "client.jar")] }),
        fileEntry("mods/server.jar", "c.jar", { downloads: [cdn("SERVER01", "server.jar")] }),
        fileEntry("mods/opt.jar", "d.jar", { downloads: [cdn("OPTSRV01", "opt.jar")] }),
        fileEntry("mods/sp.jar", "e.jar", { downloads: [cdn("SPONLY01", "sp.jar")] }),
        fileEntry("mods/unknown.jar", "e.jar", { downloads: [cdn("UNKNWN01", "unknown.jar")] }),
        fileEntry("mods/noenv.jar", "e.jar", { downloads: [cdn("NOENV001", "noenv.jar")] }),
      ],
    });
    return makePack(index, [
      { name: "overrides/mods/PresenceFootsteps-fabric.jar", data: jars.fabricClient },
      { name: "overrides/mods/PresenceFootsteps-forge.jar", data: jars.forgeClient },
      { name: "overrides/mods/both-forge.jar", data: jars.forgeBoth },
      { name: "overrides/mods/zoom.jar", data: jars.mrClient },
      { name: "server-overrides/mods/server-tool.jar", data: jars.serverJar },
      { name: "overrides/shaderpacks/a.zip", data: "s" },
      { name: "overrides/options.txt", data: "o" },
    ]);
  }

  it("reads the mod metadata of bundled jars conservatively", async () => {
    expect(await jarClientOnly(jars.fabricClient)).toBe(true);
    expect(await jarClientOnly(jars.forgeClient)).toBe(true);
    expect(await jarClientOnly(jars.forgeBoth)).toBe(false);
    expect(await jarClientOnly(jars.serverJar)).toBe(false);
    expect(await jarClientOnly(Buffer.from("not a zip"))).toBe(false);
    // [[mods]] 가 둘인데 하나만 CLIENT 면 넣는다
    expect(modsTomlClientOnly(FORGE_CLIENT["META-INF/mods.toml"] + '\n[[mods]]\nmodId="other"\n[[dependencies.other]]\nmodId="minecraft"\nside="BOTH"')).toBe(false);
    expect(modsTomlClientOnly('[[mods]]\nmodId="x"')).toBe(false);
    expect(cdnVersionId(["https://cdn.modrinth.com/data/AABBCCDD/versions/EEFFGGHH/a.jar"])).toBe("EEFFGGHH");
    expect(cdnVersionId(["https://github.com/a/b.jar"])).toBeUndefined();
  });

  it("skips client-only files using Modrinth environments and jar metadata", async () => {
    const { summary, plan } = await analyzeMrpack(await clientPack(), 16384);
    expect(plan.envUnchecked).toBe(false);
    expect(Object.keys(plan.clientFiles).sort()).toEqual(["mods/client.jar", "mods/noenv.jar", "mods/sp.jar"]);
    expect(plan.clientFiles["mods/sp.jar"]).toBe("싱글플레이 전용 (Modrinth)");
    expect(plan.clientEntries).toEqual({
      "overrides/mods/PresenceFootsteps-fabric.jar": "클라이언트 전용 (모드 정보)",
      "overrides/mods/PresenceFootsteps-forge.jar": "클라이언트 전용 (모드 정보)",
      "overrides/mods/zoom.jar": "클라이언트 전용 (Modrinth)",
    });
    // 받는 것: a, server, opt(서버 선택), unknown
    expect(summary.serverFileCount).toBe(4);
    // index 3 + overrides jar 3 + 셰이더 1 + options.txt 1
    expect(summary.clientOnlyCount).toBe(8);
    expect(summary.warnings).toEqual([]);
    // NOENV001 은 environment 가 없어 프로젝트로 확인
    expect(mrCalls).toEqual(["/versions", "/version_files", "/projects"]);
  });

  it("falls back to project server_side when versions have no environment field", async () => {
    mrMode = "noenv";
    const { plan } = await analyzeMrpack(await clientPack(), 16384);
    // 프로젝트 기준으로는 PROJCLIE(CLIENT01·zoom)·PROJNOEN 만 서버 미지원
    expect(Object.keys(plan.clientFiles).sort()).toEqual(["mods/client.jar", "mods/noenv.jar"]);
    expect(plan.clientEntries["overrides/mods/zoom.jar"]).toBe("클라이언트 전용 (Modrinth)");
  });

  it("does not fail when Modrinth is down — warns and still uses jar metadata", async () => {
    mrMode = "down";
    const { summary, plan } = await analyzeMrpack(await clientPack(), 16384);
    expect(plan.envUnchecked).toBe(true);
    expect(plan.clientFiles).toEqual({});
    expect(Object.keys(plan.clientEntries).sort()).toEqual(["overrides/mods/PresenceFootsteps-fabric.jar", "overrides/mods/PresenceFootsteps-forge.jar"]);
    expect(summary.warnings[0]).toMatch(/^Modrinth 에 연결하지 못해 클라이언트 전용 모드를 거르지 못했어요/);
    expect(summary.serverFileCount).toBe(7);
  });

  it("reuses a stored decision without asking Modrinth again, and installs accordingly", async () => {
    const file = await clientPack();
    const first = await analyzeMrpack(file, 16384);
    mrCalls.length = 0;
    mrMode = "down";
    const again = await analyzeMrpack(file, 16384, { plan: first.plan });
    expect(mrCalls).toEqual([]);
    expect(again.summary).toEqual(first.summary);

    // 설치: 판별대로 overrides 의 클라이언트 전용 jar 를 풀지 않는다 (index 의 CDN 파일은 받지 않게 판별에서 뺀 것만 확인)
    const plan = { ...first.plan, clientFiles: { ...first.plan.clientFiles, "mods/server.jar": "x", "mods/opt.jar": "x", "mods/unknown.jar": "x" } };
    const target = path.join(root, "srv-client");
    await fsp.mkdir(target);
    const job = new CreateJob(input(target));
    await installModpack(job, target, file, first.summary, { uploadId: "testupload01", source: "upload" }, plan);
    expect(mrCalls).toEqual([]);
    expect((await fsp.readdir(path.join(target, "mods"))).sort()).toEqual(["a.jar", "both-forge.jar", "server-tool.jar"]);
    expect(await exists(path.join(target, "shaderpacks"))).toBe(false);
    expect(await exists(path.join(target, "options.txt"))).toBe(false);
    const marker = JSON.parse(await fsp.readFile(path.join(target, MODPACK_MARKER), "utf8")) as ModpackMarker;
    expect(marker.skipped).toContainEqual({ path: "mods/PresenceFootsteps-fabric.jar", reason: "클라이언트 전용 (모드 정보) · 팩에 들어 있던 파일" });
    expect(marker.skipped).toContainEqual({ path: "shaderpacks/", reason: "셰이더팩 (서버에 필요 없음) · 파일 1개" });
  });

  it("keeps the decision with the stored upload (rememberSummary)", async () => {
    const file = await clientPack();
    const up = await storeUpload(fs.createReadStream(file), "c.mrpack");
    const s = await inspectMrpack(up.file, 16384);
    rememberSummary(up.id, "c.mrpack", s);
    expect(getUpload(up.id)?.plan?.clientFiles["mods/client.jar"]).toBe("클라이언트 전용 (Modrinth)");
    await dropUpload(up.id);
  });

  it("checks that the Modrinth version belongs to the chosen project", async () => {
    await expect(getModpackVersionFile("V1", "MYPROJ01")).rejects.toMatchObject({ statusCode: 400, code: "modpack_mismatch" });
  });
});

// ---------- 로더 버전 미리 확인 ----------

describe("precheckLoader", () => {
  const summary = () => ({ name: "p", versionId: "1", mc: "1.21.1", loader: "fabric" as const, loaderVersion: "0.99.0", fileCount: 0, serverFileCount: 0, totalBytes: 0, overrideCount: 0, suggestedMaxMb: 3072, idealMaxMb: 3072, clientOnlyCount: 0, blockedCount: 0, warnings: [] as string[] });

  it("turns a missing loader version into modpack_unsupported and network trouble into a warning", async () => {
    const missing = await errOf(precheckLoader(summary(), { assertVersion: async () => Promise.reject(new CreateError("not_found", "없음")) }));
    expect(missing.code).toBe("modpack_unsupported");
    expect(missing.message).toMatch(/Fabric 0\.99\.0/);
    const s = summary();
    await precheckLoader(s, { assertVersion: async () => Promise.reject(new CreateError("network", "끊김")) });
    expect(s.warnings[0]).toMatch(/미리 확인하지 못했어요/);
    const ok = summary();
    await precheckLoader(ok, { assertVersion: async () => {} });
    expect(ok.warnings).toEqual([]);
  });
});

// ---------- 보관소: 동시 업로드 · 수명 ----------

describe("modpack upload store limits", () => {
  afterEach(async () => {
    vi.useRealTimers();
    __resetUploadsForTests();
    await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
  });

  it("allows only two uploads in flight and counts them toward the limit", async () => {
    const olds: string[] = [];
    for (let i = 0; i < MAX_STORED_UPLOADS - 1; i++) olds.push((await storeUpload(Readable.from([Buffer.from(String(i))]), `${i}.mrpack`)).id);
    const { PassThrough } = await import("node:stream");
    const s1 = new PassThrough();
    const s2 = new PassThrough();
    const p1 = storeUpload(s1, "p1.mrpack", undefined, { hold: true });
    await new Promise((r) => setTimeout(r, 20));
    // 4 + 받는 중 1 = 5 → 아직 밀어내지 않음
    expect(getUpload(olds[0])).toBeDefined();
    const p2 = storeUpload(s2, "p2.mrpack", undefined, { hold: true });
    await new Promise((r) => setTimeout(r, 20));
    // 4 + 받는 중 2 = 6 → 가장 오래된 것을 밀어냄
    expect(getUpload(olds[0])).toBeUndefined();
    expect(MAX_PENDING_UPLOADS).toBe(2);
    expect(await errOf(storeUpload(Readable.from([Buffer.from("x")]), "p3.mrpack"))).toBeInstanceOf(ModpackBusyError);
    s1.end("one");
    s2.end("two");
    const [u1, u2] = await Promise.all([p1, p2]);
    // 검사 중(hold)인 것은 밀려나지 않는다
    expect(u1.busy && u2.busy).toBe(true);
    for (let i = 0; i < 3; i++) await storeUpload(Readable.from([Buffer.from("n")]), "n.mrpack");
    expect(getUpload(u1.id)).toBe(u1);
    expect(getUpload(u2.id)).toBe(u2);
  });

  it("refreshes the expiry when a job or inspection releases the pack", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const up = await storeUpload(Readable.from([Buffer.from("x")]), "x.mrpack", undefined, { hold: true });
    vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 1000);
    // 검사·만들기 중이면 만료되지 않는다
    expect(getUpload(up.id)).toBe(up);
    releaseUpload(up.id);
    expect(up.busy).toBe(false);
    expect(up.expiresAt).toBe(Date.now() + UPLOAD_TTL_MS);
    expect(getUpload(up.id)).toBe(up);
  });
});

// ---------- 서버 정보에 모드팩 표시 ----------

describe("ServerSummary.modpack", () => {
  it("reads the marker (cached by mtime) and ignores broken ones", async () => {
    const dir = path.join(root, "srv-marker");
    await fsp.mkdir(dir, { recursive: true });
    expect(await readModpackMarker(dir)).toBeUndefined();
    const marker: ModpackMarker = { name: "팩", versionId: "1.0", source: "modrinth", projectId: "proj1", modrinthVersionId: "ver1", installedAt: new Date().toISOString(), serverFileCount: 1, skipped: [] };
    await fsp.writeFile(path.join(dir, MODPACK_MARKER), JSON.stringify(marker));
    expect(await readModpackMarker(dir)).toEqual({ name: "팩", versionId: "1.0", projectId: "proj1", modrinthVersionId: "ver1" });

    const s = await addServer({ path: dir, name: "marker" });
    const app = Fastify();
    await app.register(serversRoutes);
    const res = await app.inject({ url: `/api/servers/${s.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().modpack).toEqual({ name: "팩", versionId: "1.0", projectId: "proj1", modrinthVersionId: "ver1" });
    await app.close();

    await fsp.writeFile(path.join(dir, MODPACK_MARKER), "{ broken");
    await fsp.utimes(path.join(dir, MODPACK_MARKER), new Date(), new Date(Date.now() + 5000));
    expect(await readModpackMarker(dir)).toBeUndefined();
    await fsp.writeFile(path.join(dir, MODPACK_MARKER), JSON.stringify({ name: "x", versionId: "1", projectId: "../evil" }));
    await fsp.utimes(path.join(dir, MODPACK_MARKER), new Date(), new Date(Date.now() + 10000));
    expect(await readModpackMarker(dir)).toEqual({ name: "x", versionId: "1" });
  });
});
