import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addSession, parseStatsFile, readStats } from "../src/services/stats.js";

const modern = {
  DataVersion: 3955,
  stats: {
    "minecraft:custom": { "minecraft:play_time": 20 * 60 * 95, "minecraft:deaths": 3, "minecraft:walk_one_cm": 150000, "minecraft:sprint_one_cm": 50000, "minecraft:mob_kills": 12, "minecraft:jump": 400 },
    "minecraft:mined": { "minecraft:stone": 300, "minecraft:dirt": 40, "minecraft:diamond_ore": 2 },
    "minecraft:killed": { "minecraft:zombie": 7, "minecraft:creeper": 5 },
    "minecraft:killed_by": { "minecraft:skeleton": 2, "minecraft:lava": 1 },
  },
};

describe("player stats", () => {
  it("reads the 1.13+ stats format", () => {
    const p = parseStatsFile(modern, "u1", "2026-10-21T00:00:00Z");
    expect(p).toMatchObject({ playMinutes: 95, deaths: 3, mined: 342, walkedKm: 2, mobKills: 12, jumps: 400 });
    expect(p.topMined[0]).toEqual({ id: "minecraft:stone", n: 300 });
    expect(p.killedBy.map((k) => k.id)).toEqual(["minecraft:skeleton", "minecraft:lava"]);
  });

  it("reads the old 1.12 format and the play_one_minute name", () => {
    const old = parseStatsFile({ "stat.playOneMinute": 20 * 60 * 10, "stat.deaths": 1, "stat.mineBlock.minecraft.stone": 5, "stat.walkOneCm": 100000 }, "u2", "");
    expect(old).toMatchObject({ playMinutes: 10, deaths: 1, mined: 5, walkedKm: 1 });
    expect(parseStatsFile({ stats: { "minecraft:custom": { "minecraft:play_one_minute": 20 * 60 * 30 } } }, "u3", "").playMinutes).toBe(30);
  });

  it("finds the world from server.properties and names from usercache.json", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-stats-"));
    await fsp.writeFile(path.join(dir, "server.properties"), "level-name=survival\n");
    await fsp.mkdir(path.join(dir, "survival", "stats"), { recursive: true });
    await fsp.writeFile(path.join(dir, "survival", "stats", "069a79f4-44e9-4726-a5be-fca90e38aaf5.json"), JSON.stringify(modern));
    await fsp.writeFile(path.join(dir, "survival", "stats", "broken.json"), "{");
    await fsp.writeFile(path.join(dir, "usercache.json"), JSON.stringify([{ name: "Notch", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" }]));
    const r = await readStats("nope", dir);
    expect(r.world).toBe("survival");
    expect(r.players.map((p) => p.name)).toEqual(["Notch"]);
    expect(r.savedAt).toBeTruthy();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("splits play sessions across midnight", () => {
    const from = new Date(2026, 9, 21, 23, 30).getTime();
    const to = new Date(2026, 9, 22, 0, 45).getTime();
    const days = addSession({}, "Alex", from, to);
    expect(days["2026-10-21"].Alex).toBe(30);
    expect(days["2026-10-22"].Alex).toBe(45);
  });
});
