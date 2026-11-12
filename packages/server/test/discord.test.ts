import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_AUTOMATION, DISCORD_EVENTS, DISCORD_EVENT_LABEL } from "@blockpilot/shared";
import { addServer, setAutomation } from "../src/config/store.js";
import { DISCORD_QUEUE_MAX, deliver, discordQueueStats, escapeMd, formatEvent, handleEvent, isWebhookUrl, setBatchWindow, setDiscordFetch, webhookHint } from "../src/services/discord.js";
import { automationView } from "../src/routes/automation.js";
import { waitFor } from "./helpers/fakeServer.js";

/** 이 컴퓨터 안의 가짜 디스코드 웹훅 수신기 */
let server: http.Server;
let base = "";
const got: { url: string; body: any }[] = [];
let reply: (n: number) => { status: number; body?: string } = () => ({ status: 204 });
let calls = 0;

beforeAll(async () => {
  process.env.BLOCKPILOT_DISCORD_ALLOW_LOCAL = "1";
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const r = reply(++calls);
      if (r.status < 300) got.push({ url: req.url!, body: JSON.parse(data) });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body ?? "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setBatchWindow(150);
});
afterAll(() => {
  server.close();
  delete process.env.BLOCKPILOT_DISCORD_ALLOW_LOCAL;
});

describe("discord webhook", () => {
  it("accepts only real Discord webhook URLs (local test receiver only when allowed)", () => {
    expect(isWebhookUrl("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-ABCDEF")).toBe(true);
    expect(isWebhookUrl("https://discordapp.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isWebhookUrl("https://evil.example.com/api/webhooks/1/abc")).toBe(false);
    expect(isWebhookUrl("http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isWebhookUrl("http://127.0.0.1:9999/hook")).toBe(true);
    delete process.env.BLOCKPILOT_DISCORD_ALLOW_LOCAL;
    expect(isWebhookUrl("http://127.0.0.1:9999/hook")).toBe(false);
    process.env.BLOCKPILOT_DISCORD_ALLOW_LOCAL = "1";
  });

  it("escapes markdown and blocks mentions", async () => {
    expect(escapeMd("cool_guy*")).toBe("cool\\_guy\\*");
    const m = formatEvent({ serverId: "x", type: "joined", at: "", player: "a_b", online: 2 }, "친구 서버")!;
    expect(m.title).toBe("a\\_b 님이 들어왔어요");
    got.length = 0;
    expect(await deliver(`${base}/h1`, [m])).toEqual({ ok: true });
    expect(got[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(got[0].body.embeds[0].description).toContain("지금 2명");
  });

  it("renders a friend's P2P approval request (name escaped, no IP) and offers it as a toggle", () => {
    const m = formatEvent({ serverId: "x", type: "p2p_pending", at: "", player: "ab_12cd" }, "친구 서버")!;
    expect(m.title).toBe("🙋 ab\\_12cd 님이 접속 승인을 기다려요");
    expect(m.description).toBe("**친구 서버** — 대시보드에서 승인해 주세요");
    expect(DISCORD_EVENTS).toContain("p2p_pending");
    expect(DISCORD_EVENT_LABEL.p2p_pending).toBe("친구 접속 요청");
    expect(DEFAULT_AUTOMATION.discord.events.p2p_pending).toBe(true);
  });

  it("retries when Discord rate-limits, and reports a dead webhook in Korean", async () => {
    calls = 0;
    reply = (n) => (n === 1 ? { status: 429, body: JSON.stringify({ retry_after: 0.2 }) } : { status: 204 });
    expect(await deliver(`${base}/h2`, [{ title: "t", color: 1 }])).toEqual({ ok: true });
    expect(calls).toBe(2);
    reply = () => ({ status: 404 });
    const r = await deliver(`${base}/h3`, [{ title: "t", color: 1 }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/웹훅 주소/);
    reply = () => ({ status: 204 });
  });

  it("sends only the events turned on, batches joins, and never exposes the webhook URL", async () => {
    const s = await addServer({ path: `/tmp/bp-discord-${Date.now()}`, name: "친구 서버" });
    const url = `${base}/hook-${s.id}`;
    await setAutomation(s.id, { ...DEFAULT_AUTOMATION, discord: { webhookUrl: url, events: { ...DEFAULT_AUTOMATION.discord.events, backup: false } } });
    got.length = 0;
    const ev = (type: any, extra = {}) => handleEvent({ serverId: s.id, type, at: new Date().toISOString(), ...extra });
    await ev("started");
    await ev("joined", { player: "Alex", online: 1 });
    await ev("joined", { player: "Steve", online: 2 });
    await ev("backup", { detail: "world.zip" }); // 꺼져 있음
    await ev("p2p_pending", { player: "ab12cd34" });
    await waitFor(() => got.filter((g) => g.url === `/hook-${s.id}`).length >= 3, 5000, "세 메시지");
    const titles = got.filter((g) => g.url === `/hook-${s.id}`).map((g) => g.body.embeds[0].title);
    expect(titles).toEqual(["🟢 서버가 켜졌어요", "Alex, Steve 님이 들어왔어요", "🙋 ab12cd34 님이 접속 승인을 기다려요"]);

    const view = await automationView(s.id);
    expect(view.discord.webhookSet).toBe(true);
    expect(view.discord.webhookHint).toBe(webhookHint(url));
    expect(JSON.stringify(view)).not.toContain(url);
  });

  it("caps the per-server queue: when more than 50 are waiting the oldest are dropped (once per burst)", async () => {
    const s = await addServer({ path: `/tmp/bp-discord-q-${Date.now()}`, name: "줄 서버" });
    const url = `${base}/hook-${s.id}`;
    await setAutomation(s.id, { ...DEFAULT_AUTOMATION, discord: { webhookUrl: url, events: { ...DEFAULT_AUTOMATION.discord.events, backup: true } } });
    // 디스코드가 막혀 있는 상황: 첫 전송을 붙잡아 두고 그 뒤로 사건을 쏟아 넣는다
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    setDiscordFetch(async (_u, init) => {
      await gate;
      sent.push(JSON.parse(String(init!.body)).embeds[0].description);
      return new Response(null, { status: 204 });
    });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => warned.push(a.join(" "));
    try {
      const total = DISCORD_QUEUE_MAX + 20;
      const done: Promise<unknown>[] = [];
      for (let i = 0; i < total; i++) done.push(handleEvent({ serverId: s.id, type: "backup", at: new Date().toISOString(), detail: `b${i}.zip` }));
      await waitFor(() => discordQueueStats(s.id).waiting === DISCORD_QUEUE_MAX, 5000, "줄 가득");
      // 하나는 보내는 중, 50개는 기다리는 중, 나머지(오래된 것부터)는 버렸다
      expect(discordQueueStats(s.id)).toEqual({ waiting: DISCORD_QUEUE_MAX, dropped: total - 1 - DISCORD_QUEUE_MAX });
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("건너뛰어요");
      release();
      await Promise.all(done);
      await waitFor(() => sent.length === DISCORD_QUEUE_MAX + 1, 5000, "줄 비움");
      // 버린 사건의 handleEvent 도 매달리지 않고 끝난다 (Promise.all 이 끝났다)
      expect(discordQueueStats(s.id)).toEqual({ waiting: 0, dropped: 0 });
      // 보내던 것(b0) 다음은 최근 50개 (오래된 b1..b19 는 건너뛰었다)
      expect(sent[0]).toContain("b0.zip");
      expect(sent[1]).toContain(`b${total - DISCORD_QUEUE_MAX}.zip`);
      expect(sent[sent.length - 1]).toContain(`b${total - 1}.zip`);
    } finally {
      console.warn = warn;
      setDiscordFetch((...a) => fetch(...a));
    }
  });
});
