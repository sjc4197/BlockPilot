import { describe, it, expect, afterEach } from "vitest";
import type { ServerEvent } from "@blockpilot/shared";
import { getManaged, forgetManaged } from "../src/services/process.js";
import { onServerEvent } from "../src/services/events.js";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function run(script: string) {
  const fake = await makeFakeServer(script);
  const id = `ev-${Math.random().toString(36).slice(2, 8)}`;
  const events: ServerEvent[] = [];
  const off = onServerEvent((e) => e.serverId === id && events.push(e));
  const managed = getManaged(id, fake.dir);
  cleanups.push(async () => {
    off();
    if (managed.isManaged()) await managed.stop().catch(() => {});
    forgetManaged(id);
    await fake.cleanup();
  });
  await managed.start();
  return { managed, events, types: () => events.map((e) => e.type) };
}

describe("server events", () => {
  it("reports started, joined, left and a crash when the server dies on its own", async () => {
    const { types, events } = await run(`log('Done (1.0s)! For help, type "help"'); setTimeout(() => log("Alex joined the game"), 100); setTimeout(() => log("Alex left the game"), 200); setTimeout(() => quit(1), 300);`);
    await waitFor(() => types().includes("crashed"), 10_000, "크래시 사건");
    expect(types()).toEqual(["started", "joined", "left", "crashed"]);
    expect(events[1]).toMatchObject({ player: "Alex", online: 1 });
    expect(events[2]).toMatchObject({ player: "Alex", online: 0 });
  }, 15_000);

  it("a stop from BlockPilot is a normal stop, not a crash", async () => {
    const { managed, types } = await run(`log('Done (1.0s)! For help, type "help"');`);
    await waitFor(() => types().includes("started"), 10_000, "켜짐");
    await managed.stop();
    await waitFor(() => types().includes("stopped"), 10_000, "꺼짐 사건");
    expect(types()).toEqual(["started", "stopped"]);
  }, 15_000);

  it("/stop typed in the game is also a normal stop", async () => {
    const { types } = await run(`log('Done (1.0s)! For help, type "help"'); setTimeout(() => { log("Stopping the server"); quit(0); }, 150);`);
    await waitFor(() => types().includes("stopped") || types().includes("crashed"), 10_000, "꺼짐");
    expect(types()).toEqual(["started", "stopped"]);
  }, 15_000);
});
