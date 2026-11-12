import type { AutomationSettings, ConsoleLine } from "@blockpilot/shared";
import { getAutomation, listServers } from "../config/store.js";
import { assertNotBusy } from "./backups.js";
import { onServerEvent } from "./events.js";
import { getManaged, type ManagedServer } from "./process.js";

/**
 * 아무도 없으면 자동으로 끄기.
 * 1분마다 BlockPilot 이 켠 서버를 살펴서, 접속자 0명인 채로 정한 시간이 지나면 곱게(stop 명령) 끈다.
 *
 * 로그의 "joined the game" 줄만 믿고 끄지 않는다 (플러그인·모드팩은 그 줄을 바꾸기도 한다). 두 단계로 확인한다:
 * 1. 비어 있던 시간이 다 차면 서버에 `list` 를 보내 "There are X of a max of Y players online" 응답으로 다시 센다.
 *    X > 0 이면 비어 있지 않은 것으로 보고 처음부터 다시 센다. 0이면 게임 안에 "1분 뒤에 꺼요" 를 알리고 경고 시각을 적는다.
 * 2. 다음 틱(1분 이상 뒤)에 `list` 로 한 번 더 확인하고, 그때도 0명이면 끈다.
 * - 그 사이 누가 들어오거나 서버가 꺼지면 경고를 지우고 "비어 있던 시간" 을 처음부터 다시 센다
 * - 외부에서 띄운 서버·지난번 고아 서버는 건드리지 않는다
 * - 백업·복원이 돌고 있으면 그 틱은 건너뛰고 다음에 다시 본다
 * - 한 서버의 확인(list 응답 기다리기·stop)이 아직 안 끝났으면 그 서버는 이번 틱에 건너뛴다 (다른 서버를 늦추지 않게)
 * 끄고 나면 process.ts 가 여느 때처럼 "stopped" 사건을 올리므로 디스코드 "서버가 꺼졌어요" 알림도 그대로 나간다.
 */
type Idle = AutomationSettings["idleShutdown"];

interface IdleState {
  /** 접속자가 0명이 된 시각 (ms) */
  emptySince: number;
  /** "1분 뒤에 꺼요" 를 알린 시각 (ms). 있으면 다음 틱에 한 번 더 확인하고 끈다 */
  warnedAt?: number;
  /** list 응답을 못 읽었다는 안내를 이미 남겼는지 (틱마다 되풀이하지 않게) */
  unsureNoted?: boolean;
}

/** 서버별 상태. 켜져 있고 비어 있을 때만 들어 있다 */
const idle = new Map<string, IdleState>();
/** 지금 확인·끄는 중인 서버 (틱이 겹치지 않게) */
const inFlight = new Set<string>();

const MINUTE_MS = 60_000;
/** `list` 응답을 기다리는 시간 */
const LIST_REPLY_MS = 1_500;
/** 바닐라 "There are 2 of a max of 20 players online: …", 옛 버전 "There are 2/20 players online:" */
const LIST_RE = /There are (\d+)(?: of a max of |\/)\d+ players online/i;

/** 경고 문구 (게임 안 채팅) */
export const IDLE_WARNING = "1분 뒤에 아무도 없어서 서버를 꺼요. 계속 하려면 지금 들어오세요.";

/**
 * 화면용: 아무도 없어진 시각, 경고를 보낸 시각, 이대로면 꺼질 시각.
 * 꺼지는 건 "비어 있던 시간이 다 찬 틱에 경고 → 그다음 틱에 끄기" 이므로 willStopAt 은 경고 뒤 1분이다.
 */
export function idleShutdownStatus(id: string, s: Idle): { emptySince?: string; warnedAt?: string; willStopAt?: string } {
  const st = idle.get(id);
  if (!s.enabled || !st) return {};
  const warnAt = st.warnedAt ?? st.emptySince + s.afterMinutes * MINUTE_MS;
  return {
    emptySince: new Date(st.emptySince).toISOString(),
    warnedAt: st.warnedAt !== undefined ? new Date(st.warnedAt).toISOString() : undefined,
    willStopAt: new Date(warnAt + MINUTE_MS).toISOString(),
  };
}

/**
 * 서버에 `list` 를 보내 접속자 수를 읽는다. 응답이 없거나(명령을 못 보냈거나 형식이 달라서) 못 읽으면 null.
 * 응답은 콘솔 줄로 들어오므로 "line" 사건을 잠깐 듣는다.
 */
function countOnline(m: ManagedServer): Promise<number | null> {
  return new Promise((resolve) => {
    const done = (v: number | null) => {
      clearTimeout(timer);
      m.off("line", onLine);
      resolve(v);
    };
    const onLine = (l: ConsoleLine) => {
      if (l.source === "input" || l.source === "system") return;
      const r = l.text.match(LIST_RE);
      if (r) done(Number(r[1]));
    };
    const timer = setTimeout(() => done(null), LIST_REPLY_MS);
    m.on("line", onLine);
    m.tryCommand("list").then((sent) => !sent && done(null), () => done(null));
  });
}

async function check(id: string, dir: string, now: number) {
  const a = await getAutomation(id);
  const s = a.idleShutdown;
  if (!s.enabled) {
    idle.delete(id);
    return;
  }
  const m = getManaged(id, dir);
  // 외부 실행·고아 서버는 status() 가 포트·RCON 을 건드리므로 아예 보지 않는다
  if (!m.isManaged()) {
    idle.delete(id);
    return;
  }
  const st = await m.status();
  if (st.state !== "running" || st.onlinePlayers.length > 0) {
    idle.delete(id);
    return;
  }
  let state = idle.get(id);
  if (!state) idle.set(id, (state = { emptySince: now }));

  if (state.warnedAt === undefined) {
    if (now - state.emptySince < s.afterMinutes * MINUTE_MS) return;
  } else if (now - state.warnedAt < MINUTE_MS) return;

  // 백업·복원 중이면 끝난 뒤에 다시 본다
  try {
    assertNotBusy(dir);
  } catch {
    return;
  }

  // 로그만 믿지 않고 서버에 직접 물어본다
  const online = await countOnline(m);
  if (online === null) {
    if (!state.unsureNoted) {
      state.unsureNoted = true;
      m.note("접속자 수(list)를 확인하지 못해 자동 끄기를 미뤄요. 다음에 다시 확인할게요.");
    }
    return;
  }
  if (online > 0) {
    idle.delete(id);
    m.note(`list 로 확인해 보니 ${online}명이 있어서 자동 끄기를 처음부터 다시 세요.`);
    return;
  }

  if (state.warnedAt === undefined) {
    // 1단계: 알리고 다음 틱에 한 번 더 본다
    state.warnedAt = now;
    await m.tryCommand(`say ${IDLE_WARNING}`).catch(() => {});
    return;
  }

  // 2단계: 경고 뒤에도 비어 있다 → 끈다
  idle.delete(id);
  try {
    m.note(`${s.afterMinutes}분 동안 아무도 없어서 자동으로 꺼요.`);
    await m.stop();
  } catch {
    /* 이미 꺼졌거나 끄는 중이면 그대로 둔다 */
  }
}

async function checkOnce(id: string, dir: string, now: number) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    await check(id, dir, now);
  } catch {
    /* 한 서버의 오류가 다른 서버 확인을 막지 않게 */
  } finally {
    inFlight.delete(id);
  }
}

/** 등록된 서버를 한 바퀴 살핀다. now 를 넘기면 그 시각으로 친다 (테스트용) */
export async function tickIdleShutdown(now = Date.now()) {
  const servers = await listServers();
  await Promise.all(servers.map((s) => checkOnce(s.id, s.path, now)));
}

/** 설정을 끄거나 서버를 등록 해제·삭제할 때: 기억한 상태(비어 있던 시간·경고)를 지운다 */
export function forgetIdleShutdown(id: string) {
  idle.delete(id);
}

let timer: NodeJS.Timeout | null = null;
let offEvents: (() => void) | null = null;
export function startIdleShutdown() {
  if (timer) return;
  // 틱 사이에 들어왔다 나가도 "비어 있던 시간"·경고가 이어지지 않게, 입장·꺼짐은 바로 반영한다
  offEvents = onServerEvent((e) => {
    if (e.type === "joined" || e.type === "started" || e.type === "stopped" || e.type === "crashed") idle.delete(e.serverId);
  });
  void tickIdleShutdown();
  timer = setInterval(() => void tickIdleShutdown(), MINUTE_MS);
  timer.unref();
}
export function stopIdleShutdown() {
  if (timer) clearInterval(timer);
  timer = null;
  offEvents?.();
  offEvents = null;
  idle.clear();
}
