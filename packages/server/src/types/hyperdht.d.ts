/** hyperdht 는 타입 선언을 배포하지 않아 BlockPilot 이 쓰는 부분만 적는다 (README 6.36 기준) */
declare module "hyperdht" {
  import type { Duplex } from "node:stream";

  export interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  /** Noise 로 암호화된 양방향 스트림 (@hyperswarm/secret-stream) */
  export interface SecretStream extends Duplex {
    remotePublicKey: Buffer;
    publicKey: Buffer;
    /** 이 암호 세션의 고유 해시 (양쪽이 같음) */
    handshakeHash: Buffer;
    rawStream?: { remoteHost?: string; remotePort?: number };
    opened: Promise<boolean>;
  }

  export interface HandshakePayload {
    addresses?: { host: string; port: number }[];
  }

  export interface ServerOptions {
    /** true 를 돌려주면 거부, false 면 허용. address 는 상대가 지금 보내는 주소 */
    firewall?: (remotePublicKey: Buffer, payload: HandshakePayload, address: { host: string; port: number }) => boolean;
  }

  export interface Server {
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
    refresh(): void;
    address(): { host: string; port: number; publicKey: Buffer };
    on(event: "connection", cb: (socket: SecretStream) => void): this;
    on(event: "listening" | "close", cb: () => void): this;
    on(event: string, cb: (...args: unknown[]) => void): this;
  }

  export interface DHTOptions {
    bootstrap?: string[];
    keyPair?: KeyPair;
    ephemeral?: boolean;
    port?: number;
    host?: string;
  }

  export default class DHT {
    constructor(opts?: DHTOptions);
    static keyPair(seed?: Buffer): KeyPair;
    static bootstrapper(port: number, host: string, opts?: DHTOptions): DHT;
    /** @deprecated dht-rpc 가 fullyBootstrapped 를 권장 */
    ready(): Promise<void>;
    fullyBootstrapped(): Promise<void>;
    address(): { host: string; port: number } | null;
    createServer(opts?: ServerOptions, onconnection?: (socket: SecretStream) => void): Server;
    connect(remotePublicKey: Buffer, opts?: { keyPair?: KeyPair; nodes?: unknown[] }): SecretStream;
    destroy(opts?: { force?: boolean }): Promise<void>;
    readonly destroyed: boolean;
  }
}
