import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { getModpackVersionFile, listModpackVersions, searchModpacks } from "../src/services/modrinthModpack.js";
import { modpackRoutes } from "../src/routes/modpack.js";

/** 가짜 Modrinth: 모드팩 검색·버전 */
let base = "";
let server: http.Server;
const seen: URL[] = [];
const file = (name: string, primary = true) => ({ url: `https://cdn.modrinth.com/data/P/${name}`, filename: name, primary, size: 123, hashes: { sha1: "1".repeat(40), sha512: "5".repeat(128) } });
const v = (id: string, loaders: string[], games: string[], files: any[], date: string, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: "PACK",
  name: `Pack ${id}`,
  version_number: id,
  version_type: "release",
  loaders,
  game_versions: games,
  date_published: date,
  files,
  dependencies: [],
  ...extra,
});
const VERSIONS = [
  v("fab1", ["fabric"], ["1.21.1"], [file("pack-fab1.mrpack")], "2024-05-01T00:00:00Z"),
  v("fab2", ["fabric"], ["1.21.4"], [file("extra.zip", true), file("pack-fab2.mrpack", false)], "2024-09-01T00:00:00Z", { version_type: "beta" }),
  v("nomr", ["fabric"], ["1.21.1"], [file("pack.zip")], "2024-10-01T00:00:00Z"),
  v("quilt", ["quilt"], ["1.21.1"], [file("pack-quilt.mrpack")], "2024-10-02T00:00:00Z"),
  v("oldforge", ["forge"], ["1.16.5"], [file("pack-old.mrpack")], "2024-10-03T00:00:00Z"),
  v("forge", ["forge"], ["1.20.1"], [file("pack-forge.mrpack")], "2024-08-01T00:00:00Z"),
  v("neoold", ["neoforge"], ["1.20.1"], [file("pack-neo-old.mrpack")], "2024-10-04T00:00:00Z"),
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, base);
    seen.push(u);
    const send = (o: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    if (u.pathname === "/search")
      return send({
        total_hits: 2,
        hits: [
          { project_id: "PACK", slug: "pack", title: "Pack", description: "d", author: "me", downloads: 42, icon_url: "https://cdn.modrinth.com/i.png", categories: ["fabric", "quilt", "adventure"], display_categories: ["forge"], versions: ["1.20.1", "1.21.10", "1.21.4", "1.21.1", "1.19.2", "1.18.2", "1.20.4", "1.21", "1.19.4", "1.16.5"] },
          { project_id: "NOICON", slug: "noicon", title: "No Icon", description: "", author: "x", downloads: 1, icon_url: "", categories: ["neoforge"], versions: [] },
        ],
      });
    if (u.pathname === "/project/PACK/version") return send(VERSIONS);
    const m = u.pathname.match(/^\/version\/(\w+)$/);
    if (m) {
      const found = VERSIONS.find((x) => x.id === m[1]);
      return found ? send(found) : (res.writeHead(404), res.end());
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BLOCKPILOT_MODRINTH_URL = base;
});
afterAll(() => {
  server.close();
  delete process.env.BLOCKPILOT_MODRINTH_URL;
});

describe("searchModpacks", () => {
  it("asks only for modpacks of supported loaders and maps hits", async () => {
    const r = await searchModpacks("", 20);
    const u = seen.filter((x) => x.pathname === "/search").at(-1)!;
    const facets = JSON.parse(u.searchParams.get("facets")!);
    expect(facets).toEqual([["project_type:modpack"], ["categories:fabric", "categories:forge", "categories:neoforge"]]);
    expect(u.searchParams.get("index")).toBe("downloads");
    expect(u.searchParams.get("offset")).toBe("20");
    expect(r.total).toBe(2);
    expect(r.hits[0]).toMatchObject({ projectId: "PACK", slug: "pack", author: "me", downloads: 42, iconUrl: "https://cdn.modrinth.com/i.png", loaders: ["fabric", "forge"] });
    expect(r.hits[0].gameVersions).toEqual(["1.21.10", "1.21.4", "1.21.1", "1.21", "1.20.4", "1.20.1", "1.19.4", "1.19.2"]);
    expect(r.hits[1]).toMatchObject({ iconUrl: undefined, loaders: ["neoforge"], gameVersions: [] });
    await searchModpacks("create");
    expect(seen.filter((x) => x.pathname === "/search").at(-1)!.searchParams.get("index")).toBe("relevance");
  });
});

describe("listModpackVersions", () => {
  it("keeps versions with a .mrpack, a supported loader and an MC version above the loader floor, newest first", async () => {
    const list = await listModpackVersions("PACK");
    const u = seen.filter((x) => x.pathname === "/project/PACK/version").at(-1)!;
    expect(JSON.parse(u.searchParams.get("loaders")!)).toEqual(["fabric", "forge", "neoforge"]);
    expect(list.map((x) => x.id)).toEqual(["fab2", "forge", "fab1"]);
    expect(list[0]).toMatchObject({
      name: "Pack fab2",
      versionType: "beta",
      loaders: ["fabric"],
      gameVersions: ["1.21.4"],
      file: { filename: "pack-fab2.mrpack", url: "https://cdn.modrinth.com/data/P/pack-fab2.mrpack", size: 123, sha512: "5".repeat(128) },
    });
  });

  it("rejects malformed project ids", async () => {
    await expect(listModpackVersions("../x")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("getModpackVersionFile", () => {
  it("returns the .mrpack file of a version and 404s when there is none", async () => {
    expect((await getModpackVersionFile("fab1")).file.filename).toBe("pack-fab1.mrpack");
    await expect(getModpackVersionFile("nomr")).rejects.toMatchObject({ statusCode: 404, code: "no_mrpack" });
    await expect(getModpackVersionFile("a/b")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("modpack routes", () => {
  it("serves search and versions, validating the project", async () => {
    const app = Fastify();
    await app.register(modpackRoutes);
    const s = await app.inject({ url: "/api/create/modpack/search?q=pack&offset=abc" });
    expect(s.statusCode).toBe(200);
    expect(s.json().hits).toHaveLength(2);
    expect((await app.inject({ url: "/api/create/modpack/versions?project=PACK" })).json()).toHaveLength(3);
    expect((await app.inject({ url: "/api/create/modpack/versions?project=a%2Fb" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/create/modpack/versions" })).statusCode).toBe(400);
    await app.close();
  });
});
