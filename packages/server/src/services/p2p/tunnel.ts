import { EventEmitter } from "node:events";
import net from "node:net";
import type DHT from "hyperdht";
import type { KeyPair, SecretStream, Server } from "hyperdht";
import type { Invite } from "./invite.js";
import { shortKey } from "./invite.js";
import { FrameReader, KIND, STATUS, hostChallenge, joinRespond, sendStatus, ProtocolError, type ConnKind, type StatusCode } from "./protocol.js";

/**
 * P2P 터널 코어. UI 와 분리되어 있고 DHT 인스턴스는 밖에서 받는다 (테스트는 로컬 부트스트래퍼).
 *
 * 호스트: DHT 서버 하나. 들어온 연결마다 HMAC 챌린지 → 승인 확인 → 127.0.0.1:<마크 포트> 로만 파이핑.
 * 참가자: 먼저 "제어 연결" 하나로 인증·승인을 끝낸 뒤에야 127.0.0.1 로컬 포트를 연다 (승인 기다리는 동안
 *         마크 클라이언트가 시간 초과로 끊기지 않게). 로컬 포트에 들어오는 TCP 연결마다 "데이터 연결" 을 하나씩 맺는다.
 */

export type PeerKey = string; // 공개키 hex

export interface HostPolicy {
  isApproved(key: PeerKey): boolean;
  isBlocked(key: PeerKey): boolean;
}

export interface HostOptions {
  dht: DHT;
  keyPair: KeyPair;
  secret: Buffer;
  /** 마크 서버 포트. 목적지는 항상 127.0.0.1 — 다른 곳으로 넘기는 기능은 없다 */
  mcPort: number;
  /** 절대 넘기면 안 되는 포트 (BlockPilot 대시보드 자신 등) */
  forbiddenPorts?: number[];
  policy: HostPolicy;
  /** 동시에 연결할 수 있는 친구(공개키) 수 */
  maxPeers?: number;
  /** 친구 한 명이 동시에 열 수 있는 마크 연결 수 */
  maxConnectionsPerPeer?: number;
  /** 인증을 끝내지 않은 연결을 동시에 몇 개까지 받아 줄지 (핸드셰이크 플러딩 방어) */
  maxHandshaking?: number;
  /** 승인을 기다려 주는 시간 */
  approvalTimeoutMs?: number;
  /** 인증 실패를 이만큼 반복한 공개키·주소는 잠시 거부 */
  failureLimit?: number;
  failureWindowMs?: number;
}

export interface HostPeer {
  publicKey: PeerKey;
  state: "pending" | "connected";
  /** 상대 주소 (호스트에게만 보임) */
  remote?: string;
  since: string;
  /** 데이터 연결 수 = 마크 클라이언트 연결 수 */
  connections: number;
}

interface PeerRuntime {
  publicKey: PeerKey;
  state: "pending" | "connected";
  remote?: string;
  since: string;
  streams: Map<SecretStream, ConnKind>;
  waiters: Set<(approved: boolean) => void>;
  /** 승인 대기 알림을 한 번만 */
  pendingNotified: boolean;
}

export interface HostEvents {
  status: [state: "starting" | "listening" | "stopped"];
  "peer-pending": [peer: HostPeer];
  "peer-connected": [peer: HostPeer];
  "peer-left": [peer: HostPeer];
  "auth-failed": [info: { publicKey: PeerKey; remote?: string; reason: string }];
}

/** 승인 대기 중 참가자가 보낼 수 있는 최대 바이트 (정상 참가자는 GO 전에 아무것도 보내지 않는다) */
const PRE_GO_BUFFER_LIMIT = 4096;

export class HostTunnel extends EventEmitter<HostEvents> {
  private server: Server | null = null;
  private peers = new Map<PeerKey, PeerRuntime>();
  /** 공개키·주소별 인증 실패 시각 */
  private failures = new Map<string, number[]>();
  /** 이번 실행에서 호스트가 승인한 키 (정책 저장과 별개로 즉시 반영) */
  private approvedNow = new Set<PeerKey>();
  private handshaking = 0;
  private secret: Buffer;
  readonly maxPeers: number;
  private readonly maxPerPeer: number;
  private readonly maxHandshaking: number;
  private readonly approvalTimeoutMs: number;
  private readonly failureLimit: number;
  private readonly failureWindowMs: number;

  constructor(private readonly o: HostOptions) {
    super();
    if (!Number.isInteger(o.mcPort) || o.mcPort < 1 || o.mcPort > 65535) throw new Error(`마크 서버 포트가 올바르지 않아요: ${o.mcPort}`);
    if (o.forbiddenPorts?.includes(o.mcPort)) throw new Error(`포트 ${o.mcPort} 는 BlockPilot 자신이 쓰는 포트라 친구에게 열 수 없어요.`);
    this.secret = Buffer.from(o.secret);
    this.maxPeers = o.maxPeers ?? 10;
    this.maxPerPeer = o.maxConnectionsPerPeer ?? 16;
    this.maxHandshaking = o.maxHandshaking ?? 16;
    this.approvalTimeoutMs = o.approvalTimeoutMs ?? 90_000;
    this.failureLimit = o.failureLimit ?? 5;
    this.failureWindowMs = o.failureWindowMs ?? 10 * 60_000;
  }

  get publicKey() {
    return this.o.keyPair.publicKey;
  }

  listPeers(): HostPeer[] {
    return [...this.peers.values()].map(toPeer);
  }

  /** 초대코드 재발급: 새 시크릿부터 적용. 승인 대기 중인 연결은 끊고(옛 코드로 온 것), 접속 중인 승인된 친구는 유지 */
  rotateSecret(next: Buffer, opts: { dropPending?: boolean } = {}) {
    this.secret = Buffer.from(next);
    if (opts.dropPending ?? true) {
      for (const p of this.peers.values()) if (p.state === "pending") for (const w of p.waiters) w(false);
    }
  }

  /** 홀 펀칭 전에 보이는 공개키·주소로 거부: 차단 목록, 인증 실패 반복, 핸드셰이크 폭주 */
  private deny(publicKey: Buffer, address?: { host?: string }): boolean {
    const key = publicKey.toString("hex");
    if (this.o.policy.isBlocked(key)) return true;
    if (this.tooManyFailures(key)) return true;
    if (address?.host && this.tooManyFailures(`ip:${address.host}`)) return true;
    if (this.handshaking >= this.maxHandshaking) return true;
    return false;
  }

  private tooManyFailures(id: string) {
    const list = this.failures.get(id);
    if (!list) return false;
    const now = Date.now();
    const recent = list.filter((t) => now - t < this.failureWindowMs);
    if (recent.length) this.failures.set(id, recent);
    else this.failures.delete(id);
    return recent.length >= this.failureLimit;
  }

  private recordFailure(key: PeerKey, remoteHost?: string) {
    const now = Date.now();
    for (const id of [key, ...(remoteHost ? [`ip:${remoteHost}`] : [])]) this.failures.set(id, [...(this.failures.get(id) ?? []), now]);
    // 맵이 커지면 만료된 항목을 치운다
    if (this.failures.size > 1000) for (const id of [...this.failures.keys()]) this.tooManyFailures(id);
  }

  async start() {
    this.emit("status", "starting");
    this.server = this.o.dht.createServer({ firewall: (pk, _payload, address) => this.deny(pk, address) }, (sock) => void this.handle(sock));
    await this.server.listen(this.o.keyPair);
    this.emit("status", "listening");
  }

  async stop() {
    for (const p of this.peers.values()) {
      for (const w of p.waiters) w(false);
      for (const s of p.streams.keys()) s.destroy();
    }
    this.peers.clear();
    await this.server?.close().catch(() => {});
    this.server = null;
    this.emit("status", "stopped");
  }

  /** 호스트가 승인. 호출자는 정책(저장소)에도 반영해야 다음 실행에서도 알아본다 */
  approve(key: PeerKey) {
    this.approvedNow.add(key);
    const p = this.peers.get(key);
    if (!p) return false;
    for (const w of p.waiters) w(true);
    return true;
  }

  reject(key: PeerKey) {
    const p = this.peers.get(key);
    if (!p) return false;
    for (const w of p.waiters) w(false);
    return true;
  }

  /** 접속 중인 친구를 끊는다 (차단은 호출자가 policy 에 반영하고 kick 도 부른다) */
  kick(key: PeerKey) {
    this.approvedNow.delete(key);
    const p = this.peers.get(key);
    if (!p) return false;
    for (const w of p.waiters) w(false);
    for (const s of p.streams.keys()) s.destroy();
    return true;
  }

  private isApproved(key: PeerKey) {
    return this.approvedNow.has(key) || this.o.policy.isApproved(key);
  }

  private dropIfIdle(peer: PeerRuntime) {
    if (peer.streams.size || peer.waiters.size) return;
    if (this.peers.get(peer.publicKey) !== peer) return;
    this.peers.delete(peer.publicKey);
    if (peer.state === "connected") this.emit("peer-left", toPeer(peer));
  }

  private async handle(sock: SecretStream) {
    // 상대가 끊으면 ECONNRESET 같은 오류가 올라온다. 듣는 이가 없으면 프로세스 예외가 되므로 항상 받아 둔다 (정리는 close 에서)
    sock.on("error", () => {});
    const key = sock.remotePublicKey.toString("hex");
    const remoteHost = sock.rawStream?.remoteHost;
    const remote = remoteHost ? `${remoteHost}:${sock.rawStream?.remotePort}` : undefined;
    const reader = new FrameReader(sock, PRE_GO_BUFFER_LIMIT);
    let kind: ConnKind;
    this.handshaking++;
    try {
      ({ kind } = await hostChallenge(reader, sock, this.secret, sock.remotePublicKey, sock.handshakeHash));
    } catch (e) {
      const reason = e instanceof ProtocolError ? e.message : (e as Error).message;
      if (!(e instanceof ProtocolError && e.code === "closed")) {
        this.recordFailure(key, remoteHost);
        this.emit("auth-failed", { publicKey: key, remote, reason });
        // 틀린 초대코드라는 것만 알려 준다 (어차피 실패한 쪽은 실패를 안다)
        if (e instanceof ProtocolError && e.code === "bad_mac") sendStatus(sock, STATUS.BAD_SECRET);
      }
      endSoon(sock);
      return;
    } finally {
      this.handshaking--;
    }

    let peer = this.peers.get(key);
    if (!peer) {
      if (this.peers.size >= this.maxPeers) {
        sendStatus(sock, STATUS.FULL);
        endSoon(sock);
        return;
      }
      peer = { publicKey: key, state: "pending", remote, since: new Date().toISOString(), streams: new Map(), waiters: new Set(), pendingNotified: false };
      this.peers.set(key, peer);
    } else if (kind === KIND.DATA && dataCount(peer) >= this.maxPerPeer) {
      sendStatus(sock, STATUS.FULL);
      endSoon(sock);
      return;
    }
    peer.streams.set(sock, kind);
    sock.once("close", () => {
      peer!.streams.delete(sock);
      this.dropIfIdle(peer!);
    });

    if (!this.isApproved(key)) {
      sendStatus(sock, STATUS.PENDING);
      // 대기자를 먼저 등록한 뒤 알린다 — 알림을 받자마자 approve() 를 불러도 받아들이게
      const decision = this.waitApproval(peer, sock);
      if (!peer.pendingNotified && peer.state !== "connected") {
        peer.pendingNotified = true;
        this.emit("peer-pending", toPeer(peer));
      }
      const result = await decision;
      if (result !== "approved") {
        sendStatus(sock, result === "timeout" ? STATUS.TIMEOUT : STATUS.REJECTED);
        endSoon(sock);
        return;
      }
      if (sock.destroyed) return;
    }

    const first = peer.state !== "connected";
    peer.state = "connected";
    sendStatus(sock, STATUS.GO);
    if (first) this.emit("peer-connected", toPeer(peer));
    if (kind === KIND.CONTROL) {
      // 제어 연결은 상태만 유지한다 (데이터 없음). 뭔가 보내오면 버린다
      reader.release();
      sock.resume();
      return;
    }
    const leftover = reader.release();
    this.pipeToServer(sock, leftover);
  }

  private waitApproval(peer: PeerRuntime, sock: SecretStream): Promise<"approved" | "rejected" | "timeout"> {
    return new Promise((resolve) => {
      const done = (result: "approved" | "rejected" | "timeout") => {
        clearTimeout(timer);
        peer.waiters.delete(waiter);
        sock.off("close", onClose);
        resolve(result);
        this.dropIfIdle(peer);
      };
      const waiter = (ok: boolean) => done(ok ? "approved" : "rejected");
      const onClose = () => done("rejected");
      const timer = setTimeout(() => done("timeout"), this.approvalTimeoutMs);
      peer.waiters.add(waiter);
      sock.once("close", onClose);
    });
  }

  /** 127.0.0.1:<마크 포트> 로만 넘긴다 */
  private pipeToServer(sock: SecretStream, leftover: Buffer) {
    const tcp = net.connect(this.o.mcPort, "127.0.0.1");
    tcp.once("connect", () => {
      if (leftover.length) tcp.write(leftover);
      sock.pipe(tcp).pipe(sock);
    });
    tcp.on("error", () => sock.destroy());
    tcp.on("close", () => sock.destroy());
    sock.on("close", () => tcp.destroy());
  }
}

const dataCount = (p: PeerRuntime) => [...p.streams.values()].filter((k) => k === KIND.DATA).length;
const toPeer = (p: PeerRuntime): HostPeer => ({ publicKey: p.publicKey, state: p.state, remote: p.remote, since: p.since, connections: dataCount(p) });

/** 보낼 것 보내고 닫되, 상대가 무시해도 잠시 뒤 확실히 끊는다 */
function endSoon(sock: SecretStream) {
  sock.end();
  setTimeout(() => sock.destroy(), 500).unref();
}

// ---------- 참가자 ----------

export type JoinState = "connecting" | "pending" | "connected" | "failed" | "stopped";

export interface JoinOptions {
  dht: DHT;
  invite: Invite;
  /** 참가자 자신의 키페어 (저장해 두면 호스트가 다음에도 알아본다) */
  keyPair: KeyPair;
  /** 원하는 로컬 포트. 비우면 25565, 쓰고 있으면 빈 포트 */
  localPort?: number;
  connectTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

export interface JoinEvents {
  state: [state: JoinState, detail?: string];
}

export class JoinTunnel extends EventEmitter<JoinEvents> {
  state: JoinState = "connecting";
  detail?: string;
  localPort?: number;
  /** 실패 원인 (진단용): 원본 오류 또는 호스트 상태 코드 */
  failure?: { error?: unknown; status?: "rejected" | "timeout_approval" | "full" | "bad_secret" };
  private control: SecretStream | null = null;
  private listener: net.Server | null = null;
  private clients = new Set<net.Socket>();
  /** 열리는 중이거나 열린 P2P 스트림 (stop/fail 때 전부 정리) */
  private streams = new Set<SecretStream>();
  private stopping = false;

  constructor(private readonly o: JoinOptions) {
    super();
  }

  get hostKey() {
    return this.o.invite.publicKey.toString("hex");
  }

  private setState(s: JoinState, detail?: string) {
    this.state = s;
    this.detail = detail;
    this.emit("state", s, detail);
  }

  async start() {
    this.setState("connecting");
    let status: StatusCode;
    try {
      this.control = await this.open();
      const reader = new FrameReader(this.control);
      status = await joinRespond(reader, this.control, this.o.invite.secret, this.control.publicKey, this.control.handshakeHash, KIND.CONTROL, {
        approvalTimeoutMs: this.o.approvalTimeoutMs,
        onPending: () => this.setState("pending", "호스트가 승인하면 접속할 수 있어요"),
      });
      reader.release();
      this.control.resume();
    } catch (e) {
      this.failure = { error: e };
      this.fail(explainJoinError(e));
      return;
    }
    if (status === STATUS.REJECTED) return this.fail("호스트가 접속을 거절했어요.", { status: "rejected" });
    if (status === STATUS.TIMEOUT) return this.fail("호스트가 제때 승인하지 않았어요. 호스트에게 알린 뒤 다시 시도해 주세요.", { status: "timeout_approval" });
    if (status === STATUS.FULL) return this.fail("호스트 서버에 자리가 없어요. 잠시 후 다시 시도해 주세요.", { status: "full" });
    if (status === STATUS.BAD_SECRET) return this.fail("초대코드가 맞지 않아요. 호스트에게 지금 초대코드를 다시 받아 주세요.", { status: "bad_secret" });
    if (status !== STATUS.GO) return this.fail("호스트가 예상과 다른 응답을 보냈어요.");

    this.control.on("close", () => {
      if (!this.stopping && this.state === "connected") this.fail("호스트가 초대를 끝냈거나 연결이 끊겼어요.", { error: new ProtocolError("closed", "closed") });
    });
    try {
      this.localPort = await this.listen();
    } catch (e) {
      return this.fail(`로컬 포트를 열지 못했어요: ${(e as Error).message}`);
    }
    this.setState("connected", `마인크래프트에서 localhost:${this.localPort} 로 접속하세요`);
  }

  async stop() {
    this.stopping = true;
    this.teardown();
    this.setState("stopped");
  }

  private teardown() {
    this.listener?.close();
    this.listener = null;
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    this.control?.destroy();
    this.control = null;
  }

  private fail(message: string, failure?: JoinTunnel["failure"]) {
    if (this.stopping) return;
    if (failure) this.failure = failure;
    this.teardown();
    this.setState("failed", message);
  }

  private open(): Promise<SecretStream> {
    return new Promise((resolve, reject) => {
      const sock = this.o.dht.connect(this.o.invite.publicKey, { keyPair: this.o.keyPair });
      this.streams.add(sock);
      let opened = false;
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new ProtocolError("호스트와 연결되지 않았어요 (시간 초과).", "timeout"));
      }, this.o.connectTimeoutMs ?? 30_000);
      sock.once("close", () => {
        this.streams.delete(sock);
        // stop() 으로 열리기 전에 닫히면 30초 타이머를 기다리지 않는다
        if (!opened) {
          clearTimeout(timer);
          reject(new ProtocolError("연결이 닫혔어요.", "closed"));
        }
      });
      sock.once("open", () => {
        opened = true;
        clearTimeout(timer);
        resolve(sock);
      });
      // 열리기 전 오류는 실패로, 열린 뒤 오류는 close 처리에 맡긴다 (리스너가 없으면 예외로 터진다)
      sock.on("error", (e) => {
        if (opened) return;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((client) => void this.handleClient(client));
      this.listener = srv;
      const tryPort = (port: number) => {
        srv.once("error", (e: NodeJS.ErrnoException) => {
          if (e.code === "EADDRINUSE" && port !== 0) tryPort(0);
          else reject(e);
        });
        // 127.0.0.1 에만 연다. 같은 PC 의 마크 클라이언트만 쓰게
        srv.listen(port, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
      };
      tryPort(this.o.localPort ?? 25565);
    });
  }

  private async handleClient(client: net.Socket) {
    this.clients.add(client);
    client.on("error", () => {});
    client.pause();
    let data: SecretStream;
    try {
      data = await this.open();
      const reader = new FrameReader(data);
      const status = await joinRespond(reader, data, this.o.invite.secret, data.publicKey, data.handshakeHash, KIND.DATA, { approvalTimeoutMs: this.o.approvalTimeoutMs });
      if (status !== STATUS.GO) throw new Error("호스트가 데이터 연결을 허용하지 않았어요.");
      const leftover = reader.release();
      if (client.destroyed) {
        // 인증하는 사이 마크 클라이언트가 떠났다
        data.destroy();
        this.clients.delete(client);
        return;
      }
      if (leftover.length) client.write(leftover);
    } catch {
      client.destroy();
      this.clients.delete(client);
      return;
    }
    client.resume();
    client.pipe(data).pipe(client);
    const done = () => {
      this.clients.delete(client);
      client.destroy();
      data.destroy();
    };
    client.on("close", done);
    data.on("error", done);
    data.on("close", done);
  }
}

/** 연결 실패를 사용자 말로 (자세한 원인 분류는 diagnose.ts 에서 확장) */
export function explainJoinError(e: unknown): string {
  if (e instanceof ProtocolError) {
    if (e.code === "bad_mac") return "초대코드가 맞지 않아요.";
    if (e.code === "timeout") return e.message;
    if (e.code === "closed") return "호스트가 연결을 끊었어요. 초대코드가 바뀌었거나 초대가 꺼져 있을 수 있어요.";
    return e.message;
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/HOLEPUNCH|holepunch/i.test(msg)) return "홀 펀칭에 실패했어요. 두 쪽 네트워크가 직접 연결을 허용하지 않아요.";
  if (/PEER_NOT_FOUND|not found/i.test(msg)) return "호스트를 찾지 못했어요. 호스트의 초대가 켜져 있는지 확인해 주세요.";
  return `연결하지 못했어요: ${msg}`;
}

export { shortKey };
