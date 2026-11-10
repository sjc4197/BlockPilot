import { createHash, randomBytes } from "node:crypto";

/**
 * 초대코드 = 호스트 공개키(32B) ‖ 시크릿(16B) ‖ 체크섬(2B) 를 z-base-32 로 → 80자, 4자마다 '-'.
 * 시크릿은 HMAC 챌린지에만 쓰이므로 128비트면 충분하다. 코드는 대소문자·하이픈·공백을 무시하고 읽는다.
 */

export const PUBLIC_KEY_BYTES = 32;
export const SECRET_BYTES = 16;
const CHECKSUM_BYTES = 2;
const CODE_CHARS = ((PUBLIC_KEY_BYTES + SECRET_BYTES + CHECKSUM_BYTES) * 8) / 5; // 80

const ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteError";
  }
}

export function zbase32Encode(buf: Buffer): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function zbase32Decode(s: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const c of s) {
    const v = LOOKUP.get(c);
    if (v === undefined) throw new InviteError("초대코드에 쓸 수 없는 글자가 있어요. 영문 소문자와 숫자만 들어가요 (0, l, v, 2 는 쓰지 않아요).");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export interface Invite {
  publicKey: Buffer;
  secret: Buffer;
}

const checksum = (publicKey: Buffer, secret: Buffer) => createHash("sha256").update(publicKey).update(secret).digest().subarray(0, CHECKSUM_BYTES);

export function newSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

export function encodeInvite(invite: Invite): string {
  if (invite.publicKey.length !== PUBLIC_KEY_BYTES || invite.secret.length !== SECRET_BYTES) throw new InviteError("초대코드를 만들 재료 길이가 맞지 않아요.");
  const raw = zbase32Encode(Buffer.concat([invite.publicKey, invite.secret, checksum(invite.publicKey, invite.secret)]));
  return raw.match(/.{1,4}/g)!.join("-");
}

/** 붙여 넣은 코드를 읽는다. 하이픈·공백·줄바꿈은 무시, 대문자는 소문자로 */
export function decodeInvite(code: string): Invite {
  const clean = code.toLowerCase().replace(/[\s\-_.]/g, "");
  if (!clean) throw new InviteError("초대코드를 입력해 주세요.");
  if (clean.length !== CODE_CHARS) throw new InviteError(`초대코드 길이가 맞지 않아요 (${clean.length}자, ${CODE_CHARS}자여야 해요). 빠진 글자가 없는지 확인해 주세요.`);
  const buf = zbase32Decode(clean);
  const publicKey = buf.subarray(0, PUBLIC_KEY_BYTES);
  const secret = buf.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + SECRET_BYTES);
  const sum = buf.subarray(PUBLIC_KEY_BYTES + SECRET_BYTES, PUBLIC_KEY_BYTES + SECRET_BYTES + CHECKSUM_BYTES);
  if (!sum.equals(checksum(publicKey, secret))) throw new InviteError("초대코드가 올바르지 않아요. 글자가 하나 틀렸거나 빠졌을 수 있어요.");
  return { publicKey: Buffer.from(publicKey), secret: Buffer.from(secret) };
}

/** 로그·화면용: 공개키 앞 8자 (초대코드나 시크릿은 절대 로그에 남기지 않는다) */
export const shortKey = (publicKey: Buffer | string) => (typeof publicKey === "string" ? publicKey : publicKey.toString("hex")).slice(0, 8);
