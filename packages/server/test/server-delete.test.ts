import { describe, it, expect, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { addServer, listServers } from "../src/config/store.js";
import { getManaged } from "../src/services/process.js";
import { deleteServerFolder } from "../src/services/serverDelete.js";

const exists = (p: string) => fsp.lstat(p).then(() => true, () => false);
let root: string;
let port = 25700;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-del-"));
});

/** 마인크래프트 서버처럼 보이는 폴더 (포트는 테스트마다 다르게) */
async function fakeServer(name: string, dir = path.join(root, name)) {
  const p = port++;
  await fsp.mkdir(path.join(dir, "world", "region"), { recursive: true });
  await fsp.writeFile(path.join(dir, "server.properties"), `server-port=${p}\n`);
  await fsp.writeFile(path.join(dir, "eula.txt"), "eula=true\n");
  await fsp.writeFile(path.join(dir, "world", "level.dat"), "x");
  const server = await addServer({ path: dir, name });
  return { server, dir, port: p, managed: getManaged(server.id, server.path) };
}

const registered = async (id: string) => (await listServers()).some((s) => s.id === id);

describe("deleteServerFolder", () => {
  it("refuses when the typed name does not match, and touches nothing", async () => {
    const { server, dir, managed } = await fakeServer("survival");
    await expect(deleteServerFolder(server, managed, "survival2")).rejects.toThrow(/확인용 이름이 달라요/);
    expect(await exists(path.join(dir, "world", "level.dat"))).toBe(true);
    expect(await registered(server.id)).toBe(true);
  });

  it("deletes the whole folder and removes it from the list", async () => {
    const { server, dir, managed } = await fakeServer("to-delete");
    const r = await deleteServerFolder(server, managed, "to-delete");
    expect(r.deletedPath).toBe(await fsp.realpath(root).then((rr) => path.join(rr, "to-delete")));
    expect(await exists(dir)).toBe(false);
    expect(await registered(server.id)).toBe(false);
  });

  it("follows a symlinked registration: deletes the real folder and the link", async () => {
    const realDir = path.join(root, "real-server");
    const { server: tmp } = await fakeServer("real-only", realDir);
    // 실제 폴더 대신 링크 경로로 다시 등록
    const link = path.join(root, "link-to-server");
    await fsp.symlink(realDir, link);
    const { removeServer } = await import("../src/config/store.js");
    await removeServer(tmp.id);
    const server = await addServer({ path: link, name: "linked" });
    const r = await deleteServerFolder(server, getManaged(server.id, server.path), "linked");
    expect(await exists(realDir)).toBe(false);
    expect(await exists(link)).toBe(false);
    expect(r.removedLink).toBe(link);
  });

  it("refuses when another registered server lives inside the folder", async () => {
    const outer = await fakeServer("outer");
    await fakeServer("inner", path.join(outer.dir, "inner"));
    await expect(deleteServerFolder(outer.server, outer.managed, "outer")).rejects.toThrow(/다른 등록된 서버 'inner'/);
    expect(await exists(path.join(outer.dir, "world"))).toBe(true);
  });

  it("refuses when the folder no longer looks like a Minecraft server", async () => {
    const { server, dir, managed } = await fakeServer("changed");
    await fsp.rm(dir, { recursive: true });
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, "important.docx"), "x");
    await expect(deleteServerFolder(server, managed, "changed")).rejects.toThrow(/마인크래프트 서버 폴더로 보이지 않습니다/);
    expect(await exists(path.join(dir, "important.docx"))).toBe(true);
  });

  it("refuses while the server is running (even if started outside BlockPilot)", async () => {
    const { server, dir, managed, port: p } = await fakeServer("running");
    const fake = net.createServer().listen(p, "127.0.0.1");
    await new Promise((r) => fake.once("listening", r));
    try {
      await expect(deleteServerFolder(server, managed, "running")).rejects.toThrow(/서버가 켜져 있어요/);
      expect(await exists(dir)).toBe(true);
    } finally {
      fake.close();
    }
  });
});
