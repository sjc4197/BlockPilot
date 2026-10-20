import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { LogFileEntry, LogFileContent } from "@blockpilot/shared";
import { assertPlainFilename } from "../lib/safePath.js";
import { notFound } from "../lib/errors.js";

const MAX_LINES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;

export async function listLogs(serverDir: string): Promise<LogFileEntry[]> {
  const out: LogFileEntry[] = [];
  for (const [dir, kind] of [
    ["logs", "log"],
    ["crash-reports", "crash"],
  ] as const) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(serverDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (kind === "log" && !/\.log(\.gz)?$/.test(name)) continue;
      if (kind === "crash" && !/\.txt$/.test(name)) continue;
      const st = await fs.stat(path.join(serverDir, dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ name, kind, sizeBytes: st.size, mtime: st.mtime.toISOString(), compressed: name.endsWith(".gz") });
    }
  }
  // latest.log 먼저, 그 다음 최신순
  return out.sort((a, b) => (a.name === "latest.log" ? -1 : b.name === "latest.log" ? 1 : b.mtime.localeCompare(a.mtime)));
}

export async function readLog(serverDir: string, kind: "log" | "crash", name: string, tail = MAX_LINES): Promise<LogFileContent> {
  assertPlainFilename(name);
  const file = path.join(serverDir, kind === "log" ? "logs" : "crash-reports", name);
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch {
    throw notFound("로그 파일을 찾을 수 없습니다.");
  }
  if (name.endsWith(".gz")) buf = gunzipSync(buf);
  let truncated = false;
  if (buf.length > MAX_BYTES) {
    buf = buf.subarray(buf.length - MAX_BYTES);
    truncated = true;
  }
  const all = buf.toString("utf8").split(/\r?\n/);
  if (all.length && all[all.length - 1] === "") all.pop();
  const limit = Math.min(tail, MAX_LINES);
  const lines = all.length > limit ? all.slice(-limit) : all;
  return { name, totalLines: all.length, truncated: truncated || lines.length < all.length, lines };
}
