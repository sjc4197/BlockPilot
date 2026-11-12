import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import yazl from "yazl";
import yauzl from "yauzl";
import type { BackupEntry } from "@blockpilot/shared";
import { assertPlainFilename } from "../lib/safePath.js";
import { readPropertiesFile, toRecord } from "./properties.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { retryFs } from "../lib/retry.js";

/**
 * 월드 백업: <serverDir>/backups/<level>-<timestamp>[-auto].zip
 * 네더/엔드가 별도 폴더인 Paper/Spigot(world_nether, world_the_end)도 함께 묶는다.
 *
 * 원자성:
 * - 백업은 <이름>.zip.part 에 쓰고 끝나면 .zip 으로 rename 한다. 도중에 BlockPilot 이 죽어도 잘린 zip 이 목록에 뜨지 않는다.
 * - 복원은 zip 을 먼저 끝까지 검사하고 <월드>.restoring-<stamp> 에 다 푼 다음에야 현재 월드와 바꿔치기한다.
 * - 같은 서버에서 백업·복원은 한 번에 하나만 돈다. 복원 중에 백업을 뜨면 반쯤 바뀐 월드가 zip 에 들어가고,
 *   복원 둘이 겹치면 서로의 임시 폴더를 지우므로 두 번째 요청은 409 로 거절한다.
 */

export const BACKUP_DIR = "backups";
/** 쓰는 중인 백업 파일의 접미사 */
export const PART_SUFFIX = ".part";
/** 이보다 오래된 .part 는 죽은 프로세스가 남긴 것으로 보고 목록을 읽을 때 지운다 */
export const STALE_PART_MS = 60 * 60_000;
const RESTORING_INFIX = ".restoring-";
/** 이보다 오래된 <월드>.restoring-* 는 복원하다 죽은 프로세스가 남긴 것으로 보고 다음 복원 때 지운다 */
export const STALE_STAGING_MS = 10 * 60_000;

type BusyKind = "backup" | "restore";
/** 서버 폴더(절대 경로)별로 지금 돌고 있는 작업. 백업과 복원은 같은 월드 폴더를 만지므로 서로 배타적이다 */
const busy = new Map<string, BusyKind>();

function busyError(kind: BusyKind) {
  return kind === "restore" ? conflict("이미 복원 중이에요. 끝난 뒤 다시 시도해 주세요.") : conflict("백업을 만드는 중이에요. 끝난 뒤 다시 시도해 주세요.");
}

/** 이 서버에서 백업/복원이 돌고 있으면 409. 라우트에서 save-off 를 걸기 전에 미리 확인하는 용도 */
export function assertNotBusy(serverDir: string) {
  const cur = busy.get(path.resolve(serverDir));
  if (cur) throw busyError(cur);
}

/** 작업 표시를 걸고 해제 함수를 돌려준다. 이미 다른 작업이 돌고 있으면 409. (첫 await 전에 동기적으로 잡아야 경쟁이 없다) */
function acquire(serverDir: string, kind: BusyKind): () => void {
  const key = path.resolve(serverDir);
  const cur = busy.get(key);
  if (cur) throw busyError(cur);
  busy.set(key, kind);
  return () => {
    if (busy.get(key) === kind) busy.delete(key);
  };
}

/** server.properties 의 level-name 기준으로 있을 수 있는 월드 폴더 이름들 (존재 여부와 무관) */
export async function expectedWorldDirs(serverDir: string): Promise<string[]> {
  const { lines } = await readPropertiesFile(serverDir);
  const level = toRecord(lines)["level-name"] ?? "world";
  return [level, `${level}_nether`, `${level}_the_end`];
}

export async function worldDirs(serverDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const c of await expectedWorldDirs(serverDir)) {
    const st = await fs.stat(path.join(serverDir, c)).catch(() => null);
    if (st?.isDirectory()) out.push(c);
  }
  return out;
}

export async function listBackups(serverDir: string): Promise<BackupEntry[]> {
  const backupDir = path.join(serverDir, BACKUP_DIR);
  let names: string[];
  try {
    names = await fs.readdir(backupDir);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const file of names) {
    const full = path.join(backupDir, file);
    if (file.endsWith(PART_SUFFIX)) {
      // 쓰다 만 파일. 한참 지난 것이면 죽은 프로세스가 남긴 찌꺼기라 치운다
      const st = await fs.stat(full).catch(() => null);
      if (st?.isFile() && Date.now() - st.mtimeMs > STALE_PART_MS) await fs.rm(full, { force: true }).catch(() => {});
      continue;
    }
    if (!file.endsWith(".zip")) continue;
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ file, sizeBytes: st.size, createdAt: st.mtime.toISOString(), scheduled: file.endsWith("-auto.zip") });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBackup(serverDir: string, opts: { scheduled?: boolean; label?: string } = {}): Promise<BackupEntry> {
  const release = acquire(serverDir, "backup");
  try {
    return await createBackupLocked(serverDir, opts);
  } finally {
    release();
  }
}

async function createBackupLocked(serverDir: string, opts: { scheduled?: boolean; label?: string }): Promise<BackupEntry> {
  const dirs = await worldDirs(serverDir);
  if (!dirs.length) throw badRequest("백업할 월드 폴더가 없습니다.");
  const outDir = path.join(serverDir, BACKUP_DIR);
  await fs.mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const label = opts.label ? "-" + opts.label.replace(/[^A-Za-z0-9_\-가-힣]/g, "") : "";
  const file = `${dirs[0]}-${stamp}${label}${opts.scheduled ? "-auto" : ""}.zip`;
  const target = path.join(outDir, file);
  const part = target + PART_SUFFIX;

  try {
    const zip = new yazl.ZipFile();
    for (const d of dirs) await addDir(zip, path.join(serverDir, d), d);
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(part);
      ws.on("close", () => resolve());
      ws.on("error", reject);
      zip.outputStream.on("error", reject);
      zip.outputStream.pipe(ws);
    });
    // Windows 에서는 방금 쓴 파일을 백신이 잠깐 잡고 있어 rename 이 EPERM 으로 튈 수 있다
    await retryFs(() => fs.rename(part, target));
  } catch (e) {
    await fs.rm(part, { force: true }).catch(() => {});
    throw e;
  }

  const st = await fs.stat(target);
  return { file, sizeBytes: st.size, createdAt: st.mtime.toISOString(), scheduled: !!opts.scheduled };
}

async function addDir(zip: yazl.ZipFile, abs: string, rel: string) {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    const childAbs = path.join(abs, e.name);
    const childRel = path.posix.join(rel, e.name);
    if (e.isDirectory()) await addDir(zip, childAbs, childRel);
    else if (e.isFile()) {
      // session.lock 은 서버가 잡고 있는 파일이라 제외
      if (e.name === "session.lock") continue;
      zip.addFile(childAbs, childRel);
    }
  }
}

export async function deleteBackup(serverDir: string, file: string) {
  assertPlainFilename(file);
  try {
    await fs.rm(path.join(serverDir, BACKUP_DIR, file));
  } catch {
    throw notFound("백업 파일을 찾을 수 없습니다.");
  }
}

/** 오래된 자동 백업을 keep 개만 남기고 삭제 */
export async function pruneScheduled(serverDir: string, keep: number) {
  const auto = (await listBackups(serverDir)).filter((b) => b.scheduled);
  for (const b of auto.slice(keep)) await deleteBackup(serverDir, b.file).catch(() => {});
}

/**
 * 복원. 서버는 반드시 중지 상태여야 한다 (호출자가 확인).
 * 1) zip 을 끝까지 훑어 항목 수와 경로를 검사한다 (잘렸거나 월드 폴더 밖을 가리키면 거절)
 * 2) <월드>.restoring-<stamp> 폴더에 전부 푼다 — 여기서 실패하면 현재 월드는 손대지 않은 채 임시 폴더만 지운다
 * 3) 월드 폴더를 하나씩 바꿔치기한다: 현재 폴더를 .blockpilot-backup/restore-<stamp>/ 로 옮기고 임시 폴더를 제자리로 rename.
 *    도중에 실패하면 이미 바꾼 것까지 전부 되돌리고, 되돌리기마저 실패하면 원래 월드가 든 폴더를 절대 지우지 않고 그 경로를 알려 준다.
 * 같은 서버에서 백업/복원이 이미 돌고 있으면 409.
 */
export async function restoreBackup(serverDir: string, file: string) {
  assertPlainFilename(file);
  const release = acquire(serverDir, "restore");
  try {
    return await restoreBackupLocked(serverDir, file);
  } finally {
    release();
  }
}

async function restoreBackupLocked(serverDir: string, file: string) {
  const zipPath = path.join(serverDir, BACKUP_DIR, file);
  await fs.access(zipPath).catch(() => {
    throw notFound("백업 파일을 찾을 수 없습니다.");
  });

  const expected = await expectedWorldDirs(serverDir);
  const { tops, files } = await inspectBackupZip(zipPath, expected);
  if (!files) throw badRequest("비어 있거나 잘못된 백업 파일입니다.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 예전에 복원하다 죽어서 남은 임시 폴더가 있으면 먼저 치운다 (한참 된 것만 — 이번 복원 것은 당연히 건드리지 않는다)
  await removeLeftoverStaging(serverDir, tops, stamp);

  const staging = new Map(tops.map((t) => [t, path.join(serverDir, `${t}${RESTORING_INFIX}${stamp}`)]));
  try {
    await extractZip(zipPath, staging);
  } catch (e) {
    for (const dir of staging.values()) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  // 여기까지 왔으면 zip 은 온전히 풀렸다. 이제 바꿔치기
  const trash = path.join(serverDir, ".blockpilot-backup", `restore-${stamp}`);
  await swapWorlds(serverDir, tops, staging, trash);
  return { restored: tops, previousMovedTo: path.relative(serverDir, trash) };
}

/**
 * 월드 폴더를 하나씩 바꿔치기한다. 각 폴더마다 "현재 → trash" 다음 "임시 → 현재" 순서라, 어느 단계에서 실패해도
 * 어떤 폴더가 어디에 있는지 정확히 안다. 실패하면:
 *   1) 이미 제자리에 들어간 새 폴더를 임시 폴더 이름으로 다시 빼낸다
 *   2) trash 로 옮겨 둔 원래 폴더를 제자리로 되돌린다
 *   3) 임시 폴더를 지운다
 * 되돌리기가 하나라도 실패하면 trash 는 절대 지우지 않고(원래 월드가 거기 있다) 경로를 메시지에 담아 던진다.
 * rename 은 전부 retryFs 를 거친다 — Windows 백신이 방금 푼 파일을 잠깐 잡고 있으면 EPERM 이 나는데 잠시 뒤 풀린다.
 */
async function swapWorlds(serverDir: string, tops: string[], staging: Map<string, string>, trash: string) {
  await fs.mkdir(trash, { recursive: true });
  const movedOut: string[] = []; // 원래 폴더가 trash 로 옮겨진 것
  const swapped: string[] = []; // 새 폴더가 제자리에 들어간 것
  try {
    for (const t of tops) {
      const cur = path.join(serverDir, t);
      const st = await fs.stat(cur).catch(() => null);
      if (st?.isDirectory()) {
        await retryFs(() => fs.rename(cur, path.join(trash, t)));
        movedOut.push(t);
      }
      await retryFs(() => fs.rename(staging.get(t)!, cur));
      swapped.push(t);
    }
  } catch (e) {
    const failed: string[] = [];
    for (const t of swapped) {
      await retryFs(() => fs.rename(path.join(serverDir, t), staging.get(t)!)).catch(() => failed.push(t));
    }
    for (const t of movedOut) {
      if (failed.includes(t)) continue; // 제자리에 새 폴더가 아직 남아 있어 되돌릴 수 없다
      await retryFs(() => fs.rename(path.join(trash, t), path.join(serverDir, t))).catch(() => failed.push(t));
    }
    for (const dir of staging.values()) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (failed.length) {
      const reason = (e as Error)?.message ?? String(e);
      throw new HttpError(
        500,
        "restore_swap_failed",
        `복원 도중 월드 폴더를 바꿔치기하지 못했고 되돌리기도 실패했어요 (${failed.join(", ")}: ${reason}). ` +
          `원래 월드는 ${path.relative(serverDir, trash)} 에 남아 있어요. 서버를 켜기 전에 그 폴더의 내용을 서버 폴더로 직접 옮겨 주세요.`,
      );
    }
    // 전부 되돌렸으니 빈 trash 폴더(와 비어 있다면 그 상위 .blockpilot-backup)를 치운다 — rmdir 은 비어 있지 않으면 실패하므로 다른 복원의 흔적은 건드리지 않는다
    await fs.rm(trash, { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(path.dirname(trash)).catch(() => {});
    throw e;
  }
}

/** zip 항목 이름이 안전한 상대 경로인지 (절대 경로·드라이브 문자·.. 세그먼트·역슬래시 금지) */
function isSafeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every((seg) => seg !== ".." && seg !== ".");
}

/**
 * zip 을 끝까지 훑어 최상위 폴더 목록과 파일 수를 돌려준다. 열 수 없거나(잘림·손상), 경로가 위험하거나,
 * 최상위 폴더가 이 서버의 월드 폴더 이름(level-name 기준)이 아니면 거절한다.
 */
function inspectBackupZip(zipPath: string, expectedTops: string[]): Promise<{ tops: string[]; files: number }> {
  return new Promise((resolve, reject) => {
    const unreadable = (err: unknown) => {
      const msg = (err as Error)?.message ?? String(err);
      // yauzl 이 항목 이름을 먼저 검사해 .. / 절대 경로 / 역슬래시를 거부한다 — 손상이 아니라 위험한 경로라고 알려 준다
      if (/^(invalid relative path|absolute path|invalid characters in fileName)/.test(msg)) {
        return reject(conflict(`백업 안에 서버 폴더를 벗어나는 경로가 있어요: ${msg.replace(/^[^:]*: /, "")}`));
      }
      reject(badRequest(`백업 파일을 열 수 없어요. 끝까지 쓰이지 않았거나 손상된 zip 같아요 (${msg}).`));
    };
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return unreadable(err);
      const tops = new Set<string>();
      let files = 0;
      let failed = false;
      const fail = (e: Error) => {
        if (failed) return;
        failed = true;
        reject(e);
        zip.close();
      };
      zip.on("entry", (e: yauzl.Entry) => {
        const name: string = e.fileName;
        if (!isSafeEntryName(name)) return fail(conflict(`백업 안에 서버 폴더를 벗어나는 경로가 있어요: ${name}`));
        const top = name.split("/")[0];
        if (!expectedTops.includes(top)) {
          return fail(badRequest(`백업 안의 '${top}' 은(는) 이 서버의 월드 폴더(${expectedTops.join(", ")})가 아니에요. server.properties 의 level-name 을 확인해 주세요.`));
        }
        if (!name.endsWith("/")) {
          // 중앙 디렉터리는 있는데 실제 데이터가 파일 끝을 넘어가면 잘린 zip
          if (e.relativeOffsetOfLocalHeader + e.compressedSize > zip.fileSize) {
            return fail(badRequest(`백업 파일이 끝까지 쓰이지 않았어요 (${name} 의 데이터가 파일 밖을 가리켜요).`));
          }
          files++;
        }
        tops.add(top);
        zip.readEntry();
      });
      zip.on("end", () => {
        if (!failed) resolve({ tops: [...tops], files });
      });
      zip.on("error", unreadable);
      zip.readEntry();
    });
  });
}

/**
 * 복원하다 죽어서 남은 <월드>.restoring-* 폴더 제거.
 * 이번 복원의 stamp 가 붙은 것과 아직 따끈한 것(STALE_STAGING_MS 이내)은 건드리지 않는다 — 돌고 있는 복원의 임시 폴더일 수 있다.
 */
async function removeLeftoverStaging(serverDir: string, tops: string[], currentStamp: string) {
  const names = await fs.readdir(serverDir).catch(() => [] as string[]);
  for (const n of names) {
    if (!tops.some((t) => n.startsWith(t + RESTORING_INFIX))) continue;
    if (n.endsWith(RESTORING_INFIX + currentStamp)) continue;
    const full = path.join(serverDir, n);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isDirectory() || Date.now() - st.mtimeMs < STALE_STAGING_MS) continue;
    await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

/** zip 의 각 최상위 폴더를 staging 에 적힌 폴더로 푼다 (top → 실제 폴더). 항목은 inspectBackupZip 에서 이미 검사했다. */
function extractZip(zipPath: string, staging: Map<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      let failed = false;
      const fail = (e: unknown) => {
        if (failed) return;
        failed = true;
        reject(e);
        zip.close();
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!failed) resolve();
      });
      zip.on("entry", async (e: yauzl.Entry) => {
        try {
          const name: string = e.fileName;
          const [top, ...rest] = name.split("/");
          const root = staging.get(top);
          if (!root || !isSafeEntryName(name)) throw conflict(`zip 경로가 서버 폴더를 벗어납니다: ${name}`);
          const dest = path.join(root, ...rest);
          const resolvedRoot = path.resolve(root);
          if (path.resolve(dest) !== resolvedRoot && !path.resolve(dest).startsWith(resolvedRoot + path.sep)) throw conflict("zip 경로가 서버 폴더를 벗어납니다.");
          if (name.endsWith("/")) {
            await fs.mkdir(dest, { recursive: true });
            return zip.readEntry();
          }
          await fs.mkdir(path.dirname(dest), { recursive: true });
          zip.openReadStream(e, (se, stream) => {
            if (se || !stream) return fail(se);
            const ws = createWriteStream(dest);
            stream.on("error", fail);
            stream.pipe(ws);
            ws.on("close", () => zip.readEntry());
            ws.on("error", fail);
          });
        } catch (x) {
          fail(x);
        }
      });
      zip.readEntry();
    });
  });
}
