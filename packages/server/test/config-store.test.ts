import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BACKUP_SETTINGS } from "@blockpilot/shared";
import {
  BLOCKPILOT_HOME,
  __resetConfigCacheForTests,
  addServer,
  configRecoveryInfo,
  getAuthToken,
  getBackupSettings,
  getJoinSettings,
  getP2p,
  listServers,
  migrate,
  mutate,
  renameServer,
  setAuthToken,
  setBackupSettings,
  setJoinSettings,
  type ConfigFile,
  type ConfigMigration,
} from "../src/config/store.js";
import { CURRENT_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, configFileSchema } from "../src/config/schema.js";

/**
 * config.json 저장소: 깨진 파일 보존, .bak 에서 복구, 원자적 쓰기 + .bak, 동시 변경 직렬화, 모르는 키 보존, schemaVersion·마이그레이션.
 * test/setup.ts 가 워커마다 다른 BLOCKPILOT_HOME 을 주므로 여기서 config.json 을 마음껏 지워도 된다.
 */
const CONFIG = path.join(BLOCKPILOT_HOME, "config.json");
const readJson = async () => JSON.parse(await fsp.readFile(CONFIG, "utf8"));
const corruptFiles = async () => (await fsp.readdir(BLOCKPILOT_HOME).catch(() => [] as string[])).filter((n) => n.startsWith("config.json.corrupt-"));

async function wipeHome() {
  await fsp.mkdir(BLOCKPILOT_HOME, { recursive: true });
  for (const n of await fsp.readdir(BLOCKPILOT_HOME)) {
    if (n === "config.json" || n.startsWith("config.json.") || n === ".blockpilot-backup") await fsp.rm(path.join(BLOCKPILOT_HOME, n), { recursive: true, force: true });
  }
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await __resetConfigCacheForTests();
  await wipeHome();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  warn.mockRestore();
  await __resetConfigCacheForTests();
  await wipeHome();
});

describe("config store", () => {
  it("keeps a corrupt config.json aside as .corrupt-<time> and starts empty instead of overwriting it", async () => {
    await fsp.writeFile(CONFIG, '{"servers":[{"id":"abc","name":"x","path":"/tmp/x","createdAt":"2024"}], "auth":{"token":"secret-tok');
    expect(await listServers()).toEqual([]);
    const kept = await corruptFiles();
    expect(kept).toHaveLength(1);
    expect(await fsp.readFile(path.join(BLOCKPILOT_HOME, kept[0]), "utf8")).toContain("secret-tok");
    expect(configRecoveryInfo().corruptFile).toBe(path.join(BLOCKPILOT_HOME, kept[0]));
    expect(warn).toHaveBeenCalled();

    // 다음 저장은 새 파일을 만들고, 치워 둔 파일은 건드리지 않는다
    await setAuthToken("new");
    expect((await readJson()).auth.token).toBe("new");
    expect(await corruptFiles()).toEqual(kept);
  });

  it("treats valid JSON of the wrong shape as corrupt too (servers must be a list)", async () => {
    await fsp.writeFile(CONFIG, JSON.stringify({ servers: "nope" }));
    expect(await listServers()).toEqual([]);
    expect(await corruptFiles()).toHaveLength(1);
  });

  it("keeps only the newest few .corrupt files", async () => {
    for (const t of ["2020-01-01T00-00-00.000Z", "2020-01-02T00-00-00.000Z", "2020-01-03T00-00-00.000Z"]) {
      await fsp.writeFile(path.join(BLOCKPILOT_HOME, `config.json.corrupt-${t}`), "x");
    }
    await fsp.writeFile(CONFIG, "{{{");
    await listServers();
    const kept = await corruptFiles();
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain("config.json.corrupt-2020-01-01T00-00-00.000Z");
  });

  it("does not quarantine a healthy file and reports no recovery", async () => {
    await fsp.writeFile(CONFIG, JSON.stringify({ servers: [{ id: "abc", name: "x", path: "/tmp/x", createdAt: "2024" }] }));
    expect((await listServers()).map((s) => s.id)).toEqual(["abc"]);
    expect(await corruptFiles()).toEqual([]);
    expect(configRecoveryInfo()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes config.json.bak with the previous contents before replacing, with mode 600", async () => {
    await setAuthToken("first");
    expect(await fsp.stat(`${CONFIG}.bak`).catch(() => null)).toBeNull();
    await setAuthToken("second");
    expect(JSON.parse(await fsp.readFile(`${CONFIG}.bak`, "utf8")).auth.token).toBe("first");
    expect((await readJson()).auth.token).toBe("second");
    if (process.platform !== "win32") {
      expect((await fsp.stat(CONFIG)).mode & 0o777).toBe(0o600);
      expect((await fsp.stat(`${CONFIG}.bak`)).mode & 0o777).toBe(0o600);
    }
    // 임시 파일이 남지 않는다
    expect((await fsp.readdir(BLOCKPILOT_HOME)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("lands all of 20 concurrent mutations mixing different setters", async () => {
    const { id } = await addServer({ path: "/tmp/concurrent", name: "c" });
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) jobs.push(addServer({ path: `/tmp/s${i}`, name: `s${i}` }));
      else jobs.push(setBackupSettings(id, { ...DEFAULT_BACKUP_SETTINGS, keep: i }));
    }
    jobs.push(setAuthToken("tok"), setJoinSettings({ remembered: { inviteCode: "code", usedAt: "now" } }), renameServer(id, "renamed"));
    await Promise.all(jobs);

    const onDisk = await readJson();
    expect(onDisk.servers).toHaveLength(11);
    expect(onDisk.servers.find((s: { id: string }) => s.id === id).name).toBe("renamed");
    expect(onDisk.settings[id].backup.keep).toBe(19);
    expect(onDisk.auth.token).toBe("tok");
    expect(onDisk.p2pJoin.remembered.inviteCode).toBe("code");
    // 캐시도 디스크와 같다
    expect(await listServers()).toHaveLength(11);
    expect((await getBackupSettings(id)).keep).toBe(19);
    expect(await getAuthToken()).toBe("tok");
  });

  it("round-trips unknown keys untouched and stamps schemaVersion", async () => {
    await fsp.writeFile(
      CONFIG,
      JSON.stringify({
        servers: [{ id: "abc", name: "x", path: "/tmp/x", createdAt: "2024", nickname: "extra-on-server" }],
        settings: { abc: { backup: { keep: 2 }, futureThing: { a: 1 } } },
        auth: { token: "t", extra: true },
        p2pJoin: { note: "hi" },
        someFutureTopLevel: { nested: [1, 2, 3] },
      }),
    );
    expect(await getAuthToken()).toBe("t");
    await renameServer("abc", "renamed");
    const onDisk = await readJson();
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.someFutureTopLevel).toEqual({ nested: [1, 2, 3] });
    expect(onDisk.servers[0]).toMatchObject({ id: "abc", name: "renamed", nickname: "extra-on-server" });
    expect(onDisk.settings.abc.futureThing).toEqual({ a: 1 });
    expect(onDisk.settings.abc.backup).toEqual({ keep: 2 });
    expect(onDisk.auth).toEqual({ token: "t", extra: true });
    expect(onDisk.p2pJoin).toEqual({ note: "hi" });
  });

  it("writes schemaVersion on a fresh store and skips the write when the mutator returns the same object", async () => {
    await setAuthToken("x");
    expect((await readJson()).schemaVersion).toBe(1);
    const before = await fsp.stat(CONFIG);
    await mutate((cfg) => cfg);
    await addServer({ path: "/tmp/dup", name: "a" });
    const mid = await fsp.stat(CONFIG);
    await addServer({ path: "/tmp/dup", name: "b" }); // 같은 경로 → 이미 등록된 서버, 저장 없음
    const after = await fsp.stat(CONFIG);
    expect(mid.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    expect(after.mtimeMs).toBe(mid.mtimeMs);
    expect((await listServers()).map((s) => s.name)).toEqual(["a"]);
  });

  it("keeps serving the cache after a failed mutator and the chain stays usable", async () => {
    await setAuthToken("ok");
    await expect(mutate(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await getAuthToken()).toBe("ok");
    await setAuthToken("after");
    expect((await readJson()).auth.token).toBe("after");
  });
});

// ---------- .bak 복구 ----------

const BAK = `${CONFIG}.bak`;
const bakCorruptFiles = async () => (await fsp.readdir(BLOCKPILOT_HOME).catch(() => [] as string[])).filter((n) => n.startsWith("config.json.bak.corrupt-"));
const GOOD = {
  schemaVersion: 1,
  servers: [{ id: "abc", name: "x", path: "/tmp/x", createdAt: "2024" }],
  settings: { abc: { p2p: { enabled: true, keyPair: { publicKey: "pub", secretKey: "sec" }, secret: "invite-secret", approved: [], blocked: [] } } },
  auth: { token: "bak-tok" },
  p2pJoin: { keyPair: { publicKey: "jpub", secretKey: "jsec" } },
};

describe("config store: recovery from config.json.bak", () => {
  it("restores servers, token and P2P keys from a healthy .bak after quarantining a corrupt config.json", async () => {
    await fsp.writeFile(CONFIG, '{"servers":[], "auth":{"token":"trunc');
    await fsp.writeFile(BAK, JSON.stringify(GOOD));

    expect((await listServers()).map((s) => s.id)).toEqual(["abc"]);
    expect(await getAuthToken()).toBe("bak-tok");
    expect((await getP2p("abc")).secret).toBe("invite-secret");
    expect((await getJoinSettings()).keyPair?.publicKey).toBe("jpub");

    const kept = await corruptFiles();
    expect(kept).toHaveLength(1);
    expect(configRecoveryInfo()).toEqual({ corruptFile: path.join(BLOCKPILOT_HOME, kept[0]), restoredFromBackup: true });
    // 디스크의 config.json 도 .bak 내용으로 되살아나 있고, .bak 은 그대로
    expect(await readJson()).toEqual(GOOD);
    expect(JSON.parse(await fsp.readFile(BAK, "utf8"))).toEqual(GOOD);
    if (process.platform !== "win32") expect((await fsp.stat(CONFIG)).mode & 0o777).toBe(0o600);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("config.json.bak"))).toBe(true);

    // 첫 저장: .bak 은 여전히 예전 멀쩡한 내용(토큰 bak-tok)이다 — 빈 설정으로 덮이지 않는다
    await setAuthToken("new");
    expect((await readJson()).auth.token).toBe("new");
    expect(JSON.parse(await fsp.readFile(BAK, "utf8"))).toEqual(GOOD);
    // 두 번째 저장부터는 보통처럼 직전 파일(서버·키 포함, 토큰 new)이 .bak 이 된다
    await setAuthToken("newer");
    const bak = JSON.parse(await fsp.readFile(BAK, "utf8"));
    expect(bak.auth.token).toBe("new");
    expect(bak.servers.map((s: { id: string }) => s.id)).toEqual(["abc"]);
    expect(bak.settings.abc.p2p.secret).toBe("invite-secret");
    expect(await corruptFiles()).toEqual(kept);
  });

  it("keeps a corrupt .bak as config.json.bak.corrupt-<time> too and starts fresh", async () => {
    await fsp.writeFile(CONFIG, "{{{");
    await fsp.writeFile(BAK, '{"servers": "nope"}');

    expect(await listServers()).toEqual([]);
    expect(await corruptFiles()).toHaveLength(1);
    const bakKept = await bakCorruptFiles();
    expect(bakKept).toHaveLength(1);
    expect(await fsp.readFile(path.join(BLOCKPILOT_HOME, bakKept[0]), "utf8")).toBe('{"servers": "nope"}');
    expect(await fsp.stat(BAK).catch(() => null)).toBeNull();
    expect(configRecoveryInfo().restoredFromBackup).toBeUndefined();
    expect(configRecoveryInfo().corruptFile).toMatch(/config\.json\.corrupt-/);

    // 첫 저장은 새 파일만 만들고 .bak 을 만들지 않는다 (복사할 믿을 만한 파일이 없다)
    await setAuthToken("new");
    expect((await readJson()).auth.token).toBe("new");
    expect(await fsp.stat(BAK).catch(() => null)).toBeNull();
    expect(await bakCorruptFiles()).toEqual(bakKept);
    // 그 다음부터는 보통처럼
    await setAuthToken("newer");
    expect(JSON.parse(await fsp.readFile(BAK, "utf8")).auth.token).toBe("new");
  });

  it("prunes old config.json.bak.corrupt-* files like the config.json ones", async () => {
    for (const t of ["2020-01-01T00-00-00.000Z", "2020-01-02T00-00-00.000Z", "2020-01-03T00-00-00.000Z"]) {
      await fsp.writeFile(path.join(BLOCKPILOT_HOME, `config.json.bak.corrupt-${t}`), "x");
    }
    await fsp.writeFile(CONFIG, "{{{");
    await fsp.writeFile(BAK, "{{{");
    await listServers();
    const kept = await bakCorruptFiles();
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain("config.json.bak.corrupt-2020-01-01T00-00-00.000Z");
  });

  it("never copies the still-in-place corrupt config.json over a good .bak when the quarantine move itself fails", async () => {
    await fsp.writeFile(CONFIG, "{{{");
    await fsp.writeFile(BAK, JSON.stringify(GOOD));
    // 첫 rename(깨진 파일 치우기)만 실패시킨다. 재시도 대상이 아닌 코드라 retryFs 는 바로 포기한다
    const rename = vi.spyOn(fsp, "rename");
    rename.mockRejectedValueOnce(Object.assign(new Error("simulated"), { code: "EIO" }));
    try {
      // 메모리는 .bak 내용으로 이어 가고, 디스크의 config.json 은 (못 치운) 깨진 파일 그대로
      expect((await listServers()).map((s) => s.id)).toEqual(["abc"]);
      expect(await getAuthToken()).toBe("bak-tok");
      expect(configRecoveryInfo()).toEqual({ corruptFile: CONFIG, restoredFromBackup: true });
      expect(await fsp.readFile(CONFIG, "utf8")).toBe("{{{");
      expect(await corruptFiles()).toEqual([]);

      // 첫 저장: 깨진 파일을 .bak 으로 복사하지 않고, .bak 은 멀쩡한 예전 내용 그대로
      await setAuthToken("new");
      const onDisk = await readJson();
      expect(onDisk.auth.token).toBe("new");
      expect(onDisk.servers.map((s: { id: string }) => s.id)).toEqual(["abc"]);
      expect(JSON.parse(await fsp.readFile(BAK, "utf8"))).toEqual(GOOD);

      // 이제 디스크 파일이 믿을 만하므로 다음 저장은 보통처럼 .bak 을 갱신한다
      await setAuthToken("newer");
      expect(JSON.parse(await fsp.readFile(BAK, "utf8")).auth.token).toBe("new");
    } finally {
      rename.mockRestore();
    }
  });

  it("starts fresh (no .bak) when config.json is corrupt and no .bak exists, and the first write creates no .bak", async () => {
    await fsp.writeFile(CONFIG, "{{{");
    expect(await listServers()).toEqual([]);
    expect(configRecoveryInfo().restoredFromBackup).toBeUndefined();
    await setAuthToken("new");
    expect(await fsp.stat(BAK).catch(() => null)).toBeNull();
    expect(await bakCorruptFiles()).toEqual([]);
  });
});

// ---------- 마이그레이션 ----------

describe("config store: schema version & migrations", () => {
  const seen: number[] = [];
  const fake: ConfigMigration[] = [
    { version: 3, up: (cfg) => { seen.push(3); return { ...cfg, v3: true }; } },
    { version: 2, up: (cfg) => { seen.push(2); return { ...cfg, v2: true }; } },
  ];
  beforeEach(() => { seen.length = 0; });

  it("reads a file without schemaVersion as LEGACY, not CURRENT", () => {
    expect(LEGACY_SCHEMA_VERSION).toBe(1);
    expect(configFileSchema.parse({ servers: [] }).schemaVersion).toBe(LEGACY_SCHEMA_VERSION);
    expect(configFileSchema.parse({ servers: [], schemaVersion: 7 }).schemaVersion).toBe(7);
  });

  it("runs every migration above a versionless file's (legacy) version, in ascending order", () => {
    const legacy = configFileSchema.parse({ servers: [], auth: { token: "t" } }) as ConfigFile;
    const out = migrate(legacy, fake, 3);
    expect(seen).toEqual([2, 3]);
    expect(out).toMatchObject({ schemaVersion: 3, v2: true, v3: true, auth: { token: "t" } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips migrations the file already has, and only runs the newer ones", () => {
    expect(migrate({ schemaVersion: 2, servers: [] }, fake, 3)).toMatchObject({ schemaVersion: 3, v3: true });
    expect(seen).toEqual([3]);
    seen.length = 0;
    expect(migrate({ schemaVersion: 3, servers: [] }, fake, 3)).toEqual({ schemaVersion: 3, servers: [] });
    expect(seen).toEqual([]);
  });

  it("leaves a file from a newer version alone but warns", () => {
    const out = migrate({ schemaVersion: 9, servers: [], future: 1 }, fake, 3);
    expect(out).toEqual({ schemaVersion: 9, servers: [], future: 1 });
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("더 새로운 버전"));
  });

  it("is a no-op with the real migration list at the current version", async () => {
    await fsp.writeFile(CONFIG, JSON.stringify({ servers: [], auth: { token: "legacy" } }));
    expect(await getAuthToken()).toBe("legacy");
    await setAuthToken("x");
    expect((await readJson()).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(warn).not.toHaveBeenCalled();
  });
});
