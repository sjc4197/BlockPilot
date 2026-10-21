import fs from "node:fs/promises";
import path from "node:path";
import type { PlayerStats, StatCount, StatsResponse } from "@blockpilot/shared";
import { BLOCKPILOT_HOME } from "../config/store.js";
import { onServerEvent } from "./events.js";
import { readPropertiesFile, toRecord } from "./properties.js";

/**
 * 플레이어 통계.
 * - 월드 폴더의 stats/<UUID>.json (마인크래프트가 자동 저장 때 씀)을 읽기만 한다
 * - BlockPilot 이 지켜본 입장·퇴장으로 날짜별 접속 시간을 앱 폴더에 쌓는다 (이번 주 순위용)
 */

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function top(group: unknown, n: number): StatCount[] {
  if (!group || typeof group !== "object") return [];
  return Object.entries(group as Record<string, unknown>)
    .map(([id, v]) => ({ id, n: num(v) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}
const sum = (group: unknown) => (group && typeof group === "object" ? Object.values(group as Record<string, unknown>).reduce<number>((a, v) => a + num(v), 0) : 0);

/** stats/<uuid>.json 한 개 → 요약. 1.13 이상(minecraft:custom)과 그 이전(stat.xxx) 둘 다 */
export function parseStatsFile(json: Raw, uuid: string, savedAt: string): PlayerStats {
  const s = (json.stats ?? null) as Record<string, Raw> | null;
  if (s) {
    const c = (s["minecraft:custom"] ?? {}) as Raw;
    const cm = ["walk_one_cm", "sprint_one_cm", "crouch_one_cm", "swim_one_cm", "walk_on_water_one_cm", "walk_under_water_one_cm"].reduce((a, k) => a + num(c[`minecraft:${k}`]), 0);
    return {
      uuid,
      // 1.17 부터 play_time, 그 전엔 play_one_minute (둘 다 틱 단위)
      playMinutes: Math.round(num(c["minecraft:play_time"] ?? c["minecraft:play_one_minute"]) / 20 / 60),
      deaths: num(c["minecraft:deaths"]),
      mined: sum(s["minecraft:mined"]),
      walkedKm: Math.round(cm / 1000) / 100,
      mobKills: num(c["minecraft:mob_kills"]),
      playerKills: num(c["minecraft:player_kills"]),
      jumps: num(c["minecraft:jump"]),
      topMined: top(s["minecraft:mined"], 5),
      topKilled: top(s["minecraft:killed"], 5),
      killedBy: top(s["minecraft:killed_by"], 3),
      savedAt,
    };
  }
  // 1.12 이하: { "stat.playOneMinute": n, "stat.mineBlock.minecraft.stone": n, ... }
  const pick = (prefix: string) => Object.fromEntries(Object.entries(json).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [`minecraft:${k.slice(prefix.length).replace(/^minecraft\./, "")}`, v]));
  const mined = pick("stat.mineBlock.");
  return {
    uuid,
    playMinutes: Math.round(num(json["stat.playOneMinute"]) / 20 / 60),
    deaths: num(json["stat.deaths"]),
    mined: sum(mined),
    walkedKm: Math.round((num(json["stat.walkOneCm"]) + num(json["stat.sprintOneCm"])) / 1000) / 100,
    mobKills: num(json["stat.mobKills"]),
    playerKills: num(json["stat.playerKills"]),
    jumps: num(json["stat.jump"]),
    topMined: top(mined, 5),
    topKilled: top(pick("stat.killEntity."), 5),
    killedBy: top(pick("stat.entityKilledBy."), 3),
    savedAt,
  };
}

async function names(dir: string): Promise<Map<string, string>> {
  try {
    const list = JSON.parse(await fs.readFile(path.join(dir, "usercache.json"), "utf8")) as { name: string; uuid: string }[];
    return new Map(list.map((x) => [x.uuid.toLowerCase(), x.name]));
  } catch {
    return new Map();
  }
}

export async function readStats(serverId: string, dir: string): Promise<StatsResponse> {
  const props = toRecord((await readPropertiesFile(dir)).lines);
  const world = props["level-name"] || "world";
  const sdir = path.join(dir, world, "stats");
  const who = await names(dir);
  const players: PlayerStats[] = [];
  let savedAt: string | undefined;
  for (const f of await fs.readdir(sdir).catch(() => [] as string[])) {
    const m = f.match(/^([0-9a-f-]{32,36})\.json$/i);
    if (!m) continue;
    try {
      const full = path.join(sdir, f);
      const st = await fs.stat(full);
      if (st.size > 5 * 1024 * 1024) continue;
      const at = st.mtime.toISOString();
      if (!savedAt || at > savedAt) savedAt = at;
      const p = parseStatsFile(JSON.parse(await fs.readFile(full, "utf8")), m[1], at);
      p.name = who.get(m[1].toLowerCase());
      players.push(p);
    } catch {
      /* 깨진 파일은 건너뜀 */
    }
  }
  return { world, savedAt, players, week: await weekMinutes(serverId) };
}

// ---------- BlockPilot 이 지켜본 접속 시간 ----------

type Days = Record<string, Record<string, number>>;
const sessionsFile = (id: string) => path.join(BLOCKPILOT_HOME, "playtime", `${id}.json`);
const online = new Map<string, Map<string, number>>();
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function loadDays(id: string): Promise<Days> {
  try {
    return JSON.parse(await fs.readFile(sessionsFile(id), "utf8")) as Days;
  } catch {
    return {};
  }
}

/** 접속 구간을 날짜별로 나눠 더한다 (자정을 넘긴 접속도 날짜별로) */
export function addSession(days: Days, name: string, from: number, to: number): Days {
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(to, midnight);
    const k = dayKey(t);
    days[k] = days[k] ?? {};
    days[k][name] = Math.round(((days[k][name] ?? 0) + (end - t) / 60_000) * 10) / 10;
    t = end;
  }
  // 60일보다 오래된 날은 지운다
  const keep = dayKey(to - 60 * 86_400_000);
  for (const k of Object.keys(days)) if (k < keep) delete days[k];
  return days;
}

const writes = new Map<string, Promise<unknown>>();
async function record(id: string, name: string, from: number, to: number) {
  const job = (writes.get(id) ?? Promise.resolve()).then(async () => {
    const days = addSession(await loadDays(id), name, from, to);
    await fs.mkdir(path.dirname(sessionsFile(id)), { recursive: true });
    await fs.writeFile(sessionsFile(id), JSON.stringify(days), { mode: 0o600 });
  });
  writes.set(id, job.catch(() => {}));
  await job;
}

export async function weekMinutes(id: string, now = Date.now()): Promise<{ name: string; minutes: number }[]> {
  await writes.get(id);
  const days = await loadDays(id);
  const total = new Map<string, number>();
  for (let i = 0; i < 7; i++) for (const [n, m] of Object.entries(days[dayKey(now - i * 86_400_000)] ?? {})) total.set(n, (total.get(n) ?? 0) + m);
  // 지금 접속 중인 사람은 진행 중인 시간도 더한다
  for (const [n, from] of online.get(id) ?? []) total.set(n, (total.get(n) ?? 0) + (now - from) / 60_000);
  return [...total.entries()].map(([name, minutes]) => ({ name, minutes: Math.round(minutes) })).sort((a, b) => b.minutes - a.minutes);
}

let started = false;
export function startPlaytimeTracker() {
  if (started) return;
  started = true;
  onServerEvent(async (e) => {
    const m = online.get(e.serverId) ?? new Map<string, number>();
    online.set(e.serverId, m);
    const now = new Date(e.at).getTime();
    if (e.type === "joined" && e.player) m.set(e.player, now);
    else if (e.type === "left" && e.player) {
      const from = m.get(e.player);
      m.delete(e.player);
      if (from !== undefined) await record(e.serverId, e.player, from, now);
    } else if (e.type === "stopped" || e.type === "crashed") {
      for (const [p, from] of [...m]) await record(e.serverId, p, from, now);
      m.clear();
    }
  });
}

/** 서버를 지울 때 접속 기록도 지운다 */
export async function forgetPlaytime(id: string) {
  online.delete(id);
  await fs.rm(sessionsFile(id), { force: true });
}

