import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import yazl from "yazl";
import type { CreateServerInput, ModpackMarker } from "@blockpilot/shared";
import { createPipeline, defaultDeps, type PipelineDeps } from "../src/services/create/pipeline.js";
import { CreateJob } from "../src/services/create/job.js";
import { CreateError } from "../src/services/create/errors.js";
import { MODPACK_MARKER, inspectMrpack } from "../src/services/create/modpack.js";
import { UPLOADS_DIR, UPLOAD_TTL_MS, __resetUploadsForTests, getUpload, rememberSummary, storeUpload, type StoredUpload } from "../src/services/create/modpackUpload.js";
import { providers } from "../src/services/create/loaders/index.js";
import type { LoaderProvider } from "../src/services/create/loaders/types.js";
import { systemInfo } from "../src/services/platform/index.js";

/**
 * 모드팩으로 만들기 전체 흐름 (createPipeline) — 로더 설치·Java·첫 실행은 가짜로, 모드팩 단계는 진짜로.
 * 받는 파일은 로컬 HTTP 서버, Modrinth 는 가짜 API (BLOCKPILOT_MODRINTH_URL).
 */

const sha = (b: Buffer, a: string) => createHash(a).update(b).digest("hex");
const MOD_A = Buffer.alloc(16 * 1024, 1);
const MOD_CLIENT = Buffer.alloc(8 * 1024, 2);
const DATAPACK = Buffer.alloc(1024, 3);

let files: http.Server;
let modrinth: http.Server;
let base = "";
let root = "";
const mrCalls: string[] = [];

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

const entry = (p: string, buf: Buffer, downloads: string[]) => ({ path: p, hashes: { sha1: sha(buf, "sha1"), sha512: sha(buf, "sha512") }, downloads, fileSize: buf.length });

async function makePack(): Promise<string> {
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: "2.0.0",
    name: "파이프라인 팩",
    files: [
      entry("mods/a.jar", MOD_A, [`${base}/a.jar`]),
      // Modrinth 가 client_only 라고 하는 모드 (검사 때 판별 → 만들 때는 묻지 않고 뺀다)
      entry("mods/client.jar", MOD_CLIENT, ["https://cdn.modrinth.com/data/PROJCLIE/versions/CLIENT01/client.jar"]),
      entry("datapacks/dp.zip", DATAPACK, [`${base}/dp.zip`]),
    ],
    dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.5" },
  };
  const z = new yazl.ZipFile();
  const add = (name: string, data: string | Buffer) => z.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
  add("modrinth.index.json", JSON.stringify(index));
  add("overrides/config/pack.toml", "x=1");
  add("overrides/server.properties", "level-name=packworld\nonline-mode=false\nenable-rcon=true\nrcon.password=hunter2\nmotd=from pack\n");
  add("overrides/eula.txt", "eula=false");
  add("overrides/start.sh", "echo pack script");
  add("overrides/start.bat", "echo pack script");
  add("overrides/mods/PresenceFootsteps.jar", await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "pf", version: "1", environment: "client" }) }));
  add("overrides/shaderpacks/s.zip", "s");
  z.end();
  const file = path.join(root, `pack-${Date.now()}-${Math.random().toString(16).slice(2)}.mrpack`);
  await pipeline(z.outputStream as unknown as NodeJS.ReadableStream, fs.createWriteStream(file));
  return file;
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mrpack-pipe-"));
  files = http.createServer((req, res) => {
    const body = ({ "/a.jar": MOD_A, "/dp.zip": DATAPACK } as Record<string, Buffer>)[req.url ?? ""];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((r) => files.listen(0, "127.0.0.1", r));
  const hp = `127.0.0.1:${(files.address() as AddressInfo).port}`;
  base = `http://${hp}`;
  process.env.BLOCKPILOT_MODPACK_EXTRA_HOSTS = hp;

  modrinth = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    mrCalls.push(u.pathname);
    if (u.pathname === "/versions") {
      const ids = JSON.parse(u.searchParams.get("ids")!) as string[];
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ids.map((id) => ({ id, project_id: "PROJCLIE", files: [], environment: id === "CLIENT01" ? "client_only" : "client_and_server" }))));
    }
    if (u.pathname === "/version_files") return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => modrinth.listen(0, "127.0.0.1", r));
  process.env.BLOCKPILOT_MODRINTH_URL = `http://127.0.0.1:${(modrinth.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.BLOCKPILOT_MODPACK_EXTRA_HOSTS;
  delete process.env.BLOCKPILOT_MODRINTH_URL;
  await new Promise((r) => files.close(r));
  await new Promise((r) => modrinth.close(r));
  await fsp.rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  __resetUploadsForTests();
  await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** 설치기·서버를 띄우지 않는 Fabric 공급자 */
const fakeFabric: LoaderProvider = {
  info: providers.fabric.info,
  listReleases: async () => [],
  listVersions: async () => ({ versions: [] }),
  javaMajor: async () => 21,
  downloadEstimate: async () => ({ mb: 0 }),
  assertVersion: async () => {},
  install: async ({ job, target }) => {
    job.startStep("server-jar");
    await fsp.writeFile(path.join(target, "server.jar"), "vanilla");
    job.finishStep("server-jar");
    job.startStep("loader");
    await fsp.writeFile(path.join(target, "fabric-server-launch.jar"), "fabric");
    job.finishStep("loader");
    return { kind: "jar", jar: "fabric-server-launch.jar" };
  },
};

interface Snapshot {
  files: string[];
  props: string;
  eula: string;
  script: string;
  scriptName: string;
  isModpack: boolean;
}

function deps(firstRun: (target: string, scriptName: string, isModpack: boolean) => Promise<void>): PipelineDeps {
  return {
    ...defaultDeps,
    getVersionInfo: async (id: string) => ({ id, javaMajor: 21, server: { url: `${base}/server.jar`, sha1: "0".repeat(40), size: 1 } }),
    findSystemJava: async () => ({ path: "/fake/jdk/bin/java", version: "21.0.4", major: 21, source: "system" as const }),
    findCachedRuntime: async () => null,
    installRuntime: async () => {
      throw new Error("Java 를 받으면 안 돼요");
    },
    providers: { ...defaultDeps.providers, fabric: fakeFabric },
    firstRun: async (_job, target, scriptName, _t, isModpack) => firstRun(target, scriptName, !!isModpack),
  };
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else out.push(r);
  }
  return out.sort();
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

async function preparedUpload(): Promise<StoredUpload> {
  const pack = await makePack();
  const up = await storeUpload(fs.createReadStream(pack), "pipe.mrpack");
  const summary = await inspectMrpack(up.file, Math.floor(os.totalmem() / 1048576));
  rememberSummary(up.id, "pipe.mrpack", summary);
  return up;
}

async function inputFor(up: StoredUpload, target: string): Promise<CreateServerInput> {
  return {
    path: target,
    name: path.basename(target),
    loader: "fabric",
    mcVersion: "1.21.1",
    loaderVersion: "0.16.5",
    memory: { minMb: 1024, maxMb: 2048 },
    properties: { "server-port": String(await freePort()) },
    modpack: { uploadId: up.id, source: "upload" },
    eulaAccepted: true,
  };
}

describe.runIf(systemInfo().support.create)("createPipeline with a modpack", () => {
  it("installs the pack before writing config, uses the stored client-only decision, moves datapacks into the pack's world", async () => {
    const up = await preparedUpload();
    expect(up.plan?.clientFiles["mods/client.jar"]).toBe("클라이언트 전용 (Modrinth)");
    expect(up.summary?.clientOnlyCount).toBe(3);
    mrCalls.length = 0;

    const target = path.join(root, "srv-ok");
    let snap: Snapshot | undefined;
    const job = new CreateJob(await inputFor(up, target));
    await job.run(
      createPipeline(
        deps(async (t, scriptName, isModpack) => {
          snap = {
            files: await walk(t),
            props: await fsp.readFile(path.join(t, "server.properties"), "utf8"),
            eula: await fsp.readFile(path.join(t, "eula.txt"), "utf8"),
            script: await fsp.readFile(path.join(t, scriptName), "utf8"),
            scriptName,
            isModpack,
          };
          // 서버가 월드를 만든 것처럼
          await fsp.writeFile(path.join(t, "packworld", "level.dat"), "w");
        }),
      ),
    );
    const st = job.status();
    expect(st.error, JSON.stringify(st.error)).toBeUndefined();
    expect(st.state).toBe("succeeded");

    // 만들 때 Modrinth 에 다시 묻지 않았다
    expect(mrCalls).toEqual([]);

    // 단계 순서: 모드팩 모드·설정 → 설정 파일 (팩의 eula·시작 스크립트는 애초에 넣지 않고, BlockPilot 이 쓴 것만)
    const started = job.log.filter((l) => l.startsWith("▶ ")).map((l) => l.slice(2).split(" — ")[0]);
    expect(started.indexOf("모드팩 모드·설정 넣기")).toBeGreaterThan(started.indexOf("Fabric 설치"));
    expect(started.indexOf("설정 파일 작성")).toBeGreaterThan(started.indexOf("모드팩 모드·설정 넣기"));
    expect(started.indexOf("모드팩 확인")).toBe(1);

    expect(snap!.isModpack).toBe(true);
    expect(snap!.eula).toMatch(/^eula=true$/m);
    expect(snap!.script).toContain("/fake/jdk/bin/java");
    expect(snap!.script).not.toContain("pack script");
    // 팩 server.properties 의 level-name 을 쓰고, 위험한 값은 빠졌다
    expect(snap!.props).toMatch(/level-name=packworld/);
    expect(snap!.props).toMatch(/motd=from pack/);
    expect(snap!.props).not.toMatch(/online-mode|rcon/);
    // 데이터팩은 첫 실행 전에 팩의 월드로
    expect(snap!.files).toContain("packworld/datapacks/dp.zip");
    expect(snap!.files).not.toContain("datapacks/dp.zip");
    // 클라이언트 전용(Modrinth 판별·jar 정보)·셰이더는 없다
    expect(snap!.files.filter((f) => f.startsWith("mods/"))).toEqual(["mods/a.jar"]);
    expect(snap!.files.some((f) => f.startsWith("shaderpacks"))).toBe(false);
    expect(st.steps.find((s) => s.id === "config")?.note).toMatch(/데이터팩 1개를 월드에 넣음/);

    const marker = JSON.parse(await fsp.readFile(path.join(target, MODPACK_MARKER), "utf8")) as ModpackMarker;
    expect(marker.skipped).toEqual(
      expect.arrayContaining([
        { path: "mods/client.jar", reason: "클라이언트 전용 (Modrinth)" },
        { path: "mods/PresenceFootsteps.jar", reason: "클라이언트 전용 (모드 정보) · 팩에 들어 있던 파일" },
        { path: "eula.txt", reason: "서버 보안·실행 파일이라 팩 것을 쓰지 않음 · 팩에 들어 있던 파일" },
      ]),
    );
    // 성공하면 임시 팩은 지운다
    expect(getUpload(up.id)).toBeUndefined();
    expect(await exists(up.file)).toBe(false);
  });

  it("cleans mods/ and the marker on failure, releases the pack and restarts its expiry", async () => {
    const up = await preparedUpload();
    mrCalls.length = 0;
    // 곧 만료될 팩이었다고 치고
    up.expiresAt = Date.now() + 1000;
    const target = path.join(root, "srv-fail");
    let sawBusy = false;
    let sawInstalled = false;
    const job = new CreateJob(await inputFor(up, target));
    await job.run(
      createPipeline(
        deps(async (t) => {
          sawBusy = getUpload(up.id)?.busy === true;
          sawInstalled = (await exists(path.join(t, "mods", "a.jar"))) && (await exists(path.join(t, MODPACK_MARKER)));
          throw new CreateError("server_exited", "서버가 준비를 마치기 전에 꺼졌어요.");
        }),
      ),
    );
    expect(job.status().state).toBe("failed");
    expect(sawBusy).toBe(true);
    expect(sawInstalled).toBe(true);
    expect(mrCalls).toEqual([]);
    // 이번에 만든 폴더는 통째로 정리
    expect(await exists(path.join(target, "mods"))).toBe(false);
    expect(await exists(path.join(target, MODPACK_MARKER))).toBe(false);
    expect(await exists(target)).toBe(false);
    // 같은 팩으로 다시 시도할 수 있게: busy 해제, 만료는 지금부터 다시 1시간
    const again = getUpload(up.id)!;
    expect(again.busy).toBe(false);
    expect(again.expiresAt).toBeGreaterThan(Date.now() + UPLOAD_TTL_MS - 60_000);
    expect(await exists(up.file)).toBe(true);
  });
});
