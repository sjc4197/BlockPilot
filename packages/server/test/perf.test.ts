import { describe, it, expect, afterEach } from "vitest";
import { parseLag, parseXmx } from "../src/services/perf.js";
import { parsePs, sumTree, treeMemoryMb } from "../src/services/procmem.js";
import { getManaged, forgetManaged } from "../src/services/process.js";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";

describe("perf parsing", () => {
  it("reads lag warnings and -Xmx", () => {
    expect(parseLag("[12:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2034ms or 40 ticks behind")).toBe(2034);
    expect(parseLag("Done (1.2s)!")).toBeNull();
    expect(parseXmx('exec "/x/java" -Xms2048M -Xmx4096M -jar a.jar')).toBe(4096);
    expect(parseXmx("java -Xmx6G -jar a.jar")).toBe(6144);
    expect(parseXmx("java -jar a.jar")).toBeUndefined();
  });

  it("sums memory of the start script and everything it started", () => {
    const rows = parsePs("  1   0  100\n 10   1   50\n 11  10  4000\n 12  11  300\n 20   1  999\n");
    expect(sumTree(rows, 10)).toBe(4350);
    expect(sumTree(rows, 99)).toBeNull();
  });
});

describe("live probes", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  async function start(answer: string) {
    const fake = await makeFakeServer(`log('Done (1.0s)! For help, type "help"'); onCommand((c) => { if (c === "tick query") { ${answer} } });`);
    const id = `perf-${Math.random().toString(36).slice(2, 8)}`;
    const m = getManaged(id, fake.dir);
    cleanups.push(async () => {
      if (m.isManaged()) await m.stop().catch(() => {});
      forgetManaged(id);
      await fake.cleanup();
    });
    await m.start();
    await waitFor(async () => (await m.status()).state === "running", 10_000, "켜짐");
    return m;
  }

  it("measures tick time with /tick query and hides the answer from the console", async () => {
    const m = await start(`log("The game is running normally"); log("Target tick rate: 20.0 per second."); log("Average time per tick: 12.3ms (Target: 50.0ms)"); log("Percentiles: P50: 11.0ms P95: 20.1ms P99: 31.0ms, sample: 100");`);
    expect(await m.probeTick()).toBe(12.3);
    await new Promise((r) => setTimeout(r, 200));
    expect(m.getHistory().some((l) => /tick|Percentiles|running normally/.test(l.text))).toBe(false);
  }, 20_000);

  it("knows when the version has no /tick", async () => {
    const m = await start(`log("Unknown or incomplete command, see below for error"); log("tick query<--[HERE]");`);
    expect(await m.probeTick()).toBe("unsupported");
  }, 20_000);

  it("measures memory of the running server process on this OS", async () => {
    const m = await start("");
    const mb = await treeMemoryMb(m.childPid()!);
    expect(mb).not.toBeNull();
    expect(mb!).toBeGreaterThan(5);
  }, 30_000);
});
