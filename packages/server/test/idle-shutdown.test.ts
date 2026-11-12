import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_AUTOMATION, type ServerEvent } from "@blockpilot/shared";
import { addServer, removeServer, setAutomation } from "../src/config/store.js";
import { onServerEvent } from "../src/services/events.js";
import { getManaged, forgetManaged } from "../src/services/process.js";
import { IDLE_WARNING, forgetIdleShutdown, idleShutdownStatus, tickIdleShutdown } from "../src/services/idleShutdown.js";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

/**
 * 가짜 서버: say 는 채팅으로 되돌리고, list 는 바닐라 형식으로 답한다.
 * listReply 로 "list" 응답을 바꿀 수 있다 (예: 로그에는 입장 줄이 없는데 list 는 1명이라고 하는 플러그인 서버 흉내).
 */
const BASE = `log('Done (1.0s)! For help, type "help"');
onCommand((c) => { if (c.startsWith("say ")) log("[Server] " + c.slice(4)); });
onCommand((c) => { if (c === "list") log(LIST_REPLY); });
onCommand((c) => { if (c === "join") log("Alex joined the game"); });
onCommand((c) => { if (c === "leave") log("Alex left the game"); });
`;

describe("idle shutdown", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(idle: { enabled: boolean; afterMinutes: number }, opts: { listReply?: string; script?: string } = {}) {
    const listReply = opts.listReply ?? "There are 0 of a max of 8 players online: ";
    const fake = await makeFakeServer(`const LIST_REPLY = ${JSON.stringify(listReply)};\n` + BASE + (opts.script ?? ""));
    const s = await addServer({ path: fake.dir, name: "idle" });
    await setAutomation(s.id, { ...DEFAULT_AUTOMATION, idleShutdown: idle });
    const events: ServerEvent[] = [];
    const off = onServerEvent((e) => e.serverId === s.id && events.push(e));
    const managed = getManaged(s.id, fake.dir);
    cleanups.push(async () => {
      off();
      forgetIdleShutdown(s.id);
      if (managed.isManaged()) await managed.stop().catch(() => {});
      forgetManaged(s.id);
      await removeServer(s.id);
      await fake.cleanup();
    });
    await managed.start();
    await waitFor(async () => (await managed.status()).state === "running", 10_000, "켜짐");
    const console = () => managed.getHistory().map((l) => l.text).join("\n");
    return { id: s.id, managed, events, settings: idle, console };
  }

  it("empty → list check + warning → next tick list check again → stop; status shows warnedAt/willStopAt", async () => {
    const { id, managed, events, settings, console } = await setup({ enabled: true, afterMinutes: 1 });
    const t0 = Date.now();
    await tickIdleShutdown(t0);
    // 아직 경고 전: 경고가 나갈 시각(+1분) 뒤 1분에 꺼진다
    expect(idleShutdownStatus(id, settings)).toEqual({ emptySince: iso(t0), warnedAt: undefined, willStopAt: iso(t0 + 2 * MIN) });
    await tickIdleShutdown(t0 + 30_000);
    expect((await managed.status()).state).toBe("running");
    expect(console()).not.toContain("> list");

    // 1단계: 시간이 차면 list 로 확인하고 경고만 한다 (아직 끄지 않는다)
    await tickIdleShutdown(t0 + MIN);
    expect((await managed.status()).state).toBe("running");
    expect(console()).toContain("> list");
    expect(console()).toContain(`> say ${IDLE_WARNING}`);
    expect(idleShutdownStatus(id, settings)).toEqual({ emptySince: iso(t0), warnedAt: iso(t0 + MIN), willStopAt: iso(t0 + 2 * MIN) });

    // 경고 뒤 1분이 안 됐으면 기다린다
    await tickIdleShutdown(t0 + MIN + 30_000);
    expect((await managed.status()).state).toBe("running");

    // 2단계: 한 번 더 list 로 확인하고 끈다
    const listsBefore = console().split("> list").length - 1;
    await tickIdleShutdown(t0 + 2 * MIN);
    await waitFor(async () => (await managed.status()).state === "stopped", 10_000, "꺼짐");
    expect(console().split("> list").length - 1).toBe(listsBefore + 1);
    expect(console()).toContain("1분 동안 아무도 없어서 자동으로 꺼요");
    expect(events.map((e) => e.type)).toEqual(["started", "stopped"]);
    expect(idleShutdownStatus(id, settings)).toEqual({});
    // 꺼진 뒤 또 틱이 와도 다시 끄려 들지 않는다
    await tickIdleShutdown(t0 + 3 * MIN);
    expect(events.filter((e) => e.type === "stopped")).toHaveLength(1);
  }, 40_000);

  it("trusts `list` over the log: 1 player in the list reply cancels and restarts the count", async () => {
    const { id, managed, settings, console } = await setup({ enabled: true, afterMinutes: 1 }, { listReply: "There are 1 of a max of 8 players online: Alex" });
    const t0 = Date.now();
    await tickIdleShutdown(t0);
    expect((await managed.status()).onlinePlayers).toEqual([]); // 로그로는 아무도 없다
    await tickIdleShutdown(t0 + MIN);
    expect((await managed.status()).state).toBe("running");
    expect(console()).toContain("1명이 있어서 자동 끄기를 처음부터 다시 세요");
    expect(console()).not.toContain(IDLE_WARNING);
    expect(idleShutdownStatus(id, settings)).toEqual({});
    // 다시 처음부터 센다
    const t1 = t0 + 2 * MIN;
    await tickIdleShutdown(t1);
    expect(idleShutdownStatus(id, settings).emptySince).toBe(iso(t1));
    await tickIdleShutdown(t1 + 5 * MIN);
    expect((await managed.status()).state).toBe("running");
  }, 40_000);

  it("a join between the warning and the next tick cancels the shutdown", async () => {
    const { id, managed, settings, console } = await setup({ enabled: true, afterMinutes: 1 });
    const t0 = Date.now();
    await tickIdleShutdown(t0);
    await tickIdleShutdown(t0 + MIN);
    expect(idleShutdownStatus(id, settings).warnedAt).toBe(iso(t0 + MIN));
    expect(console()).toContain(IDLE_WARNING);

    await managed.sendCommand("join");
    await waitFor(async () => (await managed.status()).onlinePlayers.length === 1, 5000, "입장");
    await tickIdleShutdown(t0 + 2 * MIN);
    expect((await managed.status()).state).toBe("running");
    expect(idleShutdownStatus(id, settings)).toEqual({});
    await tickIdleShutdown(t0 + 10 * MIN);
    expect((await managed.status()).state).toBe("running");

    // 나가면 그때부터 다시 센다 (경고도 처음부터)
    await managed.sendCommand("leave");
    await waitFor(async () => (await managed.status()).onlinePlayers.length === 0, 5000, "퇴장");
    const t1 = t0 + 11 * MIN;
    await tickIdleShutdown(t1);
    expect(idleShutdownStatus(id, settings)).toEqual({ emptySince: iso(t1), warnedAt: undefined, willStopAt: iso(t1 + 2 * MIN) });
    await tickIdleShutdown(t1 + 30_000);
    expect((await managed.status()).state).toBe("running");
  }, 40_000);

  it("does not stop when the list reply cannot be read (notes it once and keeps waiting)", async () => {
    const { managed, console } = await setup({ enabled: true, afterMinutes: 1 }, { listReply: "Online (0): " });
    const t0 = Date.now();
    await tickIdleShutdown(t0);
    await tickIdleShutdown(t0 + MIN);
    await tickIdleShutdown(t0 + 2 * MIN);
    expect((await managed.status()).state).toBe("running");
    expect(console()).not.toContain(IDLE_WARNING);
    expect(console().split("접속자 수(list)를 확인하지 못해").length - 1).toBe(1);
  }, 40_000);

  it("does nothing when disabled, and forgetting clears the state", async () => {
    const { id, managed, settings } = await setup({ enabled: false, afterMinutes: 5 });
    const t0 = Date.now();
    await tickIdleShutdown(t0);
    await tickIdleShutdown(t0 + 60 * MIN);
    expect((await managed.status()).state).toBe("running");
    expect(idleShutdownStatus(id, settings)).toEqual({});

    const on = { enabled: true, afterMinutes: 5 };
    await setAutomation(id, { ...DEFAULT_AUTOMATION, idleShutdown: on });
    await tickIdleShutdown(t0);
    expect(idleShutdownStatus(id, on).emptySince).toBe(iso(t0));
    forgetIdleShutdown(id);
    expect(idleShutdownStatus(id, on)).toEqual({});
  }, 30_000);
});
