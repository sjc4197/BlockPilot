import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EULA_HEADER, acceptEula, readEula } from "../src/services/eula.js";

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-eula-"));
});
afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

const read = () => fsp.readFile(path.join(dir, "eula.txt"), "utf8");

describe("readEula", () => {
  it("reports a missing file", async () => {
    expect(await readEula(dir)).toEqual({ exists: false, accepted: false });
  });
  it("reports eula=false as present but not accepted", async () => {
    await fsp.writeFile(path.join(dir, "eula.txt"), "#comment\neula=false\n");
    expect(await readEula(dir)).toEqual({ exists: true, accepted: false });
  });
  it("accepts eula=TRUE regardless of case and spacing", async () => {
    await fsp.writeFile(path.join(dir, "eula.txt"), "eula = TRUE\n");
    expect(await readEula(dir)).toEqual({ exists: true, accepted: true });
  });
});

describe("acceptEula", () => {
  it("creates eula.txt with the Mojang header when missing", async () => {
    await acceptEula(dir);
    const body = await read();
    expect(body.startsWith(EULA_HEADER + "\n")).toBe(true);
    expect(body).toMatch(/^eula=true$/m);
    expect(body.endsWith("\n")).toBe(true);
    expect(await readEula(dir)).toEqual({ exists: true, accepted: true });
  });

  it("flips eula=false to true while keeping comments and other lines", async () => {
    const before = ["#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).", "#Mon Jan 01 00:00:00 KST 2024", "eula=false", ""].join("\n");
    await fsp.writeFile(path.join(dir, "eula.txt"), before);
    await acceptEula(dir);
    expect(await read()).toBe(before.replace("eula=false", "eula=true"));
    expect(await readEula(dir)).toEqual({ exists: true, accepted: true });
  });

  it("keeps CRLF line endings and appends eula=true when the key is absent", async () => {
    await fsp.writeFile(path.join(dir, "eula.txt"), "#only a comment\r\n");
    await acceptEula(dir);
    expect(await read()).toBe("#only a comment\r\neula=true\r\n");
  });

  it("is idempotent, leaves no temp file behind, and does not pile up backups when already accepted", async () => {
    await acceptEula(dir);
    const first = await read();
    await acceptEula(dir);
    expect(await read()).toBe(first);
    const names = (await fsp.readdir(dir)).filter((n) => !n.startsWith("."));
    expect(names).toEqual(["eula.txt"]);
    // 새로 만든 파일이라 백업 사본이 없고, 이미 동의된 상태로 다시 불러도 생기지 않는다
    expect(await fsp.readdir(path.join(dir, ".blockpilot-backup")).catch(() => [])).toEqual([]);
  });

  it("backs up eula=false once when flipping, then writes nothing on later calls", async () => {
    const backups = () => fsp.readdir(path.join(dir, ".blockpilot-backup")).catch(() => [] as string[]);
    await fsp.writeFile(path.join(dir, "eula.txt"), "eula=false\n");
    await acceptEula(dir);
    const afterFlip = await backups();
    expect(afterFlip).toHaveLength(1);
    expect(afterFlip[0].startsWith("eula.txt.")).toBe(true);
    const body = await read();
    const mtime = (await fsp.stat(path.join(dir, "eula.txt"))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await acceptEula(dir);
    await acceptEula(dir);
    expect(await backups()).toEqual(afterFlip);
    expect(await read()).toBe(body);
    expect((await fsp.stat(path.join(dir, "eula.txt"))).mtimeMs).toBe(mtime);
  });
});
