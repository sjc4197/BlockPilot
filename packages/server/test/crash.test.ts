import { describe, it, expect, afterEach } from "vitest";
import type { ModInfo, ServerEvent } from "@blockpilot/shared";
import { DEFAULT_AUTOMATION } from "@blockpilot/shared";
import { explainCrash } from "../src/services/crash.js";
import { addServer, setAutomation, removeServer } from "../src/config/store.js";
import { onServerEvent } from "../src/services/events.js";
import { getManaged, forgetManaged } from "../src/services/process.js";
import { MAX_ATTEMPTS, setAutoRestartSecond, startAutoRestart } from "../src/services/autoRestart.js";
import { automationRuntime } from "../src/services/automationState.js";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";

const mod = (id: string, name: string, file: string): ModInfo => ({ id, name, file, enabled: true, sizeBytes: 1, loader: "fabric", authors: [], depends: [], missingDeps: [] });
const MODS = [mod("naturalist", "Naturalist", "naturalist-2.0.5-fabric-1.21.1.jar"), mod("t_and_t", "Towns and Towers", "t_and_t-fabric-neoforge-1.13.11.jar"), mod("fabric-api", "Fabric API", "fabric-api-0.116.15+1.21.1.jar")];

describe("crash explanation", () => {
  it("reads Fabric's incompatible-mods error (Korean) and names the missing mod", () => {
    const text = [
      "[main/WARN]: Mod resolution failed",
      "[main/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE t_and_t 1.13.11 {depends cristellib @ [>=3.1.7]}, ROOT_FORCELOAD_SINGLE t_and_t 1.13.11]",
      "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
      "\t - 모드 'Towns and Towers' (t_and_t)(1.13.11 버전)은 cristellib(3.1.7 이상의 버전)이 필요하지만, 해당 모드가 빠져 있습니다!",
    ].join("\n");
    const r = explainCrash(text, MODS);
    expect(r.kind).toBe("incompatible");
    expect(r.title).toContain("Towns and Towers");
    expect(r.hint).toContain("cristellib");
    expect(r.suspects.map((s) => s.name)).toEqual(["Towns and Towers"]);
  });

  it("recognises memory, port and Java problems", () => {
    expect(explainCrash("java.lang.OutOfMemoryError: Java heap space", MODS).kind).toBe("memory");
    expect(explainCrash("**** FAILED TO BIND TO PORT!", MODS).kind).toBe("port");
    expect(explainCrash("java.lang.UnsupportedClassVersionError: net/minecraft/server/Main has been compiled by a more recent version of the Java Runtime", MODS).kind).toBe("java");
  });

  it("guesses the mod that shows up most in the stack trace, but not Fabric itself", () => {
    const text = [
      "java.lang.NullPointerException: Cannot invoke \"Object.hashCode()\"",
      "\tat net.minecraft.class_1297.handler$zzb000$naturalist$onTick(class_1297.java:1234) ~[server-intermediary.jar:?]",
      "\tat com.starfish_studios.naturalist.common.entity.Bear.tick(Bear.java:88) ~[naturalist-2.0.5-fabric-1.21.1.jar:?]",
      "\tat net.fabricmc.fabric.impl.event.lifecycle.LifecycleEventsImpl ~[fabric-lifecycle-events-v1-2.3.12.jar:?]",
    ].join("\n");
    const r = explainCrash(text, MODS);
    expect(r.kind).toBe("mod");
    expect(r.suspects[0].name).toBe("Naturalist");
    expect(r.title).toContain("추정");
  });

  it("says it does not know when nothing matches", () => {
    expect(explainCrash("something went wrong", MODS).kind).toBe("unknown");
  });
});

describe("auto restart", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it(`restarts a crashing server, then gives up after ${MAX_ATTEMPTS} times in 10 minutes`, async () => {
    setAutoRestartSecond(10); // 5초 → 50ms
    startAutoRestart();
    const fake = await makeFakeServer(`log('Done (1.0s)! For help, type "help"'); setTimeout(() => { console.error("java.lang.OutOfMemoryError: Java heap space"); quit(1); }, 120);`);
    const s = await addServer({ path: fake.dir, name: "crashy" });
    await setAutomation(s.id, { ...DEFAULT_AUTOMATION, autoRestart: { enabled: true, delaySeconds: 5 } });
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
    await waitFor(() => events.some((e) => e.type === "auto-restart-failed"), 20_000, "자동 재시작 포기");
    const t = events.map((e) => e.type).filter((x) => x !== "started");
    expect(t).toEqual(["crashed", "auto-restart", "crashed", "auto-restart", "crashed", "auto-restart", "crashed", "auto-restart-failed"]);
    expect(events.find((e) => e.type === "crashed")?.crash?.kind).toBe("memory");
    expect(automationRuntime(s.id)).toMatchObject({ gaveUp: true, recentAttempts: MAX_ATTEMPTS });
    await new Promise((r) => setTimeout(r, 300));
    expect(managed.isManaged()).toBe(false);
  }, 30_000);
});
