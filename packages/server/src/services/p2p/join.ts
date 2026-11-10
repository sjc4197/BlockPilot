import type DHT from "hyperdht";
import type { P2pJoinInfo } from "@blockpilot/shared";
import { getJoinSettings, setJoinSettings } from "../../config/store.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { createDht, loadHyperdht, p2pSupport } from "./native.js";
import { decodeInvite, InviteError, shortKey } from "./invite.js";
import { JoinTunnel } from "./tunnel.js";
import { diagnoseJoinFailure, diagnoseStatus } from "./diagnose.js";
import { ProtocolError } from "./protocol.js";

/**
 * 참가 모드(친구 서버에 접속). 한 번에 하나만.
 * 초대코드를 넣으면 호스트에 연결 → 인증 → (승인 대기) → 127.0.0.1 로컬 포트를 연다. 진행은 상태 폴링으로 본다.
 */

interface Runtime {
  tunnel: JoinTunnel;
  dht: DHT;
  hostKey: string;
  since: string;
}

let current: Runtime | null = null;
/** start/stop 을 한 줄로 세운다 — 동시에 두 번 접속을 누르면 먼저 것의 터널이 새어 나간다 */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function ensureKeyPair() {
  const s = await getJoinSettings();
  if (s.keyPair) return s;
  const Dht = await loadHyperdht();
  if (!Dht) throw conflict((await p2pSupport()).reason ?? "P2P 를 쓸 수 없어요.");
  const kp = Dht.keyPair();
  const next = { ...s, keyPair: { publicKey: kp.publicKey.toString("hex"), secretKey: kp.secretKey.toString("hex") } };
  await setJoinSettings(next);
  return next;
}

export async function joinView(): Promise<P2pJoinInfo> {
  const [support, s] = await Promise.all([p2pSupport(), getJoinSettings()]);
  let remembered: P2pJoinInfo["remembered"];
  if (s.remembered) {
    try {
      remembered = { ...s.remembered, hostShortKey: shortKey(decodeInvite(s.remembered.inviteCode).publicKey) };
    } catch {
      remembered = undefined;
    }
  }
  if (!current) return { supported: support.supported, reason: support.reason, state: "idle", remembered };
  const t = current.tunnel;
  if (t.state === "stopped") return { supported: support.supported, reason: support.reason, state: "idle", remembered };
  let diagnosis;
  if (t.state === "failed") {
    const f = t.failure;
    if (f?.status === "bad_secret") diagnosis = diagnoseJoinFailure(new ProtocolError("bad", "bad_mac"));
    else if (f?.status) diagnosis = diagnoseStatus(f.status);
    else diagnosis = diagnoseJoinFailure(f?.error ?? new Error(t.detail ?? ""));
  }
  return {
    supported: support.supported,
    reason: support.reason,
    state: t.state,
    detail: t.detail,
    diagnosis,
    localPort: t.state === "connected" ? t.localPort : undefined,
    hostShortKey: shortKey(current.hostKey),
    since: current.since,
    remembered,
  };
}

/**
 * name: undefined 면 같은 호스트의 지난 이름을 물려받고, "" 이면 이름을 지운다.
 */
export function startJoin(inviteCode: string, name?: string): Promise<P2pJoinInfo> {
  return serialized(async () => {
    const support = await p2pSupport();
    if (!support.supported) throw conflict(support.reason ?? "P2P 를 쓸 수 없어요.");
    let invite;
    try {
      invite = decodeInvite(inviteCode);
    } catch (e) {
      if (e instanceof InviteError) throw badRequest(e.message);
      throw e;
    }
    await stopCurrent();
    const s = await ensureKeyPair();
    // 참가자는 클라이언트 역할만 하므로 DHT 라우팅 테이블에 오르지 않는 ephemeral 노드로
    const dht = await createDht({ ephemeral: true });
    // 로컬 포트: 기본 25565(쓰고 있으면 빈 포트). BLOCKPILOT_JOIN_PORT 로 고정할 수 있다 (0 이면 항상 빈 포트)
    const envPort = process.env.BLOCKPILOT_JOIN_PORT;
    const localPort = envPort !== undefined && envPort !== "" && Number.isInteger(Number(envPort)) ? Number(envPort) : undefined;
    const tunnel = new JoinTunnel({
      dht,
      invite,
      keyPair: { publicKey: Buffer.from(s.keyPair!.publicKey, "hex"), secretKey: Buffer.from(s.keyPair!.secretKey, "hex") },
      localPort,
    });
    const hostKey = invite.publicKey.toString("hex");
    const rt: Runtime = { tunnel, dht, hostKey, since: new Date().toISOString() };
    current = rt;
    let remembered = false;
    tunnel.on("state", (st) => {
      // 호스트가 받아 준(대기 또는 연결) 코드만 기억한다 — 오타난 코드가 멀쩡한 기억을 덮지 않게
      if ((st === "pending" || st === "connected") && !remembered) {
        remembered = true;
        void rememberInvite(inviteCode.trim(), hostKey, name).catch(() => {});
      }
      // 끝(실패·종료)나면 DHT 노드를 정리한다. 상태는 다음 시도 전까지 화면에 남긴다
      if ((st === "failed" || st === "stopped") && current === rt) void dht.destroy({ force: true }).catch(() => {});
    });
    void tunnel.start();
    return joinView();
  });
}

async function rememberInvite(inviteCode: string, hostKey: string, name: string | undefined) {
  const s = await getJoinSettings();
  let prevName: string | undefined;
  if (s.remembered) {
    try {
      if (decodeInvite(s.remembered.inviteCode).publicKey.toString("hex") === hostKey) prevName = s.remembered.name;
    } catch {
      /* 옛 기억이 깨져 있으면 무시 */
    }
  }
  const finalName = name === undefined ? prevName : name || undefined;
  await setJoinSettings({ ...s, remembered: { name: finalName, inviteCode, usedAt: new Date().toISOString() } });
}

async function stopCurrent() {
  const rt = current;
  if (!rt) return;
  current = null;
  await rt.tunnel.stop().catch(() => {});
  await rt.dht.destroy({ force: true }).catch(() => {});
}

export function stopJoin(): Promise<P2pJoinInfo> {
  return serialized(async () => {
    await stopCurrent();
    return joinView();
  });
}

export async function forgetRemembered(): Promise<P2pJoinInfo> {
  const s = await getJoinSettings();
  await setJoinSettings({ ...s, remembered: undefined });
  return joinView();
}

export const activeJoin = () => current?.tunnel ?? null;
