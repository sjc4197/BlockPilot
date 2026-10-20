import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import yazl from "yazl";
import yauzl from "yauzl";
import type { BackupEntry } from "@blockpilot/shared";
import { assertPlainFilename } from "../lib/safePath.js";
import { readPropertiesFile, toRecord } from "./properties.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

/**
 * 월드 백업: <serverDir>/backups/<level>-<timestamp>[-auto].zip
 * 네더/엔드가 별도 폴더인 Paper/Spigot(world_nether, world_the_end)도 함께 묶는다.
 */

export const BACKUP_DIR = "backups";

export async function worldDirs(serverDir: string): Promise<string[]> {
  const { lines } = await readPropertiesFile(serverDir);
  const level = toRecord(lines)["level-name"] ?? "world";
  const candidates = [level, `${level}_nether`, `${level}_the_end`];
  const out: string[] = [];
  for (const c of candidates) {
    const st = await fs.stat(path.join(serverDir, c)).catch(() => null);
    if (st?.isDirectory()) out.push(c);
  }
  return out;
}

export async function listBackups(serverDir: string): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(serverDir, BACKUP_DIR));
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const file of names) {
    if (!file.endsWith(".zip")) continue;
    const st = await fs.stat(path.join(serverDir, BACKUP_DIR, file)).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ file, sizeBytes: st.size, createdAt: st.mtime.toISOString(), scheduled: file.endsWith("-auto.zip") });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBackup(serverDir: string, opts: { scheduled?: boolean; label?: string } = {}): Promise<BackupEntry> {
  const dirs = await worldDirs(serverDir);
  if (!dirs.length) throw badRequest("백업할 월드 폴더가 없습니다.");
  const outDir = path.join(serverDir, BACKUP_DIR);
  await fs.mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const label = opts.label ? "-" + opts.label.replace(/[^A-Za-z0-9_\-가-힣]/g, "") : "";
  const file = `${dirs[0]}-${stamp}${label}${opts.scheduled ? "-auto" : ""}.zip`;
  const target = path.join(outDir, file);

  const zip = new yazl.ZipFile();
  for (const d of dirs) await addDir(zip, path.join(serverDir, d), d);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(target);
    ws.on("close", () => resolve());
    ws.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(ws);
  });

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
 * 복원: 현재 월드 폴더를 .blockpilot-backup/ 으로 옮긴 뒤 zip을 풀어 넣는다.
 * 서버는 반드시 중지 상태여야 한다 (호출자가 확인).
 */
export async function restoreBackup(serverDir: string, file: string) {
  assertPlainFilename(file);
  const zipPath = path.join(serverDir, BACKUP_DIR, file);
  await fs.access(zipPath).catch(() => {
    throw notFound("백업 파일을 찾을 수 없습니다.");
  });

  // zip 안의 최상위 폴더 목록 = 덮어쓸 월드 폴더들
  const tops = await zipTopLevelDirs(zipPath);
  if (!tops.length) throw badRequest("비어 있거나 잘못된 백업 파일입니다.");
  for (const t of tops) assertPlainFilename(t);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trash = path.join(serverDir, ".blockpilot-backup", `restore-${stamp}`);
  await fs.mkdir(trash, { recursive: true });
  for (const t of tops) {
    const cur = path.join(serverDir, t);
    const st = await fs.stat(cur).catch(() => null);
    if (st?.isDirectory()) await fs.rename(cur, path.join(trash, t));
  }
  await extractZip(zipPath, serverDir, tops);
  return { restored: tops, previousMovedTo: path.relative(serverDir, trash) };
}

function zipTopLevelDirs(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const tops = new Set<string>();
      zip.on("entry", (e) => {
        const top = e.fileName.split("/")[0];
        if (top && !e.fileName.startsWith("/") && !e.fileName.includes("..")) tops.add(top);
        zip.readEntry();
      });
      zip.on("end", () => resolve([...tops]));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

function extractZip(zipPath: string, destRoot: string, allowedTops: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", async (e) => {
        try {
          const name: string = e.fileName;
          const top = name.split("/")[0];
          if (!allowedTops.includes(top) || name.includes("..")) return zip.readEntry();
          const dest = path.join(destRoot, name);
          if (!path.resolve(dest).startsWith(path.resolve(destRoot) + path.sep)) throw conflict("zip 경로가 서버 폴더를 벗어납니다.");
          if (name.endsWith("/")) {
            await fs.mkdir(dest, { recursive: true });
            return zip.readEntry();
          }
          await fs.mkdir(path.dirname(dest), { recursive: true });
          zip.openReadStream(e, (se, stream) => {
            if (se || !stream) return reject(se);
            const ws = createWriteStream(dest);
            stream.pipe(ws);
            ws.on("close", () => zip.readEntry());
            ws.on("error", reject);
          });
        } catch (x) {
          reject(x);
        }
      });
      zip.readEntry();
    });
  });
}
