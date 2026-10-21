import fs from "node:fs/promises";
import path from "node:path";
import type { PerfInfo, PerfSample } from "@blockpilot/shared";
import { listServers } from "../config/store.js";
import { getManaged, type ManagedServer } from "./process.js";
import { detectServer } from "./serverInfo.js";
import { treeMemoryMb } from "./procmem.js";
import { platform } from "./platform/index.js";

/**
 * 성능 모니터. 대시보드를 보고 있는 동안만(최근 60초 안에 조회) 메모리는 5초, 틱 시간은 30초마다 잰다.
 * "Can't keep up" 경고는 언제나 센다 (로그 줄을 보기만 하므로 비용이 없음).
 */
const KEEP_MS = 30 * 60_000;
const VIEW_MS = 60_000;
const MEM_EVERY = platform.id === "windows" ? 10_000 : 5_000;
const TICK_EVERY = 30_000;

interface State {
  samples: PerfSample[];
  lags: { t: number; ms: number }[];
  viewedAt: number;
  lastMem: number;
  lastTick: number;
  tick: "ok" | "unsupported" | "unknown";
  busy: boolean;
}
const states = new Map<string, State>();
const attached = new WeakSet<ManagedServer>();

function st(id: string): State {
  let s = states.get(id);
  if (!s) {
    s = { samples: [], lags: [], viewedAt: 0, lastMem: 0, lastTick: 0, tick: "unknown", busy: false };
    states.set(id, s);
  }
  return s;
}

/** "Can't keep up! Is the server overloaded? Running 2034ms or 40 ticks behind" → 2034 */
export function parseLag(line: string): number | null {
  const m = line.match(/Can't keep up! .*Running (\d+)ms/);
  return m ? Number(m[1]) : null;
}

/** 시작 스크립트의 -Xmx (MB) */
export function parseXmx(text: string): number | undefined {
  const m = text.match(/-Xmx(\d+)([gGmMkK])?\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = (m[2] ?? "").toLowerCase();
  return u === "g" ? n * 1024 : u === "k" ? Math.round(n / 1024) : u === "m" ? n : Math.round(n / 1048576);
}

function attach(id: string, m: ManagedServer) {
  if (attached.has(m)) return;
  attached.add(m);
  m.on("line", (l: { text: string }) => {
    const ms = parseLag(l.text);
    if (ms !== null) st(id).lags.push({ t: Date.now(), ms });
  });
}

async function sample(id: string, dir: string) {
  const s = st(id);
  const m = getManaged(id, dir);
  attach(id, m);
  const now = Date.now();
  s.samples = s.samples.filter((x) => now - x.t < KEEP_MS);
  s.lags = s.lags.filter((x) => now - x.t < 60 * 60_000);
  if (now - s.viewedAt > VIEW_MS || s.busy) return;
  const status = await m.status();
  if (status.state !== "running" && !(status.state === "external" && status.rcon === "connected")) return;
  s.busy = true;
  try {
    const point: PerfSample = { t: now };
    const pid = m.childPid();
    if (pid && now - s.lastMem >= MEM_EVERY - 500) {
      s.lastMem = now;
      point.memMb = (await treeMemoryMb(pid)) ?? undefined;
    }
    if (s.tick !== "unsupported" && now - s.lastTick >= TICK_EVERY - 500) {
      s.lastTick = now;
      const r = await m.probeTick();
      if (r === "unsupported") s.tick = "unsupported";
      else if (typeof r === "number") {
        s.tick = "ok";
        point.mspt = r;
      }
    }
    if (point.memMb !== undefined || point.mspt !== undefined) s.samples.push(point);
  } finally {
    s.busy = false;
  }
}

export async function perfInfo(id: string, dir: string): Promise<PerfInfo> {
  const s = st(id);
  const first = s.viewedAt === 0 || Date.now() - s.viewedAt > VIEW_MS;
  s.viewedAt = Date.now();
  if (first) await sample(id, dir).catch(() => {});
  const m = getManaged(id, dir);
  const status = await m.status();
  const measuring = status.state === "running" || (status.state === "external" && status.rcon === "connected");
  let maxMemMb: number | undefined;
  try {
    const info = await detectServer(dir);
    if (info.startScript) maxMemMb = parseXmx(await fs.readFile(path.join(dir, info.startScript), "utf8"));
  } catch {
    /* 스크립트를 못 읽으면 표시만 생략 */
  }
  const lastHour = s.lags.length;
  const worst = s.lags.reduce((a, b) => Math.max(a, b.ms), 0);
  const recentMem = s.samples.filter((x) => x.memMb !== undefined && Date.now() - x.t < 5 * 60_000).map((x) => x.memMb!);
  const avgMem = recentMem.length ? recentMem.reduce((a, b) => a + b, 0) / recentMem.length : 0;
  const recentTick = s.samples.filter((x) => x.mspt !== undefined).slice(-6).map((x) => x.mspt!);
  const avgTick = recentTick.length ? recentTick.reduce((a, b) => a + b, 0) / recentTick.length : 0;
  let advice: string | undefined;
  // 자바는 힙(-Xmx)보다 몇백 MB 더 쓰는 게 정상이라, 메모리만 보고 겁주지 않고 렉 경고가 함께 있을 때만 권한다
  if (maxMemMb && avgMem >= maxMemMb && lastHour >= 3) advice = `메모리가 최대치(-Xmx ${Math.round(maxMemMb / 1024)}GB)에 붙어 있고 렉 경고도 잦아요. 시작 스크립트의 -Xmx 를 1~2GB 늘려 보세요.`;
  else if (avgTick > 50) advice = "한 틱이 50ms 를 넘어 서버가 느려지고 있어요. 서버 설정의 시야 거리(view-distance)·시뮬레이션 거리를 줄이거나 무거운 모드를 확인해 보세요.";
  else if (lastHour >= 10) advice = "최근 1시간 동안 렉 경고가 잦아요. 시야 거리를 줄이거나, 접속자가 많은 시간대인지 확인해 보세요.";
  return {
    measuring,
    maxMemMb,
    samples: s.samples,
    tick: s.tick,
    lag: { lastHour, worstMs: worst || undefined, lastAt: s.lags.length ? new Date(s.lags[s.lags.length - 1].t).toISOString() : undefined },
    advice,
  };
}

let timer: NodeJS.Timeout | null = null;
export function startPerfSampler() {
  if (timer) return;
  timer = setInterval(async () => {
    for (const s of await listServers().catch(() => [])) await sample(s.id, s.path).catch(() => {});
  }, 5000);
  timer.unref();
}
export function stopPerfSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}
