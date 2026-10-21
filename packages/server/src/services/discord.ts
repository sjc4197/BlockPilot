import type { DiscordEventKey, ServerEvent } from "@blockpilot/shared";
import { getAutomation, listServers } from "../config/store.js";
import { onServerEvent } from "./events.js";

/**
 * 디스코드 웹훅 알림.
 * - 웹훅 주소는 비밀값: 로그·API 응답·오류 메시지에 넣지 않는다
 * - 멘션은 전부 막는다 (플레이어 이름으로 @everyone 같은 장난을 못 하게)
 * - 입장·퇴장은 몇 초씩 묶어 보낸다 (디스코드 전송 제한)
 * - 전송 실패는 기록만 하고 서버 동작에는 영향을 주지 않는다
 */

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;
// 테스트 전용: 이 컴퓨터 안의 가짜 수신기로 보낼 때만 (운영자가 환경 변수로 직접 켜야 함)
const LOCAL_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}\/[\w/-]{1,80}$/;

export function isWebhookUrl(url: string) {
  return WEBHOOK_RE.test(url) || (process.env.BLOCKPILOT_DISCORD_ALLOW_LOCAL === "1" && LOCAL_RE.test(url));
}

export function webhookHint(url: string) {
  return url ? `…${url.slice(-4)}` : undefined;
}

export interface DiscordMessage {
  title: string;
  description?: string;
  color: number;
}

const COLOR = { green: 0x57f287, gray: 0x95a5a6, red: 0xed4245, yellow: 0xfee75c, blue: 0x5865f2 };

/** 디스코드 마크다운으로 읽히지 않게 (밑줄이 든 닉네임 등) */
export function escapeMd(s: string) {
  return s.replace(/([\\*_~`|>])/g, "\\$1");
}

/** 사건 → 알림 설정 항목 */
export function discordKey(type: ServerEvent["type"]): DiscordEventKey {
  if (type === "auto-restart" || type === "auto-restart-failed" || type === "scheduled-restart") return "restarted";
  return type;
}

export function formatEvent(e: ServerEvent, serverName: string): DiscordMessage | null {
  const n = `**${escapeMd(serverName)}**`;
  const online = e.online !== undefined ? `지금 ${e.online}명` : undefined;
  switch (e.type) {
    case "started":
      return { title: "🟢 서버가 켜졌어요", description: n, color: COLOR.green };
    case "stopped":
      return { title: "⚪ 서버가 꺼졌어요", description: n, color: COLOR.gray };
    case "crashed": {
      const lines = [n];
      if (e.crash) lines.push(e.crash.title, `해결: ${e.crash.hint}`);
      if (e.detail) lines.push(e.detail);
      return { title: "🔴 서버가 갑자기 꺼졌어요", description: lines.join("\n"), color: COLOR.red };
    }
    case "auto-restart":
      return { title: "🟡 서버를 다시 켜는 중이에요", description: [n, e.detail].filter(Boolean).join("\n"), color: COLOR.yellow };
    case "auto-restart-failed":
      return { title: "🔴 자동 재시작을 멈췄어요", description: [n, e.detail].filter(Boolean).join("\n"), color: COLOR.red };
    case "scheduled-restart":
      return { title: "🔵 예약 재시작", description: [n, e.detail].filter(Boolean).join("\n"), color: COLOR.blue };
    case "backup":
      return { title: "📦 백업 완료", description: [n, e.detail ? escapeMd(e.detail) : undefined].filter(Boolean).join("\n"), color: COLOR.blue };
    case "joined":
      return { title: `${escapeMd(e.player ?? "누군가")} 님이 들어왔어요`, description: [n, online].filter(Boolean).join(" · "), color: COLOR.green };
    case "left":
      return { title: `${escapeMd(e.player ?? "누군가")} 님이 나갔어요`, description: [n, online].filter(Boolean).join(" · "), color: COLOR.gray };
  }
}

/** 몰린 입장·퇴장을 한 줄로 */
export function formatPlayers(joined: string[], left: string[], online: number | undefined, serverName: string): DiscordMessage[] {
  const n = `**${escapeMd(serverName)}**`;
  const tail = online !== undefined ? ` · 지금 ${online}명` : "";
  const out: DiscordMessage[] = [];
  if (joined.length) out.push({ title: `${joined.map(escapeMd).join(", ")} 님이 들어왔어요`, description: n + tail, color: COLOR.green });
  if (left.length) out.push({ title: `${left.map(escapeMd).join(", ")} 님이 나갔어요`, description: n + tail, color: COLOR.gray });
  return out;
}

// ---------- 보내기 ----------

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** 테스트용 */
export function setDiscordFetch(f: Fetch) {
  fetchImpl = f;
}

const status = new Map<string, { lastSentAt?: string; lastError?: string }>();
export function discordStatus(serverId: string) {
  return status.get(serverId) ?? {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 메시지 묶음(최대 10개)을 보낸다. 실패해도 예외 대신 결과로 돌려준다 */
export async function deliver(url: string, messages: DiscordMessage[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = JSON.stringify({
    username: "BlockPilot",
    allowed_mentions: { parse: [] },
    embeds: messages.slice(0, 10).map((m) => ({ title: m.title.slice(0, 256), description: m.description?.slice(0, 4000), color: m.color, timestamp: new Date().toISOString() })),
  });
  let lastError = "알 수 없는 오류";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ok: true };
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        lastError = "디스코드가 잠시 보내지 말라고 했어요 (전송 제한)";
        await sleep(Math.min(10_000, Math.max(500, (j.retry_after ?? 1) * 1000)));
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, error: "웹훅 주소가 없어졌거나 잘못됐어요. 디스코드에서 새로 복사해 넣어 주세요." };
      if (res.status >= 500) {
        lastError = `디스코드 서버 오류 (${res.status})`;
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { ok: false, error: `디스코드가 메시지를 받지 않았어요 (${res.status})` };
    } catch {
      lastError = "디스코드에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.";
      await sleep(1000 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError };
}

async function send(serverId: string, url: string, messages: DiscordMessage[]) {
  if (!messages.length) return;
  const r = await deliver(url, messages);
  const s = status.get(serverId) ?? {};
  if (r.ok) status.set(serverId, { ...s, lastSentAt: new Date().toISOString(), lastError: undefined });
  else status.set(serverId, { ...s, lastError: r.error });
}

// 서버마다 순서대로 보내도록 줄을 세운다
const chains = new Map<string, Promise<unknown>>();
function enqueue(serverId: string, job: () => Promise<unknown>) {
  const next = (chains.get(serverId) ?? Promise.resolve()).then(job, job);
  chains.set(serverId, next.catch(() => {}));
  return next;
}

let batchMs = 3000;
/** 테스트용 */
export function setBatchWindow(ms: number) {
  batchMs = ms;
}
const batches = new Map<string, { joined: string[]; left: string[]; online?: number; timer: NodeJS.Timeout }>();

async function serverName(id: string) {
  return (await listServers()).find((s) => s.id === id)?.name ?? id;
}

function flushBatch(serverId: string) {
  const b = batches.get(serverId);
  if (!b) return;
  clearTimeout(b.timer);
  batches.delete(serverId);
  void enqueue(serverId, async () => {
    const a = await getAutomation(serverId);
    if (!a.discord.webhookUrl) return;
    const joined = a.discord.events.joined ? b.joined : [];
    const left = a.discord.events.left ? b.left : [];
    await send(serverId, a.discord.webhookUrl, formatPlayers(joined, left, b.online, await serverName(serverId)));
  });
}

export async function handleEvent(e: ServerEvent) {
  const a = await getAutomation(e.serverId);
  if (!a.discord.webhookUrl || !isWebhookUrl(a.discord.webhookUrl)) return;
  if (e.type === "joined" || e.type === "left") {
    if (!a.discord.events[e.type]) return;
    const b = batches.get(e.serverId) ?? { joined: [], left: [], timer: setTimeout(() => flushBatch(e.serverId), batchMs) };
    // 들어왔다 금방 나간 사람은 서로 지운다
    if (e.type === "joined") b.left.includes(e.player!) ? (b.left = b.left.filter((p) => p !== e.player)) : b.joined.push(e.player!);
    else b.joined.includes(e.player!) ? (b.joined = b.joined.filter((p) => p !== e.player)) : b.left.push(e.player!);
    b.online = e.online;
    batches.set(e.serverId, b);
    return;
  }
  // 다른 사건 전에 쌓인 입장·퇴장을 먼저 보낸다
  flushBatch(e.serverId);
  if (!a.discord.events[discordKey(e.type)]) return;
  const msg = formatEvent(e, await serverName(e.serverId));
  if (msg) await enqueue(e.serverId, () => send(e.serverId, a.discord.webhookUrl, [msg]));
}

/** 시험 메시지. 성공하면 null, 실패하면 오류 문구 */
export async function sendTestMessage(serverId: string, url: string): Promise<string | null> {
  const r = await deliver(url, [{ title: "✅ BlockPilot 알림이 연결됐어요", description: `**${escapeMd(await serverName(serverId))}** 서버 소식을 여기로 보낼게요.`, color: COLOR.green }]);
  const s = status.get(serverId) ?? {};
  status.set(serverId, r.ok ? { ...s, lastSentAt: new Date().toISOString(), lastError: undefined } : { ...s, lastError: r.error });
  return r.ok ? null : r.error;
}

let started = false;
export function startDiscordNotifier() {
  if (started) return;
  started = true;
  onServerEvent((e) => handleEvent(e));
}
