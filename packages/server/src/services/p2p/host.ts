import type DHT from "hyperdht";
import type { P2pHostInfo, P2pPeerView } from "@blockpilot/shared";
import { getP2p, getServer, listServers, setP2p, type P2pSettings } from "../../config/store.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { getManaged } from "../process.js";
import { onServerEvent } from "../events.js";
import { readPropertiesFile, toRecord } from "../properties.js";
import { createDht, loadHyperdht, p2pSupport } from "./native.js";
import { encodeInvite, newSecret, shortKey } from "./invite.js";
import { HostTunnel, type HostPeer } from "./tunnel.js";

/**
 * 서버별 호스트 터널 관리. "초대 켜기" 는 저장되고, 마크 서버가 켜져 있는 동안만 터널이 돈다
 * (서버가 켜지면 같이 켜지고, 꺼지면 같이 꺼진다).
 */

interface Runtime {
  tunnel: HostTunnel;
  dht: DHT;
  state: "starting" | "listening" | "error";
  error?: string;
  authFailures: number[];
}

const runtimes = new Map<string, Runtime>();
const starting = new Set<string>();
/** stopTunnel 마다 올라간다. startTunnel 이 await 하는 사이 중지가 들어오면 알아채고 물러난다 */
const generation = new Map<string, number>();
const DASHBOARD_PORT = Number(process.env.BLOCKPILOT_PORT ?? 4800);
const MAX_PEERS = 10;
const RECONCILE_MS = 30_000;

async function mcPortOf(dir: string) {
  const props = toRecord((await readPropertiesFile(dir)).lines);
  return { port: Number(props["server-port"] ?? 25565), props };
}

/** 동시 친구 수: 기본 10, 서버 max-players 가 더 작으면 그만큼 */
function maxPeersOf(props: Record<string, string>) {
  const mp = Number(props["max-players"]);
  return Number.isFinite(mp) && mp > 0 ? Math.min(MAX_PEERS, mp) : MAX_PEERS;
}

const keySet = (map: Map<string, Set<string>>, id: string) => {
  let s = map.get(id);
  if (!s) map.set(id, (s = new Set()));
  return s;
};

/** 키페어·시크릿이 없으면 만들어 저장한다 */
async function ensureIdentity(id: string): Promise<P2pSettings & { keyPair: NonNullable<P2pSettings["keyPair"]>; secret: string }> {
  const s = await getP2p(id);
  if (s.keyPair && s.secret) return s as P2pSettings & { keyPair: NonNullable<P2pSettings["keyPair"]>; secret: string };
  const Dht = await loadHyperdht();
  if (!Dht) throw conflict((await p2pSupport()).reason ?? "P2P 를 쓸 수 없어요.");
  const kp = Dht.keyPair();
  const next = { ...s, keyPair: s.keyPair ?? { publicKey: kp.publicKey.toString("hex"), secretKey: kp.secretKey.toString("hex") }, secret: s.secret ?? newSecret().toString("hex") };
  await setP2p(id, next);
  return next as P2pSettings & { keyPair: NonNullable<P2pSettings["keyPair"]>; secret: string };
}

const inviteOf = (s: { keyPair: { publicKey: string }; secret: string }) => encodeInvite({ publicKey: Buffer.from(s.keyPair.publicKey, "hex"), secret: Buffer.from(s.secret, "hex") });

async function startTunnel(id: string) {
  // 지난번 시작이 실패한 채 남아 있으면 치우고 다시 시도한다
  if (runtimes.get(id)?.state === "error") await stopTunnel(id);
  if (runtimes.has(id) || starting.has(id)) return;
  starting.add(id);
  const gen = generation.get(id) ?? 0;
  const cancelled = () => (generation.get(id) ?? 0) !== gen;
  try {
    const server = await getServer(id);
    const s = await ensureIdentity(id);
    const { port, props } = await mcPortOf(server.path);
    // 호스트도 announce 만 하면 되므로 라우팅 테이블에 오르지 않는 ephemeral 노드로 (트래픽 수신 방지)
    const dht = await createDht({ ephemeral: true });
    // 그 사이(await) 에 서버가 꺼졌거나 중지 요청이 왔으면 물러난다 (좀비 터널 방지)
    if (cancelled() || !(await serverRunning(id))) {
      await dht.destroy({ force: true }).catch(() => {});
      return;
    }
    // await 하는 사이 들어온 승인·차단이 유실되지 않게, 저장소를 다시 읽고 메모리 사본과 합친다
    const latest = await getP2p(id);
    for (const p of latest.approved) keySet(approvedKeys, id).add(p.publicKey);
    for (const p of latest.blocked) keySet(blockedKeys, id).add(p.publicKey);
    const tunnel = new HostTunnel({
      dht,
      keyPair: { publicKey: Buffer.from(s.keyPair.publicKey, "hex"), secretKey: Buffer.from(s.keyPair.secretKey, "hex") },
      secret: Buffer.from(latest.secret ?? s.secret, "hex"),
      mcPort: port,
      forbiddenPorts: [DASHBOARD_PORT],
      maxPeers: maxPeersOf(props),
      policy: {
        // 설정은 매번 다시 읽지 않고 메모리 사본을 쓴다 (approve/block 이 갱신)
        isApproved: (key) => approvedKeys.get(id)?.has(key) ?? false,
        isBlocked: (key) => blockedKeys.get(id)?.has(key) ?? false,
      },
    });
    const rt: Runtime = { tunnel, dht, state: "starting", authFailures: [] };
    runtimes.set(id, rt);
    tunnel.on("auth-failed", () => {
      const now = Date.now();
      rt.authFailures = [...rt.authFailures.filter((t) => now - t < 10 * 60_000), now];
    });
    try {
      await tunnel.start();
      rt.state = "listening";
      if (cancelled()) await stopTunnel(id);
    } catch (e) {
      rt.state = "error";
      rt.error = (e as Error).message;
      await dht.destroy({ force: true }).catch(() => {});
    }
  } finally {
    starting.delete(id);
  }
}

async function stopTunnel(id: string) {
  generation.set(id, (generation.get(id) ?? 0) + 1);
  const rt = runtimes.get(id);
  if (!rt) return;
  runtimes.delete(id);
  await rt.tunnel.stop().catch(() => {});
  await rt.dht.destroy({ force: true }).catch(() => {});
}

const approvedKeys = new Map<string, Set<string>>();
const blockedKeys = new Map<string, Set<string>>();

async function serverRunning(id: string) {
  const server = await getServer(id);
  const st = await getManaged(id, server.path).status();
  return st.state === "running" || st.state === "external" || st.state === "orphan";
}

export async function p2pHostView(id: string): Promise<P2pHostInfo> {
  const server = await getServer(id);
  const [support, s, { port, props }, running] = await Promise.all([p2pSupport(), getP2p(id), mcPortOf(server.path), serverRunning(id)]);
  const rt = runtimes.get(id);
  const names = new Map(s.approved.map((p) => [p.publicKey, p.name]));
  const peers: P2pPeerView[] = (rt?.tunnel.listPeers() ?? []).map((p: HostPeer) => ({ ...p, shortKey: shortKey(p.publicKey), name: names.get(p.publicKey) }));
  const now = Date.now();
  return {
    supported: support.supported,
    reason: support.reason,
    enabled: s.enabled,
    state: rt ? rt.state : "off",
    error: rt?.error,
    inviteCode: s.enabled && s.keyPair && s.secret ? inviteOf({ keyPair: s.keyPair, secret: s.secret }) : undefined,
    publicKey: s.keyPair?.publicKey,
    mcPort: port,
    maxPeers: rt?.tunnel.maxPeers ?? maxPeersOf(props),
    peers,
    approved: s.approved,
    blocked: s.blocked,
    warnings: { serverStopped: !running, whitelistOff: props["white-list"] !== "true", onlineModeOff: props["online-mode"] === "false" },
    recentAuthFailures: (rt?.authFailures ?? []).filter((t) => now - t < 10 * 60_000).length,
  };
}

export async function setP2pEnabled(id: string, enabled: boolean) {
  await getServer(id);
  if (enabled) {
    const support = await p2pSupport();
    if (!support.supported) throw conflict(support.reason ?? "P2P 를 쓸 수 없어요.");
    const s = await ensureIdentity(id);
    if (!s.enabled) await setP2p(id, { ...s, enabled: true });
    if (await serverRunning(id)) await startTunnel(id);
  } else {
    const s = await getP2p(id);
    if (s.enabled) await setP2p(id, { ...s, enabled: false });
    await stopTunnel(id);
  }
  return p2pHostView(id);
}

/** 초대코드 재발급: 옛 코드는 즉시 무효. 접속 중인 승인된 친구는 유지, 승인 대기는 끊는다 */
export async function rotateInvite(id: string) {
  const s = await ensureIdentity(id);
  const secret = newSecret();
  await setP2p(id, { ...s, secret: secret.toString("hex") });
  runtimes.get(id)?.tunnel.rotateSecret(secret);
  return p2pHostView(id);
}

export type PeerAction = "approve" | "reject" | "block" | "unblock" | "kick" | "forget";

export async function peerAction(id: string, key: string, action: PeerAction, name?: string) {
  const s = await getP2p(id);
  const rt = runtimes.get(id);
  const without = <T extends { publicKey: string }>(list: T[]): T[] => list.filter((p) => p.publicKey !== key);
  switch (action) {
    case "approve": {
      const approved = [...without(s.approved), { publicKey: key, name: name || undefined, approvedAt: new Date().toISOString() }];
      await setP2p(id, { ...s, approved, blocked: without(s.blocked) });
      keySet(approvedKeys, id).add(key);
      blockedKeys.get(id)?.delete(key);
      rt?.tunnel.approve(key);
      break;
    }
    case "reject":
      rt?.tunnel.reject(key);
      break;
    case "block": {
      const prev = s.approved.find((p) => p.publicKey === key);
      const blocked = [...without(s.blocked), { publicKey: key, name: prev?.name ?? name, blockedAt: new Date().toISOString() }];
      await setP2p(id, { ...s, approved: without(s.approved), blocked });
      approvedKeys.get(id)?.delete(key);
      keySet(blockedKeys, id).add(key);
      rt?.tunnel.kick(key);
      break;
    }
    case "unblock":
      await setP2p(id, { ...s, blocked: without(s.blocked) });
      blockedKeys.get(id)?.delete(key);
      break;
    case "kick":
      rt?.tunnel.kick(key);
      break;
    case "forget":
      await setP2p(id, { ...s, approved: without(s.approved) });
      approvedKeys.get(id)?.delete(key);
      rt?.tunnel.kick(key);
      break;
    default:
      throw badRequest("알 수 없는 동작이에요.");
  }
  return p2pHostView(id);
}

let reconcileTimer: NodeJS.Timeout | null = null;

/**
 * 초대가 켜진 서버마다 "서버가 돌고 있나" 와 "터널이 돌고 있나" 를 맞춘다.
 * 다른 곳에서 띄운(external) 서버는 켜지고 꺼질 때 사건이 없어서 이 보정으로만 따라간다.
 */
async function reconcile() {
  for (const server of await listServers().catch(() => [])) {
    const s = await getP2p(server.id).catch(() => null);
    if (!s?.enabled) continue;
    const running = await serverRunning(server.id).catch(() => false);
    const rt = runtimes.get(server.id);
    if (running && !rt) await startTunnel(server.id).catch(() => {});
    else if (!running && rt && rt.state !== "error") await stopTunnel(server.id);
  }
}

/** 마크 서버가 켜지고 꺼질 때 터널도 따라간다. BlockPilot 이 켜질 때 이미 돌고 있는 서버도 확인 */
export function startP2pHostLifecycle() {
  onServerEvent(async (e) => {
    if (e.type === "started") {
      const s = await getP2p(e.serverId).catch(() => null);
      if (s?.enabled) await startTunnel(e.serverId).catch(() => {});
    } else if (e.type === "stopped" || e.type === "crashed") {
      await stopTunnel(e.serverId);
    }
  });
  void reconcile();
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => void reconcile(), RECONCILE_MS);
    reconcileTimer.unref();
  }
}

export async function stopAllP2pHosts() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  await Promise.all([...runtimes.keys()].map((id) => stopTunnel(id)));
}

/** 서버 등록 해제·삭제 때 */
export async function forgetP2pHost(id: string) {
  await stopTunnel(id);
  approvedKeys.delete(id);
  blockedKeys.delete(id);
}
