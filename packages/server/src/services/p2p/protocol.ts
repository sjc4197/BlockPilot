import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * P2P 연결 직후의 앱 레벨 인증. 시크릿은 전송하지 않는다.
 *   호스트 → 참가자: CHALLENGE(0x01) + nonce 32B
 *   참가자 → 호스트: RESPONSE(0x02) + HMAC-SHA256(secret, nonce ‖ 참가자 공개키 ‖ handshakeHash) 32B + kind 1B (0 제어, 1 데이터)
 *   호스트 → 참가자: STATUS(0x03) + code 1B (0 GO · 1 PENDING(승인 대기) · 2 REJECTED · 3 FULL · 4 BAD_SECRET · 5 TIMEOUT(승인 시간 초과))
 * PENDING 뒤에는 GO 또는 REJECTED 가 한 번 더 온다. GO 뒤부터는 원본 TCP 바이트가 그대로 흐른다.
 */

export const MSG = { CHALLENGE: 0x01, RESPONSE: 0x02, STATUS: 0x03 } as const;
export const STATUS = { GO: 0, PENDING: 1, REJECTED: 2, FULL: 3, BAD_SECRET: 4, TIMEOUT: 5 } as const;
export type StatusCode = (typeof STATUS)[keyof typeof STATUS];
export const KIND = { CONTROL: 0, DATA: 1 } as const;
export type ConnKind = (typeof KIND)[keyof typeof KIND];

const NONCE_BYTES = 32;
const MAC_BYTES = 32;

export function computeMac(secret: Buffer, nonce: Buffer, joinerPublicKey: Buffer, handshakeHash: Buffer): Buffer {
  return createHmac("sha256", secret).update(nonce).update(joinerPublicKey).update(handshakeHash).digest();
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public code: "timeout" | "closed" | "bad_message" | "bad_mac",
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

/** 호스트 쪽: 챌린지를 보내고 응답을 검증한다. 틀리면 ProtocolError(bad_mac) */
export async function hostChallenge(reader: FrameReader, stream: Duplex, secret: Buffer, joinerPublicKey: Buffer, handshakeHash: Buffer, timeoutMs = 10_000): Promise<HostAuthResult> {
  const nonce = randomBytes(NONCE_BYTES);
  stream.write(Buffer.concat([Buffer.from([MSG.CHALLENGE]), nonce]));
  const res = await reader.read(1 + MAC_BYTES + 1, timeoutMs);
  if (res[0] !== MSG.RESPONSE) throw new ProtocolError("예상과 다른 응답이 왔어요.", "bad_message");
  const mac = res.subarray(1, 1 + MAC_BYTES);
  const kind = res[1 + MAC_BYTES] as ConnKind;
  const expected = computeMac(secret, nonce, joinerPublicKey, handshakeHash);
  if (!timingSafeEqual(mac, expected)) throw new ProtocolError("초대코드가 맞지 않아요.", "bad_mac");
  if (kind !== KIND.CONTROL && kind !== KIND.DATA) throw new ProtocolError("예상과 다른 응답이 왔어요.", "bad_message");
  return { kind };
}

export function sendStatus(stream: Duplex, code: StatusCode) {
  if (!stream.destroyed) stream.write(Buffer.from([MSG.STATUS, code]));
}

/** 참가자 쪽: 챌린지에 답하고 상태를 받는다. PENDING 이면 onPending 을 부르고 다음 상태까지 기다린다 */
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
  const ch = await reader.read(1 + NONCE_BYTES, timeoutMs);
  if (ch[0] !== MSG.CHALLENGE) throw new ProtocolError("예상과 다른 메시지가 왔어요.", "bad_message");
  const mac = computeMac(secret, ch.subarray(1), ownPublicKey, handshakeHash);
  stream.write(Buffer.concat([Buffer.from([MSG.RESPONSE]), mac, Buffer.from([kind])]));
  let st = await reader.read(2, timeoutMs);
  if (st[0] !== MSG.STATUS) throw new ProtocolError("예상과 다른 메시지가 왔어요.", "bad_message");
  if (st[1] === STATUS.PENDING) {
    opts.onPending?.();
    st = await reader.read(2, opts.approvalTimeoutMs ?? 120_000);
    if (st[0] !== MSG.STATUS) throw new ProtocolError("예상과 다른 메시지가 왔어요.", "bad_message");
  }
  return st[1] as StatusCode;
}
