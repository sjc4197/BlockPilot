import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import yazl from "yazl";
import yauzl from "yauzl";
import { MrpackIndex } from "@blockpilot/shared";
import Fastify from "fastify";
import { buildMrpack, exportVersionId, looksSecret } from "../src/services/modpackExport.js";
import { attachmentHeader, modsRoutes } from "../src/routes/mods.js";
import { addServer } from "../src/config/store.js";

const h = (b: Buffer, a: string) => createHash(a).update(b).digest("hex");
const KNOWN_A = Buffer.from("PK-fake-jar-known-a");
const KNOWN_B = Buffer.from("PK-fake-jar-known-b");
const UNKNOWN = Buffer.from("PK-fake-jar-unknown");
const DISABLED = Buffer.from("PK-fake-jar-disabled-but-known");

/** 진짜 zip 형식의 jar (fabric.mod.json 포함) */
function jarWith(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.from(c), n);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
  });
}

let base = "";
let server: http.Server;
let mode: "ok" | "down" = "ok";
const calls: { path: string; body: string }[] = [];
const VERS: Record<string, any> = {};
function ver(id: string, pid: string, name: string, buf: Buffer) {
  return {
    id,
    project_id: pid,
    version_number: "1.0",
    loaders: ["fabric"],
    game_versions: ["1.21.1"],
    // 다른 파일(소스 jar)이 먼저 오고, 우리 sha1 과 같은 파일은 두 번째
    files: [
      { url: `https://cdn.modrinth.com/data/${pid}/versions/${id}/${name}-sources.jar`, filename: `${name}-sources.jar`, primary: false, size: 1, hashes: { sha1: "0".repeat(40), sha512: "0".repeat(128) } },
      { url: `https://cdn.modrinth.com/data/${pid}/versions/${id}/${name}.jar`, filename: `${name}.jar`, primary: true, size: buf.length, hashes: { sha1: h(buf, "sha1"), sha512: h(buf, "sha512") } },
    ],
    dependencies: [],
  };
}
VERS[h(KNOWN_A, "sha1")] = ver("VA", "PA", "known-a", KNOWN_A);
VERS[h(KNOWN_B, "sha1")] = ver("VB", "PB", "known-b", KNOWN_B);
VERS[h(DISABLED, "sha1")] = ver("VD", "PD", "disabled", DISABLED);
const PROJECTS = [
  { id: "PA", title: "A", client_side: "required", server_side: "required" },
  { id: "PB", title: "B", client_side: "optional", server_side: "unknown" },
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url!, base);
      calls.push({ path: u.pathname + u.search, body });
      if (mode === "down") return res.writeHead(500).end();
      const send = (o: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (u.pathname === "/version_files") {
        const { hashes, algorithm } = JSON.parse(body);
        if (algorithm !== "sha1") return res.writeHead(400).end();
        return send(Object.fromEntries((hashes as string[]).filter((s) => VERS[s]).map((s) => [s, VERS[s]])));
      }
      if (u.pathname === "/projects") {
        const ids = JSON.parse(u.searchParams.get("ids")!) as string[];
        return send(PROJECTS.filter((p) => ids.includes(p.id)));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BLOCKPILOT_MODRINTH_URL = base;
});
afterAll(() => {
  server.close();
  delete process.env.BLOCKPILOT_MODRINTH_URL;
});
beforeEach(() => {
  mode = "ok";
  calls.length = 0;
});

async function write(dir: string, rel: string, data: string | Buffer = "") {
  const p = path.join(dir, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, data);
}

/** Fabric 1.21.1 / loader 0.16.10 서버 폴더 */
async function fabricServer() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mrpack-"));
  await write(dir, "fabric-server-launch.jar");
  await fsp.mkdir(path.join(dir, "versions/1.21.1"), { recursive: true });
  await fsp.mkdir(path.join(dir, "libraries/net/fabricmc/fabric-loader/0.16.10"), { recursive: true });
  await write(dir, "mods/known-a.jar", KNOWN_A);
  await write(dir, "mods/known-b.jar", KNOWN_B);
  await write(dir, "mods/unknown.jar", UNKNOWN);
  await write(dir, "mods/server-tool.jar", await jarWith({ "fabric.mod.json": JSON.stringify({ id: "servertool", version: "1.0", environment: "server" }) }));
  await write(dir, "mods/disabled.jar.disabled", DISABLED);
  await write(dir, "config/a.json", "{}");
  await write(dir, "config/sub/b.toml", "x=1");
  await write(dir, "config/discord-webhook.json", "{}");
  await write(dir, "config/sub/api_TOKEN.txt", "secret");
  await write(dir, "config/big.json", Buffer.alloc(1024 * 1024 + 1));
  await write(dir, "world/level.dat", "w");
  await write(dir, "logs/latest.log", "l");
  return dir;
}

async function readZip(stream: NodeJS.ReadableStream): Promise<Map<string, Buffer>> {
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, s) => {
          if (err2 || !s) return reject(err2);
          const cs: Buffer[] = [];
          s.on("data", (c: Buffer) => cs.push(c));
          s.on("end", () => {
            out.set(e.fileName, Buffer.concat(cs));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("buildMrpack", () => {
  it("links Modrinth jars, bundles the rest, and leaves out disabled mods and config by default", async () => {
    const dir = await fabricServer();
    const r = await buildMrpack({ dir, name: "우리 서버" });
    expect(r.offline).toBe(false);
    expect(r.stats).toEqual({ modrinth: 2, bundled: 2, serverOnly: 1 });
    expect(r.fileName).toMatch(/^우리 서버-\d{4}\.\d{2}\.\d{2}-\d{4}\.mrpack$/);
    const z = await readZip(r.stream);
    const index = MrpackIndex.parse(JSON.parse(z.get("modrinth.index.json")!.toString("utf8")));
    expect(index).toMatchObject({ formatVersion: 1, game: "minecraft", name: "우리 서버", dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.10" } });
    expect(index.versionId).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{4}$/);
    const byPath = Object.fromEntries(index.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["mods/known-a.jar", "mods/known-b.jar"]);
    expect(byPath["mods/known-a.jar"]).toEqual({
      path: "mods/known-a.jar",
      hashes: { sha1: h(KNOWN_A, "sha1"), sha512: h(KNOWN_A, "sha512") },
      env: { client: "required", server: "required" },
      downloads: ["https://cdn.modrinth.com/data/PA/versions/VA/known-a.jar"],
      fileSize: KNOWN_A.length,
    });
    expect(byPath["mods/known-b.jar"].env).toEqual({ client: "optional", server: "required" });
    expect(z.get("overrides/mods/unknown.jar")).toEqual(UNKNOWN);
    expect(z.has("server-overrides/mods/server-tool.jar")).toBe(true);
    const names = [...z.keys()];
    expect(names.some((n) => n.includes("disabled"))).toBe(false);
    expect(names.some((n) => n.includes("config/") || n.includes("world") || n.includes("logs"))).toBe(false);
    expect(z.get("README.txt")!.toString("utf8")).toContain("파일에서 추가");
    // sha1 으로 물어봤고, 끈 모드는 묻지도 않았다
    const asked = JSON.parse(calls.find((c) => c.path === "/version_files")!.body);
    expect(asked.algorithm).toBe("sha1");
    expect(asked.hashes).toHaveLength(4);
    expect(asked.hashes).not.toContain(h(DISABLED, "sha1"));
  });

  it("bundles everything and flags offline when Modrinth fails", async () => {
    const dir = await fabricServer();
    mode = "down";
    const r = await buildMrpack({ dir, name: "srv" });
    expect(r.offline).toBe(true);
    expect(r.stats).toEqual({ modrinth: 0, bundled: 4, serverOnly: 1 });
    const z = await readZip(r.stream);
    expect(MrpackIndex.parse(JSON.parse(z.get("modrinth.index.json")!.toString("utf8"))).files).toEqual([]);
    expect([...z.keys()].filter((n) => n.startsWith("overrides/mods/")).sort()).toEqual(["overrides/mods/known-a.jar", "overrides/mods/known-b.jar", "overrides/mods/unknown.jar"]);
    expect(z.has("server-overrides/mods/server-tool.jar")).toBe(true);
  });

  it("includes config when asked, skipping secret-looking and large files", async () => {
    const dir = await fabricServer();
    const r = await buildMrpack({ dir, name: "srv", includeConfig: true });
    const z = await readZip(r.stream);
    expect([...z.keys()].filter((n) => n.includes("config/")).sort()).toEqual(["overrides/config/a.json", "overrides/config/sub/b.toml"]);
    expect(r.excluded.sort()).toEqual(["discord-webhook.json", "sub/api_TOKEN.txt"]);
  });

  it("scans config contents for secrets, leaves those files out and lists them in README.txt", async () => {
    const dir = await fabricServer();
    await write(dir, "config/bot.json", JSON.stringify({ "token": "abcdefghijkl", "enabled": true }));
    await write(dir, "config/db.properties", "url=jdbc:mysql://db.local/mc\n");
    await write(dir, "config/hook.toml", 'url = "https://discord.com/api/webhooks/123/abc"\n');
    await write(dir, "config/sub/creds.cfg", "password = hunter2hunter2\n");
    await write(dir, "config/discordbot.txt", `bot=${"M" + "a".repeat(23)}.${"b".repeat(6)}.${"c".repeat(27)}\n`);
    await write(dir, "config/apikey.yml", "api_key: 1234567890\n");
    // 비밀처럼 보이지 않는 것: 짧은 값, 숫자 설정, 이름만 비슷한 키
    await write(dir, "config/fine.json", JSON.stringify({ requireToken: false, maxTokens: 100000, password: "" }));
    const r = await buildMrpack({ dir, name: "srv", includeConfig: true });
    const z = await readZip(r.stream);
    expect([...z.keys()].filter((n) => n.includes("config/")).sort()).toEqual(["overrides/config/a.json", "overrides/config/fine.json", "overrides/config/sub/b.toml"]);
    expect(r.excluded.sort()).toEqual(["apikey.yml", "bot.json", "db.properties", "discord-webhook.json", "discordbot.txt", "hook.toml", "sub/api_TOKEN.txt", "sub/creds.cfg"]);
    const readme = z.get("README.txt")!.toString("utf8");
    expect(readme).toContain("넣지 않은 설정 파일 (8개)");
    expect(readme).toContain("  - config/sub/creds.cfg");
    expect(readme).not.toContain("hunter2");
  });

  it("recognises secret patterns", () => {
    expect(looksSecret('"webhook": "https://x.example/abcdef"')).toBe(true);
    expect(looksSecret("passwd=abcdef")).toBe(true);
    expect(looksSecret("API-KEY: abcdefgh")).toBe(true);
    expect(looksSecret("https://discordapp.com/api/webhooks/1/x")).toBe(true);
    expect(looksSecret("jdbc:postgresql://h/db")).toBe(true);
    expect(looksSecret("token=abc")).toBe(false);
    expect(looksSecret('{"tokens": 12345678}')).toBe(false);
  });

  it("strips the Minecraft prefix from the Forge version", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mrpack-forge-"));
    await fsp.mkdir(path.join(dir, "libraries/net/minecraftforge/forge/1.20.1-47.3.0"), { recursive: true });
    await write(dir, "mods/known-a.jar", KNOWN_A);
    const r = await buildMrpack({ dir, name: "forge" });
    const z = await readZip(r.stream);
    const index = MrpackIndex.parse(JSON.parse(z.get("modrinth.index.json")!.toString("utf8")));
    expect(index.dependencies).toEqual({ minecraft: "1.20.1", forge: "47.3.0" });
  });

  it("refuses servers that are not Fabric/Forge/NeoForge or whose versions are unknown", async () => {
    const paper = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mrpack-paper-"));
    await write(paper, "paper-1.21.1-100.jar");
    await expect(buildMrpack({ dir: paper, name: "p" })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Fabric·Forge·NeoForge") });
    const fabric = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mrpack-nover-"));
    await write(fabric, "fabric-server-launch.jar");
    await expect(buildMrpack({ dir: fabric, name: "f" })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("한 번 켠 뒤") });
  });

  it("formats the version id as YYYY.MM.DD-HHmm", () => {
    expect(exportVersionId(new Date(2026, 0, 5, 7, 3))).toBe("2026.01.05-0703");
  });
});

describe("GET /api/servers/:id/mods/export.mrpack", () => {
  it("streams the pack with a Korean file name and notes when Modrinth was offline", async () => {
    const dir = await fabricServer();
    const s = await addServer({ path: dir, name: "우리 서버" });
    const app = Fastify();
    await app.register(modsRoutes);
    const ok = await app.inject({ url: `/api/servers/${s.id}/mods/export.mrpack?config=1` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/x-modrinth-modpack+zip");
    expect(ok.headers["content-disposition"]).toMatch(/^attachment; filename="modpack-\d{4}\.\d{2}\.\d{2}-\d{4}\.mrpack"; filename\*=UTF-8''%EC%9A%B0%EB%A6%AC%20%EC%84%9C%EB%B2%84-.*\.mrpack$/);
    expect(ok.headers["x-blockpilot-note"]).toBeUndefined();
    expect(ok.headers["x-blockpilot-excluded"]).toBe("2");
    expect(ok.rawPayload.subarray(0, 2).toString()).toBe("PK");
    mode = "down";
    const off = await app.inject({ url: `/api/servers/${s.id}/mods/export.mrpack` });
    expect(off.statusCode).toBe(200);
    expect(off.headers["x-blockpilot-note"]).toBe("modrinth-offline");
    // 설정을 안 넣으면 뺀 파일 헤더도 없다
    expect(off.headers["x-blockpilot-excluded"]).toBeUndefined();
    await app.close();
  });

  it("encodes the RFC 5987 file name fully and adds an ASCII fallback", () => {
    expect(attachmentHeader("Bob's (main)* 서버.mrpack", "modpack-1.mrpack")).toBe(
      `attachment; filename="modpack-1.mrpack"; filename*=UTF-8''Bob%27s%20%28main%29%2A%20%EC%84%9C%EB%B2%84.mrpack`,
    );
    expect(attachmentHeader("a", 'we"ird\\서.zip')).toBe(`attachment; filename="we_ird__.zip"; filename*=UTF-8''a`);
  });
});
