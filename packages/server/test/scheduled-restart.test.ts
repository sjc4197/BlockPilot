import { describe, it, expect, afterEach } from "vitest";
import type { ServerEvent } from "@blockpilot/shared";
import { addServer, removeServer } from "../src/config/store.js";
import { onServerEvent } from "../src/services/events.js";
import { getManaged, forgetManaged } from "../src/services/process.js";
import { nextRun, planScheduledRestart, setScheduleSecond } from "../src/services/scheduledRestart.js";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";

const all = [0, 1, 2, 3, 4, 5, 6];
describe("next scheduled time", () => {
  it("picks today if still ahead, otherwise the next allowed day", () => {
    const wed4am = new Date(2026, 9, 21, 4, 0); // 2026-10-21 수요일
    expect(nextRun({ enabled: true, time: "05:00", days: all, onlyWhenEmpty: true }, wed4am)).toEqual(new Date(2026, 9, 21, 5, 0));
    expect(nextRun({ enabled: true, time: "05:00", days: all, onlyWhenEmpty: true }, new Date(2026, 9, 21, 6, 0))).toEqual(new Date(2026, 9, 22, 5, 0));
    expect(nextRun({ enabled: true, time: "05:00", days: [0], onlyWhenEmpty: true }, wed4am)).toEqual(new Date(2026, 9, 25, 5, 0));
    expect(nextRun({ enabled: true, time: "05:00", days: all, onlyWhenEmpty: true }, new Date(2026, 9, 21, 5, 0))).toEqual(new Date(2026, 9, 22, 5, 0));
  });
});

describe("scheduled restart", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(script: string) {
    setScheduleSecond(10);
    const fake = await makeFakeServer(`log('Done (1.0s)! For help, type "help"'); onCommand((c) => { if (c.startsWith("tellraw") || c === "save-all") log("[Server] " + c); });` + script);
    const s = await addServer({ path: fake.dir, name: "sched" });
    const events: ServerEvent[] = [];
    const off = onServerEvent((e) => e.serverId === s.id && events.push(e));
    const managed = getManaged(s.id, fake.dir);
    cleanups.push(async () => {
      off();
      if (managed.isManaged()) await managed.stop().catch(() => {});
      forgetManaged(s.id);
      await removeServer(s.id);
      await fake.cleanup();
    });
    await managed.start();
    await waitFor(async () => (await managed.status()).state === "running", 10_000, "켜짐");
    return { id: s.id, managed, events };
  }

  it("warns players in chat, saves, then restarts", async () => {
    const { id, managed, events } = await setup("");
    planScheduledRestart(id, Date.now() + 700, false);
    await waitFor(() => events.filter((e) => e.type === "started").length >= 2, 15_000, "다시 켜짐");
    const said = managed.getHistory().map((l) => l.text).join("\n");
    expect(said).toContain("1분 뒤 다시 켜요");
    expect(said).toContain("10초 뒤 다시 켜요");
    expect(said).toContain("> save-all");
    expect(events.map((e) => e.type)).toEqual(["started", "scheduled-restart", "stopped", "started"]);
  }, 30_000);

  it("skips when someone is online and only-when-empty is on", async () => {
    const { id, managed, events } = await setup(`setTimeout(() => log("Alex joined the game"), 50);`);
    await waitFor(async () => (await managed.status()).onlinePlayers.length === 1, 5000, "입장");
    planScheduledRestart(id, Date.now() + 300, true);
    await waitFor(() => events.some((e) => e.type === "scheduled-restart"), 5000, "건너뜀");
    await new Promise((r) => setTimeout(r, 300));
    expect(events.find((e) => e.type === "scheduled-restart")?.detail).toContain("건너뛰었어요");
    expect(events.some((e) => e.type === "stopped")).toBe(false);
    expect(managed.getHistory().some((l) => l.text.includes("tellraw"))).toBe(false);
  }, 30_000);
});
