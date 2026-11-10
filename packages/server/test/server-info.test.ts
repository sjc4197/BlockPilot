import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectServer } from "../src/services/serverInfo.js";

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
