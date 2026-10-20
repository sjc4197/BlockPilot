import fs from "node:fs/promises";
import path from "node:path";
import type { PlayerListKind } from "@blockpilot/shared";
import { writeFileAtomic } from "../lib/atomicWrite.js";

/**
 * whitelist.json / ops.json / banned-players.json / banned-ips.json
 * 마인크래프트가 쓰는 포맷 그대로 읽고 쓴다 (들여쓰기 2칸 배열).
 */

export const LIST_FILES: Record<PlayerListKind, string> = {
  whitelist: "whitelist.json",
  ops: "ops.json",
  "banned-players": "banned-players.json",
  "banned-ips": "banned-ips.json",
};

export async function readList<T = any>(serverDir: string, kind: PlayerListKind): Promise<T[]> {
  const file = path.join(serverDir, LIST_FILES[kind]);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function writeList(serverDir: string, kind: PlayerListKind, entries: unknown[]) {
  const file = path.join(serverDir, LIST_FILES[kind]);
  await writeFileAtomic(file, JSON.stringify(entries, null, 2));
}

/** 마인크래프트 밴 파일의 날짜 포맷: "2026-10-20 10:31:05 +0900" */
export function mcTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}
