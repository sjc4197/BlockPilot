import http from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { initAuth, resetAuthFailures } from "../src/lib/auth.js";
import { installSecurityHeaders } from "../src/lib/securityHeaders.js";
import { authRoutes } from "../src/routes/auth.js";

/**
 * 토큰 인증 훅(lib/auth.ts)과 보안 헤더(lib/securityHeaders.ts) 만 단 최소 Fastify 인스턴스.
 * index.ts 와 같은 순서·같은 옵션으로 (websocket 등록(handleProtocols) → initAuth → 라우트) 붙인다.
 */
const TOKEN = "s3cret/tok+en=한글"; // 서브프로토콜에 못 쓰는 글자를 일부러 섞음 (base64url 로 감싸는지)
const bearer = { authorization: `Bearer ${TOKEN}` };
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

let app: FastifyInstance;
let wsBase: string;

beforeAll(async () => {
  process.env.BLOCKPILOT_TOKEN = TOKEN;
  app = Fastify();
  installSecurityHeaders(app);
  // index.ts 와 같은 handleProtocols: 응답 Sec-WebSocket-Protocol 에는 "blockpilot" 만 (토큰이 든 서브프로토콜을 되돌려 주지 않게)
  await app.register(websocket, { options: { handleProtocols: (protocols: Set<string>) => (protocols.has("blockpilot") ? "blockpilot" : false) } });
  await initAuth(app, "127.0.0.1");
  await app.register(authRoutes); // 진짜 GET /api/auth (required / authenticated)
  app.get("/api/ping", async () => ({ pong: true }));
  app.get("/api/servers/:id/backups/:file/download", async () => "zip");
  app.get("/api/servers/:id/mods/export", async () => "zip");
  app.get("/api/servers/:id/mods/export.mrpack", async () => "mrpack");
  app.get("/", async () => "<html></html>");
  app.get("/api/servers/:id/console", { websocket: true }, (socket) => {
    socket.send("hello");
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  wsBase = address.replace(/^http/, "ws");
});

afterAll(async () => {
  await app.close();
  delete process.env.BLOCKPILOT_TOKEN;
});

afterEach(() => {
  resetAuthFailures();
  vi.useRealTimers();
});

const openWs = (path: string, protocols?: string[]) =>
  new Promise<{ protocol: string; first: string }>((resolve, reject) => {
    const ws = new WebSocket(wsBase + path, protocols);
    ws.onerror = () => reject(new Error("ws error"));
    ws.onclose = (ev) => reject(new Error(`closed ${ev.code}`));
    ws.onmessage = (ev) => {
      resolve({ protocol: ws.protocol, first: String(ev.data) });
      ws.close();
    };
  });

/** 날것의 HTTP 업그레이드 요청 — 101 응답의 Sec-WebSocket-Protocol 헤더를 그대로 본다 (WebSocket 클라이언트는 헤더를 숨기므로) */
const rawUpgrade = (path: string, protocols: string) =>
  new Promise<{ status: number; protocol: string | undefined }>((resolve, reject) => {
    const u = new URL(wsBase.replace(/^ws/, "http") + path);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-protocol": protocols },
    });
    const done = (status: number, protocol: string | undefined) => resolve({ status, protocol });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      done(res.statusCode ?? 0, res.headers["sec-websocket-protocol"]);
    });
    req.on("response", (res) => {
      res.resume();
      done(res.statusCode ?? 0, res.headers["sec-websocket-protocol"]);
    });
    req.on("error", reject);
    req.end();
  });

describe("토큰 인증", () => {
  it("Bearer 헤더로 통과, 없으면 401, /api/auth GET 과 /api 밖은 열려 있음", async () => {
    expect((await app.inject({ url: "/api/ping", headers: bearer })).statusCode).toBe(200);
    const denied = await app.inject({ url: "/api/ping" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().message).toContain("토큰");
    expect((await app.inject({ url: "/api/ping", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/auth" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/" })).statusCode).toBe(200);
  });

  it("?token= 쿼리는 일반 API 에선 더 이상 안 받고, 다운로드 링크에서만 받는다", async () => {
    const q = `token=${encodeURIComponent(TOKEN)}`;
    expect((await app.inject({ url: `/api/ping?${q}` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/servers/a/backups/b.zip/download?${q}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/servers/a/mods/export?${q}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/servers/a/mods/export.mrpack?config=1&${q}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/servers/a/mods/export?token=wrong` })).statusCode).toBe(401);
  });

  it("WebSocket: 서브프로토콜 bp.token.<base64url> 로 인증하고 서버는 'blockpilot' 을 골라 돌려준다", async () => {
    const ok = await openWs("/api/servers/a/console", ["blockpilot", `bp.token.${b64url(TOKEN)}`]);
    expect(ok.protocol).toBe("blockpilot");
    expect(ok.first).toBe("hello");
  });

  it("WebSocket: 토큰이 틀리거나 없거나 ?token= 으로 보내면 업그레이드가 거부된다", async () => {
    await expect(openWs("/api/servers/a/console", ["blockpilot", `bp.token.${b64url("nope")}`])).rejects.toThrow();
    await expect(openWs("/api/servers/a/console", ["blockpilot"])).rejects.toThrow();
    await expect(openWs(`/api/servers/a/console?token=${encodeURIComponent(TOKEN)}`, ["blockpilot"])).rejects.toThrow();
    // 거부 응답 코드까지 확인 (업그레이드 요청을 inject 로 흉내)
    const res = await app.inject({ url: "/api/servers/a/console", headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-protocol": "blockpilot, bp.token.bm9wZQ" } });
    expect(res.statusCode).toBe(401);
  });

  it("WebSocket: 서버는 bp.token.* 서브프로토콜을 절대 되돌려 주지 않는다 (토큰이 응답 헤더로 새지 않게)", async () => {
    const tokenOnly = `bp.token.${b64url(TOKEN)}`;
    // 맞는 토큰이지만 "blockpilot" 없이 토큰 서브프로토콜만 보낸 경우: 업그레이드가 되더라도 고른 서브프로토콜이 없어야 한다
    const res = await rawUpgrade("/api/servers/a/console", tokenOnly);
    expect(res.protocol ?? "").not.toContain("bp.token");
    if (res.status === 101) expect(res.protocol).toBeUndefined();
    else expect(res.status).toBeGreaterThanOrEqual(400);
    // 정상 접속에서도 되돌려 주는 건 "blockpilot" 하나뿐
    const ok = await rawUpgrade("/api/servers/a/console", `blockpilot, ${tokenOnly}`);
    expect(ok.status).toBe(101);
    expect(ok.protocol).toBe("blockpilot");
    // 브라우저·Node 의 WebSocket 은 요청한 서브프로토콜 중 하나를 서버가 고르지 않으면 접속 실패로 처리한다
    await expect(openWs("/api/servers/a/console", [tokenOnly])).rejects.toThrow();
  });
});

describe("토큰 무차별 대입 제한", () => {
  const attempt = (remoteAddress: string, headers: Record<string, string> = {}, url = "/api/ping") => app.inject({ url, headers, remoteAddress });
  const wrong = (n: number) => ({ authorization: `Bearer wrong-${n}` });

  it("같은 IP 에서 서로 다른 틀린 토큰 5개면 그다음부터 429 (맞는 토큰이어도), 다른 IP 는 영향 없음", async () => {
    for (let i = 0; i < 5; i++) expect((await attempt("10.0.0.1", wrong(i))).statusCode).toBe(401);
    const blocked = await attempt("10.0.0.1", bearer);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().message).toContain("10분");
    expect((await attempt("10.0.0.2", bearer)).statusCode).toBe(200);
  });

  it("같은 틀린 토큰을 반복하거나 토큰 없이 오는 건 세지 않는다 (오래된 토큰을 저장한 대시보드가 자기 IP 를 잠그지 않게)", async () => {
    for (let i = 0; i < 20; i++) expect((await attempt("10.0.0.5", wrong(0))).statusCode).toBe(401);
    for (let i = 0; i < 20; i++) expect((await attempt("10.0.0.5", {})).statusCode).toBe(401);
    expect((await attempt("10.0.0.5", bearer)).statusCode).toBe(200);
  });

  it("GET /api/auth 로 내민 틀린 토큰도 센다 (로그인 화면의 확인 경로로 무차별 대입 못 하게), 토큰 없는 조회는 잠긴 뒤에도 열려 있다", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await attempt("10.0.0.6", wrong(i), "/api/auth");
      expect(res.statusCode).toBe(200);
      expect(res.json().authenticated).toBe(false);
    }
    expect((await attempt("10.0.0.6", bearer, "/api/auth")).statusCode).toBe(429);
    expect((await attempt("10.0.0.6", bearer)).statusCode).toBe(429);
    expect((await attempt("10.0.0.6", {}, "/api/auth")).statusCode).toBe(200);
    expect((await attempt("10.0.0.6", {})).statusCode).toBe(401);
  });

  it("루프백도 예외가 아니다", async () => {
    for (let i = 0; i < 5; i++) await attempt("127.0.0.1", wrong(i));
    expect((await attempt("127.0.0.1", bearer)).statusCode).toBe(429);
  });

  it("맞는 토큰으로 한 번 통과하면 실패 기록이 초기화된다", async () => {
    for (let i = 0; i < 4; i++) await attempt("10.0.0.3", wrong(i));
    expect((await attempt("10.0.0.3", bearer)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await attempt("10.0.0.3", wrong(10 + i));
    expect((await attempt("10.0.0.3", bearer)).statusCode).toBe(200);
  });

  it("10분이 지나면 풀린다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < 5; i++) await attempt("10.0.0.4", wrong(i));
    expect((await attempt("10.0.0.4", bearer)).statusCode).toBe(429);
    vi.setSystemTime(new Date("2026-01-01T00:09:59Z"));
    expect((await attempt("10.0.0.4", bearer)).statusCode).toBe(429);
    vi.setSystemTime(new Date("2026-01-01T00:10:01Z"));
    expect((await attempt("10.0.0.4", bearer)).statusCode).toBe(200);
  });

  it("기억하는 IP 수에 상한이 있어 메모리가 무한히 늘지 않는다", async () => {
    // 상한(1000)을 넘기면 가장 오래된 기록을 버린다 → 첫 IP 는 다시 처음부터 센다
    for (let i = 0; i < 5; i++) await attempt("10.1.0.0", wrong(i));
    expect((await attempt("10.1.0.0", bearer)).statusCode).toBe(429);
    for (let i = 1; i <= 1000; i++) await attempt(`10.2.${Math.floor(i / 256)}.${i % 256}`, wrong(0));
    expect((await attempt("10.1.0.0", bearer)).statusCode).toBe(200);
  });
});

describe("보안 헤더", () => {
  it.each([
    ["/api/ping", bearer, 200],
    ["/api/ping", {}, 401],
    ["/", {}, 200],
    ["/nope", {}, 404],
  ] as const)("%s → %i 응답에도 붙는다", async (url, headers, status) => {
    const res = await app.inject({ url, headers });
    expect(res.statusCode).toBe(status);
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});
