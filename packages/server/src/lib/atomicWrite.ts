import fs from "node:fs/promises";
import path from "node:path";
import { retryFs } from "./retry.js";

const BACKUP_DIR = ".blockpilot-backup";
const MAX_BACKUPS_PER_FILE = 10;

/**
 * 기존 파일을 `.blockpilot-backup/<name>.<timestamp>`에 복사한 뒤
 * 임시 파일에 쓰고 rename으로 교체한다 (쓰다 중단돼도 원본이 깨지지 않음).
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await backupIfExists(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
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
