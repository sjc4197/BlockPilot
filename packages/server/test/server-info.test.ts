import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __clearPinnedJavaCacheForTests, detectServer, getServerJavaVersion } from "../src/services/serverInfo.js";
import { platform } from "../src/services/platform/index.js";

// java -version 을 실제로 띄우지 않고 몇 번 불렸는지만 센다
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), execFile: execFileMock }));

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-detect-"));
});
afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

const mk = async (...rel: string[]) => {
  for (const r of rel) {
    const p = path.join(dir, ...r.split("/"));
    if (r.endsWith("/")) await fsp.mkdir(p, { recursive: true });
    else {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, "");
    }
  }
};

describe("detectServer", () => {
  it("recognises a Paper server even though Paper keeps net.neoforged tooling in libraries/", async () => {
    await mk("paper-1.21.1-133.jar", "libraries/net/neoforged/AutoRenamingTool/2.0.3/", "libraries/com/mojang/", "plugins/");
    const d = await detectServer(dir);
    expect(d.loader).toBe("paper");
    expect(d.mcVersion).toBe("1.21.1");
    expect(d.loaderVersion).toBe("133");
    expect(d.launchJar).toBe("paper-1.21.1-133.jar");
  });

  it("recognises NeoForge by its own library folder and derives the Minecraft version", async () => {
    await mk("libraries/net/neoforged/neoforge/21.1.265/unix_args.txt", "libraries/net/neoforged/neoforge/21.1.9/unix_args.txt", "run.sh");
    const d = await detectServer(dir);
    expect(d.loader).toBe("neoforge");
    expect(d.loaderVersion).toBe("21.1.265");
    expect(d.mcVersion).toBe("1.21.1");
  });

  it("recognises Forge and picks the highest version numerically", async () => {
    await mk("libraries/net/minecraftforge/forge/1.21.1-52.0.9/unix_args.txt", "libraries/net/minecraftforge/forge/1.21.1-52.0.10/unix_args.txt");
    const d = await detectServer(dir);
    expect(d.loader).toBe("forge");
    expect(d.loaderVersion).toBe("1.21.1-52.0.10");
    expect(d.mcVersion).toBe("1.21.1");
  });

  it("recognises Fabric and vanilla", async () => {
    await mk("fabric-server-launch.jar", "server.jar", "versions/1.21.1/server-1.21.1.jar", "libraries/net/fabricmc/fabric-loader/0.16.9/", "libraries/net/fabricmc/fabric-loader/0.16.10/");
    const f = await detectServer(dir);
    expect(f).toMatchObject({ loader: "fabric", mcVersion: "1.21.1", loaderVersion: "0.16.10", launchJar: "fabric-server-launch.jar" });
    await fsp.rm(path.join(dir, "fabric-server-launch.jar"));
    await fsp.rm(path.join(dir, "libraries"), { recursive: true });
    await fsp.rm(path.join(dir, "versions"), { recursive: true });
    const v = await detectServer(dir);
    expect(v).toMatchObject({ loader: "vanilla", launchJar: "server.jar" });
  });
});

describe("getServerJavaVersion", () => {
  const javaPath = process.platform === "win32" ? "C:\\jdk\\bin\\java.exe" : "/opt/jdk-21/bin/java";
  const script = process.platform === "win32" ? `"${javaPath}" -jar server.jar nogui\r\n` : `#!/bin/sh\nexec "${javaPath}" -jar server.jar nogui\n`;

  beforeEach(() => {
    __clearPinnedJavaCacheForTests();
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file: string, _args: string[], optsOrCb: unknown, cb?: (e: null, o: string, s: string) => void) => {
      const done = typeof optsOrCb === "function" ? (optsOrCb as typeof cb)! : cb!;
      done(null, "", 'openjdk version "21.0.4" 2024-07-16\n');
    });
  });

  it("spawns the pinned java once and serves later polls from cache", async () => {
    await fsp.writeFile(path.join(dir, platform.startScripts[0]), script);
    expect(await getServerJavaVersion(dir)).toBe("21.0.4");
    expect(await getServerJavaVersion(dir)).toBe("21.0.4");
    expect(await getServerJavaVersion(dir)).toBe("21.0.4");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe(javaPath);
  });

  it("asks again when the start script changes (mtime) and remembers a failed lookup too", async () => {
    const file = path.join(dir, platform.startScripts[0]);
    await fsp.writeFile(file, script);
    await fsp.utimes(file, new Date("2024-01-01"), new Date("2024-01-01"));
    expect(await getServerJavaVersion(dir)).toBe("21.0.4");
    await fsp.utimes(file, new Date("2024-06-01"), new Date("2024-06-01"));
    expect(await getServerJavaVersion(dir)).toBe("21.0.4");
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // 고정 java 가 없어졌다: 실패도 기억해서 시스템 java 로 떨어지되 매번 다시 띄우지 않는다
    __clearPinnedJavaCacheForTests();
    execFileMock.mockImplementation((file: string, _args: string[], optsOrCb: unknown, cb?: (e: Error | null, o: string, s: string) => void) => {
      const done = typeof optsOrCb === "function" ? (optsOrCb as typeof cb)! : cb!;
      if (file === javaPath) done(new Error("ENOENT"), "", "");
      else done(null, "", 'openjdk version "17.0.2"\n');
    });
    execFileMock.mockClear();
    await getServerJavaVersion(dir);
    await getServerJavaVersion(dir);
    const pinnedCalls = execFileMock.mock.calls.filter((c) => c[0] === javaPath);
    expect(pinnedCalls).toHaveLength(1);
  });
});
