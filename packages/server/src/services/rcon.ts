import net from "node:net";

/**
 * 마인크래프트 RCON 클라이언트 (Source RCON 프로토콜).
 * BlockPilot이 직접 띄우지 않은(외부 실행) 서버에 명령을 보낼 때 쓴다.
 *
 * 패킷: int32 length | int32 id | int32 type | payload (ASCII/UTF-8) | 0x00 | 0x00
 */

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const TIMEOUT_MS = 3000;
/** 마인크래프트가 응답을 쪼개는 단위 */
const RESPONSE_CHUNK = 4096;

export class RconError extends Error {}

export class RconClient {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; chunks: string[]; timer: NodeJS.Timeout }>();

  constructor(
    private host: string,
    private port: number,
    private password: string,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      const onErr = (e: Error) => {
        sock.destroy();
        reject(new RconError(`RCON 연결 실패 (${this.host}:${this.port}): ${e.message}`));
      };
      sock.setTimeout(TIMEOUT_MS, () => onErr(new Error("timeout")));
      sock.once("error", onErr);
      sock.once("connect", () => {
        sock.setTimeout(0);
        sock.setNoDelay(true);
        sock.off("error", onErr);
        this.sock = sock;
        sock.on("data", (d) => this.onData(d));
        sock.on("close", () => this.failAll(new RconError("RCON 연결이 끊어졌습니다.")));
        sock.on("error", (e) => this.failAll(new RconError(e.message)));
        resolve();
      });
    });
    const id = this.send(TYPE_AUTH, this.password);
    const ok = await this.waitAuth(id);
    if (!ok) {
      this.close();
      throw new RconError("RCON 비밀번호가 틀렸습니다.");
    }
  }

  /**
   * 명령 실행 후 응답 텍스트.
   * 마인크래프트는 긴 응답을 정확히 4096자 단위로 쪼개 보내므로, 4096자보다 짧은 조각이 오면 끝난 것으로 본다.
   * (끝 표시용 더미 패킷을 같이 보내는 방식은 마인크래프트가 한 번의 read 에 패킷 두 개가 들어오면 연결을 끊어 버려 쓸 수 없다)
   */
  async command(cmd: string): Promise<string> {
    if (!this.sock) throw new RconError("RCON에 연결되어 있지 않습니다.");
    const id = this.send(TYPE_COMMAND, cmd);
    try {
      return await this.register(id);
    } finally {
      this.pending.delete(id);
    }
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
    this.failAll(new RconError("closed"));
  }

  // ---------- 내부 ----------

  private send(type: number, payload: string): number {
    const id = this.nextId++;
    const body = Buffer.from(payload, "utf8");
    const pkt = Buffer.alloc(4 + 4 + 4 + body.length + 2);
    pkt.writeInt32LE(pkt.length - 4, 0);
    pkt.writeInt32LE(id, 4);
    pkt.writeInt32LE(type, 8);
    body.copy(pkt, 12);
    this.sock!.write(pkt);
    return id;
  }

  private register(id: number) {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RconError("RCON 응답 시간 초과"));
      }, TIMEOUT_MS * 2);
      this.pending.set(id, { resolve, reject, chunks: [], timer });
    });
  }

  private flush(id: number): string {
    const p = this.pending.get(id);
    if (!p) return "";
    clearTimeout(p.timer);
    const text = p.chunks.join("");
    p.resolve(text);
    return text;
  }

  private authResult: { id: number; resolve: (ok: boolean) => void } | null = null;
  private waitAuth(id: number) {
    return new Promise<boolean>((resolve) => {
      this.authResult = { id, resolve };
      setTimeout(() => {
        if (this.authResult?.id === id) {
          this.authResult = null;
          resolve(false);
        }
      }, TIMEOUT_MS);
    });
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const payload = this.buf.subarray(12, 4 + len - 2).toString("utf8");
      this.buf = this.buf.subarray(4 + len);

      if (type === 2 && this.authResult) {
        // 인증 응답: 성공이면 id가 그대로, 실패면 -1
        const r = this.authResult;
        this.authResult = null;
        r.resolve(id === r.id);
        continue;
      }
      const p = this.pending.get(id);
      if (!p) continue;
      p.chunks.push(payload);
      if (payload.length < RESPONSE_CHUNK) this.flush(id);
    }
  }

  private failAll(e: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
    this.sock = null;
  }
}

/** 한 번 연결해 명령 하나 실행하고 닫는다 */
export async function rconOnce(host: string, port: number, password: string, cmd: string): Promise<string> {
  const c = new RconClient(host, port, password);
  await c.connect();
  try {
    return await c.command(cmd);
  } finally {
    c.close();
  }
}

/** 마인크래프트 §색상 코드 제거 */
export function stripColor(s: string) {
  return s.replace(/§[0-9a-fk-or]/gi, "");
}
