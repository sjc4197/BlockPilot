import fs from "node:fs/promises";
import path from "node:path";
import { retryFs } from "./retry.js";

const BACKUP_DIR = ".blockpilot-backup";
const MAX_BACKUPS_PER_FILE = 10;

/**
 * 기존 파일을 `.blockpilot-backup/<name>.<timestamp>`에 복사한 뒤(backup:false 면 생략)
 * 임시 파일에 쓰고 rename으로 교체한다 (쓰다 중단돼도 원본이 깨지지 않음).
 */
export async function writeFileAtomic(filePath: string, content: string, opts: { mode?: number; backup?: boolean } = {}): Promise<void> {
  if (opts.backup !== false) await backupIfExists(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  // mode 를 주면 임시 파일부터 그 권한으로 만들어, rename 전까지 잠깐이라도 느슨한 권한으로 노출되지 않는다
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: opts.mode });
  await retryFs(() => fs.rename(tmp, filePath));
}

async function backupIfExists(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  const dir = path.join(path.dirname(filePath), BACKUP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(filePath, path.join(dir, `${base}.${stamp}`));
  await pruneBackups(dir, base);
}

async function pruneBackups(dir: string, base: string) {
  const files = (await fs.readdir(dir))
    .filter((f) => f.startsWith(base + "."))
    .sort();
  const excess = files.length - MAX_BACKUPS_PER_FILE;
  for (let i = 0; i < excess; i++) {
    await fs.rm(path.join(dir, files[i]), { force: true });
  }
}
