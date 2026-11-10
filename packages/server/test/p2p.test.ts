import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import type DHT from "hyperdht";
import { decodeInvite, encodeInvite, newSecret, zbase32Decode, zbase32Encode, InviteError } from "../src/services/p2p/invite.js";
import { computeMac, FrameReader, STATUS } from "../src/services/p2p/protocol.js";
import { HostTunnel, JoinTunnel, type HostPeer } from "../src/services/p2p/tunnel.js";
import { loadHyperdht, bootstrapFromEnv } from "../src/services/p2p/native.js";
import { PassThrough } from "node:stream";

// ---------- 초대코드 ----------

describe("invite code", () => {
  it("z-base-32 round-trips arbitrary bytes", () => {
    for (const n of [0, 1, 5, 32, 50]) {
      const b = Buffer.alloc(n).map((_, i) => (i * 37 + 11) & 255);
      expect(zbase32Decode(zbase32Encode(Buffer.from(b)))).toEqual(Buffer.from(b));
    }
  });

  it("encodes 32B key + 16B secret as 80 chars in groups of 4, and reads it back ignoring case, hyphens and spaces", () => {
    const publicKey = Buffer.alloc(32, 0xab);
    const secret = newSecret();
    const code = encodeInvite({ publicKey, secret });
    expect(code.replace(/-/g, "")).toHaveLength(80);
    expect(code.split("-").every((g) => g.length === 4)).toBe(true);
    const back = decodeInvite(` ${code.toUpperCase().replace(/-/g, " ")} \n`);
    expect(back.publicKey).toEqual(publicKey);
    expect(back.secret).toEqual(secret);
  });

  it("rejects a code with a typo, a wrong length, or junk characters, in Korean", () => {
    const code = encodeInvite({ publicKey: Buffer.alloc(32, 1), secret: newSecret() });
    const typo = code.replace(/^./, code[0] === "y" ? "b" : "y");
    expect(() => decodeInvite(typo)).toThrow(/올바르지 않아요/);
    expect(() => decodeInvite(code.slice(0, 40))).toThrow(/길이가 맞지 않아요/);
    expect(() => decodeInvite(code.slice(0, -1) + "0")).toThrow(InviteError);
    expect(() => decodeInvite("")).toThrow(/입력해 주세요/);
  });
});

// ---------- 챌린지 프레이밍 ----------

describe("FrameReader", () => {
  it("reassembles messages split across chunks and returns the leftover", async () => {
    const s = new PassThrough();
    const r = new FrameReader(s);
    const p = r.read(5, 1000);
    s.write(Buffer.from([1, 2]));
    s.write(Buffer.from([3, 4, 5, 9, 9]));
    expect(await p).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(r.release()).toEqual(Buffer.from([9, 9]));
  });

  it("times out and reports a closed stream", async () => {
    const s = new PassThrough();
    const r = new FrameReader(s);
    await expect(r.read(1, 50)).rejects.toMatchObject({ code: "timeout" });
    const r2 = new FrameReader(new PassThrough());
    const p = r2.read(1, 1000);
    r2["onEnd"]();
    await expect(p).rejects.toMatchObject({ code: "closed" });
  });

  it("binds the MAC to nonce, joiner key and session hash", () => {
    const secret = newSecret();
    const a = computeMac(secret, Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3));
    expect(computeMac(secret, Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3))).toEqual(a);
    expect(computeMac(secret, Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 4))).not.toEqual(a);
    expect(computeMac(newSecret(), Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3))).not.toEqual(a);
  });
});

// ---------- 터널 통합 (로컬 격리 DHT, 인터넷 없음) ----------

const waitFor = async (check: () => boolean, ms = 10_000, what = "조건") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`시간 초과: ${what}`);
};

/** TCP 로 payload 를 보내고 같은 바이트가 돌아오는지 */
function echoRoundTrip(port: number, payload: Buffer, ms = 10_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let got = 0;
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error("echo 시간 초과"));
    }, ms);
    c.on("data", (d) => {
      chunks.push(d);
      got += d.length;
      if (got >= payload.length) {
        clearTimeout(timer);
        c.destroy();
        resolve(Buffer.concat(chunks));
      }
    });
    c.on("error", reject);
    c.on("connect", () => c.write(payload));
  });
}

describe("P2P tunnel (isolated local DHT)", () => {
  let Dht: typeof DHT;
  let bootstrapper: DHT;
  let bootstrap: string[];
  let echo: net.Server;
  let mcPort: number;
  const nodes: DHT[] = [];
  const newNode = async () => {
    const n = new Dht({ bootstrap, ephemeral: true });
    nodes.push(n);
    return n;
  };

  beforeAll(async () => {
    const ctor = await loadHyperdht();
    if (!ctor) throw new Error("hyperdht 를 불러오지 못했어요");
    Dht = ctor;
    // 빈 UDP 포트를 찾아 부트스트래퍼를 띄운다 (dht-rpc 는 포트 0 을 거부)
    const dgram = await import("node:dgram");
    const port = await new Promise<number>((r) => {
      const u = dgram.createSocket("udp4");
      u.bind(0, "127.0.0.1", () => {
        const p = (u.address() as { port: number }).port;
        u.close(() => r(p));
      });
    });
    bootstrapper = Dht.bootstrapper(port, "127.0.0.1");
    await bootstrapper.fullyBootstrapped();
    bootstrap = [`127.0.0.1:${bootstrapper.address()!.port}`];
    echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    mcPort = (echo.address() as net.AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    echo?.close();
    for (const n of nodes) await n.destroy({ force: true }).catch(() => {});
    await bootstrapper?.destroy({ force: true }).catch(() => {});
  });

  const policy = (approved: Set<string>, blocked = new Set<string>()) => ({ isApproved: (k: string) => approved.has(k), isBlocked: (k: string) => blocked.has(k) });

  it("pipes a Minecraft-like TCP session end to end, only to 127.0.0.1:<mcPort>, and reports peers", async () => {
    const approved = new Set<string>();
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(approved) });
    const events: string[] = [];
    host.on("peer-pending", (p) => {
      events.push(`pending:${p.publicKey.slice(0, 4)}`);
      approved.add(p.publicKey);
      host.approve(p.publicKey);
    });
    host.on("peer-connected", (p: HostPeer) => events.push(`connected:${p.publicKey.slice(0, 4)}`));
    host.on("peer-left", (p) => events.push(`left:${p.publicKey.slice(0, 4)}`));
    await host.start();

    const joinKeys = Dht.keyPair();
    const join = new JoinTunnel({ dht: await newNode(), invite: { publicKey: host.publicKey, secret: host["o"].secret }, keyPair: joinKeys, localPort: 0 });
    const states: string[] = [];
    join.on("state", (s) => states.push(s));
    await join.start();
    expect(join.state).toBe("connected");
    expect(states).toEqual(["connecting", "pending", "connected"]);
    expect(join.localPort).toBeGreaterThan(0);
    expect(join.detail).toMatch(new RegExp(`localhost:${join.localPort}`));

    const payload = Buffer.alloc(300 * 1024).map((_, i) => i & 255);
    const back = await echoRoundTrip(join.localPort!, Buffer.from(payload));
    expect(back.equals(payload)).toBe(true);
    // 두 번째 클라이언트도 (이미 승인됐으니 대기 없이)
    const back2 = await echoRoundTrip(join.localPort!, Buffer.from("hello"));
    expect(back2.toString()).toBe("hello");

    const me = joinKeys.publicKey.toString("hex").slice(0, 4);
    expect(events.slice(0, 2)).toEqual([`pending:${me}`, `connected:${me}`]);
    expect(host.listPeers()).toHaveLength(1);
    expect(host.listPeers()[0].state).toBe("connected");

    await join.stop();
    await waitFor(() => host.listPeers().length === 0, 10_000, "친구가 나가기");
    expect(events).toContain(`left:${me}`);
    await host.stop();
  }, 60_000);

  it("rejects a wrong secret immediately and counts the failure; the joiner sees a Korean reason", async () => {
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(new Set()), failureLimit: 2 });
    const failed: string[] = [];
    host.on("auth-failed", (i) => failed.push(i.reason));
    await host.start();
    const dht = await newNode();
    const kp = Dht.keyPair();
    const bad = { publicKey: host.publicKey, secret: newSecret() };

    const j1 = new JoinTunnel({ dht, invite: bad, keyPair: kp, localPort: 0 });
    await j1.start();
    expect(j1.state).toBe("failed");
    expect(j1.detail).toMatch(/초대코드가 맞지 않아요/);
    await waitFor(() => failed.length >= 1, 5000, "auth-failed 이벤트");
    expect(failed[0]).toMatch(/초대코드가 맞지 않아요/);

    // 2번째 실패 뒤부터는 핸드셰이크 전에(firewall) 거부된다
    const j2 = new JoinTunnel({ dht, invite: bad, keyPair: kp, localPort: 0 });
    await j2.start();
    expect(j2.state).toBe("failed");
    await waitFor(() => failed.length >= 2, 5000, "두 번째 실패");
    const j3 = new JoinTunnel({ dht, invite: bad, keyPair: kp, localPort: 0, connectTimeoutMs: 4000 });
    await j3.start();
    expect(j3.state).toBe("failed");
    expect(failed).toHaveLength(2); // 세 번째는 firewall 이 막아 인증 시도 자체가 없다
    expect(host.listPeers()).toHaveLength(0);
    await host.stop();
  }, 60_000);

  it("holds an unknown peer as pending without opening the local port, then rejects or admits by host decision", async () => {
    const approved = new Set<string>();
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(approved), approvalTimeoutMs: 5000 });
    const pending: HostPeer[] = [];
    host.on("peer-pending", (p) => pending.push(p));
    await host.start();
    const dht = await newNode();
    const invite = { publicKey: host.publicKey, secret: host["o"].secret };

    // 거절
    const j1 = new JoinTunnel({ dht, invite, keyPair: Dht.keyPair(), localPort: 0 });
    const started = j1.start();
    await waitFor(() => j1.state === "pending", 10_000, "승인 대기");
    expect(j1.localPort).toBeUndefined();
    expect(pending).toHaveLength(1);
    host.reject(pending[0].publicKey);
    await started;
    expect(j1.state).toBe("failed");
    expect(j1.detail).toMatch(/거절/);
    await waitFor(() => host.listPeers().length === 0, 5000, "거절된 친구 정리");

    // 승인 시간 초과는 따로 알려 준다
    const j2 = new JoinTunnel({ dht, invite, keyPair: Dht.keyPair(), localPort: 0 });
    await j2.start();
    expect(j2.state).toBe("failed");
    expect(j2.detail).toMatch(/제때 승인하지 않았어요/);
    await waitFor(() => host.listPeers().length === 0, 5000, "시간 초과된 친구 정리");

    // 승인
    const j3 = new JoinTunnel({ dht, invite, keyPair: Dht.keyPair(), localPort: 0 });
    const s3 = j3.start();
    await waitFor(() => pending.length === 3, 10_000, "세 번째 대기");
    approved.add(pending[2].publicKey);
    host.approve(pending[2].publicKey);
    await s3;
    expect(j3.state).toBe("connected");
    expect((await echoRoundTrip(j3.localPort!, Buffer.from("ok"))).toString()).toBe("ok");
    await j3.stop();
    await host.stop();
  }, 60_000);

  it("refuses blocked keys before the handshake and enforces the peer limit", async () => {
    const blocked = new Set<string>();
    const approved = new Set<string>();
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(approved, blocked), maxPeers: 1 });
    await host.start();
    const invite = { publicKey: host.publicKey, secret: host["o"].secret };
    const dht = await newNode();

    const badKp = Dht.keyPair();
    blocked.add(badKp.publicKey.toString("hex"));
    const authFailed: string[] = [];
    const pendingSeen: string[] = [];
    host.on("auth-failed", (i) => authFailed.push(i.publicKey));
    host.on("peer-pending", (p) => pendingSeen.push(p.publicKey));
    const jb = new JoinTunnel({ dht, invite, keyPair: badKp, localPort: 0, connectTimeoutMs: 4000 });
    await jb.start();
    expect(jb.state).toBe("failed");
    expect(jb.detail).toMatch(/시간 초과/); // firewall 은 응답 없이 버린다
    expect(authFailed).toEqual([]);
    expect(pendingSeen).toEqual([]);

    const k1 = Dht.keyPair();
    const k2 = Dht.keyPair();
    approved.add(k1.publicKey.toString("hex"));
    approved.add(k2.publicKey.toString("hex"));
    const j1 = new JoinTunnel({ dht: await newNode(), invite, keyPair: k1, localPort: 0 });
    await j1.start();
    expect(j1.state).toBe("connected");
    const j2 = new JoinTunnel({ dht: await newNode(), invite, keyPair: k2, localPort: 0 });
    await j2.start();
    expect(j2.state).toBe("failed");
    expect(j2.detail).toMatch(/자리가 없어요/);
    await j1.stop();
    await host.stop();
  }, 60_000);

  it("forgets a pending peer that disconnects before approval (no ghost slot), and reports pending only once", async () => {
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(new Set()), maxPeers: 1 });
    const pendings: string[] = [];
    host.on("peer-pending", (p) => pendings.push(p.publicKey));
    await host.start();
    const invite = { publicKey: host.publicKey, secret: host["o"].secret };
    const j1 = new JoinTunnel({ dht: await newNode(), invite, keyPair: Dht.keyPair(), localPort: 0 });
    const started = j1.start();
    await waitFor(() => j1.state === "pending", 10_000, "대기");
    expect(host.listPeers()).toHaveLength(1);
    await j1.stop();
    await started;
    await waitFor(() => host.listPeers().length === 0, 5000, "대기 중 끊긴 친구 정리");
    expect(pendings).toHaveLength(1);
    // 자리가 비었으니 다른 친구가 들어올 수 있어야 한다 (maxPeers 1)
    const approved = new Set<string>();
    host.on("peer-pending", (p) => {
      approved.add(p.publicKey);
      host.approve(p.publicKey);
    });
    host["o"].policy = policy(approved);
    const j2 = new JoinTunnel({ dht: await newNode(), invite, keyPair: Dht.keyPair(), localPort: 0 });
    await j2.start();
    expect(j2.state).toBe("connected");
    await j2.stop();
    await host.stop();
  }, 60_000);

  it("approve() alone is enough for this session: data connections pass without the policy being updated", async () => {
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(new Set()) });
    host.on("peer-pending", (p) => host.approve(p.publicKey));
    await host.start();
    const join = new JoinTunnel({ dht: await newNode(), invite: { publicKey: host.publicKey, secret: host["o"].secret }, keyPair: Dht.keyPair(), localPort: 0 });
    await join.start();
    expect(join.state).toBe("connected");
    expect((await echoRoundTrip(join.localPort!, Buffer.from("data-ok"), 8000)).toString()).toBe("data-ok");
    await join.stop();
    await host.stop();
  }, 60_000);

  it("drops a joiner that floods data before GO instead of buffering it", async () => {
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(new Set()), approvalTimeoutMs: 20_000 });
    await host.start();
    const dht = await newNode();
    const kp = Dht.keyPair();
    // 참가자 역할을 흉내: 인증까지 정상으로 한 뒤 승인 전에 데이터를 쏟아붓는다
    const sock = dht.connect(host.publicKey, { keyPair: kp });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.once("open", () => r()));
    const { FrameReader: FR, joinRespond: respond, KIND: K } = await import("../src/services/p2p/protocol.js");
    const reader = new FR(sock);
    let pending = false;
    const p = respond(reader, sock, host["o"].secret, sock.publicKey, sock.handshakeHash, K.CONTROL, { onPending: () => (pending = true), approvalTimeoutMs: 20_000 }).catch((e: Error) => e);
    await waitFor(() => pending, 10_000, "대기 상태");
    for (let i = 0; i < 8; i++) sock.write(Buffer.alloc(1024, 1));
    await waitFor(() => sock.destroyed, 10_000, "호스트가 끊기");
    expect(await p).toBeInstanceOf(Error);
    await waitFor(() => host.listPeers().length === 0, 5000, "정리");
    await host.stop();
  }, 60_000);

  it("rotateSecret invalidates the old invite for new joiners but keeps connected friends", async () => {
    const approved = new Set<string>();
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(approved) });
    await host.start();
    const old = { publicKey: host.publicKey, secret: host["o"].secret };
    const k1 = Dht.keyPair();
    approved.add(k1.publicKey.toString("hex"));
    const j1 = new JoinTunnel({ dht: await newNode(), invite: old, keyPair: k1, localPort: 0 });
    await j1.start();
    expect(j1.state).toBe("connected");

    const fresh = newSecret();
    host.rotateSecret(fresh);
    // 접속 중인 친구는 그대로 (새 데이터 연결도 새 시크릿으로 인증해야 하므로 옛 코드로는 실패)
    expect(j1.state).toBe("connected");
    const k2 = Dht.keyPair();
    approved.add(k2.publicKey.toString("hex"));
    const jOld = new JoinTunnel({ dht: await newNode(), invite: old, keyPair: k2, localPort: 0 });
    await jOld.start();
    expect(jOld.state).toBe("failed");
    expect(jOld.detail).toMatch(/초대코드가 맞지 않아요/);
    const jNew = new JoinTunnel({ dht: await newNode(), invite: { publicKey: host.publicKey, secret: fresh }, keyPair: k2, localPort: 0 });
    await jNew.start();
    expect(jNew.state).toBe("connected");
    await j1.stop();
    await jNew.stop();
    await host.stop();
  }, 60_000);

  it("refuses to proxy to a forbidden port (the dashboard itself)", async () => {
    expect(() => new HostTunnel({ dht: bootstrapper, keyPair: Dht.keyPair(), secret: newSecret(), mcPort: 4800, forbiddenPorts: [4800], policy: policy(new Set()) })).toThrow(/BlockPilot 자신/);
    expect(() => new HostTunnel({ dht: bootstrapper, keyPair: Dht.keyPair(), secret: newSecret(), mcPort: 0, policy: policy(new Set()) })).toThrow(/올바르지 않아요/);
  });

  it("the joiner notices when the host stops", async () => {
    const approved = new Set<string>();
    const host = new HostTunnel({ dht: await newNode(), keyPair: Dht.keyPair(), secret: newSecret(), mcPort, policy: policy(approved) });
    await host.start();
    const kp = Dht.keyPair();
    approved.add(kp.publicKey.toString("hex"));
    const join = new JoinTunnel({ dht: await newNode(), invite: { publicKey: host.publicKey, secret: host["o"].secret }, keyPair: kp, localPort: 0 });
    await join.start();
    expect(join.state).toBe("connected");
    await host.stop();
    await waitFor(() => join.state === "failed", 10_000, "호스트 종료 감지");
    expect(join.detail).toMatch(/끊겼어요|끝냈거나/);
    await join.stop();
  }, 60_000);
});

describe("bootstrap override", () => {
  it("reads BLOCKPILOT_DHT_BOOTSTRAP as a comma list", () => {
    expect(bootstrapFromEnv({})).toBeUndefined();
    expect(bootstrapFromEnv({ BLOCKPILOT_DHT_BOOTSTRAP: " a:1, b:2 ,, " })).toEqual(["a:1", "b:2"]);
  });
});
