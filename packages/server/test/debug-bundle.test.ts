import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import yauzl from "yauzl";
import { addServer, BLOCKPILOT_HOME, getAutomation, setAuthToken, setAutomation, setP2p } from "../src/config/store.js";
import { JOBS_DIR } from "../src/services/create/job.js";
import { LOG_FILE, MASK, createAppLogger } from "../src/lib/logger.js";
import { BUNDLE_PREFIX, DEBUG_DIR, buildDebugBundle, pruneOldBundles } from "../src/services/debugBundle.js";
import { debugRoutes } from "../src/routes/debug.js";
import { makeFakeServer } from "./helpers/fakeServer.js";

const TOKEN = "supersecrettoken-1234567890";
const WEBHOOK = "https://discord.com/api/webhooks/987654321/WebhookTokenValueXYZ-9876";
const SECRET_HEX = "ef".repeat(16);

/** zip 의 항목 이름 → 본문 */
function readZip(zipPath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, string>();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, stream) => {
          if (err2 || !stream) return reject(err2);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            out.set(e.fileName, Buffer.concat(chunks).toString("utf8"));
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

let fake: Awaited<ReturnType<typeof makeFakeServer>>;
let serverId: string;

beforeAll(async () => {
  fake = await makeFakeServer("", {
    files: {
      "logs/latest.log": Array.from({ length: 400 }, (_, i) => `[12:00:00] [Server thread/INFO]: line ${i}`).join("\n") + "\n",
      "crash-reports/crash-2025-01-01_12.00.00-server.txt": "---- Minecraft Crash Report ----\njava.lang.OutOfMemoryError\n",
      "world/level.dat": "LEVEL",
      "world/region/r.0.0.mca": "REGION",
      "mods/some-mod.jar": "JAR",
      "backups/world-2025.zip": "ZIP",
    },
  });
  await fsp.writeFile(path.join(fake.dir, "server.properties"), `server-port=${fake.port}\nenable-rcon=true\nrcon.password=hunter2secret\nmotd=안녕\n`);
  const s = await addServer({ path: fake.dir, name: "신고 테스트" });
  serverId = s.id;
  await setAuthToken(TOKEN);
  const a = await getAutomation(serverId);
  await setAutomation(serverId, { ...a, discord: { ...a.discord, webhookUrl: WEBHOOK } });
  await setP2p(serverId, { enabled: true, keyPair: { publicKey: "ab".repeat(32), secretKey: "cd".repeat(64) }, secret: SECRET_HEX, approved: [], blocked: [] });
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.writeFile(path.join(JOBS_DIR, "job-test.json"), JSON.stringify({ id: "job-test", target: "/tmp/x", tempPaths: [] }));
  // 앱 로그에 토큰과 웹훅이 섞여 있어도 묶음에서는 가려져야 한다
  const { logger, flush } = createAppLogger({ toConsole: "none", file: LOG_FILE });
  logger.info(`접속 토큰을 생성했습니다 → ${TOKEN}`);
  logger.info(`웹훅 ${WEBHOOK} 으로 보냄`);
  flush();
});

afterAll(async () => {
  await setAuthToken(null);
  await fake.cleanup();
});

describe("문제 신고 파일", () => {
  it("about · system · config · 서버 정보만 담고, 월드·모드·백업은 넣지 않으며 비밀은 가린다", async () => {
    const b = await buildDebugBundle();
    expect(b.fileName.startsWith(BUNDLE_PREFIX)).toBe(true);
    expect(b.path.startsWith(DEBUG_DIR)).toBe(true);
    if (process.platform !== "win32") expect((await fsp.stat(b.path)).mode & 0o777).toBe(0o600);

    const z = await readZip(b.path);
    const names = [...z.keys()];
    expect(names).toEqual(expect.arrayContaining(["about.json", "system.json", "config.json", "blockpilot.log", "jobs/job-test.json", `servers/${serverId}/info.json`, `servers/${serverId}/latest.log`, `servers/${serverId}/server.properties`, `servers/${serverId}/crash-reports/crash-2025-01-01_12.00.00-server.txt`]));
    expect(names.some((n) => /world|\.mca|\.dat|mods\/|backups\/|\.jar/.test(n))).toBe(false);
    expect(names.some((n) => /^servers\/[^/]+\/(start\.sh|run\.sh|start\.bat|run\.bat)$/.test(n))).toBe(true);

    const about = JSON.parse(z.get("about.json")!);
    expect(about.home).toBe(BLOCKPILOT_HOME);
    expect(about.node).toBe(process.version);
    expect(about.servers).toBe(1);
    expect(about.env.BLOCKPILOT_HOME).toBe(BLOCKPILOT_HOME);
    expect(about.skippedForSize).toEqual([]);
    expect(JSON.parse(z.get("system.json")!).os).toBeTruthy();

    const config = JSON.parse(z.get("config.json")!);
    expect(config.auth.token).toBe(MASK);
    expect(config.settings[serverId].p2p.secret).toBe(MASK);
    expect(config.settings[serverId].p2p.keyPair.secretKey).toBe(MASK);
    expect(config.settings[serverId].p2p.keyPair.publicKey).toBe("abababab…");
    expect(config.settings[serverId].automation.discord.webhookUrl).toBe("https://discord.com/api/webhooks/…/…9876");
    expect(config.servers[0].path).toBe(fake.dir);

    const info = JSON.parse(z.get(`servers/${serverId}/info.json`)!);
    expect(info.id).toBe(serverId);
    expect(info.exists).toBe(true);
    expect(info.detected.hasStartScript).toBe(true);
    expect(info.status.state).toBe("stopped");

    expect(z.get(`servers/${serverId}/latest.log`)!.split("\n").filter(Boolean)).toHaveLength(300);
    expect(z.get(`servers/${serverId}/latest.log`)).toContain("line 399");
    expect(z.get(`servers/${serverId}/server.properties`)).toContain(`rcon.password=${MASK}`);
    expect(z.get(`servers/${serverId}/server.properties`)).toContain(`server-port=${fake.port}`);
    expect(z.get("blockpilot.log")).toContain(`→ ${MASK}`);
    expect(z.get("blockpilot.log")).toContain("…9876");

    // 어디에도 비밀이 남지 않는다
    const everything = [...z.values()].join("\n");
    for (const secret of [TOKEN, "WebhookTokenValueXYZ", "hunter2secret", SECRET_HEX, "cd".repeat(64)]) expect(everything).not.toContain(secret);
  });

  it("한 시간 지난 파일만 지운다", async () => {
    await fsp.mkdir(DEBUG_DIR, { recursive: true });
    const old = path.join(DEBUG_DIR, `${BUNDLE_PREFIX}old.zip`);
    const fresh = path.join(DEBUG_DIR, `${BUNDLE_PREFIX}fresh.zip`);
    const other = path.join(DEBUG_DIR, "something-else.zip");
    for (const f of [old, fresh, other]) await fsp.writeFile(f, "x");
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await fsp.utimes(old, past, past);
    await fsp.utimes(other, past, past);
    await pruneOldBundles();
    await expect(fsp.stat(old)).rejects.toThrow();
    await expect(fsp.stat(fresh)).resolves.toBeTruthy();
    await expect(fsp.stat(other)).resolves.toBeTruthy();
    await fsp.rm(fresh, { force: true });
    await fsp.rm(other, { force: true });
  });

  it("API: POST 로 만들고 GET 으로 받는다. 이상한 이름은 거절", async () => {
    const app = Fastify();
    await app.register(debugRoutes);
    const made = await app.inject({ method: "POST", url: "/api/debug/bundle" });
    expect(made.statusCode).toBe(200);
    const body = made.json() as { fileName: string; sizeBytes: number; downloadPath: string };
    expect(body.downloadPath).toBe(`/api/debug/bundle/${body.fileName}`);
    expect(body.sizeBytes).toBeGreaterThan(0);

    const got = await app.inject({ method: "GET", url: body.downloadPath });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/zip");
    expect(Number(got.headers["content-length"])).toBe(body.sizeBytes);
    expect(got.rawPayload.subarray(0, 2).toString()).toBe("PK");

    expect((await app.inject({ method: "GET", url: "/api/debug/bundle/..%2Fconfig.json" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/debug/bundle/blockpilot-debug-nope.zip" })).statusCode).toBe(404);
    await app.close();
  });
});
