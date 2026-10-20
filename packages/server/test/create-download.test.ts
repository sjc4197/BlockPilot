import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { downloadFile, fetchJson } from "../src/services/create/download.js";
import { CreateError } from "../src/services/create/errors.js";

const BODY = Buffer.alloc(256 * 1024, 7);
const SHA256 = createHash("sha256").update(BODY).digest("hex");
const JSON_BODY = Buffer.from(JSON.stringify({ hello: "world" }));
const JSON_SHA1 = createHash("sha1").update(JSON_BODY).digest("hex");

let server: http.Server;
let base: string;
let dir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/file") {
      res.writeHead(200, { "content-length": BODY.length });
      res.end(BODY);
    } else if (req.url === "/slow") {
      res.writeHead(200, { "content-length": BODY.length });
      res.write(BODY.subarray(0, 1024)); // 나머지는 보내지 않음
    } else if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON_BODY);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-dl-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fsp.rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

describe("downloadFile", () => {
  it("keeps the file only when the hash matches, and reports progress", async () => {
    const dest = path.join(dir, "ok.bin");
    let last = 0;
    const r = await downloadFile({ url: `${base}/file`, dest, hash: { algo: "sha256", expected: SHA256 }, onProgress: (d) => (last = d) });
    expect(r.bytes).toBe(BODY.length);
    expect(last).toBe(BODY.length);
    expect((await fsp.readFile(dest)).equals(BODY)).toBe(true);
    expect(await exists(dest + ".part")).toBe(false);
  });

  it("rejects a hash mismatch and leaves nothing behind", async () => {
    const dest = path.join(dir, "bad.bin");
    const err = await downloadFile({ url: `${base}/file`, dest, hash: { algo: "sha256", expected: "0".repeat(64) } }).catch((e) => e);
    expect(err).toBeInstanceOf(CreateError);
    expect(err.code).toBe("hash_mismatch");
    expect(err.message).toMatch(/공식 해시와 달라요/);
    expect(await exists(dest)).toBe(false);
    expect(await exists(dest + ".part")).toBe(false);
  });

  it("does not retry a 404", async () => {
    const err = await downloadFile({ url: `${base}/missing`, dest: path.join(dir, "x.bin"), hash: { algo: "sha1", expected: "0" } }).catch((e) => e);
    expect(err.code).toBe("not_found");
  });

  it("turns a stalled transfer into a network error and cleans up", async () => {
    const dest = path.join(dir, "slow.bin");
    const err = await downloadFile({ url: `${base}/slow`, dest, hash: { algo: "sha256", expected: SHA256 }, idleTimeoutMs: 200, retries: 0 }).catch((e) => e);
    expect(err.code).toBe("network");
    expect(await exists(dest + ".part")).toBe(false);
  });

  it("stops when cancelled", async () => {
    const ctrl = new AbortController();
    const dest = path.join(dir, "cancel.bin");
    const p = downloadFile({ url: `${base}/slow`, dest, hash: { algo: "sha256", expected: SHA256 }, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    const err = await p.catch((e) => e);
    expect(err.code).toBe("cancelled");
    expect(await exists(dest + ".part")).toBe(false);
  });
});

describe("fetchJson", () => {
  it("verifies sha1 of the raw bytes", async () => {
    expect(await fetchJson(`${base}/json`, { sha1: JSON_SHA1 })).toEqual({ hello: "world" });
    const err = (await fetchJson(`${base}/json`, { sha1: "f".repeat(40) }).catch((e) => e)) as CreateError;
    expect(err.code).toBe("hash_mismatch");
  });

  it("maps a refused connection to a Korean network error", async () => {
    const err = (await fetchJson("http://127.0.0.1:1/nothing", { retries: 0 }).catch((e) => e)) as CreateError;
    expect(err.code).toBe("network");
    expect(err.hint).toMatch(/인터넷 연결/);
  });
});
