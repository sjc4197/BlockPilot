import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dgram from "node:dgram";
import type DHT from "hyperdht";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";
import { addServer, getP2p, removeServer } from "../src/config/store.js";
import { getManaged } from "../src/services/process.js";
import { emitServerEvent } from "../src/services/events.js";
import { loadHyperdht } from "../src/services/p2p/native.js";
import { decodeInvite } from "../src/services/p2p/invite.js";
import { JoinTunnel } from "../src/services/p2p/tunnel.js";
import { p2pHostView, peerAction, rotateInvite, setP2pEnabled, startP2pHostLifecycle, stopAllP2pHosts } from "../src/services/p2p/host.js";

/**
 * 호스트 관리자: 초대 켜기 → (서버가 켜져 있으면) 터널 시작 → 초대코드로 친구 접속 → 승인 저장 → 재발급 → 끄기.
 * 격리된 로컬 DHT (BLOCKPILOT_DHT_BOOTSTRAP) 를 쓴다.
 */
describe("P2P host manager", () => {
  let Dht: typeof DHT;
  let bootstrapper: DHT;
  let fake: Awaited<ReturnType<typeof makeFakeServer>>;
  let serverId: string;
  const nodes: DHT[] = [];

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
    fake = await makeFakeServer(`log("Done (1.0s)! For help, type \\"help\\"");`);
    const s = await addServer({ path: fake.dir, name: "p2p-host-test" });
    serverId = s.id;
    startP2pHostLifecycle();
  }, 30_000);

  afterAll(async () => {
    await stopAllP2pHosts();
    for (const n of nodes) await n.destroy({ force: true }).catch(() => {});
    const m = getManaged(serverId, fake.dir);
    if (m.isManaged()) await m.stop().catch(() => {});
    await removeServer(serverId).catch(() => {});
    await fake.cleanup();
    await bootstrapper.destroy({ force: true }).catch(() => {});
    delete process.env.BLOCKPILOT_DHT_BOOTSTRAP;
  });

  it("enabling while the server is stopped stores the setting and waits; the tunnel starts when the server comes up", async () => {
    let v = await p2pHostView(serverId);
    expect(v).toMatchObject({ supported: true, enabled: false, state: "off" });
    expect(v.warnings.serverStopped).toBe(true);
    expect(v.inviteCode).toBeUndefined();

    v = await setP2pEnabled(serverId, true);
    expect(v.enabled).toBe(true);
    expect(v.state).toBe("off"); // 서버가 꺼져 있으니 아직
    expect(v.inviteCode).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){19}$/);
    expect((await getP2p(serverId)).enabled).toBe(true);

    const managed = getManaged(serverId, fake.dir);
    await managed.start();
    await waitFor(async () => (await managed.status()).state === "running", 10_000, "가짜 서버 켜지기");
    await waitFor(async () => (await p2pHostView(serverId)).state === "listening", 15_000, "터널이 켜지기");
  }, 40_000);

  it("a friend joins with the invite code, gets approved with a name, and the approval is saved", async () => {
    const v = await p2pHostView(serverId);
    const invite = decodeInvite(v.inviteCode!);
    const dht = new Dht({ bootstrap: [process.env.BLOCKPILOT_DHT_BOOTSTRAP!], ephemeral: true });
    nodes.push(dht);
    const kp = Dht.keyPair();
    const join = new JoinTunnel({ dht, invite, keyPair: kp, localPort: 0 });
    const started = join.start();
    await waitFor(async () => (await p2pHostView(serverId)).peers.some((p) => p.state === "pending"), 10_000, "승인 대기");
    const key = kp.publicKey.toString("hex");
    const after = await peerAction(serverId, key, "approve", "철수");
    expect(after.approved).toEqual([expect.objectContaining({ publicKey: key, name: "철수" })]);
    await started;
    expect(join.state).toBe("connected");
    await waitFor(async () => (await p2pHostView(serverId)).peers.some((p) => p.state === "connected" && p.name === "철수"), 10_000, "접속 중 표시");
    expect((await getP2p(serverId)).approved[0].name).toBe("철수");
    await join.stop();
    await waitFor(async () => (await p2pHostView(serverId)).peers.length === 0, 10_000, "나감");
  }, 40_000);

  it("rotating the invite changes the code; blocking removes approval; disabling stops the tunnel", async () => {
    const before = (await p2pHostView(serverId)).inviteCode!;
    const rotated = await rotateInvite(serverId);
    expect(rotated.inviteCode).not.toBe(before);
    expect(decodeInvite(rotated.inviteCode!).publicKey).toEqual(decodeInvite(before).publicKey); // 공개키는 그대로, 시크릿만 바뀜

    const key = rotated.approved[0].publicKey;
    const blocked = await peerAction(serverId, key, "block");
    expect(blocked.approved).toEqual([]);
    expect(blocked.blocked).toEqual([expect.objectContaining({ publicKey: key, name: "철수" })]);
    const unblocked = await peerAction(serverId, key, "unblock");
    expect(unblocked.blocked).toEqual([]);

    const off = await setP2pEnabled(serverId, false);
    expect(off).toMatchObject({ enabled: false, state: "off" });
    expect(off.inviteCode).toBeUndefined();
  }, 30_000);

  it("the tunnel follows the server: stops when the server stops", async () => {
    await setP2pEnabled(serverId, true);
    await waitFor(async () => (await p2pHostView(serverId)).state === "listening", 15_000, "터널 재시작");
    emitServerEvent({ serverId, type: "stopped", online: 0 });
    await waitFor(async () => (await p2pHostView(serverId)).state === "off", 10_000, "터널 멈춤");
    const managed = getManaged(serverId, fake.dir);
    await managed.stop();
  }, 30_000);
});
