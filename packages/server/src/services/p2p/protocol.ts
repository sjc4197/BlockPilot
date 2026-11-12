import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * P2P 연결 직후의 앱 레벨 인증. 시크릿은 전송하지 않는다.
 *   호스트 → 참가자: CHALLENGE(0x01) + version 1B + nonce 32B
 *   참가자 → 호스트: RESPONSE(0x02) + version 1B + HMAC-SHA256(secret, version ‖ nonce ‖ 참가자 공개키 ‖ handshakeHash) 32B + kind 1B (0 제어, 1 데이터)
 *   호스트 → 참가자: STATUS(0x03) + code 1B (0 GO · 1 PENDING(승인 대기) · 2 REJECTED · 3 FULL · 4 BAD_SECRET · 5 TIMEOUT(승인 시간 초과) · 6 VERSION_MISMATCH)
 * PENDING 뒤에는 GO 또는 REJECTED 가 한 번 더 온다. GO 뒤부터는 원본 TCP 바이트가 그대로 흐른다.
 *
 * 버전 바이트는 양쪽이 같은 규칙으로 말하는지 먼저 확인하는 용도다. 다르면 MAC 을 보기 전에 "버전이 달라요" 로 끝낸다.
 * MAC 입력에도 버전을 넣어 둔 것은, 나중에 버전마다 규칙이 갈릴 때 낮은 버전으로 속여 내려앉히지 못하게 하려는 것.
 *
 * 호환: 1.3.0 은 버전 바이트 없이 CHALLENGE(0x01)+nonce / RESPONSE(0x02)+mac+kind 를 보냈다.
 * 헤더 2B(종류+버전)를 먼저 읽기 때문에 옛 상대의 nonce[0]·mac[0] 가 버전 자리에 오고, 1 이 아닐 확률(255/256)로
 * version_mismatch 가 된다. 드물게 그 바이트가 1 이면 길이가 안 맞아 시간 초과로 끝난다 — 사용자가 적어 그대로 둔다.
 */

/** 이 빌드가 말하는 핸드셰이크 규칙 버전. 프레임 모양이나 의미가 바뀌면 올린다 */
export const PROTOCOL_VERSION = 1;

export const MSG = { CHALLENGE: 0x01, RESPONSE: 0x02, STATUS: 0x03 } as const;
export const STATUS = { GO: 0, PENDING: 1, REJECTED: 2, FULL: 3, BAD_SECRET: 4, TIMEOUT: 5, VERSION_MISMATCH: 6 } as const;
export type StatusCode = (typeof STATUS)[keyof typeof STATUS];
export const KIND = { CONTROL: 0, DATA: 1 } as const;
export type ConnKind = (typeof KIND)[keyof typeof KIND];

const NONCE_BYTES = 32;
const MAC_BYTES = 32;
/** 종류 1B + 버전 1B */
const HEADER_BYTES = 2;

export const VERSION_MISMATCH_MESSAGE = "친구와 BlockPilot 버전이 달라요. 둘 다 최신 버전으로 올린 뒤 다시 해 보세요.";

export function computeMac(secret: Buffer, nonce: Buffer, joinerPublicKey: Buffer, handshakeHash: Buffer, version: number = PROTOCOL_VERSION): Buffer {
  return createHmac("sha256", secret).update(Buffer.from([version])).update(nonce).update(joinerPublicKey).update(handshakeHash).digest();
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public code: "timeout" | "closed" | "bad_message" | "bad_mac" | "version_mismatch",
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * 스트림에서 정확히 n 바이트를 읽는다. 남은 조각은 돌려주어 다음 읽기나 파이핑에 쓰게 한다.
 * (스트림 조각 경계가 메시지 경계와 다를 수 있어 직접 모은다)
 */
export class FrameReader {
  private buffered: Buffer[] = [];
  private waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private ended = false;
  private readonly onData = (chunk: Buffer) => {
    this.buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    // 프로토콜 메시지는 몇십 바이트다. 그 이상(특히 아직 읽는 이가 없을 때) 쌓이면 상대가 규칙을 어긴 것 → 끊는다
    if (this.limit && this.buffered.reduce((n, b) => n + b.length, 0) > this.limit) {
      this.waiting?.reject(new ProtocolError("상대가 규칙에 없는 데이터를 보냈어요.", "bad_message"));
      this.waiting = null;
      this.ended = true;
      this.stream.destroy();
      return;
    }
    this.flush();
  };
  private readonly onEnd = () => {
    this.ended = true;
    this.waiting?.reject(new ProtocolError("상대가 연결을 끊었어요.", "closed"));
    this.waiting = null;
  };

  /** limit: 프로토콜 단계에서 허용할 누적 바이트 (0 이면 제한 없음) */
  constructor(
    private stream: Duplex,
    private limit = 4096,
  ) {
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("close", this.onEnd);
    stream.on("error", this.onEnd);
  }

  private flush() {
    if (!this.waiting) return;
    const total = this.buffered.reduce((n, b) => n + b.length, 0);
    if (total < this.waiting.n) return;
    const all = Buffer.concat(this.buffered);
    const head = all.subarray(0, this.waiting.n);
    const rest = all.subarray(this.waiting.n);
    this.buffered = rest.length ? [Buffer.from(rest)] : [];
    const w = this.waiting;
    this.waiting = null;
    clearTimeout(w.timer);
    w.resolve(Buffer.from(head));
  }

  read(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.waiting) throw new Error("FrameReader: 읽기가 겹쳤어요");
    if (this.ended) return Promise.reject(new ProtocolError("상대가 연결을 끊었어요.", "closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new ProtocolError("상대가 제때 응답하지 않았어요.", "timeout"));
      }, timeoutMs);
      this.waiting = { n, resolve, reject, timer };
      this.flush();
    });
  }

  /**
   * 프로토콜이 끝났다: 듣기를 멈추고 남은 바이트를 돌려준다 (파이핑 전에 먼저 흘려보내야 함).
   * data 리스너를 떼면 흐르는(flowing) 스트림이 데이터를 허공에 흘리므로 일단 멈춰 둔다. pipe() 가 다시 흐르게 한다
   */
  release(): Buffer {
    this.stream.pause();
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onEnd);
    this.stream.off("error", this.onEnd);
    const rest = Buffer.concat(this.buffered);
    this.buffered = [];
    return rest;
  }
}

export interface HostAuthResult {
  kind: ConnKind;
}

/** 종류·버전 헤더를 읽고 검사한다. 종류가 다르면 bad_message, 버전이 다르면 version_mismatch */
async function readHeader(reader: FrameReader, expectType: number, timeoutMs: number): Promise<void> {
  const head = await reader.read(HEADER_BYTES, timeoutMs);
  if (head[0] !== expectType) throw new ProtocolError("예상과 다른 메시지가 왔어요.", "bad_message");
  if (head[1] !== PROTOCOL_VERSION) throw new ProtocolError(VERSION_MISMATCH_MESSAGE, "version_mismatch");
}

/** CHALLENGE 프레임 (테스트와 호스트가 같이 씀) */
export function encodeChallenge(nonce: Buffer, version: number = PROTOCOL_VERSION): Buffer {
  return Buffer.concat([Buffer.from([MSG.CHALLENGE, version]), nonce]);
}

/** RESPONSE 프레임 (테스트와 참가자가 같이 씀) */
export function encodeResponse(mac: Buffer, kind: ConnKind, version: number = PROTOCOL_VERSION): Buffer {
  return Buffer.concat([Buffer.from([MSG.RESPONSE, version]), mac, Buffer.from([kind])]);
}

/** 호스트 쪽: 챌린지를 보내고 응답을 검증한다. 틀리면 ProtocolError(bad_mac), 규칙 버전이 다르면 ProtocolError(version_mismatch) */
export async function hostChallenge(reader: FrameReader, stream: Duplex, secret: Buffer, joinerPublicKey: Buffer, handshakeHash: Buffer, timeoutMs = 10_000): Promise<HostAuthResult> {
  const nonce = randomBytes(NONCE_BYTES);
  stream.write(encodeChallenge(nonce));
  await readHeader(reader, MSG.RESPONSE, timeoutMs);
  const res = await reader.read(MAC_BYTES + 1, timeoutMs);
  const mac = res.subarray(0, MAC_BYTES);
  const kind = res[MAC_BYTES] as ConnKind;
  const expected = computeMac(secret, nonce, joinerPublicKey, handshakeHash);
  if (!timingSafeEqual(mac, expected)) throw new ProtocolError("초대코드가 맞지 않아요.", "bad_mac");
  if (kind !== KIND.CONTROL && kind !== KIND.DATA) throw new ProtocolError("예상과 다른 응답이 왔어요.", "bad_message");
  return { kind };
}

export function sendStatus(stream: Duplex, code: StatusCode) {
  if (!stream.destroyed) stream.write(Buffer.from([MSG.STATUS, code]));
}

/**
 * 참가자 쪽: 챌린지에 답하고 상태를 받는다. PENDING 이면 onPending 을 부르고 다음 상태까지 기다린다.
 * 호스트의 규칙 버전이 다르면(챌린지 버전이 다르거나 STATUS VERSION_MISMATCH 가 오면) ProtocolError(version_mismatch) — 답하지도 않는다
 */
export async function joinRespond(
  reader: FrameReader,
  stream: Duplex,
  secret: Buffer,
  ownPublicKey: Buffer,
  handshakeHash: Buffer,
  kind: ConnKind,
  opts: { timeoutMs?: number; approvalTimeoutMs?: number; onPending?: () => void } = {},
): Promise<StatusCode> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  await readHeader(reader, MSG.CHALLENGE, timeoutMs);
  const nonce = await reader.read(NONCE_BYTES, timeoutMs);
  const mac = computeMac(secret, nonce, ownPublicKey, handshakeHash);
  stream.write(encodeResponse(mac, kind));
  let st = await readStatus(reader, timeoutMs);
  if (st === STATUS.PENDING) {
    opts.onPending?.();
    st = await readStatus(reader, opts.approvalTimeoutMs ?? 120_000);
  }
  return st;
}

async function readStatus(reader: FrameReader, timeoutMs: number): Promise<StatusCode> {
  const st = await reader.read(2, timeoutMs);
  if (st[0] !== MSG.STATUS) throw new ProtocolError("예상과 다른 메시지가 왔어요.", "bad_message");
  if (st[1] === STATUS.VERSION_MISMATCH) throw new ProtocolError(VERSION_MISMATCH_MESSAGE, "version_mismatch");
  return st[1] as StatusCode;
}
