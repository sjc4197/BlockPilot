import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import yauzl from "yauzl";
import { BACKUP_DIR, createBackup, listBackups, restoreBackup, STALE_PART_MS, STALE_STAGING_MS } from "../src/services/backups.js";
import { backupStatus, latestScheduledBackupAt, resetSchedulerState, seedLastRunAt } from "../src/services/scheduler.js";

const exists = (p: string) => fsp.lstat(p).then(() => true, () => false);
let dir: string;

/** 월드 폴더가 있는 가짜 서버 폴더 (프로세스는 띄우지 않는다) */
async function makeWorld(root: string, files: Record<string, string> = { "world/level.dat": "level", "world/region/r.0.0.mca": "region" }) {
  for (const [name, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), body);
  }
}

/** zip 안 항목 이름 목록 (전부 읽히는지 = 열리는지 확인용) */
function zipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const names: string[] = [];
      zip.on("entry", (e) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** yazl 로 zip 을 만들어 backups/ 에 둔다 */
async function writeZip(file: string, entries: Record<string, string>) {
  const zip = new yazl.ZipFile();
  for (const [name, body] of Object.entries(entries)) zip.addBuffer(Buffer.from(body), name);
  zip.end();
  const target = path.join(dir, BACKUP_DIR, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(target);
    ws.on("close", () => resolve());
    ws.on("error", reject);
    zip.outputStream.pipe(ws);
  });
  return target;
}

async function worldUntouched() {
  expect(await fsp.readFile(path.join(dir, "world", "level.dat"), "utf8")).toBe("level");
  expect(await fsp.readFile(path.join(dir, "world", "region", "r.0.0.mca"), "utf8")).toBe("region");
  const names = await fsp.readdir(dir);
  expect(names.filter((n) => n.includes(".restoring-"))).toEqual([]);
  expect(await exists(path.join(dir, ".blockpilot-backup"))).toBe(false);
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-backup-"));
  await fsp.writeFile(path.join(dir, "server.properties"), "server-port=25565\nlevel-name=world\n");
  await makeWorld(dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

/** 특정 경로(src 가 pattern 에 맞을 때)의 fs.rename 만 실패시킨다. 나머지는 원래대로 */
function failRename(pattern: (src: string, dest: string) => boolean, code = "EIO") {
  const real = fsp.rename;
  const calls: string[] = [];
  vi.spyOn(fsp, "rename").mockImplementation(async (src, dest) => {
    if (pattern(String(src), String(dest))) {
      calls.push(String(src));
      throw Object.assign(new Error(`${code}: simulated rename failure ${src}`), { code });
    }
    return real(src, dest);
  });
  return calls;
}

/** 폴더(와 그 안)의 mtime 을 지정 시각으로 */
async function touchDir(p: string, when: Date) {
  await fsp.utimes(p, when, when);
}

describe("createBackup", () => {
  it("writes the zip atomically: no .part leftovers and the zip opens with every world file", async () => {
    const b = await createBackup(dir, { label: "테스트" });
    const names = await fsp.readdir(path.join(dir, BACKUP_DIR));
    expect(names).toEqual([b.file]);
    expect(b.file).toMatch(/^world-.*-테스트\.zip$/);
    expect(b.scheduled).toBe(false);
    expect(b.sizeBytes).toBeGreaterThan(0);
    const entries = await zipEntries(path.join(dir, BACKUP_DIR, b.file));
    expect(entries.sort()).toEqual(["world/level.dat", "world/region/r.0.0.mca"]);
    expect(await listBackups(dir)).toEqual([b]);
  });

  it("bundles nether/end sibling folders and skips session.lock", async () => {
    await makeWorld(dir, { "world_nether/DIM-1/x": "n", "world_the_end/DIM1/y": "e", "world/session.lock": "lock" });
    const b = await createBackup(dir, { scheduled: true });
    expect(b.file.endsWith("-auto.zip")).toBe(true);
    const entries = await zipEntries(path.join(dir, BACKUP_DIR, b.file));
    expect(entries).not.toContain("world/session.lock");
    expect(entries).toContain("world_nether/DIM-1/x");
    expect(entries).toContain("world_the_end/DIM1/y");
  });

  it("refuses when there is no world folder", async () => {
    await fsp.rm(path.join(dir, "world"), { recursive: true });
    await expect(createBackup(dir)).rejects.toThrow(/백업할 월드 폴더가 없습니다/);
    expect(await exists(path.join(dir, BACKUP_DIR))).toBe(false);
  });
});

describe("listBackups", () => {
  it("hides .part files: a stale one is deleted, a fresh one is kept on disk", async () => {
    const b = await createBackup(dir);
    const stale = path.join(dir, BACKUP_DIR, "world-old-auto.zip.part");
    const fresh = path.join(dir, BACKUP_DIR, "world-new.zip.part");
    await fsp.writeFile(stale, "half");
    await fsp.writeFile(fresh, "half");
    const old = new Date(Date.now() - STALE_PART_MS - 60_000);
    await fsp.utimes(stale, old, old);
    const list = await listBackups(dir);
    expect(list.map((x) => x.file)).toEqual([b.file]);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });
});

describe("restoreBackup", () => {
  it("restores a good backup, moving the current world to the trash folder", async () => {
    const b = await createBackup(dir);
    await fsp.writeFile(path.join(dir, "world", "level.dat"), "changed");
    await fsp.writeFile(path.join(dir, "world", "extra.txt"), "extra");
    const r = await restoreBackup(dir, b.file);
    expect(r.restored).toEqual(["world"]);
    expect(r.previousMovedTo).toMatch(/^\.blockpilot-backup[\\/]restore-/);
    expect(await fsp.readFile(path.join(dir, "world", "level.dat"), "utf8")).toBe("level");
    expect(await exists(path.join(dir, "world", "extra.txt"))).toBe(false);
    expect(await fsp.readFile(path.join(dir, r.previousMovedTo, "world", "level.dat"), "utf8")).toBe("changed");
    expect((await fsp.readdir(dir)).filter((n) => n.includes(".restoring-"))).toEqual([]);
  });

  it("rejects a truncated zip and leaves the current world untouched", async () => {
    const b = await createBackup(dir);
    const zipPath = path.join(dir, BACKUP_DIR, b.file);
    const st = await fsp.stat(zipPath);
    await fsp.truncate(zipPath, st.size - 40);
    await expect(restoreBackup(dir, b.file)).rejects.toThrow(/백업 파일을 열 수 없어요/);
    await worldUntouched();
  });

  it("rejects a zip whose central directory survives but whose data is cut off", async () => {
    // 중앙 디렉터리를 뒤에 그대로 붙여 두고 가운데(파일 데이터)만 잘라낸 zip
    const good = await writeZip("ok.zip", { "world/level.dat": "x".repeat(2000) });
    const buf = await fsp.readFile(good);
    const cdSig = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const cut = Buffer.concat([buf.subarray(0, 60), buf.subarray(cdSig)]);
    await fsp.writeFile(path.join(dir, BACKUP_DIR, "cut.zip"), cut);
    await expect(restoreBackup(dir, "cut.zip")).rejects.toThrow(/끝까지 쓰이지 않았|열 수 없어요/);
    await worldUntouched();
  });

  it("rejects entries that escape the world folder (.. segment)", async () => {
    // yazl/yauzl 둘 다 .. 를 거부하므로 같은 길이의 이름을 쓴 뒤 바이트를 바꿔치기한다
    const p = await writeZip("evil.zip", { "world/xx/eula.txt": "eula=false" });
    const buf = await fsp.readFile(p);
    const s = buf.toString("latin1").split("world/xx/eula.txt").join("world/../eula.txt");
    await fsp.writeFile(p, Buffer.from(s, "latin1"));
    await expect(restoreBackup(dir, "evil.zip")).rejects.toThrow(/벗어나는 경로가 있어요: world\/\.\.\/eula\.txt/);
    await worldUntouched();
    expect(await exists(path.join(dir, "eula.txt"))).toBe(false);
  });

  it("rejects a zip whose top-level folder is not one of this server's worlds", async () => {
    await writeZip("plugins.zip", { "plugins/evil.jar": "x", "world/level.dat": "y" });
    await expect(restoreBackup(dir, "plugins.zip")).rejects.toThrow(/월드 폴더.*가 아니에요/);
    await worldUntouched();
    expect(await exists(path.join(dir, "plugins"))).toBe(false);
  });

  it("rejects an empty zip and a missing file", async () => {
    await writeZip("empty.zip", {});
    await expect(restoreBackup(dir, "empty.zip")).rejects.toThrow(/비어 있거나 잘못된/);
    await expect(restoreBackup(dir, "nope.zip")).rejects.toThrow(/찾을 수 없습니다/);
    await expect(restoreBackup(dir, "../x.zip")).rejects.toThrow(/잘못된 파일 이름/);
    await worldUntouched();
  });

  it("removes a stale leftover .restoring folder (older than 10 min) but keeps a fresh one", async () => {
    const b = await createBackup(dir);
    const stale = path.join(dir, "world.restoring-2020-01-01T00-00-00-000Z");
    const fresh = path.join(dir, "world.restoring-2099-01-01T00-00-00-000Z");
    await fsp.mkdir(path.join(stale, "region"), { recursive: true });
    await fsp.mkdir(path.join(fresh, "region"), { recursive: true });
    await touchDir(stale, new Date(Date.now() - STALE_STAGING_MS - 60_000));
    await restoreBackup(dir, b.file);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    // 이번 복원의 임시 폴더는 제자리로 들어갔으니 남아 있지 않다
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes(".restoring-"));
    expect(leftovers).toEqual([path.basename(fresh)]);
  });

  describe("swap failure", () => {
    beforeEach(async () => {
      await makeWorld(dir, { "world_nether/DIM-1/x": "nether" });
    });

    it("rolls every world back when the second folder cannot be moved into place, and removes the trash folder", async () => {
      const b = await createBackup(dir);
      expect(await zipEntries(path.join(dir, BACKUP_DIR, b.file))).toContain("world_nether/DIM-1/x");
      await fsp.writeFile(path.join(dir, "world", "level.dat"), "changed");
      await fsp.writeFile(path.join(dir, "world_nether", "DIM-1", "x"), "nether-changed");
      // world 는 바꿔치기가 끝났고 world_nether.restoring-* → world_nether 에서 실패
      const calls = failRename((src) => path.basename(src).startsWith("world_nether.restoring-"));
      await expect(restoreBackup(dir, b.file)).rejects.toThrow(/simulated rename failure/);
      expect(calls).toHaveLength(1);
      // 원래 월드가 전부 제자리로 돌아왔다 (복원 전 내용 그대로)
      expect(await fsp.readFile(path.join(dir, "world", "level.dat"), "utf8")).toBe("changed");
      expect(await fsp.readFile(path.join(dir, "world_nether", "DIM-1", "x"), "utf8")).toBe("nether-changed");
      expect((await fsp.readdir(dir)).filter((n) => n.includes(".restoring-"))).toEqual([]);
      expect(await exists(path.join(dir, ".blockpilot-backup"))).toBe(false);
      // 백업 파일은 그대로라 다시 시도할 수 있다
      expect((await listBackups(dir)).map((x) => x.file)).toEqual([b.file]);
    });

    it("never deletes the trash folder when rolling back fails, and names it in the error", async () => {
      const b = await createBackup(dir);
      await fsp.writeFile(path.join(dir, "world", "level.dat"), "changed");
      // world_nether 를 제자리로 넣는 데 실패 + 옮겨 둔 world 를 되돌리는 것도 실패
      failRename((src, dest) => {
        if (path.basename(src).startsWith("world_nether.restoring-")) return true;
        return src.includes(".blockpilot-backup") && path.basename(src) === "world" && path.basename(dest) === "world";
      });
      let err: any;
      await restoreBackup(dir, b.file).catch((e) => (err = e));
      expect(err).toBeTruthy();
      expect(err.statusCode).toBe(500);
      expect(err.message).toMatch(/원래 월드는 \.blockpilot-backup[\\/]restore-[^ ]+ 에 남아 있어요/);
      const trashRel = err.message.match(/원래 월드는 (\S+) 에 남아 있어요/)![1];
      const trash = path.join(dir, trashRel);
      // 원래 world 는 trash 안에 온전히 남아 있고, world_nether 는 되돌려졌다
      expect(await fsp.readFile(path.join(trash, "world", "level.dat"), "utf8")).toBe("changed");
      expect(await fsp.readFile(path.join(dir, "world_nether", "DIM-1", "x"), "utf8")).toBe("nether");
      // 제자리에는 아무 world 도 없다 (새 폴더는 빼냈고 원래 것은 되돌리지 못했다) — 조용히 반쯤 복원된 상태가 아니다
      expect(await exists(path.join(dir, "world"))).toBe(false);
      expect((await fsp.readdir(dir)).filter((n) => n.includes(".restoring-"))).toEqual([]);
    });

    it("retries a transient EPERM rename (Windows antivirus) and then succeeds", async () => {
      const b = await createBackup(dir);
      await fsp.writeFile(path.join(dir, "world", "level.dat"), "changed");
      let left = 2;
      const real = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (src, dest) => {
        if (left > 0 && path.basename(String(src)).startsWith("world.restoring-")) {
          left--;
          throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        }
        return real(src, dest);
      });
      const r = await restoreBackup(dir, b.file);
      expect(r.restored.sort()).toEqual(["world", "world_nether"]);
      expect(left).toBe(0);
      expect(await fsp.readFile(path.join(dir, "world", "level.dat"), "utf8")).toBe("level");
      expect(await fsp.readFile(path.join(dir, r.previousMovedTo, "world", "level.dat"), "utf8")).toBe("changed");
    });
  });

  describe("concurrency", () => {
    it("rejects a second restore of the same server with 409 while the first completes", async () => {
      const b = await createBackup(dir);
      await fsp.writeFile(path.join(dir, "world", "level.dat"), "changed");
      const first = restoreBackup(dir, b.file);
      const second = restoreBackup(dir, b.file);
      let err: any;
      await second.catch((e) => (err = e));
      expect(err?.statusCode).toBe(409);
      expect(err?.message).toMatch(/이미 복원 중이에요/);
      const r = await first;
      expect(r.restored).toEqual(["world"]);
      expect(await fsp.readFile(path.join(dir, "world", "level.dat"), "utf8")).toBe("level");
      expect((await fsp.readdir(dir)).filter((n) => n.includes(".restoring-"))).toEqual([]);
      // 잠금이 풀려 다음 복원은 된다
      await expect(restoreBackup(dir, b.file)).resolves.toMatchObject({ restored: ["world"] });
    });

    it("rejects a backup while a restore is running, and a restore while a backup is running", async () => {
      const b = await createBackup(dir);
      const restoring = restoreBackup(dir, b.file);
      await expect(createBackup(dir)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/이미 복원 중이에요/) });
      await restoring;

      const backing = createBackup(dir);
      await expect(restoreBackup(dir, b.file)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/백업을 만드는 중이에요/) });
      await expect(createBackup(dir)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/백업을 만드는 중이에요/) });
      await backing;
      // 다른 서버 폴더는 영향 없다
      const other = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-backup-other-"));
      try {
        await fsp.writeFile(path.join(other, "server.properties"), "level-name=world\n");
        await makeWorld(other);
        const b2 = createBackup(dir);
        await expect(createBackup(other)).resolves.toMatchObject({ scheduled: false });
        await b2;
      } finally {
        await fsp.rm(other, { recursive: true, force: true });
      }
    });

    it("releases the lock when a restore fails", async () => {
      await writeZip("empty.zip", {});
      await expect(restoreBackup(dir, "empty.zip")).rejects.toThrow(/비어 있거나 잘못된/);
      await expect(createBackup(dir)).resolves.toMatchObject({ scheduled: false });
    });
  });
});

describe("scheduler seeding", () => {
  afterEach(() => resetSchedulerState());

  it("latestScheduledBackupAt picks the newest -auto.zip regardless of order and ignores manual ones", () => {
    const e = (file: string, createdAt: string) => ({ file, sizeBytes: 1, createdAt, scheduled: file.endsWith("-auto.zip") });
    expect(latestScheduledBackupAt([])).toBeUndefined();
    expect(latestScheduledBackupAt([e("world-a.zip", "2026-01-03T00:00:00.000Z")])).toBeUndefined();
    expect(
      latestScheduledBackupAt([
        e("world-1-auto.zip", "2026-01-01T00:00:00.000Z"),
        e("world-3.zip", "2026-01-03T00:00:00.000Z"),
        e("world-2-auto.zip", "2026-01-02T00:00:00.000Z"),
      ]),
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("seedLastRunAt takes lastRunAt from the newest -auto.zip on disk, once", async () => {
    const id = "seed-" + path.basename(dir);
    const auto = await createBackup(dir, { scheduled: true });
    const when = new Date("2026-01-05T10:00:00.000Z");
    await fsp.utimes(path.join(dir, BACKUP_DIR, auto.file), when, when);
    await createBackup(dir); // 수동 백업은 무시
    const s = await seedLastRunAt(id, dir);
    expect(s.lastRunAt).toBe(when.toISOString());
    expect((await backupStatus(id)).lastRunAt).toBe(when.toISOString());
    // 두 번째 호출은 디스크를 다시 보지 않는다
    await fsp.rm(path.join(dir, BACKUP_DIR), { recursive: true });
    expect((await seedLastRunAt(id, dir)).lastRunAt).toBe(when.toISOString());
  });

  it("seedLastRunAt leaves lastRunAt empty when there is no auto backup (first tick runs as before)", async () => {
    const id = "seed-none-" + path.basename(dir);
    await createBackup(dir);
    expect((await seedLastRunAt(id, dir)).lastRunAt).toBeUndefined();
  });
});
