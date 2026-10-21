import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { applyUpdates, findUpdates, install, search } from "../src/services/modrinth.js";

/** 가짜 Modrinth: A(서버 모드) → B(필수 의존), C(클라이언트 전용), BAD(해시가 틀린 파일) */
const jar = (s: string) => Buffer.from(`PK-fake-jar-${s}`);
const h = (b: Buffer, a: string) => createHash(a).update(b).digest("hex");
const FILES: Record<string, Buffer> = { "a-1.0.jar": jar("a1"), "b-1.0.jar": jar("b1"), "b-1.1.jar": jar("b11"), "c-1.0.jar": jar("c1"), "bad-1.0.jar": jar("bad") };
let base = "";
let server: http.Server;
const ver = (id: string, pid: string, file: string, deps: string[] = [], badHash = false) => ({
  id,
  project_id: pid,
  version_number: file.replace(/^\w+-|\.jar$/g, ""),
  version_type: "release",
  loaders: ["fabric"],
  game_versions: ["1.21.1"],
  files: [{ url: `${base}/files/${file}`, filename: file, primary: true, size: FILES[file].length, hashes: { sha1: h(FILES[file], "sha1"), sha512: badHash ? "0".repeat(128) : h(FILES[file], "sha512") } }],
  dependencies: deps.map((d) => ({ project_id: d, dependency_type: "required" })),
});
const PROJECTS: Record<string, any> = {
  A: { id: "A", title: "Mod A", server_side: "required", client_side: "optional" },
  B: { id: "B", title: "Lib B", server_side: "required", client_side: "required" },
  C: { id: "C", title: "Client C", server_side: "unsupported", client_side: "required" },
  BAD: { id: "BAD", title: "Bad", server_side: "required", client_side: "optional" },
};
const VERSIONS = () => ({ A: [ver("va1", "A", "a-1.0.jar", ["B"])], B: [ver("vb11", "B", "b-1.1.jar"), ver("vb1", "B", "b-1.0.jar")], C: [ver("vc1", "C", "c-1.0.jar")], BAD: [ver("vbad", "BAD", "bad-1.0.jar", [], true)] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url!, base);
      const send = (o: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (u.pathname.startsWith("/files/")) return res.end(FILES[u.pathname.slice(7)]);
      if (u.pathname === "/search") return send({ total_hits: 1, hits: [{ project_id: "A", slug: "a", title: "Mod A", description: "d", author: "x", downloads: 5, server_side: "required", client_side: "optional" }] });
      let m = u.pathname.match(/^\/project\/(\w+)\/version$/);
      if (m) return send((VERSIONS() as any)[m[1]]);
      m = u.pathname.match(/^\/project\/(\w+)$/);
      if (m) return send(PROJECTS[m[1]]);
      m = u.pathname.match(/^\/version\/(\w+)$/);
      if (m) return send(Object.values(VERSIONS()).flat().find((v) => v.id === m![1]));
      if (u.pathname === "/projects") return send(Object.values(PROJECTS));
      const all = Object.values(VERSIONS()).flat();
      const bySha = (s: string) => all.find((v) => v.files[0].hashes.sha1 === s);
      if (u.pathname === "/version_files") return send(Object.fromEntries((JSON.parse(body).hashes as string[]).filter(bySha).map((s) => [s, bySha(s)])));
      if (u.pathname === "/version_files/update") return send(Object.fromEntries((JSON.parse(body).hashes as string[]).filter(bySha).map((s) => [s, (VERSIONS() as any)[bySha(s)!.project_id][0]])));
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BLOCKPILOT_MODRINTH_URL = base;
});
afterAll(() => {
  server.close();
  delete process.env.BLOCKPILOT_MODRINTH_URL;
});

async function serverDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-mr-"));
  await fsp.mkdir(path.join(dir, "mods"));
  return { dir, loader: "fabric", mcVersion: "1.21.1" };
}

describe("modrinth", () => {
  it("does not offer Modrinth for vanilla servers", async () => {
    expect((await search({ dir: "/nope", loader: "vanilla", mcVersion: "1.21.1" }, "x")).supported).toBe(false);
  });

  it("installs a mod with its required dependency, verifies sha512, and skips what is already there", async () => {
    const t = await serverDir();
    const r = await install(t, "A");
    expect(r.installed.map((i) => [i.file, i.dependency])).toEqual([
      ["a-1.0.jar", false],
      ["b-1.1.jar", true],
    ]);
    expect((await fsp.readdir(path.join(t.dir, "mods"))).sort()).toEqual(["a-1.0.jar", "b-1.1.jar"]);
    const again = await install(t, "A");
    expect(again.installed).toEqual([]);
    expect(again.skipped[0].reason).toContain("이미");
    expect((await search(t, "a")).hits[0].installed).toBe(true);
  });

  it("refuses client-only mods unless confirmed, and leaves nothing behind on a bad hash", async () => {
    const t = await serverDir();
    await expect(install(t, "C")).rejects.toThrow(/클라이언트 전용/);
    expect((await install(t, "C", { allowClientOnly: true })).installed[0].file).toBe("c-1.0.jar");
    await expect(install(t, "BAD")).rejects.toThrow();
    expect(await fsp.readdir(path.join(t.dir, "mods"))).toEqual(["c-1.0.jar"]);
  });

  it("finds updates and replaces the jar, keeping the old one and the disabled state", async () => {
    const t = await serverDir();
    await fsp.writeFile(path.join(t.dir, "mods", "b-1.0.jar.disabled"), FILES["b-1.0.jar"]);
    const ups = await findUpdates(t);
    expect(ups).toMatchObject([{ file: "b-1.0.jar.disabled", title: "Lib B", current: "1.0", latest: "1.1" }]);
    const r = await applyUpdates(t, ["b-1.0.jar.disabled"]);
    expect(r.updated).toEqual([{ file: "b-1.0.jar.disabled", to: "b-1.1.jar.disabled" }]);
    expect(await fsp.readdir(path.join(t.dir, "mods"))).toEqual(["b-1.1.jar.disabled"]);
    expect(await fsp.readdir(path.join(t.dir, r.backupDir))).toEqual(["b-1.0.jar.disabled"]);
    expect(await findUpdates(t)).toEqual([]);
  });
});
