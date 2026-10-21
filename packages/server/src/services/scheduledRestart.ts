import type { AutomationSettings } from "@blockpilot/shared";
import { getAutomation, listServers } from "../config/store.js";
import { emitServerEvent } from "./events.js";
import { getManaged } from "./process.js";
import { automationRuntime } from "./automationState.js";

/**
 * 예약 재시작: 정한 요일·시각에 BlockPilot 이 켠 서버를 다시 켠다.
 * 10분·5분·1분·10초 전에 게임 채팅으로 노란 공지, 1분 전에 월드 저장.
 * "아무도 없을 때만" 이면 공지 없이, 그 시각에 접속자가 있으면 그날은 건너뛴다.
 */
type Sched = AutomationSettings["scheduledRestart"];

/** from 이후 가장 가까운 예약 시각 (이 컴퓨터의 시간대 기준) */
export function nextRun(s: Sched, from: Date): Date | null {
  if (!s.days.length) return null;
  const [hh, mm] = s.time.split(":").map(Number);
  for (let add = 0; add <= 7; add++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + add, hh, mm, 0, 0);
    if (d.getTime() > from.getTime() && s.days.includes(d.getDay())) return d;
  }
  return null;
}

const WARNINGS: { before: number; text: string }[] = [
  { before: 600, text: "10분 뒤 서버를 다시 켜요. 잠깐 나갔다 들어오세요!" },
  { before: 300, text: "5분 뒤 서버를 다시 켜요." },
  { before: 60, text: "1분 뒤 다시 켜요. 월드를 저장했어요." },
  { before: 10, text: "10초 뒤 다시 켜요!" },
];

let secondMs = 1000;
/** 테스트용: 1초를 몇 ms 로 칠지 */
export function setScheduleSecond(ms: number) {
  secondMs = ms;
}

const planned = new Map<string, { target: number; timers: NodeJS.Timeout[] }>();
const skipTarget = new Map<string, number>();

function cancel(id: string) {
  for (const t of planned.get(id)?.timers ?? []) clearTimeout(t);
  planned.delete(id);
}

async function managedFor(id: string) {
  const server = (await listServers()).find((s) => s.id === id);
  return server ? getManaged(id, server.path) : null;
}

async function say(id: string, text: string) {
  const m = await managedFor(id);
  if (!m?.isManaged()) return;
  await m.tryCommand(`tellraw @a ${JSON.stringify({ text: `[서버] ${text}`, color: "yellow" })}`).catch(() => {});
}

/** target 시각의 재시작을 예약한다 (공지 포함). 이미 지난 공지는 건너뛴다 */
export function planScheduledRestart(id: string, target: number, onlyWhenEmpty: boolean) {
  cancel(id);
  const timers: NodeJS.Timeout[] = [];
  const now = Date.now();
  const at = (ms: number, fn: () => unknown) => timers.push(setTimeout(fn, Math.max(0, ms - now)));
  if (!onlyWhenEmpty) {
    for (const w of WARNINGS) {
      const when = target - w.before * secondMs;
      if (when < now) continue;
      at(when, async () => {
        if (w.before === 60) {
          const m = await managedFor(id);
          await m?.tryCommand("save-all").catch(() => {});
        }
        await say(id, w.text);
      });
    }
  }
  at(target, async () => {
    planned.delete(id);
    if (skipTarget.get(id) === target) {
      skipTarget.delete(id);
      automationRuntime(id).skipNext = false;
      return;
    }
    const m = await managedFor(id);
    if (!m?.isManaged()) return;
    const st = await m.status();
    if (st.state !== "running") return;
    if (onlyWhenEmpty && st.onlinePlayers.length > 0) {
      emitServerEvent({ serverId: id, type: "scheduled-restart", detail: `접속자(${st.onlinePlayers.length}명)가 있어서 이번 예약 재시작은 건너뛰었어요.` });
      return;
    }
    emitServerEvent({ serverId: id, type: "scheduled-restart", detail: "예약한 시각이 되어 서버를 다시 켜요." });
    try {
      await m.restart();
    } catch (e) {
      emitServerEvent({ serverId: id, type: "auto-restart-failed", detail: `예약 재시작 중 다시 켜지 못했어요: ${(e as Error).message}` });
    }
  });
  planned.set(id, { target, timers });
}

/** 서버 하나의 다음 예약을 계산하고, 10분 남짓 남았으면 공지 타이머까지 건다 */
export async function refreshSchedule(id: string) {
  const a = await getAutomation(id);
  const rt = automationRuntime(id);
  const s = a.scheduledRestart;
  if (!s.enabled) {
    cancel(id);
    skipTarget.delete(id);
    rt.nextScheduledAt = undefined;
    rt.skipNext = false;
    return;
  }
  const next = nextRun(s, new Date());
  rt.nextScheduledAt = next?.toISOString();
  if (!next) return cancel(id);
  const target = next.getTime();
  rt.skipNext = skipTarget.get(id) === target;
  const p = planned.get(id);
  if (target - Date.now() <= 11 * 60_000 && p?.target !== target) planScheduledRestart(id, target, s.onlyWhenEmpty);
  if (p && p.target !== target && target - Date.now() > 11 * 60_000) cancel(id);
}

/** 다음 한 번만 건너뛰기 / 되돌리기 */
export async function setSkipNext(id: string, skip: boolean) {
  const a = await getAutomation(id);
  const next = nextRun(a.scheduledRestart, new Date());
  if (!next) return;
  if (skip) skipTarget.set(id, next.getTime());
  else skipTarget.delete(id);
  automationRuntime(id).skipNext = skip;
  // 공지는 건너뛰는 날에도 울리지 않게 다시 건다
  cancel(id);
  if (!skip) await refreshSchedule(id);
}

let timer: NodeJS.Timeout | null = null;
export function startScheduledRestarts() {
  if (timer) return;
  const tick = async () => {
    for (const s of await listServers()) await refreshSchedule(s.id).catch(() => {});
  };
  void tick();
  timer = setInterval(() => void tick(), 30_000);
  timer.unref();
}
export function stopScheduledRestarts() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const id of [...planned.keys()]) cancel(id);
}
