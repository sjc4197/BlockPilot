import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dgram from "node:dgram";
import net from "node:net";
import type DHT from "hyperdht";
import { loadHyperdht } from "../src/services/p2p/native.js";
import { encodeInvite, newSecret } from "../src/services/p2p/invite.js";
import { HostTunnel } from "../src/services/p2p/tunnel.js";
import { forgetRemembered, joinView, startJoin, stopJoin } from "../src/services/p2p/join.js";
import { getJoinSettings } from "../src/config/store.js";

const waitFor = async (check: () => Promise<boolean>, ms = 10_000, what = "조건") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`시간 초과: ${what}`);
};

describe("P2P join manager", () => {
  let Dht: typeof DHT;
  let bootstrapper: DHT;
  let hostDht: DHT;
  let host: HostTunnel;
  let echo: net.Server;
  const approved = new Set<string>();

  beforeAll(async () => {
    Dht = (await loadHyperdht())!;
    const port = await new Promise<number>((r) => {
      const u = dgram.createSocket("udp4");
      u.bind(0, "127.0.0.1", () => {
        const p = (u.address() as { port: number }).port;
        u.close(() => r(p));
      });
    });
    bootstrapper = Dht.bootstrapper(port, "127.0.0.1");
    await bootstrapper.fullyBootstrapped();
    process.env.BLOCKPILOT_DHT_BOOTSTRAP = `127.0.0.1:${port}`;
    // 다른 테스트가 25565 가 열려 있으면 "서버가 켜져 있다" 고 보므로 빈 포트를 쓴다
    process.env.BLOCKPILOT_JOIN_PORT = "0";
    echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    hostDht = new Dht({ bootstrap: [`127.0.0.1:${port}`], ephemeral: true });
    host = new HostTunnel({ dht: hostDht, keyPair: Dht.keyPair(), secret: newSecret(), mcPort: (echo.address() as net.AddressInfo).port, policy: { isApproved: (k) => approved.has(k), isBlocked: () => false } });
    await host.start();
  }, 30_000);

  afterAll(async () => {
    await stopJoin();
    await host.stop();
    await hostDht.destroy({ force: true }).catch(() => {});
    echo.close();
    await bootstrapper.destroy({ force: true }).catch(() => {});
    delete process.env.BLOCKPILOT_DHT_BOOTSTRAP;
    delete process.env.BLOCKPILOT_JOIN_PORT;
  });

  it("rejects a malformed invite code with a Korean 400 and starts nothing", async () => {
    await expect(startJoin("abcd")).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/길이가 맞지 않아요/) });
    expect((await joinView()).state).toBe("idle");
  });

  it("connects with a valid code: pending until the host approves, then connected with a local port; remembers the invite", async () => {
    const code = encodeInvite({ publicKey: host.publicKey, secret: host["secret"] });
    const v0 = await startJoin(code, "철수네");
    expect(v0.state).toBe("connecting");
    expect(v0.hostShortKey).toBe(host.publicKey.toString("hex").slice(0, 8));
    await waitFor(async () => (await joinView()).state === "pending", 10_000, "승인 대기");
    const pending = host.listPeers()[0];
    approved.add(pending.publicKey);
    host.approve(pending.publicKey);
    await waitFor(async () => (await joinView()).state === "connected", 10_000, "연결");
    const v = await joinView();
    expect(v.localPort).toBeGreaterThan(0);
    expect(v.detail).toMatch(/localhost:/);
    expect(v.remembered).toMatchObject({ name: "철수네", inviteCode: code });
    // 로컬 포트로 실제 데이터가 흐른다
    const back = await new Promise<string>((resolve, reject) => {
      const c = net.connect(v.localPort!, "127.0.0.1");
      c.on("data", (d) => {
        resolve(d.toString());
        c.destroy();
      });
      c.on("error", reject);
      c.on("connect", () => c.write("ping"));
    });
    expect(back).toBe("ping");
    // 같은 키페어가 유지된다 (호스트가 다음에도 알아보게)
    const kp1 = (await getJoinSettings()).keyPair!.publicKey;
    expect(kp1).toBe(pending.publicKey);
  }, 40_000);

  it("stop returns to idle but keeps the remembered invite; forget clears it", async () => {
    const v = await stopJoin();
    expect(v.state).toBe("idle");
    expect(v.remembered?.name).toBe("철수네");
    await waitFor(async () => host.listPeers().length === 0, 10_000, "호스트에서 나감");
    const f = await forgetRemembered();
    expect(f.remembered).toBeUndefined();
  }, 20_000);
});

describe("P2P join manager — edge cases", () => {
  it("a wrong secret ends in failed with a diagnosis, and a second connect while active replaces the first cleanly", async () => {
    const Dht = (await loadHyperdht())!;
    const port = await new Promise<number>((r) => {
      const u = dgram.createSocket("udp4");
      u.bind(0, "127.0.0.1", () => {
        const p = (u.address() as { port: number }).port;
        u.close(() => r(p));
      });
    });
    const boot = Dht.bootstrapper(port, "127.0.0.1");
    await boot.fullyBootstrapped();
    process.env.BLOCKPILOT_DHT_BOOTSTRAP = `127.0.0.1:${port}`;
    process.env.BLOCKPILOT_JOIN_PORT = "0";
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const hostDht = new Dht({ bootstrap: [`127.0.0.1:${port}`], ephemeral: true });
    const approved = new Set<string>();
    const host = new HostTunnel({ dht: hostDht, keyPair: Dht.keyPair(), secret: newSecret(), mcPort: (echo.address() as net.AddressInfo).port, policy: { isApproved: (k) => approved.has(k), isBlocked: () => false } });
    await host.start();
    try {
      // 틀린 시크릿
      const wrong = encodeInvite({ publicKey: host.publicKey, secret: newSecret() });
      await startJoin(wrong, "");
      await waitFor(async () => (await joinView()).state === "failed", 10_000, "실패");
      const v = await joinView();
      expect(v.diagnosis?.kind).toBe("bad_code");
      expect(v.remembered).toBeUndefined(); // 호스트가 받아 주지 않은 코드는 기억하지 않는다

      // 맞는 코드로 두 번 연달아 (두 번째가 첫 번째를 대체)
      const good = encodeInvite({ publicKey: host.publicKey, secret: host["secret"] });
      const [a, b] = await Promise.all([startJoin(good, "첫째"), startJoin(good, "둘째")]);
      expect(a.state).not.toBe("idle");
      expect(b.state).not.toBe("idle");
      await waitFor(async () => (await joinView()).state === "pending", 10_000, "대기");
      expect(host.listPeers()).toHaveLength(1);
      approved.add(host.listPeers()[0].publicKey);
      host.approve(host.listPeers()[0].publicKey);
      await waitFor(async () => (await joinView()).state === "connected", 10_000, "연결");
      expect((await joinView()).remembered?.name).toBe("둘째");
      await stopJoin();
      await waitFor(async () => host.listPeers().length === 0, 10_000, "정리");
    } finally {
      await stopJoin();
      await host.stop();
      await hostDht.destroy({ force: true }).catch(() => {});
      echo.close();
      await boot.destroy({ force: true }).catch(() => {});
      delete process.env.BLOCKPILOT_DHT_BOOTSTRAP;
      delete process.env.BLOCKPILOT_JOIN_PORT;
    }
  }, 40_000);
});
