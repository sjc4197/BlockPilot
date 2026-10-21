import type { ServerEvent } from "@blockpilot/shared";
import { getAutomation, listServers } from "../config/store.js";
import { emitServerEvent, onServerEvent } from "./events.js";
import { getManaged } from "./process.js";
import { automationRuntime } from "./automationState.js";

/**
 * 크래시 자동 재시작.
 * - 켠 서버에만, 정한 시간(기본 30초) 뒤 다시 켠다
 * - 10분 안에 세 번 넘게 죽으면 같은 문제가 반복되는 것이라 멈추고 알린다
 * - 사람이 레버로 켜거나 끄면 횟수를 처음부터 다시 센다
 */
export const WINDOW_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;

let secondMs = 1000;
/** 테스트용: 1초를 몇 ms 로 칠지 */
export function setAutoRestartSecond(ms: number) {
  secondMs = ms;
}

const attempts = new Map<string, number[]>();
const timers = new Map<string, NodeJS.Timeout>();
const ours = new Set<string>();

function recent(id: string) {
  const now = Date.now();
  const list = (attempts.get(id) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(id, list);
  return list;
}

function reset(id: string) {
  attempts.delete(id);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  const rt = automationRuntime(id);
  rt.recentAttempts = 0;
  rt.gaveUp = false;
  rt.pendingRestartAt = undefined;
}

export async function handleAutoRestart(e: ServerEvent) {
  const id = e.serverId;
  const rt = automationRuntime(id);
  if (e.type === "crashed") {
    rt.lastCrash = e.crash;
    const a = await getAutomation(id);
    if (!a.autoRestart.enabled) return;
    const list = recent(id);
    if (list.length >= MAX_ATTEMPTS) {
      rt.gaveUp = true;
      rt.pendingRestartAt = undefined;
      emitServerEvent({ serverId: id, type: "auto-restart-failed", detail: `10분 안에 ${MAX_ATTEMPTS}번 넘게 꺼져서 더는 자동으로 켜지 않아요. 원인을 고친 뒤 레버로 켜 주세요.` });
      return;
    }
    list.push(Date.now());
    rt.recentAttempts = list.length;
    const delay = a.autoRestart.delaySeconds;
    rt.pendingRestartAt = new Date(Date.now() + delay * secondMs).toISOString();
    emitServerEvent({ serverId: id, type: "auto-restart", detail: `${delay}초 뒤 다시 켜요 (10분 안에 ${list.length}/${MAX_ATTEMPTS}번째)` });
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(async () => {
        timers.delete(id);
        rt.pendingRestartAt = undefined;
        const server = (await listServers()).find((s) => s.id === id);
        if (!server) return;
        const m = getManaged(id, server.path);
        // 그새 사람이 켰으면 그대로 둔다
        if (m.isManaged() || (await m.status()).state !== "stopped") return;
        ours.add(id);
        try {
          await m.start();
        } catch (err) {
          ours.delete(id);
          emitServerEvent({ serverId: id, type: "auto-restart-failed", detail: `다시 켜지 못했어요: ${(err as Error).message}` });
        }
      }, delay * secondMs),
    );
    return;
  }
  if (e.type === "started") {
    // 자동 재시작으로 켜진 거면 횟수를 이어 세고, 사람이 켠 거면 처음부터
    if (ours.has(id)) ours.delete(id);
    else reset(id);
    return;
  }
  if (e.type === "stopped") reset(id);
}

let started = false;
export function startAutoRestart() {
  if (started) return;
  started = true;
  onServerEvent((e) => handleAutoRestart(e));
}
